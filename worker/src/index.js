const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 60; // Cloudflare KV's floor for expirationTtl
// Compressed SDP offers/answers are ~1-2KB; anything much larger is abuse.
const MAX_PAYLOAD_LENGTH = 32 * 1024;
const CODE_RE = /^\d{6}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function randomCode() {
  // crypto-random so active codes can't be predicted from previous ones.
  // Rejection sampling rather than a plain modulo: 2^32 isn't a multiple of
  // 900000, so `% 900000` would make the low codes measurably likelier.
  const limit = Math.floor(0x100000000 / 900000) * 900000;
  const buf = new Uint32Array(1);
  let value;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(100000 + (value % 900000));
}

// KV holds whatever we last wrote, but a truncated or hand-edited value
// shouldn't turn into a 500 — treat anything unparseable as a missing session.
function parseSession(raw) {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// Cloudflare KV requires expirationTtl >= 60s, so clamp rather than letting
// an almost-expired session be rejected outright on write.
function remainingTtl(createdAt) {
  if (!Number.isFinite(createdAt)) return TTL_SECONDS;
  const elapsed = Math.floor((Date.now() - createdAt) / 1000);
  return Math.max(MIN_TTL_SECONDS, Math.min(TTL_SECONDS, TTL_SECONDS - elapsed));
}

async function allocateCode(sessions) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const existing = await sessions.get(code);
    if (!existing) return code;
  }
  return null;
}

// Mints short-lived Cloudflare TURN credentials so peers behind strict/
// symmetric NAT (common on carrier mobile hotspots) have a relay fallback
// when direct STUN-assisted P2P fails. Requires the TURN_KEY_ID and
// TURN_KEY_API_TOKEN secrets from a Cloudflare Realtime TURN key; if they
// aren't configured, callers just get an empty list and fall back to STUN.
async function turnCredentials(env) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return json({ iceServers: [] });
  }
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!res.ok) return json({ iceServers: [] });
    const data = await res.json();
    return json({ iceServers: data.iceServers ? [data.iceServers] : [] });
  } catch {
    return json({ iceServers: [] });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'turn' && request.method === 'GET' && parts.length === 1) {
      return turnCredentials(env);
    }

    if (parts[0] !== 'session') {
      return json({ error: 'not found' }, 404);
    }

    // POST /session  { offer } -> { code }
    if (request.method === 'POST' && parts.length === 1) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      if (!body || typeof body.offer !== 'string' || body.offer.length > MAX_PAYLOAD_LENGTH) {
        return json({ error: 'offer required' }, 400);
      }

      const code = await allocateCode(env.SESSIONS);
      if (!code) return json({ error: 'could not allocate code' }, 500);

      await env.SESSIONS.put(
        code,
        JSON.stringify({ offer: body.offer, answer: null, createdAt: Date.now() }),
        { expirationTtl: TTL_SECONDS }
      );
      return json({ code });
    }

    // Everything below addresses a specific session by code.
    const code = parts[1];
    if (parts.length >= 2 && !CODE_RE.test(code)) {
      return json({ error: 'not found' }, 404);
    }

    // GET /session/:code -> { offer, answer }
    if (request.method === 'GET' && parts.length === 2) {
      const raw = await env.SESSIONS.get(code);
      if (!raw) return json({ error: 'not found' }, 404);
      const data = parseSession(raw);
      if (!data) return json({ error: 'not found' }, 404);
      return json({ offer: data.offer, answer: data.answer });
    }

    // DELETE /session/:code — the host calls this once it has consumed the
    // answer, so the handshake blob doesn't linger in KV for the full TTL.
    if (request.method === 'DELETE' && parts.length === 2) {
      await env.SESSIONS.delete(code);
      return json({ ok: true });
    }

    // POST /session/:code/answer  { answer } -> { ok }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'answer') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      if (!body || typeof body.answer !== 'string' || body.answer.length > MAX_PAYLOAD_LENGTH) {
        return json({ error: 'answer required' }, 400);
      }

      const raw = await env.SESSIONS.get(code);
      if (!raw) return json({ error: 'not found' }, 404);

      const data = parseSession(raw);
      if (!data) return json({ error: 'not found' }, 404);
      data.answer = body.answer;
      // Keep the session's original expiry instead of granting it a fresh
      // full TTL — otherwise answering resets the 10-minute window the
      // client (and the README) count on.
      await env.SESSIONS.put(code, JSON.stringify(data), {
        expirationTtl: remainingTtl(data.createdAt),
      });
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};
