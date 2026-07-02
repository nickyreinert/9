import './style.css';
import { renderQr, createScanner } from './qr.js';
import { createPeerConnection, waitForIceGatheringComplete } from './webrtc.js';
import { compressSdp, decompressSdp } from './sdp.js';

const app = document.querySelector('#app');

app.innerHTML = `
  <header>
    <h1>QR P2P Text Share</h1>
    <p>Pair two browsers by scanning QR codes, then type — no server, no accounts.</p>
  </header>

  <div class="panel">
    <div class="status-row">
      <div class="status-dot" id="statusDot"></div>
      <div class="status-text" id="statusText">Disconnected</div>
    </div>
    <div class="controls-row">
      <label class="checkbox">
        <input type="checkbox" id="sameWifi" />
        Same Wi-Fi (no STUN)
      </label>
      <button id="hostBtn">Start as Host</button>
      <button id="joinBtn" class="secondary">Join Session</button>
      <button id="resetBtn" class="secondary hidden">Reset</button>
    </div>
  </div>

  <div class="panel hidden" id="offerPanel">
    <h2>1. Share this QR (Offer)</h2>
    <p class="hint">Have the other device scan this code.</p>
    <div class="qr-wrap">
      <canvas id="offerCanvas"></canvas>
      <div class="code-box"><textarea id="offerCode" readonly></textarea></div>
      <button id="copyOfferBtn" class="secondary">Copy code</button>
    </div>
  </div>

  <div class="panel hidden" id="scanOfferPanel">
    <h2>Scan the Host's QR (Offer)</h2>
    <p class="hint">Point your camera at the offer QR code, or paste the code below.</p>
    <div class="qr-wrap"><video id="scanOfferVideo" muted playsinline></video></div>
    <div class="paste-row">
      <textarea id="pasteOffer" placeholder="Paste offer code here"></textarea>
      <button id="applyOfferBtn" class="secondary">Use pasted code</button>
    </div>
    <div class="error-msg hidden" id="offerError"></div>
  </div>

  <div class="panel hidden" id="answerPanel">
    <h2>2. Share this QR (Answer)</h2>
    <p class="hint">Have the host scan this code to finish pairing.</p>
    <div class="qr-wrap">
      <canvas id="answerCanvas"></canvas>
      <div class="code-box"><textarea id="answerCode" readonly></textarea></div>
      <button id="copyAnswerBtn" class="secondary">Copy code</button>
    </div>
  </div>

  <div class="panel hidden" id="scanAnswerPanel">
    <h2>3. Scan the Joiner's QR (Answer)</h2>
    <p class="hint">Point your camera at the answer QR code, or paste the code below.</p>
    <div class="qr-wrap"><video id="scanAnswerVideo" muted playsinline></video></div>
    <div class="paste-row">
      <textarea id="pasteAnswer" placeholder="Paste answer code here"></textarea>
      <button id="applyAnswerBtn" class="secondary">Use pasted code</button>
    </div>
    <div class="error-msg hidden" id="answerError"></div>
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
const hostBtn = el('hostBtn');
const joinBtn = el('joinBtn');
const resetBtn = el('resetBtn');

const offerPanel = el('offerPanel');
const offerCanvas = el('offerCanvas');
const offerCode = el('offerCode');
const copyOfferBtn = el('copyOfferBtn');

const scanOfferPanel = el('scanOfferPanel');
const scanOfferVideo = el('scanOfferVideo');
const pasteOffer = el('pasteOffer');
const applyOfferBtn = el('applyOfferBtn');
const offerError = el('offerError');

const answerPanel = el('answerPanel');
const answerCanvas = el('answerCanvas');
const answerCode = el('answerCode');
const copyAnswerBtn = el('copyAnswerBtn');

const scanAnswerPanel = el('scanAnswerPanel');
const scanAnswerVideo = el('scanAnswerVideo');
const pasteAnswer = el('pasteAnswer');
const applyAnswerBtn = el('applyAnswerBtn');
const answerError = el('answerError');

const sharedText = el('sharedText');

const state = {
  role: null, // 'host' | 'joiner'
  pc: null,
  channel: null,
  connected: false,
  isRemoteUpdate: false,
  offerScanner: null,
  answerScanner: null,
};

let debounceTimer = null;

function setStatus(text, cls) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (cls ? ' ' + cls : '');
}

function showPanel(elm, show) {
  elm.classList.toggle('hidden', !show);
}

function resetPanels() {
  showPanel(offerPanel, false);
  showPanel(scanOfferPanel, false);
  showPanel(answerPanel, false);
  showPanel(scanAnswerPanel, false);
  offerError.classList.add('hidden');
  answerError.classList.add('hidden');
}

async function stopScanner(which) {
  const key = which === 'offer' ? 'offerScanner' : 'answerScanner';
  if (state[key]) {
    state[key].stop();
    state[key].destroy();
    state[key] = null;
  }
}

function teardownConnection() {
  stopScanner('offer');
  stopScanner('answer');
  if (state.channel) {
    state.channel.close();
    state.channel = null;
  }
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  state.connected = false;
  sharedText.value = '';
  sharedText.disabled = true;
}

function resetAll() {
  teardownConnection();
  state.role = null;
  resetPanels();
  setStatus('Disconnected', '');
  hostBtn.classList.remove('hidden');
  joinBtn.classList.remove('hidden');
  resetBtn.classList.add('hidden');
  sameWifiCheckbox.disabled = false;
}

function setupDataChannel(channel) {
  state.channel = channel;
  channel.onopen = () => {
    state.connected = true;
    setStatus('Connected', 'connected');
    sharedText.disabled = false;
    stopScanner('offer');
    stopScanner('answer');
  };
  channel.onclose = () => {
    state.connected = false;
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
    if (!state.pc) return;
    if (pc.connectionState === 'connecting') {
      setStatus('Connecting…', 'connecting');
    } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setStatus('Connection failed', 'failed');
    } else if (pc.connectionState === 'closed') {
      setStatus('Disconnected', '');
    }
  };
}

async function startHost() {
  resetPanels();
  state.role = 'host';
  hostBtn.classList.add('hidden');
  joinBtn.classList.add('hidden');
  resetBtn.classList.remove('hidden');
  sameWifiCheckbox.disabled = true;
  setStatus('Connecting…', 'connecting');

  const pc = createPeerConnection(sameWifiCheckbox.checked);
  state.pc = pc;
  wirePeerConnectionLifecycle(pc);
  setupDataChannel(pc.createDataChannel('text'));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGatheringComplete(pc);

  const payload = JSON.stringify({ t: 'offer', sdp: compressSdp(pc.localDescription.sdp) });
  offerCode.value = payload;
  await renderQr(offerCanvas, payload);
  showPanel(offerPanel, true);
  showPanel(scanAnswerPanel, true);

  await startScanning('answer', scanAnswerVideo, handleAnswerPayload, answerError);
}

async function startJoin() {
  resetPanels();
  state.role = 'joiner';
  hostBtn.classList.add('hidden');
  joinBtn.classList.add('hidden');
  resetBtn.classList.remove('hidden');
  sameWifiCheckbox.disabled = true;
  setStatus('Disconnected', '');

  showPanel(scanOfferPanel, true);
  await startScanning('offer', scanOfferVideo, handleOfferPayload, offerError);
}

async function startScanning(which, videoEl, onPayload, errorEl) {
  const key = which === 'offer' ? 'offerScanner' : 'answerScanner';
  errorEl.classList.add('hidden');
  try {
    const scanner = createScanner(videoEl, (data) => {
      onPayload(data, errorEl);
    });
    state[key] = scanner;
    await scanner.start();
  } catch (err) {
    errorEl.textContent = 'Camera unavailable — paste the code below instead.';
    errorEl.classList.remove('hidden');
  }
}

async function handleOfferPayload(raw, errorEl) {
  try {
    const payload = JSON.parse(raw);
    if (payload.t !== 'offer') throw new Error('not an offer');
    const sdp = decompressSdp(payload.sdp);

    await stopScanner('offer');
    showPanel(scanOfferPanel, false);
    setStatus('Connecting…', 'connecting');

    const pc = createPeerConnection(sameWifiCheckbox.checked);
    state.pc = pc;
    wirePeerConnectionLifecycle(pc);
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    const outPayload = JSON.stringify({ t: 'answer', sdp: compressSdp(pc.localDescription.sdp) });
    answerCode.value = outPayload;
    await renderQr(answerCanvas, outPayload);
    showPanel(answerPanel, true);
  } catch (err) {
    errorEl.textContent = 'Could not read that code: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

async function handleAnswerPayload(raw, errorEl) {
  try {
    const payload = JSON.parse(raw);
    if (payload.t !== 'answer') throw new Error('not an answer');
    const sdp = decompressSdp(payload.sdp);

    await stopScanner('answer');
    showPanel(scanAnswerPanel, false);

    await state.pc.setRemoteDescription({ type: 'answer', sdp });
  } catch (err) {
    errorEl.textContent = 'Could not read that code: ' + err.message;
    errorEl.classList.remove('hidden');
  }
}

hostBtn.addEventListener('click', () => startHost());
joinBtn.addEventListener('click', () => startJoin());
resetBtn.addEventListener('click', () => resetAll());

applyOfferBtn.addEventListener('click', () => {
  const raw = pasteOffer.value.trim();
  if (raw) handleOfferPayload(raw, offerError);
});
applyAnswerBtn.addEventListener('click', () => {
  const raw = pasteAnswer.value.trim();
  if (raw) handleAnswerPayload(raw, answerError);
});

copyOfferBtn.addEventListener('click', () => navigator.clipboard.writeText(offerCode.value));
copyAnswerBtn.addEventListener('click', () => navigator.clipboard.writeText(answerCode.value));
