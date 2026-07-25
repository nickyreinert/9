import './style.css';
import { renderQr, createScanner } from './qr.js';
import { createPeerConnection, waitForIceGatheringComplete } from './webrtc.js';
import { compressSdp, decompressSdp } from './sdp.js';
import { createSession, fetchSession, submitAnswer, deleteSession, fetchTurnServers } from './signal.js';
import { sendFile, triggerDownload, MAX_FILE_SIZE } from './filetransfer.js';
import { UserError } from './errors.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const app = document.querySelector('#app');

app.innerHTML = `
  <header class="hero">
    <div class="hero-left">
      <div class="logo">
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
      <button id="collapseToggleBtn" class="icon-btn" title="Expand/collapse" aria-label="Expand or collapse connect panel">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <div class="status-detail hidden" id="statusDetail"></div>
    <div class="status-progress hidden" id="statusProgress"><div></div></div>

    <div class="error-msg hidden" id="connectError"></div>

    <div class="connect-body" id="connectBody">
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
  </div>

  <div class="panel text-panel">
    <textarea id="sharedText" maxlength="50000" placeholder="Type here — it'll sync as soon as you're connected..."></textarea>
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
    <div class="status-progress hidden" id="fileProgress"><div></div></div>
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
const statusDetail = el('statusDetail');
const statusProgress = el('statusProgress');
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
const collapseToggleBtn = el('collapseToggleBtn');
const wifiTooltip = el('wifiTooltip');

const sharedText = el('sharedText');
const hiddenToggle = el('hiddenToggle');
const copyBtn = el('copyBtn');
const fileBtn = el('fileBtn');
const fileInput = el('fileInput');
const fileStatus = el('fileStatus');
const fileProgress = el('fileProgress');

const COPY_ICON = copyBtn.innerHTML;
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

wifiTooltip.addEventListener('click', (e) => e.preventDefault());

const CODE_RE = /^\d{6}$/;
// Matches the textarea's maxlength; also bounds what we accept from the peer
// and keeps a full-text sync comfortably under the ~256KB DataChannel
// message limit (past which send() errors and can kill the channel).
const MAX_TEXT_LENGTH = 50000;

// The relay drops a handshake after 10 minutes (the worker's KV TTL), so a
// code older than that can never be answered.
const SESSION_TTL_MS = 10 * 60 * 1000;

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
  // Bumped by every teardown. Setting up a connection is a long chain of
  // awaits (TURN fetch, ICE gathering, signaling round-trips); each step
  // re-checks this so a superseded attempt — a second QR scan, a toggled
  // checkbox — bails out instead of driving a peer connection that was
  // already closed underneath it.
  generation: 0,
};

let debounceTimer = null;
let revealTimer = null;

// Fetched once and reused for every connection attempt — the TURN service
// issues credentials valid for a day, far longer than a session. An empty
// result (offline blip, or TURN simply not configured) isn't cached, so a
// transient failure doesn't lock the whole page session out of TURN.
let turnServersPromise = null;
function getTurnServers() {
  if (!turnServersPromise) {
    turnServersPromise = fetchTurnServers().then((servers) => {
      if (!servers.length) turnServersPromise = null;
      return servers;
    });
  }
  return turnServersPromise;
}

function safeSend(payload) {
  if (!state.channel || state.channel.readyState !== 'open') return false;
  try {
    state.channel.send(payload);
    return true;
  } catch {
    // channel closed between the check and the send — the onclose handler
    // takes care of the UI, nothing to do here
    return false;
  }
}

let fileStatusTimer = null;
function setFileStatus(text, autoHideMs = 0, percent = null) {
  clearTimeout(fileStatusTimer);
  if (!text) {
    fileStatus.classList.add('hidden');
    fileProgress.classList.add('hidden');
    return;
  }
  fileStatus.textContent = text;
  fileStatus.classList.remove('hidden');
  if (percent === null) {
    fileProgress.classList.add('hidden');
  } else {
    fileProgress.classList.remove('hidden');
    fileProgress.firstElementChild.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
  if (autoHideMs) {
    fileStatusTimer = setTimeout(() => {
      fileStatus.classList.add('hidden');
      fileProgress.classList.add('hidden');
    }, autoHideMs);
  }
}

function flashReveal() {
  if (!hiddenToggle.checked) return;
  sharedText.classList.remove('masked');
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    sharedText.classList.add('masked');
  }, 900);
}

function setStatus(text, cls, detail) {
  statusText.textContent = text;
  statusDot.className = 'status-dot' + (cls ? ' ' + cls : '');
  statusDetail.textContent = detail || '';
  statusDetail.classList.toggle('hidden', !detail);
  // Indeterminate while anything is in flight — there's no real percentage
  // for ICE gathering / signaling, so this just signals "still working."
  statusProgress.classList.toggle('hidden', cls !== 'connecting');
  statusProgress.classList.toggle('indeterminate', cls === 'connecting');
}

function stopPolling() {
  clearTimeout(state.pollTimer);
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
  state.generation++;
  stopPolling();
  stopScanner();
  showSlot('qr');
  connectPanel.classList.remove('collapsed');
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
    setFileStatus(null);
  }
}

// Once connected, ask WebRTC which candidate pair actually won so the
// status line can say plainly whether Cloudflare's TURN relay is carrying
// the (still end-to-end encrypted) traffic, or the link is direct.
async function describeConnectionPath(pc) {
  if (!pc) return null;
  try {
    const stats = await pc.getStats();
    let pair = null;
    for (const report of stats.values()) {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
        break;
      }
    }
    if (!pair) {
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
          pair = report;
          break;
        }
      }
    }
    if (!pair) return null;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    return relayed ? 'Relayed via Cloudflare TURN' : 'Direct connection';
  } catch {
    return null;
  }
}

function setupDataChannel(channel) {
  channel.binaryType = 'arraybuffer';
  state.channel = channel;
  // Every handler checks it still belongs to the live channel — after a
  // reconnect, the old channel's close/error events fire late and would
  // otherwise clobber the new connection's UI state.
  channel.onopen = () => {
    if (state.channel !== channel) return;
    setStatus('Connected', 'connected');
    // A hint from an earlier failed attempt ("uncheck Same Wi-Fi…") is not
    // just stale now, it's wrong — clear it.
    connectError.classList.add('hidden');
    stopPolling();
    stopScanner();
    connectPanel.classList.add('collapsed');
    if (hiddenToggle.checked) sendHiddenState();
    if (sharedText.value) safeSend(JSON.stringify({ type: 'text', value: sharedText.value }));
    if (state.pendingFile) beginFileSend(state.pendingFile);
    const pcAtOpen = state.pc;
    describeConnectionPath(pcAtOpen).then((detail) => {
      if (state.channel === channel && state.pc === pcAtOpen && detail) {
        statusDetail.textContent = detail;
        statusDetail.classList.remove('hidden');
      }
    });
  };
  channel.onclose = () => {
    if (state.channel !== channel) return;
    setStatus('Disconnected', '');
    connectPanel.classList.remove('collapsed');
    // Drop a half-received file rather than leaving its chunks (up to the
    // 25MB cap) pinned in memory waiting for a 'file-end' that can't come.
    if (state.incomingFile) {
      state.incomingFile = null;
      setFileStatus('Incoming file cancelled — the connection closed.', 5000);
    }
  };
  channel.onerror = () => {
    if (state.channel !== channel) return;
    setStatus('Connection failed', 'failed');
  };
  channel.onmessage = (event) => {
    if (state.channel !== channel) return;
    if (typeof event.data !== 'string') {
      receiveFileChunk(event.data);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'text' && typeof msg.value === 'string') {
        state.isRemoteUpdate = true;
        sharedText.value = msg.value.slice(0, MAX_TEXT_LENGTH);
        state.isRemoteUpdate = false;
        flashReveal();
      } else if (msg.type === 'hidden') {
        applyHiddenState(!!msg.value);
      } else if (msg.type === 'file-start') {
        startFileReceive(msg);
      } else if (msg.type === 'file-end') {
        finishFileReceive();
      }
    } catch {
      // ignore malformed messages
    }
  };
}

function startFileReceive(msg) {
  // The peer controls this metadata, so pin it down before trusting it:
  // a bogus size would defeat the receive cap, and the name becomes the
  // download filename.
  const size = Number(msg.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE) {
    // Silently ignoring this left the receiver staring at nothing while the
    // sender showed a progress bar climbing to 100%.
    state.incomingFile = null;
    setFileStatus('Incoming file rejected — bad or oversized metadata.', 5000);
    return;
  }
  const name = String(msg.name || 'file').replace(/[/\\]/g, '_').slice(0, 200);
  const mime = typeof msg.mime === 'string' ? msg.mime : 'application/octet-stream';
  state.incomingFile = { name, size, mime, chunks: [], received: 0 };
  setFileStatus(`Receiving "${name}"… 0%`, 0, 0);
}

function receiveFileChunk(data) {
  const incoming = state.incomingFile;
  if (!incoming) return;
  incoming.received += data.byteLength;
  if (incoming.received > incoming.size) {
    // More bytes than announced — drop the transfer rather than buffer
    // unbounded data in memory.
    state.incomingFile = null;
    setFileStatus('Incoming file aborted — it exceeded its announced size.', 5000);
    return;
  }
  incoming.chunks.push(data);
  const percent = Math.round((incoming.received / incoming.size) * 100);
  setFileStatus(`Receiving "${incoming.name}"… ${percent}%`, 0, percent);
}

function finishFileReceive() {
  const incoming = state.incomingFile;
  if (!incoming) return;
  state.incomingFile = null;
  // Short of the announced size means chunks went missing — downloading it
  // anyway would hand the user a silently truncated file that looks fine.
  if (incoming.received !== incoming.size) {
    setFileStatus(`"${incoming.name}" arrived incomplete — nothing was saved.`, 5000);
    return;
  }
  const blob = new Blob(incoming.chunks, { type: incoming.mime });
  triggerDownload(blob, incoming.name);
  setFileStatus(`Received "${incoming.name}".`, 3000);
}

async function beginFileSend(file) {
  if (state.sendingFile || !state.channel || state.channel.readyState !== 'open') return;
  state.sendingFile = true;
  setFileStatus(`Sending "${file.name}"… 0%`, 0, 0);
  try {
    await sendFile(state.channel, file, (sent, total) => {
      const percent = Math.round((sent / total) * 100);
      setFileStatus(`Sending "${file.name}"… ${percent}%`, 0, percent);
    });
    setFileStatus(`Sent "${file.name}".`, 3000);
  } catch {
    setFileStatus(`Failed to send "${file.name}".`, 5000);
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
  safeSend(JSON.stringify({ type: 'hidden', value: hiddenToggle.checked }));
}

sharedText.addEventListener('input', () => {
  if (state.isRemoteUpdate) return;
  flashReveal();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    safeSend(JSON.stringify({ type: 'text', value: sharedText.value }));
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

  // fileStatus, not connectError — the connect panel (and any error inside
  // it) is hidden once paired, exactly when this error is most likely.
  if (file.size > MAX_FILE_SIZE) {
    setFileStatus(`That file is too big — max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB.`, 5000);
    return;
  }
  if (state.sendingFile) {
    setFileStatus('Still sending the previous file — try again once it finishes.', 5000);
    return;
  }

  if (state.channel && state.channel.readyState === 'open') {
    beginFileSend(file);
  } else {
    state.pendingFile = file;
    setFileStatus(`"${file.name}" will send as soon as you're connected…`);
  }
});

