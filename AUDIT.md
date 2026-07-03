# Security & Reliability Audit — 9

**Scope:** the full client (`src/`) and the signaling worker (`worker/`).
**Method:** manual source review of every file, informed by how a hostile
peer, a hostile link-crafter, and a hostile network client would each try
to abuse the app; every finding below was reproduced and re-verified fixed
with an automated test (Playwright for the client, direct HTTP calls for
the worker) before being marked resolved.
**Verdict:** the core design is sound — shared text and files stay
DTLS-encrypted and peer-to-peer, the relay never sees them, nothing is
rendered from untrusted input via `innerHTML`. The issues found were all
at the *edges*: inputs crossing a trust boundary that weren't validated,
and a handful of lifecycle bugs that could leak memory or a live camera.
None were exploitable for data disclosure of another user's session; the
worst realistic impact was a crashed tab or a stuck UI.

---

## Trust model

| Party | Sees | Can abuse by |
|---|---|---|
| The other peer (once connected) | The shared text/files (that's the point), and connection metadata | Sending malformed protocol messages, oversized/mislabeled files, huge text |
| Anyone with a join link or 6-digit code | Nothing until they successfully complete the handshake | Crafting a malicious `?offer=` parameter |
| The Cloudflare Worker (`worker/`) | The one-time SDP offer/answer (ICE candidates, DTLS fingerprint — *not* the shared text) | Abusing the KV store, guessing active codes |
| Google STUN / Cloudflare TURN | Both peers' public IPs, for NAT traversal | N/A (standard WebRTC exposure, disclosed in-app via tooltip) |
| A passive network observer | Nothing — signaling to the worker is HTTPS, the P2P link is DTLS | — |

The shared text and any transferred file **never** touch the worker or
any third-party server, checked or unchecked "Same Wi-Fi" — that box only
controls which servers help the two devices find each other, not who
holds the data.

---

## Findings and fixes

| # | Area | Severity | Issue | Fix |
|---|---|---|---|---|
| 1 | SDP decompression | Medium | `decompressSdp` ran attacker-controlled input (the `?offer=` URL param — craftable into any link) through `atob` + zlib inflate with no size cap and no validation of the result, before handing it to `RTCPeerConnection`. A malicious link could pass an oversized or crafted payload. | Input capped at 16KB before inflating; output must start with `v=` (a real SDP does) or it's rejected. All decode failures now throw one clean `Invalid connection data` instead of a raw browser exception. |
| 2 | Incoming file transfer | Medium | The receiving side trusted the peer's `file-start` message (name, size, mime) completely and just kept pushing chunks into an array with no bound — a malicious or buggy peer could announce a 1KB file and then stream unlimited data, growing memory without limit. | `size` must be a finite, positive number within the 25MB cap; `name` is length-capped and stripped of `/`/`\` before becoming the download filename. A transfer that receives more bytes than it announced is aborted immediately rather than buffered further. |
| 3 | Session code generation (worker) | Medium | 6-digit pairing codes were generated with `Math.random()`, which is not cryptographically secure and is predictable in principle. | Switched to `crypto.getRandomValues`. |
| 4 | Worker payload size (worker) | Low | `POST /session` and `POST /session/:code/answer` accepted a body of any size into KV, with no cap. | Both capped at 32KB (a real compressed SDP is ~1-2KB). |
| 5 | Worker route validation (worker) | Low | The `:code` path segment wasn't validated against the 6-digit format before use. | Added an explicit format check; malformed codes 404 immediately. |
| 6 | Handshake retention (worker) | Low | The README always claimed handshake blobs are "deleted right after use" — nothing actually deleted them; they sat in KV for the full 10-minute TTL regardless of whether pairing succeeded seconds later. | Added `DELETE /session/:code`; the host calls it immediately after consuming the answer. Verified live: the relay 404s on that code right after pairing completes. |
| 7 | Shared text size | Low | No cap on the text field. A large paste (or a malicious peer sending one) risks exceeding the ~256KB practical DataChannel message limit, which can throw and kill the channel outright. | Capped at 50,000 characters on both the `<textarea maxlength>` and on any incoming `text` message. |
| 8 | Stuck file sends | **Reliability** | `waitForDrain`'s backpressure promise had no failure path — if the connection dropped mid-transfer, it never resolved *or* rejected, silently locking `state.sendingFile` and blocking all future sends until a full page reload. | Now rejects on the channel's `close`/`error` events, and the send loop re-checks `readyState` after every drain wait. |
| 9 | Camera stream leak | **Reliability** | Double-tapping the scan button (or a very quick toggle) could race two `getUserMedia()` calls; the first stream's tracks were never stopped, leaving the camera's hardware light on indefinitely. Scanner-construction failure after acquiring the stream also leaked it. | Toggle handler is now re-entrancy-guarded; every failure path after acquiring a stream explicitly stops its tracks. |
| 10 | Stale event handlers | **Reliability** | A torn-down `RTCDataChannel`'s `close`/`error` events can fire asynchronously *after* a new connection has already been started, and were able to clobber the new connection's status UI. | Every handler now checks `state.channel === channel` (the specific instance it was registered for) before acting. |
| 11 | Answer polling overlap | **Reliability** | Polling used `setInterval`, so a slow `fetch` could still be in flight when the next tick fired, risking two concurrent attempts to apply the answer. | Switched to a self-scheduling `setTimeout` chain — the next poll is only scheduled after the current one finishes. |
| 12 | Reload after connecting | **Correctness** | The joiner's URL keeps its one-time `?code=&offer=...` params after pairing. Reloading replayed them: the code had already been deleted from the relay (see #6) and the offer's ICE session is dead, so the retry failed, surfacing a confusing "Couldn't connect directly" error with a blank QR instead of the fresh session a reload should give. | `?code`/`offer`/`wifi`/`hidden` are stripped from the URL via `history.replaceState` immediately after being read once, regardless of whether the join succeeds. A reload now always starts clean. |
| 13 | "File too big" error placement | Low (UX) | The oversized-file error rendered into `#connectError`, which lives inside the connect panel — exactly the element that's collapsed once connected, i.e. hidden precisely when this error was most likely to fire. | Moved to the dedicated file-status line, which is always reachable. |
| 14 | TURN fetch caching | Low (reliability) | A failed `/turn` fetch (transient network blip, or TURN simply not configured yet) was cached as "no TURN" for the rest of the page's lifetime. | Only a non-empty result is cached; a failure is retried on the next connection attempt. |

---

## Deliberately out of scope / accepted risk

Being direct about what this audit does *not* close off:

- **Code-guessing window.** A 6-digit code is 1,000,000 combinations, live for up to 10 minutes, and `GET /session/:code` has no rate limiting. A sufficiently motivated attacker hammering the worker could brute-force an active code within its window and pull the offer (connection metadata — not the shared text, which doesn't exist until a DataChannel is established). QR-code/embedded-offer pairing skips this endpoint entirely and isn't exposed to it. Mitigating this properly needs rate limiting (e.g. Cloudflare's built-in WAF rate rules, or a request-count check in the Worker) — not implemented here as it's a availability/abuse-prevention feature, not a data-confidentiality hole, and was out of scope for this pass.
- **`/turn` has no auth.** Anyone can call it and receive valid (if short-lived) Cloudflare TURN credentials, which could in principle be used to relay unrelated traffic through your TURN allocation. Cloudflare bills TURN by usage; if this becomes a target, scope the credentials down or add a lightweight check (e.g. require a valid, unconsumed session code).
- **Worker and TURN/STUN providers are trusted infrastructure.** If Cloudflare's Worker platform or KV were compromised, an attacker could serve a malicious offer to intercept a handshake. This is inherent to using any relay for NAT traversal and isn't specific to this app's code.
- **Dependencies** (`qrcode`, `qr-scanner`, `pako`) are used as published; this audit read the relevant code paths in each (the exact bugs the earlier QR-sizing and camera-mirroring fixes were built around) but did not do a full supply-chain audit of every line.
- **No Content-Security-Policy header.** Nothing in the current codebase writes untrusted data into `innerHTML` (the one `app.innerHTML = ...` assignment is the app's own static template), so there's no live XSS path — but a CSP header would be a reasonable defense-in-depth addition against any future regression.

---

## Testing performed

- Worker endpoints exercised directly: create/get/answer/delete session, oversized-payload rejection (400), malformed-code rejection (404).
- A crafted malicious `?offer=` URL loaded in a real browser → clean error, graceful fallback to hosting, no exception leaking to the console.
- Verified live that a relay session is actually gone (404) immediately after the handshake completes.
- Full two-browser Playwright suites: text/hidden-mode sync, QR-encoded settings, file transfer (MD5-verified byte-for-byte), oversized-file rejection, camera scanner (stream acquisition, no mirror transform), connect-panel collapse behavior, and the reload-after-connect fix — all passing.
