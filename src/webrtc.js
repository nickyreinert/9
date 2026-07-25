export function createPeerConnection(sameWifi, turnServers = []) {
  const config = sameWifi
    ? { iceServers: [] }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, ...turnServers] };
  return new RTCPeerConnection(config);
}

// Older browsers don't expose RTCIceCandidate.type, so fall back to reading
// the candidate line itself ("… typ relay …").
function isRelayCandidate(candidate) {
  return candidate.type === 'relay' || / typ relay\b/.test(candidate.candidate || '');
}

// Non-trickle ICE: wait until gathering finishes (or times out) so the local
// SDP embeds all candidates and only needs a single QR exchange.
//
// The timeout is the tricky part. Whatever has been gathered when it fires is
// all the other peer will ever see — there's no second chance to send a late
// candidate. A flat 6s budget is plenty on a LAN, where gathering completes in
// milliseconds, but a TURN allocation over a slow, lossy link (train or hotel
// Wi-Fi, tethered mobile data) routinely takes longer than that. Giving up
// there ships an offer with no relay candidate — precisely the one candidate
// that can bridge two devices on different networks — and it fails silently,
// exactly when a relay is the only thing that would have worked.
//
// So: keep the short budget for the common case, but when a relay is expected
// and hasn't arrived yet, hold out for it until the hard deadline.
export function waitForIceGatheringComplete(
  pc,
  { timeoutMs = 6000, relayTimeoutMs = 20000, needRelay = false, onWaitingForRelay } = {}
) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let sawRelay = false;
    let notified = false;
    let overtime = false; // past the short budget, holding out for a relay
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      pc.removeEventListener('icecandidate', onCandidate);
      clearTimeout(timer);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const onCandidate = (event) => {
      // A null candidate is the end-of-gathering signal.
      if (!event.candidate) return finish();
      if (!isRelayCandidate(event.candidate)) return;
      sawRelay = true;
      // Already in overtime purely to wait for this — don't sit through the
      // rest of the poll interval now that it's here.
      if (overtime) finish();
    };
    const onDeadline = () => {
      if (needRelay && !sawRelay && Date.now() - started < relayTimeoutMs) {
        overtime = true;
        if (!notified) {
          notified = true;
          onWaitingForRelay?.();
        }
        timer = setTimeout(onDeadline, 500);
        return;
      }
      finish();
    };

    pc.addEventListener('icegatheringstatechange', onStateChange);
    pc.addEventListener('icecandidate', onCandidate);
    timer = setTimeout(onDeadline, timeoutMs);
  });
}
