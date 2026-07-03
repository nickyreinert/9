export function createPeerConnection(sameWifi, turnServers = []) {
  const config = sameWifi
    ? { iceServers: [] }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...turnServers] };
  return new RTCPeerConnection(config);
}

// Non-trickle ICE: wait until gathering finishes (or times out) so the
// local SDP embeds all candidates and only needs a single QR exchange.
export function waitForIceGatheringComplete(pc, timeoutMs = 6000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', check);
    const timer = setTimeout(finish, timeoutMs);
  });
}
