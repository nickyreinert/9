import './style.css';
import { renderQr, createScanner } from './qr.js';
import { createPeerConnection, waitForIceGatheringComplete } from './webrtc.js';
import { compressSdp, decompressSdp } from './sdp.js';
import { createSession, fetchSession, submitAnswer } from './signal.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <header>
    <h1>QR P2P Text Share</h1>
    <p>Open on two devices. One shows a code, the other clicks Connect — no server sees your text.</p>
  </header>

  <div class="panel connect-panel">
    <div class="status-row">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">Starting…</div>
    </div>

    <div class="connect-row">
      <div class="qr-hover" tabindex="0">
        <canvas id="hostCanvas"></canvas>
        <div class="bubble qr-bubble">
          <strong>Your code</strong> — scan to connect. Encodes:
          <div class="bubble-url" id="qrTooltipUrl"></div>
        </div>
      </div>

      <div class="big-code" id="hostCodeText">------</div>

      <div class="join-controls">
        <input type="text" id="codeInput" placeholder="Enter code" maxlength="6" inputmode="numeric" autocomplete="off" />
        <button id="joinCodeBtn">Connect</button>
        <button id="cameraToggleBtn" class="icon-btn" title="Scan a QR code with your camera" aria-label="Scan QR code">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 8V6a2 2 0 0 1 2-2h2M20 8V6a2 2 0 0 1-2-2h-2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2" stroke-linecap="round"/>
            <rect x="9" y="9" width="6" height="6" rx="1"/>
          </svg>
        </button>
      </div>
    </div>

    <video id="scanVideo" class="hidden" muted playsinline></video>
    <div class="error-msg hidden" id="connectError"></div>

    <label class="checkbox">
      <input type="checkbox" id="sameWifi" />
      Same Wi-Fi (no STUN)
      <span class="tooltip" tabindex="0">?
        <span class="bubble">When unchecked, a public STUN server (Google's) helps the two devices
          find each other across different networks. It only ever sees connection
          metadata — never your shared text.</span>
      </span>
    </label>
  </div>

  <div class="panel">
    <textarea id="sharedText" placeholder="Connect to start typing..." disabled></textarea>
  </div>
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

const sharedText = el('sharedText');

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

function setStatus(text, cls) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (cls ? ' ' + cls : '');
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function stopScanner() {
  scanVideo.classList.add('hidden');
  if (state.scanner) {
    state.scanner.stop();
    state.scanner.destroy();
    state.scanner = null;
  }
}

function teardown() {
  stopPolling();
  stopScanner();
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
      }
    } catch {
      // ignore malformed messages
    }
  };
}

sharedText.addEventListener('input', () => {
  if (state.isRemoteUpdate) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (state.channel && state.channel.readyState === 'open') {
      state.channel.send(JSON.stringify({ type: 'text', value: sharedText.value }));
    }
  }, 75);
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
  const opening = scanVideo.classList.contains('hidden');
  connectError.classList.add('hidden');
  if (opening) {
    scanVideo.classList.remove('hidden');
    try {
      const scanner = createScanner(scanVideo, (data) => {
        const code = extractCode(data);
        if (code) joinWithCode(code);
      });
      state.scanner = scanner;
      await scanner.start();
    } catch {
      scanVideo.classList.add('hidden');
      connectError.textContent = 'Camera unavailable — enter the code instead.';
      connectError.classList.remove('hidden');
    }
  } else {
    await stopScanner();
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
