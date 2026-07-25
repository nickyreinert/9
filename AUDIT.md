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

## Second pass — logic and correctness

A follow-up review focused on control flow rather than trust boundaries:
what happens when two things race, when a promise never settles, and when
a peer stops halfway through. Each finding below was reproduced against
the pre-fix build and re-verified afterwards.

| # | Area | Severity | Issue | Fix |
|---|---|---|---|---|
| 15 | Superseded connection attempts | **Correctness** | Setting up a connection is a long chain of `await`s. The guards between them checked `state.mode`, which is still `'host'` for a *second* host attempt — so an attempt that had been torn down mid-flight (a re-scan, a toggled checkbox) resumed anyway, built its own `RTCPeerConnection`, overwrote `state.pc`, and registered a second relay session. Reproduced with a slow `/turn`: two live peer connections left open, only one of them reachable by the code on screen. | A `state.generation` counter, bumped by every `teardown()`. Both `startHost` and `joinWithCode` capture it and bail at each step if it moved, and the whole chain is wrapped so driving an already-closed connection can't escape as an unhandled rejection. Verified: one live peer connection after the same race. |
| 16 | Truncated file transfers | **Correctness** | `file-end` triggered the download unconditionally. A transfer cut short mid-stream (peer sleeps, Wi-Fi drops) handed the user a silently truncated file reported as `Received "…"`. Reproduced by announcing 8KB and sending 1KB — the browser downloaded it and the UI called it a success. | The received byte count must equal the announced size, or nothing is saved and the receiver is told it arrived incomplete. |
| 17 | Unbounded answer polling | **Reliability** | The host polled the relay every 1.5s forever. Past the 10-minute KV TTL the session is gone and the code on screen is dead, but a tab left open kept polling indefinitely. A malformed answer was equally unbounded — it was re-fetched and re-applied on every tick. | Polling stops at the session TTL and mints a fresh code instead of showing a QR that resolves to nothing. An answer is deleted from the relay before being applied, so a bad one is tried exactly once. |
| 18 | Stalled file sends | **Reliability** | The `close`/`error` rejection added in #8 only helps when the channel *reports* the failure. A peer that vanishes without a clean close leaves `bufferedAmount` pinned and no event ever fires — `waitForDrain` hangs and `state.sendingFile` stays locked until reload, the same symptom #8 set out to fix. | A stall watchdog rejects when the outgoing buffer makes no progress at all for 30s; it re-arms while the buffer is still draining, so a genuinely slow link isn't cut off. |
| 19 | Decompression bomb | Medium | #1 capped the *compressed* input at 16KB but not the inflated output — 16KB of deflate expands to hundreds of MB. Confirmed: a 5.4KB `?offer=` param inflated to 4MB unchecked. | Streaming inflate with a 128KB output cap, enforced chunk by chunk so an oversized payload is never fully materialised. |
| 20 | `disconnected` treated as failure | **Correctness** | `disconnected` is a recoverable ICE state, not a terminal one, but it was handled identically to `failed` — a brief blip showed "Connection failed", and the "uncheck Same Wi-Fi" hint appeared even after a connection that had worked fine for minutes, where it is simply wrong advice. | `disconnected` now reports "Reconnecting…"; only `failed` is terminal, and the Same-Wi-Fi hint is limited to links that never came up. A stale error is also cleared when a connection succeeds. |
| 21 | Service worker cached failures | **Reliability** | The `fetch` handler cached every response it saw, including 404s and 5xx. A miss or a bad deploy got written to the cache and served back happily on later loads; `cache.put` also throws outright on a 206. Confirmed: a 404 was written to the cache. | Only complete, successful, same-origin responses are stored, and the write is wrapped in `waitUntil` so it survives the worker being shut down. |
| 22 | Camera stream leak on start failure | **Reliability** | #9 covered failures during acquisition, but not `scanner.start()` failing *after* the stream was acquired: the scanner was already in `state.scanner` and was never stopped, so the next camera open overwrote the handle and orphaned a live stream. | The failure path releases the scanner before giving up. |
| 23 | Relay TTL reset on answer (worker) | Low | `POST /session/:code/answer` re-wrote the record with a full fresh `expirationTtl`, silently extending a session's life past the 10 minutes the client and README both count on. | The record carries its creation time and the remaining TTL is preserved (clamped to KV's 60s floor). |
| 24 | Worker robustness | Low | A KV value that failed to parse threw out of the handler as a 500, and `GET /session/:code` echoed the whole stored record. `randomCode` used `% 900000` over a `Uint32`, which is not a multiple of 2³² and so biased the low codes. | Unparseable records 404 like a missing session, `GET` returns only `offer`/`answer`, and code generation uses rejection sampling. |
| 25 | Silent rejections and raw errors | Low (UX) | Oversized or malformed `file-start` metadata was dropped with no feedback — the sender showed a progress bar climbing to 100% while the receiver showed nothing. Failed joins rendered `err.message` directly, surfacing raw `DOMException` text. | Rejected transfers say so; join errors are classified, and anything that isn't a deliberate user-facing message becomes a generic one. |

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

For the second pass, every finding was first reproduced against the
unmodified build and then re-verified fixed:

- Two-browser pairing, bidirectional text sync, hidden-mode sync and a 300KB MD5-verified file transfer, re-run to confirm nothing regressed.
- A truncated transfer (8KB announced, 1KB sent) — pre-fix the browser downloaded it and the UI reported success; post-fix nothing is saved and the receiver is told why.
- The supersede race driven with a deliberately slow `/turn`: pre-fix two peer connections left open, post-fix exactly one.
- A 404 requested through the service worker: pre-fix written to the cache, post-fix not — with the app shell still cached.
- A 4MB zlib bomb packed into a 5.4KB `?offer=` param: rejected before inflating.
- Worker: TTL preservation across an answer, the 60s clamp, unparseable-record handling, and 3,000 generated codes checked for range and spread.
- File transfer in isolation: clean send, closed channel, mid-transfer close, a peer that stops responding entirely, and a file that becomes unreadable — each rejects promptly instead of hanging.
