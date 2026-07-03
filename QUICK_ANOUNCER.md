I was in need of a quick way to send text from one device to another, like passwords after setting up a new machine. 

So I build "9". 

https://9.1-1-1.de

Two devices connect with a QR scan or a 6-digit code. Latter one uses a tiny Cloudflare relay to fetch the connection offer, but the text itself travels over a direct, DTLS-encrypted WebRTC connection.

If you are on the same Wi-Fi, you just go ahead and scan the QR code. Otherwise deactivate "Same Wi-Fi" and use Google STUN for NAT traversal, or in rare cases Cloudflare TURN. 

If you are lazy or have no camera at hand, use the 6-digit code. It will fetch the connection offer through a tiny Cloudflare relay, but the text itself still travels over a direct, DTLS-encrypted WebRTC connection.'

Whatever you type in one device shows up in the other in real time.

The text travels over a direct, DTLS-encrypted WebRTC connection.

No server ever sees it, and nothing is stored anywhere. 

You can also activate "masking" mode, which hides the text with asterisks, but still allows copy and sync to work. Each edit is briefly revealed for ~900ms before re-masking.

Yes, file transfer is supported, too. 

Yes, there are alternatives, but they don't match the simplicity and privacy of this one - AFAIK:

- PairDrop (to big and does not support TURN/STUN AFAIK)
- Snapdrop (out of commission it seems)
- ShareDrop (out of commission it seems)
- Wormhole (to big)
- LocalSend (to big)