function wirePeerConnectionLifecycle(pc) {
  let everConnected = false;
  pc.onconnectionstatechange = () => {
    if (!state.pc || pc !== state.pc) return;
    if (pc.connectionState === 'connecting') {
      setStatus(
        'Connecting…',
        'connecting',
        sameWifiCheckbox.checked
          ? 'Trying local network only'
          : 'Trying local network, Google STUN, Cloudflare TURN'
      );
    } else if (pc.connectionState === 'connected') {
      everConnected = true;
    } else if (pc.connectionState === 'disconnected') {
      // Not terminal: ICE recovers from this on its own after a brief
      // network blip, so don't declare failure — that's what 'failed' is
      // for. If the channel is already gone the peer left deliberately and
      // its 'Disconnected' status should stand.
      if (state.channel && state.channel.readyState === 'open') {
        setStatus('Reconnecting…', 'connecting', 'Connection interrupted');
      }
    } else if (pc.connectionState === 'failed') {
      setStatus('Connection failed', 'failed');
      // Only sound advice for a link that never came up. After a working
      // connection drops, "uncheck Same Wi-Fi" is simply wrong.
      if (sameWifiCheckbox.checked && !everConnected) {
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
  const gen = state.generation;
  const superseded = () => gen !== state.generation;

  state.mode = 'host';
  hostCodeText.textContent = '------';
  qrTooltipUrl.textContent = '';
  setStatus('Preparing…', 'connecting', 'Gathering connection candidates');

  try {
    const turnServers = sameWifiCheckbox.checked ? [] : await getTurnServers();
    if (superseded()) return;

    const pc = createPeerConnection(sameWifiCheckbox.checked, turnServers);
    state.pc = pc;
    wirePeerConnectionLifecycle(pc);
    setupDataChannel(pc.createDataChannel('text'));

    const offer = await pc.createOffer();
    if (superseded()) return;
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    if (superseded()) return;

    setStatus('Registering…', 'connecting', 'Handshake via Cloudflare');
    const compressedOffer = compressSdp(pc.localDescription.sdp);

    let code;
    try {
      ({ code } = await createSession(compressedOffer));
    } catch {
      if (superseded()) return;
      setStatus('Signaling server unavailable', 'failed');
      return;
    }
    if (superseded()) return;

    setStatus('Waiting for a peer…', 'connecting', 'Polling Cloudflare relay');

    state.hostCode = code;
    hostCodeText.textContent = code;
    const url = codeUrl(code, compressedOffer);
    qrTooltipUrl.textContent = url;
    try {
      await renderQr(hostCanvas, url);
    } catch {
      // offer too dense for a QR (can happen with many ICE candidates) —
      // the 6-digit code path still works, so don't fail the whole host setup
    }
    if (superseded()) return;

    pollForAnswer(pc, code);
  } catch {
    // A superseded attempt drives an already-closed peer connection and
    // throws — that's expected, and the newer attempt owns the UI now.
    if (superseded()) return;
    setStatus('Could not start a session', 'failed');
  }
}

function pollForAnswer(pc, code) {
  stopPolling();
  // The relay forgets the handshake once its TTL lapses, so past this point
  // the code on screen is dead and polling it is pure noise.
  const deadline = Date.now() + SESSION_TTL_MS;
  const stale = () => state.pc !== pc || state.hostCode !== code;

  // setTimeout chain rather than setInterval, so a slow fetch can't overlap
  // the next tick and double-apply the answer.
  const poll = async () => {
    if (stale()) return;

    let session = null;
    try {
      session = await fetchSession(code);
    } catch {
      // transient network error — retry until the deadline
    }
    if (stale()) return;

    if (session && session.answer) {
      // The answer is single-use either way: consume it and drop it from
      // the relay before applying it, so a malformed one can't be re-fetched
      // and re-applied on every tick from here to the deadline.
      stopPolling();
      deleteSession(code);
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: decompressSdp(session.answer) });
      } catch {
        if (state.pc !== pc) return;
        setStatus('Peer sent invalid connection data', 'failed');
        startHost();
      }
      return;
    }

    if (Date.now() >= deadline) {
      // Replace the expired code with a fresh one instead of leaving a QR
      // on screen that no longer resolves to anything.
      startHost();
      return;
    }
    state.pollTimer = setTimeout(poll, 1500);
  };
  state.pollTimer = setTimeout(poll, 1500);
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
  const gen = state.generation;
  const superseded = () => gen !== state.generation;
  state.mode = 'joiner';

  try {
    let offerSdp;
    if (embeddedOffer) {
      // Offer came straight from the QR — no Cloudflare fetch needed for it.
      setStatus('Preparing…', 'connecting', 'Reading offer from link');
      offerSdp = decompressSdp(embeddedOffer);
    } else {
      setStatus('Preparing…', 'connecting', 'Fetching handshake via Cloudflare');
      const session = await fetchSession(code);
      if (superseded()) return;
      if (!session) throw new UserError('That code was not found — it may have expired.');
      offerSdp = decompressSdp(session.offer);
    }

    const turnServers = sameWifiCheckbox.checked ? [] : await getTurnServers();
    if (superseded()) return;

    const pc = createPeerConnection(sameWifiCheckbox.checked, turnServers);
    state.pc = pc;
    wirePeerConnectionLifecycle(pc);
    pc.ondatachannel = (event) => setupDataChannel(event.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    if (superseded()) return;
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);
    if (superseded()) return;

    // The answer still relays back through Cloudflare either way — it's a
    // small, one-time blob and the host is already polling for it there.
    setStatus('Registering…', 'connecting', 'Sending handshake via Cloudflare');
    await submitAnswer(code, compressSdp(pc.localDescription.sdp));
  } catch (err) {
    // A second scan/click tore this attempt down mid-flight; the newer one
    // owns the UI, so stay out of its way.
    if (superseded()) return;
    // Raw DOMExceptions from WebRTC mean nothing to the person reading this.
    connectError.textContent =
      err instanceof UserError ? err.message : "Couldn't connect — please try again with a fresh code.";
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

// Guards against a double-tap racing two getUserMedia calls — the first
// stream would be orphaned with its tracks still live (camera stays on).
let cameraBusy = false;
cameraToggleBtn.addEventListener('click', async () => {
  if (cameraBusy) return;
  cameraBusy = true;
  try {
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
        // The scanner may already own a live camera stream — starting it is
        // what failed, not acquiring it — so release it before giving up,
        // otherwise the camera stays on with no handle left to stop it.
        await stopScanner();
        showSlot('qr');
        connectError.textContent = 'Camera unavailable — enter the code instead.';
        connectError.classList.remove('hidden');
      }
    } else {
      await stopScanner();
      showSlot('qr');
    }
  } finally {
    cameraBusy = false;
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

collapseToggleBtn.addEventListener('click', () => {
  const collapsed = connectPanel.classList.toggle('collapsed');
  // Expanding while already connected means "pair a different device" —
  // the panel's old QR/code are for a session that's already paired and
  // stale, so there's nothing else useful to show; start a fresh one.
  if (!collapsed && state.channel && state.channel.readyState === 'open') {
    startHost();
  }
});

const initialParams = new URLSearchParams(location.search);
const initialCode = initialParams.get('code');
const initialJoin = initialCode && CODE_RE.test(initialCode)
  ? {
      code: initialCode,
      offer: initialParams.get('offer'),
      wifi: initialParams.get('wifi') === '1',
      hidden: initialParams.get('hidden') === '1',
    }
  : null;

// A join link is one-time — the code and embedded offer are only valid for
// a single handshake. Strip them immediately so reloading this tab (after
// pairing, or after a failed attempt) can't retry a dead connection; it
// just starts fresh, same as opening the page any other time.
if (location.search) history.replaceState(null, '', location.pathname);

if (initialJoin) {
  joinWithCode(initialJoin.code, initialJoin.offer, { wifi: initialJoin.wifi, hidden: initialJoin.hidden });
} else {
  startHost();
}
