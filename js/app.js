import { i18n, LANG_META, SUPPORTED_LANGS, detectLang, saveLang } from './i18n.js';

let initCrypto = null;
let pack_key = null;
let unpack_key = null;
let cryptoLoadPromise = null;

// Ленивая загрузка сторонних <script> по требованию (не блокируют первую отрисовку страницы)
const scriptLoadPromises = {};
function loadScript(src) {
    if (scriptLoadPromises[src]) return scriptLoadPromises[src];
    scriptLoadPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
        document.head.appendChild(s);
    });
    return scriptLoadPromises[src];
}

function ensureQRCodeLib() {
    return loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js');
}

function ensureJsQRLib() {
    return loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js');
}
// Прогреваем библиотеку заранее в фоне, не дожидаясь клика по кнопке сканирования —
// на iOS Safari/Chrome (WebKit) getUserMedia теряет привязку к жесту пользователя,
// если между кликом и вызовом проходит слишком много времени (например, на загрузку скрипта).
ensureJsQRLib().catch(() => {});

let currentLang = 'en';
let currentMode = 'send';
let selectedFile = null;
let senderPC = null;
let receiverPC = null;

let scanStream = null;
let scanRafId = null;
let scanTargetId = null;
let scannedChunks = {};
let totalExpectedChunks = 0;

let recvBuffers = [];
let recvTotal = 0;
let writableStream = null;
let writeQueue = Promise.resolve();
let sendAckResolver = null;
let sendAckCleanup = null;

let qrCyclerInterval = null;
let scanDetector = null;

// --- Pause / cancel / stall-watch / keep-tab-open state ---
let sendTransferChannel = null;
let sendPaused = false;
let sendPauseWaiters = [];
let sendCancelled = false;
let sendTransferActive = false;
let sendLastProgressTs = 0;
let sendStallInterval = null;

let recvChannel = null;
let recvPaused = false;
let recvCancelled = false;
let recvTransferActive = false;
let recvLastProgressTs = 0;
let recvStallInterval = null;

const STALL_TIMEOUT_MS = 20000; // no progress for this long -> show a warning

const FILE_CHUNK_SIZE = 64 * 1024;
const SEND_BUFFER_LOW_THRESHOLD = 1024 * 1024;
const SEND_BUFFER_HIGH_WATERMARK = 2 * 1024 * 1024;

const IDB_NAME = 'p2p_transfer';
const IDB_STORE = 'resume';
const RESUME_SAVE_INTERVAL = 64; // save progress every N chunks

// Shared ICE config — same on PC and mobile so offer/answer keys stay compatible
// and NAT traversal works in both directions (phone→PC and PC→phone).
const ICE_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    iceCandidatePoolSize: 4,
};

/**
 * Normalize a pasted/scanned connection key so PC ↔ mobile exchange works even when
 * messengers insert line breaks, zero-width chars, or turn `+` into spaces.
 * Must stay in sync with normalize_b64() in src/lib.rs.
 */
function normalizeConnectionKey(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
    const urlSafe = s.includes('-') || s.includes('_');
    if (urlSafe) {
        // Current format: only A-Za-z0-9_- — drop every whitespace
        return s.replace(/\s+/g, '').trim();
    }
    // Legacy standard base64: newlines/tabs drop, plain spaces often mean corrupted `+`
    return s
        .replace(/[ \t]/g, '+')
        .replace(/[\r\n\f\v]+/g, '')
        .trim();
}

/**
 * Drop useless ICE candidates that bloat desktop keys (virtual NICs, link-local)
 * while keeping host + srflx needed for same-WiFi and internet paths.
 * Result: PC keys are similar in size/shape to mobile keys.
 */
function compactSdp(sdp) {
    if (!sdp || typeof sdp !== 'string') return sdp;
    const lines = sdp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out = [];
    const candidates = [];
    let endOfCandidatesIdx = -1;

    for (const line of lines) {
        if (line.startsWith('a=candidate:')) {
            candidates.push(line);
        } else if (line === 'a=end-of-candidates') {
            // Remember position; insert filtered candidates before this marker
            endOfCandidatesIdx = out.length;
            out.push(line);
        } else {
            out.push(line);
        }
    }

    const picked = selectBestCandidates(candidates);
    if (endOfCandidatesIdx >= 0) {
        out.splice(endOfCandidatesIdx, 0, ...picked);
    } else {
        // No end-of-candidates marker — append before trailing empty lines
        let insertAt = out.length;
        while (insertAt > 0 && out[insertAt - 1] === '') insertAt--;
        out.splice(insertAt, 0, ...picked);
    }
    return out.join('\r\n');
}

function selectBestCandidates(candidates) {
    if (!candidates.length) return [];

    const scored = [];
    for (const line of candidates) {
        // a=candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type> ...
        const parts = line.split(/\s+/);
        if (parts.length < 8) continue;
        const protocol = (parts[2] || '').toLowerCase();
        const ip = parts[4] || '';
        const typIdx = parts.indexOf('typ');
        const typ = typIdx >= 0 ? (parts[typIdx + 1] || '') : '';

        // Skip clearly useless addresses that only appear on desktops (VPN/Docker/APIPA)
        if (/^169\.254\./.test(ip)) continue;           // link-local
        if (/^0\.0\.0\.0$/.test(ip)) continue;
        if (/^127\./.test(ip)) continue;                // loopback
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
            // private docker/vm range — keep only a couple later via limits
        }

        let score = 0;
        if (typ === 'host') score += 100;
        else if (typ === 'srflx') score += 90;
        else if (typ === 'prflx') score += 70;
        else if (typ === 'relay') score += 60;
        else score += 40;

        if (protocol === 'udp') score += 15;
        else if (protocol === 'tcp') score += 5;

        // Prefer IPv4 for smaller keys / broader mobile support
        if (ip.includes(':')) score -= 8;

        // Slightly deprioritize typical virtual-bridge ranges
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) score -= 20;
        if (/^192\.168\.56\./.test(ip)) score -= 25; // VirtualBox host-only
        if (/^10\.0\.2\./.test(ip)) score -= 20;      // common VM NAT

        scored.push({ line, score, typ, protocol, ip });
    }

    scored.sort((a, b) => b.score - a.score);

    // Cap per type so desktop multi-NIC machines don't produce huge multi-QR keys
    const limits = { host: 3, srflx: 4, prflx: 2, relay: 2, other: 2 };
    const counts = {};
    const picked = [];
    const seen = new Set();

    for (const c of scored) {
        const key = `${c.typ}|${c.protocol}|${c.ip}`;
        if (seen.has(key)) continue;
        const bucket = limits[c.typ] != null ? c.typ : 'other';
        if ((counts[bucket] || 0) >= (limits[bucket] || 2)) continue;
        seen.add(key);
        counts[bucket] = (counts[bucket] || 0) + 1;
        picked.push(c.line);
    }
    return picked;
}

/** Build a compact, cross-device connection payload from RTCSessionDescription. */
function sessionToKeyPayload(desc) {
    const sdp = compactSdp(desc.sdp);
    return JSON.stringify({ sdp, type: desc.type });
}

/**
 * Decode a connection key (offer or answer) into an RTCSessionDescription-like object.
 * Tolerates whitespace, legacy standard-base64, and raw JSON (very old fallback).
 */
async function decodeConnectionKey(rawKey) {
    const raw = normalizeConnectionKey(rawKey);
    if (!raw) throw new Error('empty');

    // Try encrypted packed key first (current + legacy formats)
    if (unpack_key) {
        try {
            const unpacked = unpack_key(raw);
            return JSON.parse(unpacked);
        } catch {
            // fall through
        }
    }

    // Raw JSON SDP (fallback / debug)
    try {
        return JSON.parse(rawKey.trim());
    } catch {
        // try normalized as JSON too
        return JSON.parse(raw);
    }
}

