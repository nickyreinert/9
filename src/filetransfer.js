export const MAX_FILE_SIZE = 25 * 1024 * 1024;

const CHUNK_SIZE = 16 * 1024;
// Pause sending once the channel's outgoing buffer backs up past this, and
// resume on 'bufferedamountlow' — otherwise a big file floods the channel
// faster than SCTP can drain it and the connection stalls.
const BUFFERED_AMOUNT_LOW_THRESHOLD = 256 * 1024;

function waitForDrain(channel) {
  if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW_THRESHOLD) return Promise.resolve();
  channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;
  return new Promise((resolve) => {
    channel.addEventListener('bufferedamountlow', resolve, { once: true });
  });
}

export async function sendFile(channel, file, onProgress) {
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
    const buffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    onProgress?.(offset, file.size);
  }

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
