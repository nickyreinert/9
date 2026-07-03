# 9 - Share text. Quickly. Secure. Anonymous.

Text sync between two devices over a direct WebRTC DataChannel. The
shared text itself is always fully peer-to-peer and DTLS-encrypted — no
server ever sees it, nothing is stored.

## How it works

1. Open the page on both devices. Each one immediately generates a QR
   code and a 6-digit code — no button press required.
2. On the device you want to join *from*, click **Connect**. Either scan
   the other device's QR with the in-page camera, or just type in the
   6-digit code you read off its screen.
3. The DataChannel opens automatically and the shared textarea syncs
   instantly in both directions.

Reloading the page always generates a fresh code. Scanning the QR with
your phone's regular camera app also works — it encodes a plain URL
(`?code=123456`) that auto-joins on load, no extra click needed.

Check **Same Wi-Fi (no STUN)** when both devices are on the same local
network for a direct LAN connection. Leave it unchecked to use a public
STUN server for NAT traversal (still peer-to-peer).

### Why there's a signaling relay

WebRTC still needs the two devices to exchange a one-time connection
handshake (SDP offer/answer) before a P2P link exists — that data is too
large to fit in a 6-digit code by itself. `worker/` is a tiny Cloudflare
Worker + KV store that holds each pending handshake under its code for
10 minutes and is deleted/expired right after use. It never sees your
shared text, only the connection setup metadata.

## Development

```bash
npm install
npm run dev      # dev server (needs the worker running too, see below)
npm run build    # static production build in dist/
npm run preview  # serve the production build
```

Run the signaling worker locally in a second terminal:

```bash
cd worker
npx wrangler dev --port 8787
```

The app talks to the worker via `VITE_SIGNAL_URL`, defaulting to
`http://localhost:8787` for local dev.

The production build is a static bundle — deploy `dist/` to any static
host, it does not need its own backend beyond the small worker.

## Deployment (GitHub Pages + Cloudflare)

### Pages site

`.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages
via GitHub Actions on every push to `main`. One-time setup:

1. In the repo's **Settings → Pages**, set **Source** to "GitHub Actions".
2. `public/CNAME` already points Pages at `9.1-1-1.de`; if you change the
   domain, update that file to match.
3. In Cloudflare DNS for the domain, add a `CNAME` record pointing to
   `nickyreinert.github.io`. Leave it **DNS only** (grey cloud) until
   GitHub issues its TLS cert for the custom domain, then you can proxy
   it (orange cloud) with SSL/TLS mode set to Full or Full (strict).
4. Once the domain resolves, enable **Enforce HTTPS** in the Pages
   settings.

### Signaling worker

1. `cd worker && npx wrangler login` (one-time, opens a browser to
   authorize your Cloudflare account).
2. Create the KV namespace: `npx wrangler kv namespace create SESSIONS`,
   then copy the resulting `id` into `worker/wrangler.toml`.
3. `npx wrangler deploy` — prints the worker's URL, e.g.
   `https://qr-p2p-signal.<your-subdomain>.workers.dev`.
4. In the GitHub repo, add a repository **variable** (Settings → Secrets
   and variables → Actions → Variables) named `SIGNAL_URL` set to that
   URL. The deploy workflow passes it into the build as
   `VITE_SIGNAL_URL`.
5. Re-run the deploy workflow (or push again) so the site picks it up.