/** Wait for ICE gathering with a generous timeout — mobile often needs longer than PC. */
function waitForIceGathering(pc, timeoutMs = 8000) {
    return new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            pc.removeEventListener('icegatheringstatechange', onChange);
            resolve();
        };
        const onChange = () => {
            if (pc.iceGatheringState === 'complete') finish();
        };
        pc.addEventListener('icegatheringstatechange', onChange);
        setTimeout(finish, timeoutMs);
    });
}

function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

async function idbDelete(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

// SHA-256 of first 64 KB of a File — used as a fast identity fingerprint
async function headHash(file) {
    const slice = await file.slice(0, FILE_CHUNK_SIZE).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', slice);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function resumeKey(name, size, hash) {
    return `${name}::${size}::${hash}`;
}

// i18n translations are imported from ./i18n.js

async function startApp() {
    await ensureCrypto();
}

async function ensureCrypto() {
    if (pack_key && unpack_key && initCrypto) return true;
    if (!cryptoLoadPromise) {
        cryptoLoadPromise = (async () => {
            try {
                const cryptoModule = await import('../pkg/webrtc_crypto.js');
                initCrypto = cryptoModule.default;
                pack_key = cryptoModule.pack_key;
                unpack_key = cryptoModule.unpack_key;
                await initCrypto();
                console.log('WASM успешно запущен!');
                return true;
            } catch (e) {
                console.error('Ошибка загрузки WASM:', e);
                return false;
            }
        })();
    }

    return cryptoLoadPromise;
}
startApp();

function setLang(lang) {
    currentLang = i18n[lang] ? lang : 'en';
    document.documentElement.lang = currentLang;

    // Update all static text nodes tagged with data-i18n
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        const value = i18n[currentLang]?.[key];
        if (value != null) el.textContent = value;
    });

    // Update globe-button label
    const codeEl = document.getElementById('langCurrentCode');
    if (codeEl && LANG_META[currentLang]) {
        codeEl.textContent = LANG_META[currentLang].code;
    }

    // Sync active state on every option button (dropdown + sheet)
    document.querySelectorAll('.lang-option').forEach((btn) => {
        const active = btn.dataset.lang === currentLang;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active);
    });

    // Persist choice
    saveLang(currentLang);

    // Close any open picker
    closeLangMenu();
    closeLangSheet();
}

// ── Language picker UI ────────────────────────────────────────────────────

/** Populate dropdown & bottom-sheet with one button per language */
function initLangUI() {
    const dropdown  = document.getElementById('langDropdown');
    const sheetList = document.getElementById('langSheetList');

    SUPPORTED_LANGS.forEach((lang) => {
        const meta = LANG_META[lang];
        const isActive = lang === currentLang;

        [dropdown, sheetList].forEach((container) => {
            if (!container) return;
            const btn = document.createElement('button');
            btn.className = 'lang-option' + (isActive ? ' active' : '');
            btn.dataset.lang = lang;
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', isActive);
            btn.innerHTML =
                `<span class="lang-option-name">${meta.label}</span>` +
                `<span class="lang-option-code">${meta.code}</span>`;
            btn.addEventListener('click', () => setLang(lang));
            container.appendChild(btn);
        });
    });

    // Sync globe label
    const codeEl = document.getElementById('langCurrentCode');
    if (codeEl && LANG_META[currentLang]) {
        codeEl.textContent = LANG_META[currentLang].code;
    }
}

/** Toggle dropdown (desktop) or bottom sheet (mobile) */
function toggleLangMenu() {
    if (window.matchMedia('(max-width: 640px)').matches) {
        openLangSheet();
    } else {
        const dropdown = document.getElementById('langDropdown');
        if (dropdown.classList.contains('open')) {
            closeLangMenu();
        } else {
            dropdown.classList.add('open');
            document.getElementById('langGlobeBtn')?.setAttribute('aria-expanded', 'true');
        }
    }
}

function closeLangMenu() {
    document.getElementById('langDropdown')?.classList.remove('open');
    document.getElementById('langGlobeBtn')?.setAttribute('aria-expanded', 'false');
}

function openLangSheet() {
    document.getElementById('langSheet')?.classList.add('open');
    document.getElementById('langSheetBackdrop')?.classList.add('open');
    document.body.style.overflow = 'hidden';
    document.body.classList.add('lang-sheet-open');
}

function closeLangSheet() {
    document.getElementById('langSheet')?.classList.remove('open');
    document.getElementById('langSheetBackdrop')?.classList.remove('open');
    document.body.style.overflow = '';
    document.body.classList.remove('lang-sheet-open');
}

// Close dropdown when clicking outside of it
document.addEventListener('click', (e) => {
    const langSwitch = document.getElementById('langSwitch');
    if (langSwitch && !langSwitch.contains(e.target)) {
        closeLangMenu();
    }
});

// Close sheet / dropdown on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeLangMenu(); closeLangSheet(); }
});

function getTranslation(key, params = {}) {
    let text = i18n[currentLang]?.[key] || i18n['ru']?.[key] || '';
    for (const [k, v] of Object.entries(params)) {
        text = text.replace(`{${k}}`, v);
    }
    return text;
}

function setMode(mode) {
    currentMode = mode;
    document.getElementById('mode-send-btn').classList.toggle('active', mode === 'send');
    document.getElementById('mode-recv-btn').classList.toggle('active', mode === 'recv');
    document.getElementById('panel-send').classList.toggle('active', mode === 'send');
    document.getElementById('panel-recv').classList.toggle('active', mode === 'recv');
}

function setConnStatus(live) {
    const dot = document.getElementById('connStatusDot');
    if (!dot) return;
    dot.classList.toggle('live', !!live);
}

function setStep(prefix, activeStep) {
    for (let i = 1; i <= 4; i++) {
        const stepEl = document.getElementById(`${prefix}-step${i}`);
        if (!stepEl) continue;
        const wasActive = stepEl.classList.contains('active');
        stepEl.classList.remove('active', 'done', 'just-activated');
        if (i < activeStep) stepEl.classList.add('done');
        if (i === activeStep) {
            stepEl.classList.add('active');
            if (!wasActive) {
                stepEl.classList.add('just-activated');
                stepEl.addEventListener('animationend', () => stepEl.classList.remove('just-activated'), { once: true });
            }
        }
    }
}

function showStatus(id, type, text, spinner = false) {
    const el = document.getElementById(id);
    el.className = 'status-bar visible ' + type;
    el.innerHTML = (spinner ? '<div class="spinner"></div> ' : '') + text;
}

function setProgress(fillId, textId, pctId, pct, text) {
    const fillEl = document.getElementById(fillId);
    fillEl.style.width = pct + '%';
    document.getElementById(textId).textContent = text;
    document.getElementById(pctId).textContent = pct + '%';

    const barEl = fillEl.closest('.progress-bar');
    if (barEl) {
        barEl.style.setProperty('--progress-pct', pct + '%');
        barEl.style.setProperty('--progress-active', (pct > 0 && pct < 100) ? '1' : '0');
    }
}

function showStatusWithReload(id, text) {
    const el = document.getElementById(id);
    el.className = 'status-bar visible error';
    el.innerHTML = text +
        ` <button onclick="location.reload()" style="margin-left:8px;padding:2px 10px;border:1px solid var(--red);background:transparent;color:var(--red);border-radius:6px;cursor:pointer;">` +
        getTranslation('btnReload') + `</button>`;
}

function setPauseButtonState(btnId, paused) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const key = paused ? 'btnResume' : 'btnPause';
    btn.setAttribute('data-i18n', key);
    btn.textContent = getTranslation(key);
}

// --- Sender-side pause / cancel ---
function waitIfSendPaused() {
    return new Promise(resolve => {
        if (!sendPaused) return resolve();
        sendPauseWaiters.push(resolve);
    });
}

