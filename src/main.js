import './style.css';
import { renderQr, createScanner } from './qr.js';
import { createPeerConnection, waitForIceGatheringComplete } from './webrtc.js';
import { compressSdp, decompressSdp } from './sdp.js';
import { createSession, fetchSession, submitAnswer, fetchTurnServers } from './signal.js';
import { sendFile, triggerDownload, MAX_FILE_SIZE } from './filetransfer.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="hero">
    <div class="hero-left">
      <div class="dots" aria-hidden="true">
        <span></span><span></span><span></span>
        <span></span><span></span><span></span>
        <span></span><span></span><span></span>
      </div>
      <h1 class="digit-nine" role="img" aria-label="9">
        <span class="seg seg-a"></span>
        <span class="seg seg-b"></span>
        <span class="seg seg-c"></span>
        <span class="seg seg-d"></span>
        <span class="seg seg-f"></span>
        <span class="seg seg-g"></span>
      </h1>
    </div>
    <div class="hero-right">
      <p>Share text. Quickly. Secure. Anonymous.</p>
    </div>
  </header>

  <div class="panel connect-panel" id="connectPanel">
    <div class="row-status">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">Starting…</div>
      <button id="cameraToggleBtn" class="icon-btn" title="Scan a QR code with your camera" aria-label="Scan QR code">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 1-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" stroke-linecap="round"/>
          <rect x="9" y="9" width="6" height="6" rx="1"/>
        </svg>
      </button>
    </div>

    <div class="error-msg hidden" id="connectError"></div>

    <div class="row-qr" id="qrPanel">
      <div class="qr-hover" tabindex="0">
        <canvas id="hostCanvas"></canvas>
        <div class="bubble qr-bubble">
          <strong>Your code</strong> — scan to connect. Encodes:
          <div class="bubble-url" id="qrTooltipUrl"></div>
        </div>
      </div>
    </div>

    <div class="row-qr hidden" id="numpadPanel">
      <div class="numpad">
        <button type="button" class="numpad-key" data-digit="1">1</button>
        <button type="button" class="numpad-key" data-digit="2">2</button>
        <button type="button" class="numpad-key" data-digit="3">3</button>
        <button type="button" class="numpad-key" data-digit="4">4</button>
        <button type="button" class="numpad-key" data-digit="5">5</button>
        <button type="button" class="numpad-key" data-digit="6">6</button>
        <button type="button" class="numpad-key" data-digit="7">7</button>
        <button type="button" class="numpad-key" data-digit="8">8</button>
        <button type="button" class="numpad-key" data-digit="9">9</button>
        <button type="button" class="numpad-key numpad-clear" id="numpadClear">⌫</button>
        <button type="button" class="numpad-key" data-digit="0">0</button>
        <div></div>
      </div>
    </div>

    <div class="row-qr hidden" id="cameraPanel">
      <video id="scanVideo" muted playsinline></video>
    </div>

    <div class="big-code" id="hostCodeText">------</div>

    <div class="row-join">
      <button id="numpadToggleBtn" class="icon-btn" title="Enter code with an on-screen keypad" aria-label="Toggle on-screen keypad">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="4" width="16" height="16" rx="2"/>
          <path d="M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" stroke-linecap="round"/>
        </svg>
      </button>
      <input type="text" id="codeInput" placeholder="Enter code" maxlength="6" inputmode="numeric" autocomplete="off" />
      <button id="joinCodeBtn">Connect</button>
      <span class="tooltip" id="codeTooltip" tabindex="0">?
        <span class="bubble">However you enter it — QR scan, keypad, or typing — connecting
          always briefly relays a one-time handshake through a small Cloudflare
          service so the two devices can find each other. Your shared text itself
          never passes through it and stays directly peer-to-peer.</span>
      </span>
    </div>

    <label class="row-wifi checkbox">
      <input type="checkbox" id="sameWifi" checked />
      Same Wi-Fi (no STUN/TURN)
      <span class="tooltip" id="wifiTooltip" tabindex="0">?
        <span class="bubble">Checked connects the two devices directly over the local network only —
          the quickest, most anonymous option, with no external server involved at all. Uncheck it
          if the devices aren't on the same network: a public STUN server (Google's) and TURN relay
          (Cloudflare's) then help them find each other. They only ever see connection metadata —
          never your shared text.</span>
      </span>
    </label>
  </div>

  <div class="panel text-panel">
    <textarea id="sharedText" placeholder="Type here — it'll sync as soon as you're connected..."></textarea>
    <div class="text-controls">
      <label class="checkbox">
        <input type="checkbox" id="hiddenToggle" />
        Hidden
      </label>
      <input type="file" id="fileInput" hidden />
      <button id="fileBtn" class="icon-btn" type="button" title="Send a file" aria-label="Send a file">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button id="copyBtn" class="icon-btn" type="button" title="Copy to clipboard" aria-label="Copy to clipboard">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="8" y="8" width="12" height="12" rx="2"/>
          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    <div class="file-status hidden" id="fileStatus"></div>
  </div>

  <footer class="site-footer">
    <span>Powered by <a href="https://institut-fdh.de" target="_blank" rel="noopener noreferrer">Institut für digitale Herausforderung</a></span>
    <span class="footer-sep">·</span>
    <a href="https://buymeacoffee.com/nickyreinert" target="_blank" rel="noopener noreferrer">Buy me a coffee</a>
    <span class="footer-sep">·</span>
    <a href="https://9000.1-1-1.de/" target="_blank" rel="noopener noreferrer">HTTP Mirror</a>
  </footer>
`;

const el = (id) => document.getElementById(id);

const statusDot = el('statusDot');
const statusText = el('statusText');
const sameWifiCheckbox = el('sameWifi');

const hostCanvas = el('hostCanvas');
const hostCodeText = el('hostCodeText');
const qrTooltipUrl = el('qrTooltipUrl');

const codeInput = el('codeInput');
const joinCodeBtn = el('joinCodeBtn');
const cameraToggleBtn = el('cameraToggleBtn');
const scanVideo = el('scanVideo');
const connectError = el('connectError');

const qrPanel = el('qrPanel');
const numpadPanel = el('numpadPanel');
const cameraPanel = el('cameraPanel');
const numpadToggleBtn = el('numpadToggleBtn');
const connectPanel = el('connectPanel');
const wifiTooltip = el('wifiTooltip');

const sharedText = el('sharedText');
const hiddenToggle = el('hiddenToggle');
const copyBtn = el('copyBtn');
const fileBtn = el('fileBtn');
const fileInput = el('fileInput');
const fileStatus = el('fileStatus');

const COPY_ICON = copyBtn.innerHTML;
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

wifiTooltip.addEventListener('click', (e) => e.preventDefault());

const CODE_RE = /^\d{6}$/;

const state = {
  mode: null, // 'host' | 'joiner'
  pc: null,
  channel: null,
  isRemoteUpdate: false,
  pollTimer: null,
  scanner: null,
  hostCode: null,
  pendingFile: null, // picked before a channel was open; sent as soon as one opens
  sendingFile: false,
  incomingFile: null, // { name, size, mime, chunks, received } while a receive is in progress
};

let debounceTimer = null;
let revealTimer = null;

// Fetched once per page load and reused for every connection attempt — the
// TURN service issues credentials valid for a day, far longer than a session.
let turnServersPromise = null;
function getTurnServers() {
  if (!turnServersPromise) turnServersPromise = fetchTurnServers();
  return turnServersPromise;
}

function flashReveal() {
  if (!hiddenToggle.checked) return;
  sharedText.classList.remove('masked');
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    sharedText.classList.add('masked');
  }, 900);
}

function setStatus(text, cls) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (cls ? ' ' + cls : '');
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function stopScanner() {
  if (state.scanner) {
    state.scanner.stop();
    state.scanner.destroy();
    state.scanner = null;
  }
}

function showSlot(which) {
  qrPanel.classList.toggle('hidden', which !== 'qr');
  numpadPanel.classList.toggle('hidden', which !== 'numpad');
  cameraPanel.classList.toggle('hidden', which !== 'camera');
}

function teardown() {
  stopPolling();
  stopScanner();
  showSlot('qr');
  connectPanel.classList.remove('hidden');
  if (state.channel) {
    state.channel.close();
    state.channel = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.hostCode = null;
  state.sendingFile = false;
  if (state.incomingFile) {
    state.incomingFile = null;
    fileStatus.classList.add('hidden');
  }
}

function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  state.channel = channel;
  channel.onopen = () => {
    setStatus('Connected', 'connected');
    stopPolling();
    stopScanner();
    connectPanel.classList.add('hidden');
    if (hiddenToggle.checked) sendHiddenState();
    if (sharedText.value) channel.send(JSON.stringify({ type: 'text', value: sharedText.value }));
    if (state.pendingFile) beginFileSend(state.pendingFile);
  };
  channel.onclose = () => {
    setStatus('Disconnected', '');
    connectPanel.classList.remove('hidden');
  };
  channel.onerror = () => {
    setStatus('Connection failed', 'failed');
  };
  channel.onmessage = (event) => {
    if (typeof event.data !== 'string') {
      receiveFileChunk(event.data);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'text') {
        state.isRemoteUpdate = true;
        sharedText.value = msg.value;
        state.isRemoteUpdate = false;
        flashReveal();
      } else if (msg.type === 'hidden') {
        applyHiddenState(msg.value);
      } else if (msg.type === 'file-start') {
        state.incomingFile = { name: msg.name, size: msg.size, mime: msg.mime, chunks: [], received: 0 };
        fileStatus.classList.remove('hidden');
        fileStatus.textContent = `Receiving "${msg.name}"… 0%`;
      } else if (msg.type === 'file-end') {
        finishFileReceive();
      }
    } catch {
      // ignore malformed messages
    }
  };
}

function receiveFileChunk(data) {
  const incoming = state.incomingFile;
  if (!incoming) return;
  incoming.chunks.push(data);
  incoming.received += data.byteLength;
  fileStatus.textContent = `Receiving "${incoming.name}"… ${Math.round((incoming.received / incoming.size) * 100)}%`;
}

function finishFileReceive() {
  const incoming = state.incomingFile;
  if (!incoming) return;
  const blob = new Blob(incoming.chunks, { type: incoming.mime });
  triggerDownload(blob, incoming.name);
  fileStatus.textContent = `Received "${incoming.name}".`;
  setTimeout(() => fileStatus.classList.add('hidden'), 3000);
  state.incomingFile = null;
}

async function beginFileSend(file) {
  if (state.sendingFile || !state.channel || state.channel.readyState !== 'open') return;
  state.sendingFile = true;
  fileStatus.classList.remove('hidden');
  fileStatus.textContent = `Sending "${file.name}"… 0%`;
  try {
    await sendFile(state.channel, file, (sent, total) => {
      fileStatus.textContent = `Sending "${file.name}"… ${Math.round((sent / total) * 100)}%`;
    });
    fileStatus.textContent = `Sent "${file.name}".`;
    setTimeout(() => fileStatus.classList.add('hidden'), 3000);
  } catch {
    fileStatus.textContent = `Failed to send "${file.name}".`;
  } finally {
    state.sendingFile = false;
    state.pendingFile = null;
  }
}

function applyHiddenState(value) {
  hiddenToggle.checked = value;
  clearTimeout(revealTimer);
  sharedText.classList.toggle('masked', value);
}

function sendHiddenState() {
  if (state.channel && state.channel.readyState === 'open') {
    state.channel.send(JSON.stringify({ type: 'hidden', value: hiddenToggle.checked }));
  }
}

sharedText.addEventListener('input', () => {
  if (state.isRemoteUpdate) return;
  flashReveal();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (state.channel && state.channel.readyState === 'open') {
      state.channel.send(JSON.stringify({ type: 'text', value: sharedText.value }));
    }
  }, 75);
});

hiddenToggle.addEventListener('change', () => {
  clearTimeout(revealTimer);
  sharedText.classList.toggle('masked', hiddenToggle.checked);
  sendHiddenState();
  if (state.mode === 'host' && !(state.channel && state.channel.readyState === 'open')) {
    startHost();
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(sharedText.value);
    copyBtn.innerHTML = CHECK_ICON;
    setTimeout(() => {
      copyBtn.innerHTML = COPY_ICON;
    }, 1200);
  } catch {
    // clipboard API unavailable or denied — nothing more we can do
  }
});

fileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    connectError.textContent = `That file is too big — max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`;
    connectError.classList.remove('hidden');
    return;
  }

  if (state.channel && state.channel.readyState === 'open') {
    beginFileSend(file);
  } else {
    state.pendingFile = file;
    fileStatus.classList.remove('hidden');
    fileStatus.textContent = `"${file.name}" will send as soon as you're connected…`;
  }
});

