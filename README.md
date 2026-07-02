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
