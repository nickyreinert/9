# QR P2P Text Share

Browser-only, serverless text sync between two devices over a direct WebRTC
DataChannel. Pairing (SDP offer/answer exchange) happens by scanning QR
codes — no backend, no accounts, no stored data.

## How it works

1. Device A clicks **Start as Host** — an offer QR code is generated.
2. Device B clicks **Join Session** and scans it (or pastes the code).
3. Device B's answer QR is scanned back on Device A (or pasted).
4. The DataChannel opens and the shared textarea syncs instantly in both
   directions.

Check **Same Wi-Fi (no STUN)** when both devices are on the same local
network for a direct LAN connection. Leave it unchecked to use a public
STUN server for NAT traversal (still peer-to-peer — no server ever sees
the text).

Camera scanning requires HTTPS (or `localhost`). A paste fallback is
always available under each QR code so the app works without a camera.

## Development

```bash
npm install
npm run dev      # dev server
npm run build    # static production build in dist/
npm run preview  # serve the production build
```

The production build is a static bundle — deploy `dist/` to any static
host (it does not need a backend).

## Deployment (GitHub Pages + Cloudflare)

`.github/workflows/deploy.yml` builds and deploys `dist/` to GitHub Pages
via GitHub Actions on every push to `main`. One-time setup:

1. In the repo's **Settings → Pages**, set **Source** to "GitHub Actions".
2. `public/CNAME` already points Pages at `9.1-1-1.de`; if you change the
   domain, update that file to match.
3. In Cloudflare DNS for the domain, add a `CNAME` record pointing to
   `nickyreinert.github.io` (DNS-only or proxied both work; GitHub issues
   its own TLS cert for the custom domain either way).
4. Once the domain resolves, enable **Enforce HTTPS** in the Pages
   settings.