function wirePeerConnectionLifecycle(pc) {
  pc.onconnectionstatechange = () => {
    if (!state.pc || pc !== state.pc) return;
    if (pc.connectionState === 'connecting') {
      setStatus('Connecting…', 'connecting');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('Connection failed', 'failed');
      if (sameWifiCheckbox.checked) {
        connectError.textContent =
          "Couldn't connect directly — if the devices aren't on the same network, uncheck \"Same Wi-Fi\" and try again.";
        connectError.classList.remove('hidden');
      }
    } else if (pc.connectionState === 'closed') {
      setStatus('Disconnected', '');
    }
  };
}

function codeUrl(code, compressedOffer) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('code', code);
  url.searchParams.set('offer', compressedOffer);
  if (sameWifiCheckbox.checked) url.searchParams.set('wifi', '1');
  if (hiddenToggle.checked) url.searchParams.set('hidden', '1');
  return url.toString();
}

async function startHost() {
  teardown();
  state.mode = 'host';
  hostCodeText.textContent = '------';
  qrTooltipUrl.textContent = '';
  setStatus('Waiting for a peer…', 'connecting');

  const turnServers = sameWifiCheckbox.checked ? [] : await getTurnServers();
  if (state.mode !== 'host') return; // superseded while fetching TURN credentials

  const pc = createPeerConnection(sameWifiCheckbox.checked, turnServers);
  state.pc = pc;
  wirePeerConnectionLifecycle(pc);
  setupDataChannel(pc.createDataChannel('text'));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const compressedOffer = compressSdp(pc.localDescription.sdp);

  let code;
  try {
    ({ code } = await createSession(compressedOffer));
  } catch (err) {
    setStatus('Signaling server unavailable', 'failed');
    return;
  }
  if (state.mode !== 'host' || state.pc !== pc) return; // superseded

  state.hostCode = code;
  hostCodeText.textContent = code;
  const url = codeUrl(code, compressedOffer);
  qrTooltipUrl.textContent = url;
  await renderQr(hostCanvas, url);

  pollForAnswer(pc, code);
}

