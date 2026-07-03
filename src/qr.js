import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';

export async function renderQr(canvas, text) {
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'L',
    margin: 1,
    scale: 5,
  });
}

export async function createScanner(videoEl, onResult) {
  // Acquire the stream ourselves and hand it to QrScanner pre-attached.
  // QrScanner skips its own getUserMedia call when videoEl.srcObject is
  // already set — which also skips its facing-mode guess-based mirroring
  // (it sets an inline `scaleX(-1)` transform when it *thinks* it's a
  // front camera, based on parsing the camera's label string, and that
  // guess sometimes misfires and mirrors the rear camera instead). We
  // only ever want the rear camera here, never mirrored.
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  videoEl.srcObject = stream;

  const scanner = new QrScanner(videoEl, (result) => onResult(result.data), {
    highlightScanRegion: true,
    highlightCodeOutline: true,
    onDecodeError: () => {},
  });

  // Some Android browsers/WebViews report the camera's native landscape
  // sensor frame as-is instead of rotating it to match a portrait device,
  // leaving the preview sideways. Detect that mismatch and correct it.
  // Set directly (not via a CSS class) so it can't be clobbered by any
  // inline transform QrScanner itself might still set elsewhere.
  videoEl.addEventListener('loadedmetadata', () => {
    const portraitViewport = window.innerHeight > window.innerWidth;
    const landscapeStream = videoEl.videoWidth > videoEl.videoHeight;
    videoEl.style.transform = portraitViewport && landscapeStream ? 'rotate(90deg)' : '';
  });

  return scanner;
}

export { QrScanner };