function setSendPausedState(paused, notifyPeer = true, statusText = null) {
    sendPaused = paused;
    if (!paused) {
        sendPauseWaiters.forEach(r => r());
        sendPauseWaiters = [];
    }
    setPauseButtonState('btnPauseSend', paused);
    if (statusText) {
        showStatus('sendStatus', paused ? 'warning' : 'info', statusText, !paused);
    } else if (paused) {
        showStatus('sendStatus', 'warning', getTranslation('statusPaused'), false);
    }
    if (notifyPeer && sendTransferChannel && sendTransferChannel.readyState === 'open') {
        try { sendTransferChannel.send(paused ? '__pause__' : '__resume__'); } catch (e) { /* ignore */ }
    }
}

function togglePauseSend() {
    if (!sendTransferChannel || sendCancelled) return;
    setSendPausedState(!sendPaused);
}

function cancelSend() {
    if (!sendTransferChannel && !sendTransferActive) return;
    sendCancelled = true;
    setSendPausedState(false, false); // wake up any paused loop so it can exit
    if (sendTransferChannel && sendTransferChannel.readyState === 'open') {
        try { sendTransferChannel.send('__cancel__'); } catch (e) { /* ignore */ }
    }
    stopSendStallWatch();
    sendTransferActive = false;
    showStatus('sendStatus', 'warning', getTranslation('statusCancelled'), false);
    setTimeout(() => resetSender(true), 1200);
}

function startSendStallWatch() {
    stopSendStallWatch();
    sendLastProgressTs = Date.now();
    sendStallInterval = setInterval(() => {
        const el = document.getElementById('sendStallWarning');
        if (!el) return;
        if (sendPaused || sendCancelled) { el.style.display = 'none'; return; }
        if (Date.now() - sendLastProgressTs > STALL_TIMEOUT_MS) {
            el.textContent = getTranslation('stallWarning');
            el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    }, 3000);
}

function stopSendStallWatch() {
    if (sendStallInterval) { clearInterval(sendStallInterval); sendStallInterval = null; }
    const el = document.getElementById('sendStallWarning');
    if (el) el.style.display = 'none';
}

// --- Receiver-side pause / cancel ---
function togglePauseRecv() {
    if (!recvChannel || recvCancelled) return;
    recvPaused = !recvPaused;
    setPauseButtonState('btnPauseRecv', recvPaused);
    if (recvChannel.readyState === 'open') {
        try { recvChannel.send(recvPaused ? '__pause__' : '__resume__'); } catch (e) { /* ignore */ }
    }
    showStatus('recvStatus', recvPaused ? 'warning' : 'info', getTranslation(recvPaused ? 'statusPaused' : 'statusChannelOpen'), !recvPaused);
}

function cancelRecv() {
    if (!recvChannel && !recvTransferActive) return;
    recvCancelled = true;
    if (recvChannel && recvChannel.readyState === 'open') {
        try { recvChannel.send('__cancel__'); } catch (e) { /* ignore */ }
    }
    stopRecvStallWatch();
    recvTransferActive = false;
    showStatus('recvStatus', 'warning', getTranslation('statusCancelled'), false);
    if (writableStream) {
        const ws = writableStream;
        writableStream = null;
        writeQueue.then(async () => { try { await ws.abort(); } catch (e) { /* ignore */ } });
    }
    setTimeout(() => resetReceiver(true), 1200);
}

function startRecvStallWatch() {
    stopRecvStallWatch();
    recvLastProgressTs = Date.now();
    recvStallInterval = setInterval(() => {
        const el = document.getElementById('recvStallWarning');
        if (!el) return;
        if (recvPaused || recvCancelled) { el.style.display = 'none'; return; }
        if (Date.now() - recvLastProgressTs > STALL_TIMEOUT_MS) {
            el.textContent = getTranslation('stallWarning');
            el.style.display = 'block';
        } else {
            el.style.display = 'none';
        }
    }, 3000);
}

function stopRecvStallWatch() {
    if (recvStallInterval) { clearInterval(recvStallInterval); recvStallInterval = null; }
    const el = document.getElementById('recvStallWarning');
    if (el) el.style.display = 'none';
}

function resetSendProgressUI() {
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressText').textContent = '—';
    document.getElementById('progressPct').textContent = '0%';
    document.getElementById('sendETA').textContent = '—';
    document.getElementById('sendSpeed').textContent = '—';
    document.getElementById('sendSent').textContent = '—';
}

function resetRecvProgressUI() {
    document.getElementById('recvProgressFill').style.width = '0%';
    document.getElementById('recvProgressText').textContent = '—';
    document.getElementById('recvProgressPct').textContent = '0%';
    document.getElementById('recvETA').textContent = '—';
    document.getElementById('recvSpeed').textContent = '—';
    document.getElementById('recvReceived').textContent = '—';
}

function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtName(name) {
    if (name.length <= 30) return name;
    const ext = name.lastIndexOf('.');
    if (ext > 0) return name.slice(0, 12) + '…' + name.slice(ext);
    return name.slice(0, 28) + '…';
}

function fmtETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return getTranslation('etaSeconds', { seconds: Math.ceil(seconds) });
    if (seconds < 3600) return getTranslation('etaMinutesSeconds', { minutes: Math.floor(seconds / 60), seconds: Math.ceil(seconds % 60) });
    return getTranslation('etaHoursMinutes', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
}

function fmtSpeed(bps) {
    if (bps < 1024) return bps.toFixed(0) + ' B/s';
    if (bps < 1048576) return (bps / 1024).toFixed(1) + ' KB/s';
    return (bps / 1048576).toFixed(1) + ' MB/s';
}

function copyText(inputId, btnId) {
    const text = document.getElementById(inputId).value;
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById(btnId);
        btn.textContent = getTranslation('copied');
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = getTranslation('copy');
            btn.classList.remove('copied');
        }, 2000);
    });
}

function handleDrop(e) {
    e.preventDefault();
    document.getElementById('dropzone').classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
}

function handleFile(file) {
    if (!file) return;
    selectedFile = file;
    document.getElementById('dropzone').style.display = 'none';
    const info = document.getElementById('fileInfo');
    info.classList.add('visible');
    document.getElementById('fileName').textContent = fmtName(file.name);
    document.getElementById('fileSize').textContent = fmtSize(file.size);
    document.getElementById('btnCreateOffer').disabled = false;
}

function clearFile() {
    selectedFile = null;
    document.getElementById('fileInput').value = '';
    document.getElementById('dropzone').style.display = '';
    document.getElementById('fileInfo').classList.remove('visible');
    document.getElementById('btnCreateOffer').disabled = true;
}

function resetSender(preserveStatus = false) {
    if (senderPC) { senderPC.close(); senderPC = null; }
    setConnStatus(false);
    if (sendAckCleanup) {
        sendAckCleanup();
        sendAckCleanup = null;
    }
    sendAckResolver = null;
    sendTransferChannel = null;
    sendPaused = false;
    sendPauseWaiters = [];
    sendCancelled = false;
    sendTransferActive = false;
    stopSendStallWatch();
    setPauseButtonState('btnPauseSend', false);
    const sendControls = document.getElementById('sendTransferControls');
    if (sendControls) sendControls.style.display = 'flex';
    stopQRCycler();
    clearFile();
    document.getElementById('btnCreateOffer').textContent = getTranslation('btnCreate');
    const offerKeyBox = document.getElementById('offerKeyBox');
    if (offerKeyBox) offerKeyBox.style.display = 'none';
    document.getElementById('offerKey').value = '';
    document.getElementById('offerQRNote').textContent = '';
    document.getElementById('offerQR').innerHTML = '';
    document.getElementById('answerInput').value = '';
    document.getElementById('answerInput').classList.remove('waiting');
    if (!preserveStatus) {
        document.getElementById('sendStatus').className = 'status-bar';
        document.getElementById('sendStatus').textContent = '';
        document.getElementById('sendProgress').classList.remove('visible');
        resetSendProgressUI();
        setStep('s', 1);
    }
}

