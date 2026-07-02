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
  return new QrScanner(videoEl, (result) => onResult(result.data), {
    highlightScanRegion: true,
    highlightCodeOutline: true,
    onDecodeError: () => {},
  });
}

export { QrScanner };