function pollForAnswer(pc, code) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (state.pc !== pc || state.hostCode !== code) {
      stopPolling();
      return;
    }
    try {
      const session = await fetchSession(code);
      if (session && session.answer && state.pc === pc) {
        stopPolling();
        await pc.setRemoteDescription({ type: 'answer', sdp: decompressSdp(session.answer) });
      }
    } catch {
      // transient network error, keep polling
    }
  }, 1500);
}

async function joinWithCode(code, embeddedOffer, presetOpts) {
  await stopScanner();
  connectError.classList.add('hidden');

  if (!CODE_RE.test(code)) {
    connectError.textContent = 'That code looks invalid — it should be 6 digits.';
    connectError.classList.remove('hidden');
    return;
  }

  if (presetOpts) {
    sameWifiCheckbox.checked = !!presetOpts.wifi;
    applyHiddenState(!!presetOpts.hidden);
  }

  teardown();
  state.mode = 'joiner';
  setStatus('Connecting…', 'connecting');

  try {
    let offerSdp;
    if (embeddedOffer) {
      // Offer came straight from the QR — no Cloudflare fetch needed for it.
      offerSdp = decompressSdp(embeddedOffer);
    } else {
      const session = await fetchSession(code);
      if (!session) throw new Error('Code not found or expired');
      offerSdp = decompressSdp(session.offer);
    }

    const turnServers = sameWifiCheckbox.checked ? [] : await getTurnServers();
    const pc = createPeerConnection(sameWifiCheckbox.checked, turnServers);
    state.pc = pc;
    wirePeerConnectionLifecycle(pc);
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    // The answer still relays back through Cloudflare either way — it's a
    // small, one-time blob and the host is already polling for it there.
    await submitAnswer(code, compressSdp(pc.localDescription.sdp));
  } catch (err) {
    connectError.textContent = err.message;
    connectError.classList.remove('hidden');
    startHost();
  }
}