function resetReceiver(preserveStatus = false) {
    if (receiverPC) { receiverPC.close(); receiverPC = null; }
    setConnStatus(false);
    stopQRCycler();
    recvBuffers = [];
    recvTotal = 0;
    writableStream = null;
    writeQueue = Promise.resolve();
    scanTargetId = null;
    recvChannel = null;
    recvPaused = false;
    recvCancelled = false;
    recvTransferActive = false;
    stopRecvStallWatch();
    setPauseButtonState('btnPauseRecv', false);
    const recvControls = document.getElementById('recvTransferControls');
    if (recvControls) recvControls.style.display = 'flex';
    
    document.getElementById('offerInput').value = '';
    document.getElementById('answerKey').value = '';
    document.getElementById('answerQRNote').textContent = '';
    document.getElementById('answerQR').innerHTML = '';
    if (!preserveStatus) {
        document.getElementById('recvStatus').className = 'status-bar';
        document.getElementById('recvStatus').textContent = '';
        document.getElementById('recvProgress').classList.remove('visible');
        resetRecvProgressUI();
        setStep('r', 1);
    }
    const saveBtn = document.getElementById('btnSaveFile');
    if (saveBtn) {
        saveBtn.style.display = 'none';
        saveBtn.onclick = null;
    }
}

async function createOffer() {
    if (!selectedFile) return;
    if (!await ensureCrypto()) {
        showStatusWithReload('sendStatus', getTranslation('errCrypto'));
        return;
    }
    
    const btn = document.getElementById('btnCreateOffer');
    const defaultLabel = getTranslation('btnCreate');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> ' + getTranslation('creating');
    try {
        senderPC = new RTCPeerConnection(ICE_CONFIG);
        const channel = senderPC.createDataChannel('fileTransfer', { ordered: true });
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = SEND_BUFFER_LOW_THRESHOLD;
        sendTransferChannel = channel;
        sendPaused = false;
        sendPauseWaiters = [];
        sendCancelled = false;

        senderPC.onconnectionstatechange = () => {
            if (['disconnected', 'failed', 'closed'].includes(senderPC.connectionState) && sendTransferActive) {
                sendTransferActive = false;
                stopSendStallWatch();
                showStatusWithReload('sendStatus', getTranslation('errConnectionLost'));
            }
        };

        channel.onopen = async () => {
            setStep('s', 4);
            setConnStatus(true);
            showStatus('sendStatus', 'info', getTranslation('statusConnected'), true);
            document.getElementById('sendProgress').classList.add('visible');
            const hash = await headHash(selectedFile);
            channel._fileHeadHash = hash;
            channel.send(JSON.stringify({
                __meta__: true,
                name: selectedFile.name,
                size: selectedFile.size,
                headHash: hash
            }));
        };

        channel.onmessage = (e) => {
            if (e.data === '__pause__') {
                setSendPausedState(true, false, getTranslation('statusPausedByPeer'));
                return;
            }
            if (e.data === '__resume__') {
                setSendPausedState(false, false, getTranslation('statusResumedByPeer'));
                return;
            }
            if (e.data === '__cancel__') {
                sendCancelled = true;
                setSendPausedState(false, false);
                stopSendStallWatch();
                sendTransferActive = false;
                showStatus('sendStatus', 'warning', getTranslation('statusCancelledByPeer'), false);
                setTimeout(() => resetSender(true), 1200);
                return;
            }

            if (e.data === '__ready_stream__') {
                showStatus('sendStatus', 'info', getTranslation('statusReadyStream'), true);
                document.getElementById('sendProgress').classList.add('visible');
                sendFileChunked(channel, selectedFile, true, 0);
                return;
            }

            if (e.data === '__ready_blob__') {
                showStatus('sendStatus', 'info', getTranslation('statusReadyBlob'), true);
                document.getElementById('sendProgress').classList.add('visible');
                sendFileChunked(channel, selectedFile, false, 0);
                return;
            }

            if (typeof e.data === 'string' && e.data.startsWith('__resume_from__:')) {
                const startChunk = parseInt(e.data.split(':')[1], 10) || 0;
                const startOffset = startChunk * FILE_CHUNK_SIZE;
                const pct = selectedFile.size ? Math.round(startOffset / selectedFile.size * 100) : 0;
                showStatus('sendStatus', 'info', getTranslation('statusResumingReady', { chunk: startChunk }), true);
                document.getElementById('sendProgress').classList.add('visible');
                sendFileChunked(channel, selectedFile, false, startChunk);
                return;
            }

            if (e.data === '__ack__' && typeof sendAckResolver === 'function') {
                if (sendAckCleanup) {
                    sendAckCleanup();
                    sendAckCleanup = null;
                }
                const resolve = sendAckResolver;
                sendAckResolver = null;
                resolve();
            }
        };

        const offer = await senderPC.createOffer();
        await senderPC.setLocalDescription(offer);

        await waitForIceGathering(senderPC, 8000);

        // Compact SDP so desktop keys match mobile size/shape and paste cleanly both ways
        const sdpData = sessionToKeyPayload(senderPC.localDescription);
        const packedKey = pack_key(sdpData);
        
        document.getElementById('offerKey').value = packedKey;
        btn.innerHTML = getTranslation('keyCreated');
        
        generateChunkedQR('offerQR', 'offerQRNote', packedKey);
        setStep('s', 3);
        document.getElementById('answerInput').classList.add('waiting');
    } catch (e) {
        if (senderPC) { senderPC.close(); senderPC = null; }
        showStatusWithReload('sendStatus', getTranslation('errCreateKey') + e.message);
        btn.innerHTML = defaultLabel;
        btn.disabled = !selectedFile;
    }
}

async function waitForSendBuffer(channel) {
    if (channel.bufferedAmount <= SEND_BUFFER_HIGH_WATERMARK) return;

    await new Promise((resolve, reject) => {
        const cleanup = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            channel.removeEventListener('close', onClose);
            channel.removeEventListener('error', onError);
        };
        const onLow = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); reject(new Error(getTranslation('errCancelBuffer'))); };
        const onError = () => { cleanup(); reject(new Error(getTranslation('errCancelBufferErr'))); };

        channel.addEventListener('bufferedamountlow', onLow, { once: true });
        channel.addEventListener('close', onClose, { once: true });
        channel.addEventListener('error', onError, { once: true });
    });
}

function waitForSendAck(channel) {
    return new Promise((resolve, reject) => {
        // Ensure any previous stale resolver is cleared before assigning new one
        sendAckResolver = null;
        sendAckCleanup = null;

        const cleanup = () => {
            if (sendAckResolver === resolve) sendAckResolver = null;
            sendAckCleanup = null;
            channel.removeEventListener('close', onClose);
            channel.removeEventListener('error', onError);
        };

        const onClose = () => {
            cleanup();
            reject(new Error(getTranslation('errCancelBuffer')));
        };

        const onError = () => {
            cleanup();
            reject(new Error(getTranslation('errCancelBufferErr')));
        };

        channel.addEventListener('close', onClose, { once: true });
        channel.addEventListener('error', onError, { once: true });
        sendAckCleanup = cleanup;
        sendAckResolver = resolve;
    });
}

