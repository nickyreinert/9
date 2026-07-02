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

  <div class="panel">
    <div class="status-row">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">Starting…</div>
    </div>
    <div class="controls-row">
      <label class="checkbox">
        <input type="checkbox" id="sameWifi" />
        Same Wi-Fi (no STUN)
      </label>
    </div>
  </div>

  <div class="panel" id="hostPanel">
    <h2>Your code</h2>
    <p class="hint">Have the other device scan this or enter the code below.</p>
    <div class="qr-wrap">
      <canvas id="hostCanvas"></canvas>
      <div class="big-code" id="hostCodeText">------</div>
    </div>
  </div>

  <div class="panel">
    <button id="connectBtn">Connect</button>
    <div class="hidden" id="connectPanel">
      <div class="qr-wrap"><video id="scanVideo" muted playsinline></video></div>
      <div class="code-row">
        <input type="text" id="codeInput" placeholder="Enter code" maxlength="6" inputmode="numeric" autocomplete="off" />
        <button id="codeGoBtn" class="secondary">Join</button>
      </div>
      <div class="error-msg hidden" id="connectError"></div>
    </div>
  </div>

  <div class="panel">
    <h2>Shared text</h2>
    <textarea id="sharedText" placeholder="Connect to start typing..." disabled></textarea>
  </div>
`;

const el = (id) => document.getElementById(id);

const statusDot = el('statusDot');
const statusText = el('statusText');
const sameWifiCheckbox = el('sameWifi');

const hostPanel = el('hostPanel');
const hostCanvas = el('hostCanvas');
const hostCodeText = el('hostCodeText');

const connectBtn = el('connectBtn');
const connectPanel = el('connectPanel');
const scanVideo = el('scanVideo');
const codeInput = el('codeInput');
const codeGoBtn = el('codeGoBtn');
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

function showPanel(elm, show) {
  elm.classList.toggle('hidden', !show);
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
  sharedText.value = '';
  sharedText.disabled = true;
}

function setupDataChannel(channel) {
  state.channel = channel;
  channel.onopen = () => {
    setStatus('Connected', 'connected');
    sharedText.disabled = false;
    stopPolling();
    stopScanner();
    showPanel(hostPanel, false);
    showPanel(connectPanel, false);
    connectBtn.classList.add('hidden');
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
  connectBtn.classList.remove('hidden');
  showPanel(hostPanel, true);
  showPanel(connectPanel, false);
  hostCodeText.textContent = '------';
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
  await renderQr(hostCanvas, codeUrl(code));

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
  showPanel(hostPanel, false);
  showPanel(connectPanel, false);
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

connectBtn.addEventListener('click', async () => {
  const opening = connectPanel.classList.contains('hidden');
  showPanel(connectPanel, opening);
  connectError.classList.add('hidden');
  if (opening) {
    try {
      const scanner = createScanner(scanVideo, (data) => {
        const code = extractCode(data);
        if (code) joinWithCode(code);
      });
      state.scanner = scanner;
      await scanner.start();
    } catch {
      // camera unavailable — manual code entry below still works
    }
  } else {
    await stopScanner();
  }
});

codeGoBtn.addEventListener('click', () => joinWithCode(codeInput.value.trim()));
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