function parseScannedPayload(raw) {
  const trimmed = raw.trim();
  if (CODE_RE.test(trimmed)) return { code: trimmed, offer: null };
  try {
    const u = new URL(trimmed);
    const code = u.searchParams.get('code');
    const offer = u.searchParams.get('offer');
    if (code && CODE_RE.test(code)) {
      return {
        code,
        offer: offer || null,
        wifi: u.searchParams.get('wifi') === '1',
        hidden: u.searchParams.get('hidden') === '1',
      };
    }
  } catch {
    // not a URL
  }
  return null;
}

cameraToggleBtn.addEventListener('click', async () => {
  const opening = cameraPanel.classList.contains('hidden');
  connectError.classList.add('hidden');
  if (opening) {
    showSlot('camera');
    try {
      const scanner = await createScanner(scanVideo, (data) => {
        const parsed = parseScannedPayload(data);
        if (parsed) joinWithCode(parsed.code, parsed.offer, { wifi: parsed.wifi, hidden: parsed.hidden });
      });
      state.scanner = scanner;
      await scanner.start();
    } catch {
      showSlot('qr');
      connectError.textContent = 'Camera unavailable — enter the code instead.';
      connectError.classList.remove('hidden');
    }
  } else {
    await stopScanner();
    showSlot('qr');
  }
});

