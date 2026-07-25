import { deflate, Inflate } from 'pako';
import { UserError } from './errors.js';

// The offer/answer arrive via URL params and the public relay, so treat them
// as untrusted: cap the compressed input (real SDPs compress to ~1-2KB) and
// sanity-check the inflated output before handing it to WebRTC.
const MAX_COMPRESSED_LENGTH = 16 * 1024;
// Capping the input alone isn't enough — 16KB of deflate can expand to
// hundreds of megabytes. Bound the *output* while inflating and bail the
// moment it goes past what a real SDP could plausibly be.
const MAX_INFLATED_LENGTH = 128 * 1024;

export function compressSdp(sdp) {
  const deflated = deflate(sdp);
  let binary = '';
  for (let i = 0; i < deflated.length; i++) binary += String.fromCharCode(deflated[i]);
  return btoa(binary);
}

// Streaming inflate so the size cap is enforced chunk by chunk, before an
// oversized payload is ever fully materialised in memory.
function inflateBounded(bytes) {
  const inflator = new Inflate();
  const chunks = [];
  let total = 0;
  let overflow = false;
  inflator.onData = (chunk) => {
    if (overflow) return;
    total += chunk.length;
    if (total > MAX_INFLATED_LENGTH) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  };
  inflator.push(bytes, true);
  if (overflow || inflator.err) throw new UserError('Invalid connection data');

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function decompressSdp(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_COMPRESSED_LENGTH) {
    throw new UserError('Invalid connection data');
  }
  let sdp;
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    sdp = new TextDecoder().decode(inflateBounded(bytes));
  } catch {
    throw new UserError('Invalid connection data');
  }
  if (!sdp.startsWith('v=')) throw new UserError('Invalid connection data');
  return sdp;
}
