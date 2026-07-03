import { deflate, inflate } from 'pako';

// The offer/answer arrive via URL params and the public relay, so treat them
// as untrusted: cap the compressed input (real SDPs compress to ~1-2KB) and
// sanity-check the inflated output before handing it to WebRTC.
const MAX_COMPRESSED_LENGTH = 16 * 1024;

export function compressSdp(sdp) {
  const deflated = deflate(sdp);
  let binary = '';
  for (let i = 0; i < deflated.length; i++) binary += String.fromCharCode(deflated[i]);
  return btoa(binary);
}

export function decompressSdp(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_COMPRESSED_LENGTH) {
    throw new Error('Invalid connection data');
  }
  let sdp;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    sdp = new TextDecoder().decode(inflate(bytes));
  } catch {
    throw new Error('Invalid connection data');
  }
  if (!sdp.startsWith('v=')) throw new Error('Invalid connection data');
  return sdp;
}
