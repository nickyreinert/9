import { deflate, inflate } from 'pako';

export function compressSdp(sdp) {
  const deflated = deflate(sdp);
  let binary = '';
  for (let i = 0; i < deflated.length; i++) binary += String.fromCharCode(deflated[i]);
  return btoa(binary);
}

export function decompressSdp(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(inflate(bytes));
}