numpadToggleBtn.addEventListener('click', async () => {
  const opening = numpadPanel.classList.contains('hidden');
  if (opening) {
    await stopScanner();
    showSlot('numpad');
  } else {
    showSlot('qr');
  }
});

numpadPanel.addEventListener('click', (e) => {
  const digitBtn = e.target.closest('.numpad-key[data-digit]');
  if (digitBtn) {
    if (codeInput.value.length < 6) codeInput.value += digitBtn.dataset.digit;
    codeInput.focus();
    return;
  }
  if (e.target.closest('#numpadClear')) {
    codeInput.value = codeInput.value.slice(0, -1);
    codeInput.focus();
  }
});

joinCodeBtn.addEventListener('click', () => joinWithCode(codeInput.value.trim()));
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinWithCode(codeInput.value.trim());
});

sameWifiCheckbox.addEventListener('change', () => {
  if (state.mode === 'host' && !(state.channel && state.channel.readyState === 'open')) {
    startHost();
  }
});

const initialParams = new URLSearchParams(location.search);
const initialCode = initialParams.get('code');
if (initialCode && CODE_RE.test(initialCode)) {
  joinWithCode(initialCode, initialParams.get('offer'), {
    wifi: initialParams.get('wifi') === '1',
    hidden: initialParams.get('hidden') === '1',
  });
} else {
  startHost();
}
