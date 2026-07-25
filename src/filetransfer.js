export const MAX_FILE_SIZE = 25 * 1024 * 1024;

const CHUNK_SIZE = 16 * 1024;
// Pause sending once the channel's outgoing buffer backs up past this, and
// resume on 'bufferedamountlow' — otherwise a big file floods the channel
// faster than SCTP can drain it and the connection stalls.
const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;
// A peer that vanishes without a clean close (device sleeps, Wi-Fi drops)
// leaves the buffer permanently full and no 'close' event ever arrives, so a
// plain event wait would hang forever and wedge file sending until reload.
// Give up if the outgoing buffer makes no progress at all for this long.
const DRAIN_STALL_TIMEOUT_MS = 30000;

function waitForDrain(channel) {
  if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) return Promise.resolve();
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  return new Promise((resolve, reject) => {
    let lastBuffered = channel.bufferedAmount;
    let stallTimer = null;
    const cleanup = () => {
      clearTimeout(stallTimer);
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onClose);
    };
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connection lost mid-transfer'));
    };
    const onStall = () => {
      // Re-arm as long as the peer is still consuming — a genuinely slow
      // link keeps draining, it just hasn't crossed the low-water mark yet.
      if (channel.readyState === 'open' && channel.bufferedAmount < lastBuffered) {
        lastBuffered = channel.bufferedAmount;
        stallTimer = setTimeout(onStall, DRAIN_STALL_TIMEOUT_MS);
        return;
      }
      cleanup();
      reject(new Error('Transfer stalled — the peer stopped responding'));
    };
    stallTimer = setTimeout(onStall, DRAIN_STALL_TIMEOUT_MS);
    channel.addEventListener('bufferedamountlow', onLow);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onClose);
  });
}

export async function sendFile(channel, file, onProgress) {
  if (channel.readyState !== 'open') throw new Error('Connection lost mid-transfer');
  channel.send(
    JSON.stringify({
      type: 'file-start',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
    })
  );

  let offset = 0;
  while (offset < file.size) {
    await waitForDrain(channel);
    if (channel.readyState !== 'open') throw new Error('Connection lost mid-transfer');
    const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    // A zero-length slice would spin this loop forever — that happens when
    // the file shrank or became unreadable after it was picked.
    if (buffer.byteLength === 0) throw new Error('File became unreadable mid-transfer');
    channel.send(buffer);
    offset += buffer.byteLength;
    onProgress?.(offset, file.size);
  }

  if (channel.readyState !== 'open') throw new Error('Connection lost mid-transfer');
  channel.send(JSON.stringify({ type: 'file-end' }));
}

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