async function sendFileChunked(channel, file, requireAck = false, startChunk = 0) {
    let offset = startChunk * FILE_CHUNK_SIZE;
    const startTime = Date.now();
    let lastTime = startTime;
    let lastOffset = offset;
    let chunkIndex = startChunk;

    sendTransferActive = true;
    startSendStallWatch();

    try {
        while (offset < file.size) {
            if (sendCancelled) throw new Error('__CANCELLED__');
            await waitIfSendPaused();
            if (sendCancelled) throw new Error('__CANCELLED__');

            await waitForSendBuffer(channel);
            if (channel.readyState !== 'open') throw new Error(getTranslation('errCancelBuffer'));

            const chunk = await file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
            const ackPromise = requireAck ? waitForSendAck(channel) : null;
            channel.send(chunk);
            if (ackPromise) await ackPromise;
            offset += chunk.byteLength;
            chunkIndex++;
            sendLastProgressTs = Date.now();

            const pct = file.size ? Math.min(100, Math.round(offset / file.size * 100)) : 100;
            setProgress('progressFill', 'sendSent', 'progressPct', pct, `${getTranslation('progressSent')}${fmtSize(offset)} / ${fmtSize(file.size)}`);

            const now = Date.now();
            const elapsed = (now - startTime) / 1000;
            const dt = now - lastTime;
            const dBytes = offset - lastOffset;

            if (dt > 500) {
                const speed = (dBytes / dt) * 1000;
                lastTime = now;
                lastOffset = offset;
                document.getElementById('sendSpeed').textContent = fmtSpeed(speed);
            }

            const avgSpeed = elapsed > 0 ? (offset - startChunk * FILE_CHUNK_SIZE) / elapsed : 0;
            const eta = avgSpeed > 0 ? (file.size - offset) / avgSpeed : Infinity;
            document.getElementById('sendETA').textContent = fmtETA(eta);
        }

        await waitForSendBuffer(channel);
        if (channel.readyState === 'open') {
            channel.send('__done__');
            sendTransferActive = false;
            stopSendStallWatch();
            const sendControls = document.getElementById('sendTransferControls');
            if (sendControls) sendControls.style.display = 'none';
            showStatus('sendStatus', 'success', getTranslation('statusSentOk'));
            setProgress('progressFill', 'sendSent', 'progressPct', 100, getTranslation('progressDone'));
            document.getElementById('sendETA').textContent = getTranslation('progressEtaDone');
            document.getElementById('sendSent').textContent = fmtSize(file.size) + ' / ' + fmtSize(file.size);
            setTimeout(() => resetSender(true), 2000);
        }
    } catch (e) {
        sendTransferActive = false;
        stopSendStallWatch();
        if (e.message === '__CANCELLED__' || sendCancelled) {
            // Cancellation already shows its own status message via cancelSend()/peer handler
            return;
        }
        showStatusWithReload('sendStatus', getTranslation('errTransfer') + e.message);
    }
}

async function applyAnswer() {
    const rawKey = document.getElementById('answerInput').value;
    if (!normalizeConnectionKey(rawKey)) return;
    if (!await ensureCrypto()) {
        showStatusWithReload('sendStatus', getTranslation('errCrypto'));
        return;
    }

    setStep('s', 4);
    document.getElementById('answerInput').classList.remove('waiting');
    showStatus('sendStatus', 'info', getTranslation('statusApplyingAnswer'), true);

    let answerObj;
    try {
        answerObj = await decodeConnectionKey(rawKey);
    } catch {
        return showStatusWithReload('sendStatus', getTranslation('errBadAnswerKey'));
    }

    try {
        await senderPC.setRemoteDescription(new RTCSessionDescription(answerObj));
    } catch (e) {
        showStatusWithReload('sendStatus', getTranslation('errConnect') + e.message);
    }
}

