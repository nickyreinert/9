const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:8787';

export async function createSession(offer) {
  const res = await fetch(`${SIGNAL_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer }),
  });
  if (!res.ok) throw new Error('Could not create a session (signaling server unavailable)');
  return res.json();
}

export async function fetchSession(code) {
  const res = await fetch(`${SIGNAL_URL}/session/${code}`);
  if (!res.ok) return null;
  return res.json();
}

export async function submitAnswer(code, answer) {
  const res = await fetch(`${SIGNAL_URL}/session/${code}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  if (!res.ok) throw new Error('Could not submit the answer (code expired?)');
  return res.json();
}

export function deleteSession(code) {
  // Fire-and-forget cleanup; the KV TTL is the backstop if this never lands.
  return fetch(`${SIGNAL_URL}/session/${code}`, { method: 'DELETE' }).catch(() => {});
}

export async function fetchTurnServers() {
  try {
    const res = await fetch(`${SIGNAL_URL}/turn`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.iceServers) ? data.iceServers : [];
  } catch {
    return [];
  }
}
