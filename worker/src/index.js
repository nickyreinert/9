const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const TTL_SECONDS = 600;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
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
      if (!body || typeof body.offer !== 'string') {
        return json({ error: 'offer required' }, 400);
      }

      const code = await allocateCode(env.SESSIONS);
      if (!code) return json({ error: 'could not allocate code' }, 500);

      await env.SESSIONS.put(code, JSON.stringify({ offer: body.offer, answer: null }), {
        expirationTtl: TTL_SECONDS,
      });
      return json({ code });
    }

    // GET /session/:code -> { offer, answer }
    if (request.method === 'GET' && parts.length === 2) {
      const raw = await env.SESSIONS.get(parts[1]);
      if (!raw) return json({ error: 'not found' }, 404);
      return json(JSON.parse(raw));
    }

    // POST /session/:code/answer  { answer } -> { ok }
    if (request.method === 'POST' && parts.length === 3 && parts[2] === 'answer') {
      const code = parts[1];
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid json' }, 400);
      }
      if (!body || typeof body.answer !== 'string') {
        return json({ error: 'answer required' }, 400);
      }

      const raw = await env.SESSIONS.get(code);
      if (!raw) return json({ error: 'not found' }, 404);

      const data = JSON.parse(raw);
      data.answer = body.answer;
      await env.SESSIONS.put(code, JSON.stringify(data), { expirationTtl: TTL_SECONDS });
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
};