async function createAnswer() {
    const rawKey = document.getElementById('offerInput').value;
    if (!normalizeConnectionKey(rawKey)) return;
    if (!await ensureCrypto()) {
        showStatusWithReload('recvStatus', getTranslation('errCrypto'));
        return;
    }

    let offerObj;
    try {
        offerObj = await decodeConnectionKey(rawKey);
    } catch {
        return showStatusWithReload('recvStatus', getTranslation('errBadKey'));
    }

    try {
        receiverPC = new RTCPeerConnection(ICE_CONFIG);
        recvBuffers = [];
        recvTotal = 0;
        recvPaused = false;
        recvCancelled = false;

        receiverPC.onconnectionstatechange = () => {
            if (['disconnected', 'failed', 'closed'].includes(receiverPC.connectionState) && recvTransferActive) {
                recvTransferActive = false;
                stopRecvStallWatch();
                showStatusWithReload('recvStatus', getTranslation('errConnectionLost'));
            }
        };

        let fileName = 'received_file';
        let fileSize = 0;
        let startTime = null;
        let lastTime = null;
        let lastRecv = 0;

        receiverPC.ondatachannel = (e) => {
            const channel = e.channel;
            channel.binaryType = 'arraybuffer';
            recvChannel = channel;

            channel.onmessage = async (ev) => {
            if (typeof ev.data === 'string') {
                if (ev.data === '__pause__') {
                    recvPaused = true;
                    setPauseButtonState('btnPauseRecv', true);
                    showStatus('recvStatus', 'warning', getTranslation('statusPausedByPeer'), false);
                    return;
                }

                if (ev.data === '__resume__') {
                    recvPaused = false;
                    setPauseButtonState('btnPauseRecv', false);
                    showStatus('recvStatus', 'info', getTranslation('statusResumedByPeer'), true);
                    return;
                }

                if (ev.data === '__cancel__') {
                    recvCancelled = true;
                    recvTransferActive = false;
                    stopRecvStallWatch();
                    showStatus('recvStatus', 'warning', getTranslation('statusCancelledByPeer'), false);
                    if (writableStream) {
                        const ws = writableStream;
                        writableStream = null;
                        writeQueue.then(async () => { try { await ws.abort(); } catch (e) { /* ignore */ } });
                    }
                    setTimeout(() => resetReceiver(true), 1200);
                    return;
                }

                if (ev.data === '__done__') {
                    // Clear resume record
                    if (channel._resumeKey) {
                        idbDelete(channel._resumeKey).catch(() => {});
                        channel._resumeKey = null;
                    }

                    // Show success UI immediately, before waiting for disk close
                    recvTransferActive = false;
                    stopRecvStallWatch();
                    const recvControlsDone = document.getElementById('recvTransferControls');
                    if (recvControlsDone) recvControlsDone.style.display = 'none';
                    showStatus('recvStatus', 'success', getTranslation('statusFileReceived', { name: fmtName(fileName), size: fmtSize(fileSize) }));
                    setProgress('recvProgressFill', 'recvReceived', 'recvProgressPct', 100, getTranslation('progressDone'));
                    document.getElementById('recvETA').textContent = getTranslation('progressEtaDone');
                    document.getElementById('recvReceived').textContent = fmtSize(fileSize) + ' / ' + fmtSize(fileSize);

                    if (writableStream) {
                        // Close stream in background — don't block UI
                        writeQueue.then(async () => {
                            try {
                                await writableStream.close();
                            } catch (e) { console.error('Error closing stream:', e); }
                            writableStream = null;
                        });
                    } else {
                        const blob = new Blob(recvBuffers);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = fileName; a.click();
                        URL.revokeObjectURL(url);
                    }

                    setTimeout(() => resetReceiver(true), 3000);
                    return;
                }

                if (ev.data === '__ack__') {
                    return;
                }

                try {
                    const meta = JSON.parse(ev.data);
                    if (meta.__meta__) {
                        fileName = meta.name;
                        fileSize = meta.size;
                        const hash = meta.headHash || '';
                        const rKey = resumeKey(meta.name, meta.size, hash);
                        channel._resumeKey = rKey;
                        channel._recvChunkIndex = 0;

                        let savedChunk = 0;
                        try {
                            const saved = await idbGet(rKey);
                            if (saved && saved.chunkIndex > 0) {
                                savedChunk = saved.chunkIndex;
                            }
                        } catch (e) { /* ignore IDB errors */ }

                        const startReceiver = (resumeFromChunk) => {
                            channel._recvChunkIndex = resumeFromChunk;
                            recvTotal = resumeFromChunk * FILE_CHUNK_SIZE;

                            if ('showSaveFilePicker' in window && resumeFromChunk === 0) {
                                const btnSave = document.getElementById('btnSaveFile');
                                if (btnSave) {
                                    btnSave.style.display = 'inline-flex';
                                    btnSave.textContent = getTranslation('btnSaveFile');
                                    btnSave.onclick = async () => {
                                        try {
                                            const handle = await window.showSaveFilePicker({ suggestedName: fileName });
                                            writableStream = await handle.createWritable();
                                            writeQueue = Promise.resolve();
                                            btnSave.style.display = 'none';
                                            channel.send('__ready_blob__');
                                            setStep('r', 3);
                                            showStatus('recvStatus', 'info', getTranslation('recvStreamStatus'), true);
                                            document.getElementById('recvProgress').classList.add('visible');
                                            startTime = Date.now(); lastTime = startTime; lastRecv = 0;
                                        } catch (err) {
                                            console.warn('Save picker canceled or failed:', err);
                                            if (err.name === 'AbortError') {
                                                showStatus('recvStatus', 'warning', getTranslation('saveCanceled'), false);
                                                const fallbackLink = document.getElementById('fallback-blob-link');
                                                if (fallbackLink) {
                                                    fallbackLink.onclick = (event) => {
                                                        event.preventDefault();
                                                        writableStream = null;
                                                        btnSave.style.display = 'none';
                                                        channel.send('__ready_blob__');
                                                        setStep('r', 3);
                                                        showStatus('recvStatus', 'warning', getTranslation('saveFallbackActive'), true);
                                                        document.getElementById('recvProgress').classList.add('visible');
                                                        startTime = Date.now(); lastTime = startTime; lastRecv = 0;
                                                    };
                                                }
                                            } else {
                                                writableStream = null;
                                                btnSave.style.display = 'none';
                                                channel.send('__ready_blob__');
                                                setStep('r', 3);
                                                showStatus('recvStatus', 'warning', getTranslation('saveNotSupported'), true);
                                                document.getElementById('recvProgress').classList.add('visible');
                                                startTime = Date.now(); lastTime = startTime; lastRecv = 0;
                                            }
                                        }
                                    };
                                }
                                showStatus('recvStatus', 'warning', getTranslation('savePrompt'), false);
                            } else {
                                writableStream = null;
                                if (resumeFromChunk > 0) {
                                    const pct = fileSize ? Math.round(resumeFromChunk * FILE_CHUNK_SIZE / fileSize * 100) : 0;
                                    channel.send(`__resume_from__:${resumeFromChunk}`);
                                    setStep('r', 3);
                                    showStatus('recvStatus', 'info', getTranslation('statusResuming', { pct }), true);
                                } else {
                                    channel.send('__ready_blob__');
                                    if (!('showSaveFilePicker' in window)) {
                                        setStep('r', 3);
                                        showStatus('recvStatus', 'warning', getTranslation('statusBrowserFallback'), true);
                                    }
                                }
                                document.getElementById('recvProgress').classList.add('visible');
                                startTime = Date.now(); lastTime = startTime; lastRecv = 0;
                            }
                        };

                        if (savedChunk > 0) {
                            const pct = fileSize ? Math.round(savedChunk * FILE_CHUNK_SIZE / fileSize * 100) : 0;
                            const recvStatusEl = document.getElementById('recvStatus');
                            recvStatusEl.className = 'status-bar visible info';
                            recvStatusEl.innerHTML =
                                getTranslation('resumeFound', { pct }) +
                                ` <button onclick="this.closest('.status-bar').dataset.chose='resume'" ` +
                                `style="margin-left:8px;padding:2px 10px;border:1px solid var(--blue);background:transparent;color:var(--blue);border-radius:6px;cursor:pointer;">` +
                                getTranslation('resumeYes') + `</button>` +
                                ` <button onclick="this.closest('.status-bar').dataset.chose='fresh'" ` +
                                `style="margin-left:4px;padding:2px 10px;border:1px solid var(--text-muted);background:transparent;color:var(--text-muted);border-radius:6px;cursor:pointer;">` +
                                getTranslation('resumeNo') + `</button>`;

                            // Poll for user choice (buttons set data-chose on the element)
                            await new Promise(resolve => {
                                const poll = setInterval(() => {
                                    const chose = recvStatusEl.dataset.chose;
                                    if (chose) {
                                        clearInterval(poll);
                                        delete recvStatusEl.dataset.chose;
                                        resolve(chose);
                                    }
                                }, 100);
                            }).then(chose => {
                                startReceiver(chose === 'resume' ? savedChunk : 0);
                            });
                        } else {
                            startReceiver(0);
                        }
                    }
                } catch (e) { console.error('Parse metadata error:', e); }
                return;
            }

            // Binary chunk
            const chunkIdx = channel._recvChunkIndex ?? 0;
            channel._recvChunkIndex = chunkIdx + 1;

            if (channel._resumeKey && (chunkIdx % RESUME_SAVE_INTERVAL === 0)) {
                idbSet(channel._resumeKey, { chunkIndex: chunkIdx }).catch(() => {});
            }

            if (writableStream) {
                const chunkData = new Uint8Array(ev.data);
                writeQueue = writeQueue.then(async () => {
                    try {
                        await writableStream.write(chunkData);
                    } catch (e) {
                        console.error('Write error:', e);
                        recvTransferActive = false;
                        stopRecvStallWatch();
                        showStatusWithReload('recvStatus', 'Write error: ' + e.message);
                    }
                });
            } else {
                recvBuffers.push(ev.data);
            }

            recvTotal += ev.data.byteLength;
            recvLastProgressTs = Date.now();
            if (!recvTransferActive) {
                recvTransferActive = true;
                startRecvStallWatch();
            }
            const now = Date.now();
            if (!startTime) { startTime = now; lastTime = now; lastRecv = 0; }

            const elapsed = (now - startTime) / 1000;
            const dt = now - lastTime;
            const dBytes = recvTotal - lastRecv;
            const speed = dt > 50 ? (dBytes / dt) * 1000 : 0;
            if (dt > 50) { lastTime = now; lastRecv = recvTotal; document.getElementById('recvSpeed').textContent = fmtSpeed(speed); }
            
            const avgSpeed = elapsed > 0 ? recvTotal / elapsed : 0;
            const eta = fileSize && avgSpeed > 0 ? (fileSize - recvTotal) / avgSpeed : Infinity;
            const pct = fileSize ? Math.round(recvTotal / fileSize * 100) : 0;

            setProgress('recvProgressFill', 'recvReceived', 'recvProgressPct', pct, `${fmtSize(recvTotal)} / ${fmtSize(fileSize)}`);
            document.getElementById('recvETA').textContent = fmtETA(eta);
            };

            channel.onopen = () => {
                setStep('r', 3);
                setConnStatus(true);
                showStatus('recvStatus', 'info', getTranslation('statusChannelOpen'), true);
                document.getElementById('recvProgress').classList.add('visible');
            };
        };

        await receiverPC.setRemoteDescription(new RTCSessionDescription(offerObj));
        const answer = await receiverPC.createAnswer();
        await receiverPC.setLocalDescription(answer);

        await waitForIceGathering(receiverPC, 8000);

        // Same packing path as offer — compact SDP + URL-safe key for PC↔mobile paste/QR
        const sdpData = sessionToKeyPayload(receiverPC.localDescription);
        const packedKey = pack_key(sdpData);
        
        document.getElementById('answerKey').value = packedKey;
        generateChunkedQR('answerQR', 'answerQRNote', packedKey);
        setStep('r', 3);
        showStatus('recvStatus', 'info', getTranslation('statusConnReady'), true);
        document.getElementById('recvProgress').classList.add('visible');
    } catch (e) {
        if (receiverPC) { receiverPC.close(); receiverPC = null; }
        showStatusWithReload('recvStatus', getTranslation('errCreateAnswer') + e.message);
    }
}

