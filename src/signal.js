import { UserError } from './errors.js';

const SIGNAL_URL = import.meta.env.VITE_SIGNAL_URL || 'http://localhost:8787';

export async function createSession(offer) {
  const res = await fetch(`${SIGNAL_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offer }),
  });
  if (!res.ok) throw new UserError('Could not create a session (signaling server unavailable)');
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
  if (!res.ok) throw new UserError('Could not submit the answer — the code may have expired.');
  return res.json();
}

export function deleteSession(code) {
  // Fire-and-forget cleanup; the KV TTL is the backstop if this never lands.
  return fetch(`${SIGNAL_URL}/session/${code}`, { method: 'DELETE' }).catch(() => {});
}

// Bounded, because this blocks the whole connection setup: on a captive or
// half-broken network (train Wi-Fi mid-handover) the request can hang for
// far longer than the browser's default, leaving the app stuck on
// "Preparing…" with nothing on screen to explain it. Better to give up and
// connect STUN-only than to stall indefinitely.
const TURN_FETCH_TIMEOUT_MS = 5000;

export async function fetchTurnServers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SIGNAL_URL}/turn`, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.iceServers) ? data.iceServers : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
