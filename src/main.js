import './style.css';
import { renderQr, createScanner } from './qr.js';
import { createPeerConnection, waitForIceGatheringComplete } from './webrtc.js';
import { compressSdp, decompressSdp } from './sdp.js';
import { createSession, fetchSession, submitAnswer } from './signal.js';

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

  <div class="panel row-status">
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

  <div class="panel row-qr" id="qrPanel">
    <div class="qr-hover" tabindex="0">
      <canvas id="hostCanvas"></canvas>
      <div class="bubble qr-bubble">
        <strong>Your code</strong> — scan to connect. Encodes:
        <div class="bubble-url" id="qrTooltipUrl"></div>
      </div>
    </div>
  </div>

  <div class="panel row-qr hidden" id="numpadPanel">
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

  <div class="panel row-qr hidden" id="cameraPanel">
    <video id="scanVideo" muted playsinline></video>
  </div>

  <div class="big-code" id="hostCodeText">------</div>

  <div class="panel row-join">
    <button id="numpadToggleBtn" class="icon-btn" title="Enter code with an on-screen keypad" aria-label="Toggle on-screen keypad">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <path d="M8 9h.01M12 9h.01M16 9h.01M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01" stroke-linecap="round"/>
      </svg>
    </button>
    <input type="text" id="codeInput" placeholder="Enter code" maxlength="6" inputmode="numeric" autocomplete="off" />
    <button id="joinCodeBtn">Connect</button>
  </div>

  <label class="panel row-wifi checkbox">
    <input type="checkbox" id="sameWifi" />
    Same Wi-Fi (no STUN)
    <span class="tooltip" tabindex="0">?
      <span class="bubble">When unchecked, a public STUN server (Google's) helps the two devices
        find each other across different networks. It only ever sees connection
        metadata — never your shared text.</span>
    </span>
  </label>

  <div class="panel">
    <textarea id="sharedText" placeholder="Connect to start typing..." disabled></textarea>
    <div class="text-controls">
      <label class="checkbox">
        <input type="checkbox" id="hiddenToggle" />
        Hidden
      </label>
      <button id="copyBtn" class="secondary btn-small" type="button">Copy</button>
    </div>
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

const sharedText = el('sharedText');
const hiddenToggle = el('hiddenToggle');
const copyBtn = el('copyBtn');

const CODE_RE = /^\d{6}$/;

const state = {
  mode: null, // 'host' | 'joiner'
  pc: null,
  channel: null,
  isRemoteUpdate: false,
  pollTimer: null,
  scanner: null,
  hostCode: null,
};

let debounceTimer = null;
let revealTimer = null;

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
  if (state.channel) {
    state.channel.close();
    state.channel = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.hostCode = null;
  sharedText.disabled = true;
}

function setupDataChannel(channel) {
  state.channel = channel;
  channel.onopen = () => {
    setStatus('Connected', 'connected');
    sharedText.disabled = false;
    stopPolling();
    stopScanner();
  };
  channel.onclose = () => {
    setStatus('Disconnected', '');
    sharedText.disabled = true;
  };
  channel.onerror = () => {
    setStatus('Connection failed', 'failed');
  };
  channel.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'text') {
        state.isRemoteUpdate = true;
        sharedText.value = msg.value;
        state.isRemoteUpdate = false;
        flashReveal();
      }
    } catch {
      // ignore malformed messages
    }
  };
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
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(sharedText.value);
    const original = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => {
      copyBtn.textContent = original;
    }, 1200);
  } catch {
    // clipboard API unavailable or denied — nothing more we can do
  }
});

function wirePeerConnectionLifecycle(pc) {
  pc.onconnectionstatechange = () => {
    if (!state.pc || pc !== state.pc) return;
    if (pc.connectionState === 'connecting') {
      setStatus('Connecting…', 'connecting');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('Connection failed', 'failed');
    } else if (pc.connectionState === 'closed') {
      setStatus('Disconnected', '');
    }
  };
}

function codeUrl(code) {
  return `${location.origin}${location.pathname}?code=${code}`;
}

async function startHost() {
  teardown();
  state.mode = 'host';
  hostCodeText.textContent = '------';
  qrTooltipUrl.textContent = '';
  setStatus('Waiting for a peer…', 'connecting');

  const pc = createPeerConnection(sameWifiCheckbox.checked);
  state.pc = pc;
  wirePeerConnectionLifecycle(pc);
  setupDataChannel(pc.createDataChannel('text'));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  let code;
  try {
    ({ code } = await createSession(compressSdp(pc.localDescription.sdp)));
  } catch (err) {
    setStatus('Signaling server unavailable', 'failed');
    return;
  }
  if (state.mode !== 'host' || state.pc !== pc) return; // superseded

  state.hostCode = code;
  hostCodeText.textContent = code;
  const url = codeUrl(code);
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

async function joinWithCode(code) {
  await stopScanner();
  connectError.classList.add('hidden');

  if (!CODE_RE.test(code)) {
    connectError.textContent = 'That code looks invalid — it should be 6 digits.';
    connectError.classList.remove('hidden');
    return;
  }

  teardown();
  state.mode = 'joiner';
  setStatus('Connecting…', 'connecting');

  try {
    const session = await fetchSession(code);
    if (!session) throw new Error('Code not found or expired');

    const pc = createPeerConnection(sameWifiCheckbox.checked);
    state.pc = pc;
    wirePeerConnectionLifecycle(pc);
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: decompressSdp(session.offer) });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    await submitAnswer(code, compressSdp(pc.localDescription.sdp));
  } catch (err) {
    connectError.textContent = err.message;
    connectError.classList.remove('hidden');
    startHost();
  }
}

function extractCode(raw) {
  const trimmed = raw.trim();
  if (CODE_RE.test(trimmed)) return trimmed;
  try {
    const u = new URL(trimmed);
    const c = u.searchParams.get('code');
    if (c && CODE_RE.test(c)) return c;
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
      const scanner = createScanner(scanVideo, (data) => {
        const code = extractCode(data);
        if (code) joinWithCode(code);
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

const initialCode = new URLSearchParams(location.search).get('code');
if (initialCode && CODE_RE.test(initialCode)) {
  joinWithCode(initialCode);
} else {
  startHost();
}