const QR_MAX_CHUNK_SIZE = 700;
const QR_DESKTOP_SIZE = 320;
const QR_MOBILE_SIZE = 240;

function getQrRenderSize() {
    return window.innerWidth <= 520 ? QR_MOBILE_SIZE : QR_DESKTOP_SIZE;
}

function stopQRCycler() {
    if (qrCyclerInterval) {
        clearInterval(qrCyclerInterval);
        qrCyclerInterval = null;
    }
    const offerControls = document.getElementById('offer-qr-controls');
    if (offerControls) offerControls.remove();
    const answerControls = document.getElementById('answer-qr-controls');
    if (answerControls) answerControls.remove();
}

async function generateChunkedQR(containerId, noteId, dataStr) {
    stopQRCycler();
    const container = document.getElementById(containerId);
    const note = document.getElementById(noteId);
    container.innerHTML = '';

    try {
        await ensureQRCodeLib();
    } catch (e) {
        container.innerHTML = '<p style="color:var(--red);padding:12px;">Ошибка загрузки библиотеки QR</p>';
        return;
    }

    container.classList.remove('qr-pop');
    void container.offsetWidth; // restart animation
    container.classList.add('qr-pop');
    const prefix = containerId === 'offerQR' ? 'offer' : 'answer';

    if (dataStr.length <= QR_MAX_CHUNK_SIZE) {
        const existingControls = document.getElementById(`${prefix}-qr-controls`);
        if (existingControls) existingControls.remove();
        try {
            const size = getQrRenderSize();
            new QRCode(container, { text: dataStr, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
            note.textContent = getTranslation('qrReady', { size: fmtSize(dataStr.length) });
            note.style.color = 'var(--text-muted)';
        } catch (e) {
            container.innerHTML = '<p style="color:var(--red);padding:12px;">Ошибка генерации QR</p>';
        }
        return;
    }

    const chunks = [];
    for (let i = 0; i < dataStr.length; i += QR_MAX_CHUNK_SIZE) {
        chunks.push(dataStr.slice(i, i + QR_MAX_CHUNK_SIZE));
    }
    const totalParts = chunks.length;
    let currentPart = 0;
    let isPaused = false;

    function showPart(index) {
        currentPart = (index + totalParts) % totalParts;
        const partData = `P2P|${totalParts}|${currentPart + 1}|${chunks[currentPart]}`;
        container.innerHTML = '';
        try {
            const size = getQrRenderSize();
            new QRCode(container, { text: partData, width: size, height: size, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
            note.textContent = getTranslation('qrPart', { current: currentPart + 1, total: totalParts, cameraHint: getTranslation('qrCameraHint') });
            note.style.color = isPaused ? 'var(--blue)' : 'var(--orange)';
        } catch (e) {
            container.innerHTML = '<p style="color:var(--red);padding:12px;">Ошибка генерации части</p>';
        }
        updateControlsUI();
    }

    function startInterval() {
        if (qrCyclerInterval) clearInterval(qrCyclerInterval);
        qrCyclerInterval = setInterval(() => {
            if (!isPaused) {
                showPart(currentPart + 1);
            }
        }, 3500);
    }

    function togglePause() {
        isPaused = !isPaused;
        if (isPaused) {
            if (qrCyclerInterval) {
                clearInterval(qrCyclerInterval);
                qrCyclerInterval = null;
            }
            showPart(currentPart);
        } else {
            showPart((currentPart + 1) % totalParts);
            startInterval();
        }
    }

    function nextPart() {
        isPaused = true;
        if (qrCyclerInterval) {
            clearInterval(qrCyclerInterval);
            qrCyclerInterval = null;
        }
        showPart(currentPart + 1);
    }

    function prevPart() {
        isPaused = true;
        if (qrCyclerInterval) {
            clearInterval(qrCyclerInterval);
            qrCyclerInterval = null;
        }
        showPart(currentPart - 1);
    }

    function updateControlsUI() {
        const playBtn = document.getElementById(`${prefix}-qr-play`);
        if (playBtn) {
            playBtn.textContent = isPaused ? '▶' : '⏸';
            playBtn.title = getTranslation(isPaused ? 'qrPlay' : 'qrPause');
        }
    }

    // Create controls if they don't exist
    let controls = document.getElementById(`${prefix}-qr-controls`);
    if (!controls) {
        controls = document.createElement('div');
        controls.className = 'qr-controls';
        controls.id = `${prefix}-qr-controls`;

        const prevBtn = document.createElement('button');
        prevBtn.className = 'qr-btn';
        prevBtn.id = `${prefix}-qr-prev`;
        prevBtn.innerHTML = '❮';
        prevBtn.type = 'button';
        prevBtn.title = getTranslation('qrPrev');
        prevBtn.onclick = prevPart;

        const playBtn = document.createElement('button');
        playBtn.className = 'qr-btn';
        playBtn.id = `${prefix}-qr-play`;
        playBtn.innerHTML = '⏸';
        playBtn.type = 'button';
        playBtn.title = getTranslation('qrPause');
        playBtn.onclick = togglePause;

        const nextBtn = document.createElement('button');
        nextBtn.className = 'qr-btn';
        nextBtn.id = `${prefix}-qr-next`;
        nextBtn.innerHTML = '❯';
        nextBtn.type = 'button';
        nextBtn.title = getTranslation('qrNext');
        nextBtn.onclick = nextPart;

        controls.appendChild(prevBtn);
        controls.appendChild(playBtn);
        controls.appendChild(nextBtn);

        // Insert controls between container and note
        container.parentNode.insertBefore(controls, note);
    }

    showPart(0);
    startInterval();
}

function switchTab(prefix, type, btnEl) {
    btnEl.closest('.key-tabs').querySelectorAll('.key-tab').forEach(t => t.classList.remove('active'));
    btnEl.classList.add('active');

    const qrPanel = document.getElementById(`${prefix}-qr-panel`);
    if (type === 'text') {
        qrPanel.classList.remove('visible');
    } else {
        qrPanel.classList.add('visible');
        const keyId = prefix === 'offer' ? 'offerKey' : 'answerKey';
        const qrId = prefix === 'offer' ? 'offerQR' : 'answerQR';
        const noteId = prefix === 'offer' ? 'offerQRNote' : 'answerQRNote';
        const data = document.getElementById(keyId).value;
        if (data && document.getElementById(qrId).innerHTML === '') {
            generateChunkedQR(qrId, noteId, data);
        }
    }
}

let scanTorchTrack = null;
let scanTorchOn = false;

async function openScanner(targetInputId) {
    closeScanner();
    scanTargetId = targetInputId;
    scannedChunks = {};
    totalExpectedChunks = 0;
    scanDetector = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;

    const modal = document.getElementById('scanModal');
    const status = document.getElementById('scanStatus');
    status.textContent = '';
    status.style.color = 'var(--text-muted)';
    modal.classList.add('visible');

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error(getTranslation('cameraNotSupported'));
        }

        // Запускаем getUserMedia сразу же, синхронно в этом же тике клика — на iOS
        // (Safari и Chrome, оба работают на WebKit) промис легко "отвязывается" от
        // жеста пользователя, если перед вызовом есть await на загрузку скрипта и т.д.
        // jsQR при этом подгружается параллельно (обычно уже прогрет заранее).
        const getCameraStream = (constraints) => navigator.mediaDevices.getUserMedia(constraints);

        const camPromise = getCameraStream({
            audio: false,
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        }).catch(async () => {
            // Мягкий фолбэк: самые базовые констрейнты без ideal-размеров —
            // некоторые версии iOS Safari отклоняют более строгие запросы.
            return getCameraStream({ audio: false, video: { facingMode: 'environment' } });
        });

        const [stream] = await Promise.all([camPromise, ensureJsQRLib()]);
        scanStream = stream;

        const video = document.getElementById('scanVideo');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = scanStream;
        try {
            await video.play();
        } catch (playErr) {
            // На некоторых версиях iOS первый play() может быть отклонён — пробуем ещё раз.
            await new Promise(r => setTimeout(r, 150));
            await video.play().catch(() => {});
        }

        setupTorchButton();

        status.textContent = getTranslation('scanHint');
        startJsQRLoop();
    } catch (err) {
        if (err.name === 'NotAllowedError') {
            status.textContent = getTranslation('cameraAccessDenied');
        } else {
            status.textContent = getTranslation('cameraError') + err.message;
        }
        status.style.color = 'var(--red)';
    }
}

function setupTorchButton() {
    const btn = document.getElementById('scanTorchBtn');
    if (!btn) return;
    scanTorchTrack = null;
    scanTorchOn = false;
    btn.style.display = 'none';
    btn.classList.remove('active');

    const track = scanStream && scanStream.getVideoTracks()[0];
    if (!track) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) {
        scanTorchTrack = track;
        btn.style.display = 'inline-flex';
    }
}

function toggleTorch() {
    if (!scanTorchTrack) return;
    scanTorchOn = !scanTorchOn;
    scanTorchTrack.applyConstraints({ advanced: [{ torch: scanTorchOn }] }).catch(() => {
        scanTorchOn = !scanTorchOn; // revert on failure
    });
    const btn = document.getElementById('scanTorchBtn');
    if (btn) btn.classList.toggle('active', scanTorchOn);
}

function startJsQRLoop() {
    const video = document.getElementById('scanVideo');
    const canvas = document.getElementById('scanCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // На iOS (Safari и Chrome, оба на движке WebKit) чтение пикселей с канваса
    // (getImageData) на каждый animation-frame — очень дорогая операция и она
    // "подвешивает" превью камеры, из-за чего сканер выглядит нерабочим.
    // Ограничиваем частоту попыток распознавания и понижаем разрешение кадра —
    // этого более чем достаточно для чтения QR, а камера остаётся плавной.
    const DETECT_INTERVAL_MS = 120;
    const MAX_PROCESS_WIDTH = 900;
    let lastAttempt = 0;

    async function tick(ts) {
        if (!scanStream) return;
        scanRafId = requestAnimationFrame(tick);

        if (ts - lastAttempt < DETECT_INTERVAL_MS) return;
        lastAttempt = ts;

        if (video.readyState !== video.HAVE_ENOUGH_DATA) return;

        if (scanDetector) {
            try {
                const codes = await scanDetector.detect(video);
                if (codes && codes.length > 0 && codes[0].rawValue) {
                    processScannedChunk(codes[0].rawValue);
                }
                return;
            } catch (err) {
                scanDetector = null;
            }
        }

        const rawW = video.videoWidth || 1280;
        const rawH = video.videoHeight || 720;
        const scale = rawW > MAX_PROCESS_WIDTH ? MAX_PROCESS_WIDTH / rawW : 1;
        const w = Math.round(rawW * scale);
        const h = Math.round(rawH * scale);
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code) {
            processScannedChunk(code.data);
        }
    }
    scanRafId = requestAnimationFrame(tick);
}

function flashScanSuccess() {
    const video = document.getElementById('scanVideo');
    if (!video) return;
    video.classList.remove('scan-flash');
    // force reflow so the animation can restart if it's already running
    void video.offsetWidth;
    video.classList.add('scan-flash');
    setTimeout(() => video.classList.remove('scan-flash'), 650);
}

function processScannedChunk(data) {
    const status = document.getElementById('scanStatus');

    if (data.startsWith('P2P|')) {
        // Format: P2P|<total>|<1-based-index>|<payload>
        // Split only the first 3 pipes so payload stays intact even if corrupted.
        const match = /^P2P\|(\d+)\|(\d+)\|(.*)$/s.exec(data);
        if (match) {
            const total = parseInt(match[1], 10);
            const idx = parseInt(match[2], 10);
            const payload = match[3];

            if (!total || !idx || idx > total) return;

            totalExpectedChunks = total;

            const collected = Object.keys(scannedChunks).length;
            const nextExpectedIdx = collected + 1;

            // Already have this part — ignore silently (camera re-reading the same frame)
            if (scannedChunks[idx] !== undefined) {
                return;
            }

            // Strict order enforcement: reject any part that isn't the next expected one
            if (idx !== nextExpectedIdx) {
                status.textContent = getTranslation('qrWrongOrder', { expected: nextExpectedIdx, got: idx });
                status.style.color = 'var(--red)';
                return;
            }

            scannedChunks[idx] = payload;
            const newCollected = idx;

            status.textContent = getTranslation('partsCollected', { collected: newCollected, total: total });
            status.style.color = 'var(--blue)';

            // Green glow flash every 3 successfully scanned parts
            if (newCollected % 3 === 0) {
                flashScanSuccess();
            }

            if (newCollected === total) {
                let fullData = '';
                for (let i = 1; i <= total; i++) {
                    fullData += scannedChunks[i];
                }
                // Same normalized key on every device after multi-part QR scan
                document.getElementById(scanTargetId).value = normalizeConnectionKey(fullData);
                status.textContent = getTranslation('qrSuccess');
                status.style.color = 'var(--green)';
                flashScanSuccess();
                setTimeout(closeScanner, 800);
            }
            return;
        }
    }

    // Single-part QR — normalize so scanned key matches a pasted one
    document.getElementById(scanTargetId).value = normalizeConnectionKey(data);
    status.textContent = getTranslation('qrScanned');
    status.style.color = 'var(--green)';
    flashScanSuccess();
    setTimeout(closeScanner, 500);
}

function closeScanner() {
    cancelAnimationFrame(scanRafId);
    if (scanStream) {
        scanStream.getTracks().forEach(t => t.stop());
        scanStream = null;
    }
    scanDetector = null;
    scanTorchTrack = null;
    scanTorchOn = false;
    const torchBtn = document.getElementById('scanTorchBtn');
    if (torchBtn) {
        torchBtn.style.display = 'none';
        torchBtn.classList.remove('active');
    }
    document.getElementById('scanVideo').srcObject = null;
    document.getElementById('scanModal').classList.remove('visible');
}

function openFaq() {
    document.getElementById('faq-modal').classList.add('visible');
}

function closeFaq() {
    document.getElementById('faq-modal').classList.remove('visible');
}

const faqToggleBtn = document.getElementById('faq-toggle-btn');
if (faqToggleBtn) faqToggleBtn.addEventListener('click', openFaq);
const faqCloseBtn = document.getElementById('faq-close-btn');
if (faqCloseBtn) faqCloseBtn.addEventListener('click', closeFaq);
const faqModal = document.getElementById('faq-modal');
if (faqModal) {
    faqModal.addEventListener('click', (e) => {
        if (e.target === faqModal) closeFaq();
    });
}

window.addEventListener('beforeunload', (e) => {
    if (sendTransferActive || recvTransferActive) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Auto-detect language from localStorage → browser → fallback 'en'
setLang(detectLang());
// Populate the globe-button dropdown & bottom-sheet
initLangUI();

window.setMode = setMode;
window.togglePauseSend = togglePauseSend;
window.cancelSend = cancelSend;
window.togglePauseRecv = togglePauseRecv;
window.cancelRecv = cancelRecv;
window.setLang        = setLang;
window.toggleLangMenu = toggleLangMenu;
window.closeLangMenu  = closeLangMenu;
window.openLangSheet  = openLangSheet;
window.closeLangSheet = closeLangSheet;
window.handleDrop = handleDrop;
window.handleFile = handleFile;
window.clearFile = clearFile;
window.createOffer = createOffer;
window.applyAnswer = applyAnswer;
window.copyText = copyText;
window.switchTab = switchTab;
window.openScanner = openScanner;
window.closeScanner = closeScanner;
window.toggleTorch = toggleTorch;
window.createAnswer = createAnswer;
window.fmtSize = fmtSize;