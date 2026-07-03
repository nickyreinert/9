import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';

export async function renderQr(canvas, text) {
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'L',
    margin: 1,
    scale: 5,
  });
}

export function createScanner(videoEl, onResult) {
  const scanner = new QrScanner(videoEl, (result) => onResult(result.data), {
    highlightScanRegion: true,
    highlightCodeOutline: true,
    onDecodeError: () => {},
  });

  // Some Android browsers/WebViews report the camera's native landscape
  // sensor frame as-is instead of rotating it to match a portrait device,
  // leaving the preview sideways. Detect that mismatch and correct it with CSS.
  videoEl.addEventListener('loadedmetadata', () => {
    const portraitViewport = window.innerHeight > window.innerWidth;
    const landscapeStream = videoEl.videoWidth > videoEl.videoHeight;
    videoEl.classList.toggle('video-needs-rotation', portraitViewport && landscapeStream);
  });

  return scanner;
}

export { QrScanner };
