let initCrypto = null;
let pack_key = null;
let unpack_key = null;
let cryptoLoadPromise = null;

let currentLang = 'ru';
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
let sendAckResolver = null;
let sendAckCleanup = null;

let qrCyclerInterval = null;
let scanDetector = null;

const FILE_CHUNK_SIZE = 64 * 1024;
const SEND_BUFFER_LOW_THRESHOLD = 1024 * 1024;
const SEND_BUFFER_HIGH_WATERMARK = 2 * 1024 * 1024;

const i18n = {
    ru: {
        brand: 'P2P File Transfer',
        tag: 'END-TO-END ENCRYPTED',
        modeSend: '📤 Отправитель',
        modeRecv: '📥 Получатель',
        sendTitle: 'Отправка файла',
        sendDesc: 'Инициализация соединения и создание ключа',
        step1Send: 'Шаг 1 — Выберите файл',
        dropText: 'Нажмите или перетащите файл сюда',
        dropHint: 'Любой тип и размер файла',
        btnCreate: 'Создать ключ соединения →',
        step2Send: 'Шаг 2 — Передайте ключ получателю',
        tabText: '📋 Текст',
        tabQr: '📱 QR-код',
        copy: 'Копировать',
        hintSend: 'Скопируйте текст или покажите QR-код получателю',
        step3Send: 'Шаг 3 — Вставьте ответный ключ',
        btnScanAns: '📷 Сканировать QR-код получателя',
        btnConnect: 'Подключиться и отправить файл',
        step4Send: 'Шаг 4 — Передача файла',
        eta: 'Осталось:',
        speed: 'Скорость:',
        sent: 'Передано:',
        recvTitle: 'Получение файла',
        recvDesc: 'Вставьте ключ отправителя для скачивания',
        step1Recv: 'Шаг 1 — Вставьте ключ отправителя',
        btnScanOff: '📷 Сканировать QR-код отправителя',
        btnCreateAns: 'Создать ответный ключ →',
        step2Recv: 'Шаг 2 — Передайте ответный ключ',
        hintRecv: 'Отправьте этот текст обратно или покажите QR-код',
        step3Recv: 'Шаг 3 — Ожидание и получение файла',
        received: 'Получено:',
        modalTitle: '📷 Сканировать QR-код',
        scanHint: 'Наведите камеру на QR-код',
        faqTitle: 'P2P FILE TRANSFER',
        faqQ1: 'ЧТО ЭТО?',
        faqA1: 'Это инструмент для мгновенной и прямой передачи файлов любой величины между устройствами. Связь устанавливается непосредственно между двумя браузерами.',
        faqQ2: 'КАК ЭТО РАБОТАЕТ?',
        faqA2: 'Технология WebRTC находит кратчайший сетевой маршрут между отправителем и получателем. Файл режется на чанки по 64 КБ, а отправка ждёт освобождения внутреннего буфера канала и подтверждения записи, чтобы не забивать память и не перегружать браузер.',
        faqQ3: 'ПОЧЕМУ ЭТО БЕЗОПАСНО?',
        faqA3: 'Перед отправкой в сеть каждый кусок данных принудительно шифруется локальным криптографическим движком на базе WebAssembly (Rust) по алгоритму AES-256-GCM. Секретные ключи генерируются на вашем компьютере и не передаются на сторонние сервера в открытом виде.',
        faqQ4: 'ЗАЧЕМ ЭТО НУЖНО?',
        faqA4: 'Никаких облачных хранилищ, логов и промежуточных серверов. Файлы не копятся в памяти там, где браузер умеет писать на диск сразу, а реальное ограничение на размер файла зависит от браузера и его встроенных лимитов.',
        faqQ5: 'КАКИЕ БРАУЗЕРЫ ПОДХОДЯТ?',
        faqA5: 'Лучший режим для огромных файлов: Chrome, Edge и другие Chromium-браузеры на HTTPS — они умеют писать файл сразу на диск через File System Access API. Firefox и Safari поддерживают WebRTC, но без прямой записи на диск приложение использует fallback через скачивание, поэтому для очень больших файлов там возможны лимиты памяти.',
        qrReady: 'Готово · {size}',
        qrPart: 'Часть {current} из {total} · {cameraHint}',
        qrCameraHint: 'Наведите камеру',
        cameraNotSupported: 'Камера не поддерживается вашим браузером',
        cameraAccessDenied: 'Доступ к камере запрещен. Разрешите в настройках.',
        cameraError: 'Ошибка камеры: ',
        qrPrev: 'Предыдущая часть',
        qrNext: 'Следующая часть',
        qrPause: 'Приостановить автопрокрутку',
        qrPlay: 'Запустить автопрокрутку',
        btnSaveFile: '📥 Выбрать папку',
        recvStreamStatus: 'Получение файла с прямой записью на диск...',
        saveCanceled: 'Выбор папки отменён. Нажмите кнопку ещё раз или <a href=\"#\" id=\"fallback-blob-link\" style=\"text-decoration:underline;color:inherit;font-weight:600;\">скачайте в память браузера</a>',
        saveNotSupported: 'Запись на диск не поддерживается в этом браузере. Файл будет собран в памяти...',
        saveFallbackActive: 'Запись на диск отменена. Файл будет собран в памяти...',
        savePrompt: 'Нажмите \"Выбрать папку\" для потоковой записи на диск'
    },
    en: {
        brand: 'P2P File Transfer',
        tag: 'END-TO-END ENCRYPTED',
        modeSend: '📤 Sender',
        modeRecv: '📥 Receiver',
        sendTitle: 'Send File',
        sendDesc: 'Initialize connection and generate a key',
        step1Send: 'Step 1 — Select File',
        dropText: 'Click or drag file here',
        dropHint: 'Any file type and size',
        btnCreate: 'Generate Connection Key →',
        step2Send: 'Step 2 — Share Key with Receiver',
        tabText: '📋 Text',
        tabQr: '📱 QR Code',
        copy: 'Copy',
        hintSend: 'Copy text or show the QR code to the receiver',
        step3Send: 'Step 3 — Paste Response Key',
        btnScanAns: '📷 Scan Receiver QR Code',
        btnConnect: 'Connect & Send File',
        step4Send: 'Step 4 — File Transfer',
        eta: 'Remaining:',
        speed: 'Speed:',
        sent: 'Sent:',
        recvTitle: 'Receive File',
        recvDesc: 'Paste sender key to download',
        step1Recv: 'Step 1 — Paste Sender Key',
        btnScanOff: '📷 Scan Sender QR Code',
        btnCreateAns: 'Generate Response Key →',
        step2Recv: 'Step 2 — Share Response Key',
        hintRecv: 'Send this text back or show the QR code',
        step3Recv: 'Step 3 — Waiting & Receiving File',
        received: 'Received:',
        modalTitle: '📷 Scan QR Code',
        scanHint: 'Point your camera at the QR code',
        faqTitle: 'P2P FILE TRANSFER',
        faqQ1: 'WHAT IS IT?',
        faqA1: 'This is a tool for instant, direct file transfer of any size between devices. The connection is established directly between two browsers.',
        faqQ2: 'HOW DOES IT WORK?',
        faqA2: 'WebRTC finds the shortest network route between sender and receiver. Files are split into 64 KB chunks, and sending waits for the channel buffer to drain plus disk-write acknowledgements so the browser is not flooded with queued data.',
        faqQ3: 'WHY IS IT SAFE?',
        faqA3: 'Before anything leaves your device, each chunk is encrypted locally with a WebAssembly-powered Rust crypto engine using AES-256-GCM. Secret keys are generated on your computer and are not sent to third-party servers in plain text.',
        faqQ4: 'WHY DOES THIS MATTER?',
        faqA4: 'There are no cloud storages, logs, or intermediate servers. Files do not pile up in memory where direct disk writing is available, and the real file size limit depends on the browser and its built-in limits.',
        faqQ5: 'WHICH BROWSERS WORK BEST?',
        faqA5: 'Best mode for huge files: Chrome, Edge, and other Chromium browsers over HTTPS because they can write directly to disk with the File System Access API. Firefox and Safari support WebRTC, but without direct disk writing the app falls back to browser download memory, so very large files may hit browser limits.',
        qrReady: 'Ready · {size}',
        qrPart: 'Part {current} of {total} · {cameraHint}',
        qrCameraHint: 'Point your camera',
        cameraNotSupported: 'Camera is not supported by your browser',
        cameraAccessDenied: 'Camera access denied. Please allow it in settings.',
        cameraError: 'Camera error: ',
        qrPrev: 'Previous part',
        qrNext: 'Next part',
        qrPause: 'Pause auto-rotation',
        qrPlay: 'Resume auto-rotation',
        btnSaveFile: '📥 Choose folder',
        recvStreamStatus: 'Receiving file with direct disk write...',
        saveCanceled: 'Folder selection canceled. Click the button again or <a href=\"#\" id=\"fallback-blob-link\" style=\"text-decoration:underline;color:inherit;font-weight:600;\">download to browser memory</a>',
        saveNotSupported: 'Direct disk write is not supported in this browser. File will be buffered in memory...',
        saveFallbackActive: 'Disk write canceled. File will be buffered in memory...',
        savePrompt: 'Click \"Choose folder\" for direct streaming to disk'
    }
};

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
    currentLang = i18n[lang] ? lang : 'ru';
    document.documentElement.lang = currentLang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const key = el.getAttribute('data-i18n');
        const value = i18n[currentLang][key];
        if (value != null) el.textContent = value;
    });
    document.getElementById('lang-ru').classList.toggle('active', currentLang === 'ru');
    document.getElementById('lang-en').classList.toggle('active', currentLang === 'en');
}

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

function setStep(prefix, activeStep) {
    for (let i = 1; i <= 4; i++) {
        const stepEl = document.getElementById(`${prefix}-step${i}`);
        if (!stepEl) continue;
        stepEl.classList.remove('active', 'done');
        if (i < activeStep) stepEl.classList.add('done');
        if (i === activeStep) stepEl.classList.add('active');
    }
}

function showStatus(id, type, text, spinner = false) {
    const el = document.getElementById(id);
    el.className = 'status-bar visible ' + type;
    el.innerHTML = (spinner ? '<div class="spinner"></div> ' : '') + text;
}

function setProgress(fillId, textId, pctId, pct, text) {
    document.getElementById(fillId).style.width = pct + '%';
    document.getElementById(textId).textContent = text;
    document.getElementById(pctId).textContent = pct + '%';
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
    if (name.length <= 40) return name;
    const ext = name.lastIndexOf('.');
    if (ext > 0) return name.slice(0, 18) + '…' + name.slice(ext);
    return name.slice(0, 38) + '…';
}

function fmtETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '—';
    if (seconds < 60) return Math.ceil(seconds) + ' сек';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' мин ' + Math.ceil(seconds % 60) + ' сек';
    return Math.floor(seconds / 3600) + ' ч ' + Math.floor((seconds % 3600) / 60) + ' мин';
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
        btn.textContent = 'Скопировано!';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = 'Копировать';
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
    if (sendAckCleanup) {
        sendAckCleanup();
        sendAckCleanup = null;
    }
    sendAckResolver = null;
    stopQRCycler();
    clearFile();
    document.getElementById('btnCreateOffer').textContent = 'Создать ключ';
    const offerKeyBox = document.getElementById('offerKeyBox');
    if (offerKeyBox) offerKeyBox.style.display = 'none';
    document.getElementById('offerKey').value = '';
    document.getElementById('offerQRNote').textContent = '';
    document.getElementById('offerQR').innerHTML = '';
    document.getElementById('answerInput').value = '';
    if (!preserveStatus) {
        document.getElementById('sendStatus').className = 'status-bar';
        document.getElementById('sendStatus').textContent = '';
    }
    document.getElementById('sendProgress').classList.remove('visible');
    resetSendProgressUI();
    setStep('s', 1);
}

function resetReceiver(preserveStatus = false) {
    if (receiverPC) { receiverPC.close(); receiverPC = null; }
    stopQRCycler();
    recvBuffers = [];
    recvTotal = 0;
    writableStream = null;
    scanTargetId = null;
    
    document.getElementById('offerInput').value = '';
    document.getElementById('answerKey').value = '';
    document.getElementById('answerQRNote').textContent = '';
    document.getElementById('answerQR').innerHTML = '';
    if (!preserveStatus) {
        document.getElementById('recvStatus').className = 'status-bar';
        document.getElementById('recvStatus').textContent = '';
    }
    document.getElementById('recvProgress').classList.remove('visible');
    resetRecvProgressUI();
    const saveBtn = document.getElementById('btnSaveFile');
    if (saveBtn) {
        saveBtn.style.display = 'none';
        saveBtn.onclick = null;
    }
    setStep('r', 1);
}

async function createOffer() {
    if (!selectedFile) return;
    if (!await ensureCrypto()) {
        showStatus('sendStatus', 'error', 'Не удалось загрузить криптомодуль');
        return;
    }
    
    const btn = document.getElementById('btnCreateOffer');
    const defaultLabel = 'Создать ключ соединения →';
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div> Создание...';
    try {
        senderPC = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const channel = senderPC.createDataChannel('fileTransfer', { ordered: true });
        channel.binaryType = 'arraybuffer';
        channel.bufferedAmountLowThreshold = SEND_BUFFER_LOW_THRESHOLD;

        channel.onopen = () => {
            setStep('s', 4);
            showStatus('sendStatus', 'info', 'Подключено. Ожидание готовности получателя...', true);
            channel.send(JSON.stringify({ __meta__: true, name: selectedFile.name, size: selectedFile.size }));
        };

        channel.onmessage = (e) => {
            if (e.data === '__ready_stream__') {
                showStatus('sendStatus', 'info', 'Получатель готов. Стримим файл на диск...', true);
                document.getElementById('sendProgress').classList.add('visible');
                sendFileChunked(channel, selectedFile, true);
                return;
            }

            if (e.data === '__ready_blob__') {
                showStatus('sendStatus', 'info', 'Получатель готов. Передача файла...', true);
                document.getElementById('sendProgress').classList.add('visible');
                sendFileChunked(channel, selectedFile, false);
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

        await new Promise(resolve => {
            if (senderPC.iceGatheringState === 'complete') return resolve();
            senderPC.onicegatheringstatechange = () => {
                if (senderPC.iceGatheringState === 'complete') resolve();
            };
            setTimeout(resolve, 7000);
        });

        const sdpData = JSON.stringify({ sdp: senderPC.localDescription.sdp, type: senderPC.localDescription.type });
        const packedKey = await pack_key(sdpData);
        
        document.getElementById('offerKey').value = packedKey;
        btn.innerHTML = 'Ключ создан';
        
        generateChunkedQR('offerQR', 'offerQRNote', packedKey);
        setStep('s', 3);
    } catch (e) {
        if (senderPC) { senderPC.close(); senderPC = null; }
        showStatus('sendStatus', 'error', 'Ошибка создания ключа: ' + e.message);
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
        const onClose = () => { cleanup(); reject(new Error('Канал передачи закрыт')); };
        const onError = () => { cleanup(); reject(new Error('Ошибка канала передачи')); };

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
            reject(new Error('Канал передачи закрыт'));
        };

        const onError = () => {
            cleanup();
            reject(new Error('Ошибка канала передачи'));
        };

        channel.addEventListener('close', onClose, { once: true });
        channel.addEventListener('error', onError, { once: true });
        sendAckCleanup = cleanup;
        // Assign resolver LAST — after listeners are set, to avoid race
        sendAckResolver = resolve;
    });
}

async function sendFileChunked(channel, file, requireAck = false) {
    let offset = 0;
    const startTime = Date.now();
    let lastTime = startTime;
    let lastOffset = 0;

    try {
        while (offset < file.size) {
            await waitForSendBuffer(channel);
            if (channel.readyState !== 'open') throw new Error('Канал передачи не открыт');

            const chunk = await file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
            const ackPromise = requireAck ? waitForSendAck(channel) : null;
            channel.send(chunk);
            if (ackPromise) await ackPromise;
            offset += chunk.byteLength;

            const pct = file.size ? Math.min(100, Math.round(offset / file.size * 100)) : 100;
            setProgress('progressFill', 'sendSent', 'progressPct', pct, `Отправлено: ${fmtSize(offset)} / ${fmtSize(file.size)}`);

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

            const avgSpeed = elapsed > 0 ? offset / elapsed : 0;
            const eta = avgSpeed > 0 ? (file.size - offset) / avgSpeed : Infinity;
            document.getElementById('sendETA').textContent = fmtETA(eta);
        }

        await waitForSendBuffer(channel);
        if (channel.readyState === 'open') {
            channel.send('__done__');
            showStatus('sendStatus', 'success', 'Файл успешно отправлен!');
            setProgress('progressFill', 'sendSent', 'progressPct', 100, 'Завершено');
            document.getElementById('sendETA').textContent = '0 сек';
            document.getElementById('sendSent').textContent = fmtSize(file.size) + ' / ' + fmtSize(file.size);
            setTimeout(() => resetSender(true), 2000);
        }
    } catch (e) {
        showStatus('sendStatus', 'error', 'Ошибка передачи: ' + e.message);
    }
}

async function applyAnswer() {
    const rawKey = document.getElementById('answerInput').value.trim();
    if (!rawKey) return;
    if (!await ensureCrypto()) {
        showStatus('sendStatus', 'error', 'Не удалось загрузить криптомодуль');
        return;
    }

    setStep('s', 4);
    showStatus('sendStatus', 'info', 'Применение ответа...', true);

    let answerObj;
    try {
        const unpacked = await unpack_key(rawKey);
        answerObj = JSON.parse(unpacked);
    } catch {
        try {
            answerObj = JSON.parse(rawKey);
        } catch {
            return showStatus('sendStatus', 'error', 'Неверный формат ключа ответа');
        }
    }

    try {
        await senderPC.setRemoteDescription(new RTCSessionDescription(answerObj));
    } catch (e) {
        showStatus('sendStatus', 'error', 'Ошибка подключения: ' + e.message);
    }
}

async function createAnswer() {
    const rawKey = document.getElementById('offerInput').value.trim();
    if (!rawKey) return;
    if (!await ensureCrypto()) {
        showStatus('recvStatus', 'error', 'Не удалось загрузить криптомодуль');
        return;
    }

    let offerObj;
    try {
        const unpacked = await unpack_key(rawKey);
        offerObj = JSON.parse(unpacked);
    } catch {
        try {
            offerObj = JSON.parse(rawKey);
        } catch {
            return showStatus('recvStatus', 'error', 'Неверный формат ключа');
        }
    }

    try {
        receiverPC = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        recvBuffers = [];
        recvTotal = 0;

        let fileName = 'received_file';
        let fileSize = 0;
        let startTime = null;
        let lastTime = null;
        let lastRecv = 0;

        receiverPC.ondatachannel = (e) => {
            const channel = e.channel;
            channel.binaryType = 'arraybuffer';

            channel.onmessage = async (ev) => {
            if (typeof ev.data === 'string') {
                if (ev.data === '__done__') {
                    if (writableStream) {
                        try {
                            await writableStream.close();
                        } catch (e) { console.error('Ошибка закрытия потока:', e); }
                        writableStream = null;
                    } else {
                        const blob = new Blob(recvBuffers);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url; a.download = fileName; a.click();
                        URL.revokeObjectURL(url);
                    }

                    showStatus('recvStatus', 'success', `Файл "${fmtName(fileName)}" (${fmtSize(fileSize)}) успешно получен!`);
                    setProgress('recvProgressFill', 'recvReceived', 'recvProgressPct', 100, 'Завершено');
                    document.getElementById('recvETA').textContent = '0 сек';
                    
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

                        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                        if ('showSaveFilePicker' in window && !isMobile) {
                            const btnSave = document.getElementById('btnSaveFile');
                            if (btnSave) {
                                btnSave.style.display = 'inline-flex';
                                btnSave.textContent = '📥 Выбрать папку';
                                btnSave.onclick = async () => {
                                    try {
                                        const handle = await window.showSaveFilePicker({ suggestedName: fileName });
                                        writableStream = await handle.createWritable();
                                        btnSave.style.display = 'none';
                                        channel.send('__ready_stream__');
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
                                            // Fallback automatically if it's a TypeError or NotSupportedError (e.g. Samsung Internet stub)
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
                            channel.send('__ready_blob__');
                            setStep('r', 3);
                            showStatus('recvStatus', 'warning', 'Браузер не умеет писать напрямую на диск. Файл будет собран в памяти и скачан в конце.', true);
                            document.getElementById('recvProgress').classList.add('visible');
                            startTime = Date.now(); lastTime = startTime; lastRecv = 0;
                        }
                    }
                } catch (e) { console.error('Parse metadata error:', e); }
                return;
            }

            if (writableStream) {
                try {
                    await writableStream.write(ev.data);
                    if (channel.readyState === 'open') {
                        channel.send('__ack__');
                    }
                } catch (e) {
                    console.error('Write error:', e);
                }
            } else {
                recvBuffers.push(ev.data);
            }

            recvTotal += ev.data.byteLength;
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
                showStatus('recvStatus', 'info', 'Канал открыт. Ожидание метаданных...', true);
                document.getElementById('recvProgress').classList.add('visible');
            };
        };

        await receiverPC.setRemoteDescription(new RTCSessionDescription(offerObj));
        const answer = await receiverPC.createAnswer();
        await receiverPC.setLocalDescription(answer);

        await new Promise(resolve => {
            if (receiverPC.iceGatheringState === 'complete') return resolve();
            receiverPC.onicegatheringstatechange = () => {
                if (receiverPC.iceGatheringState === 'complete') resolve();
            };
            setTimeout(resolve, 7000);
        });

        const sdpData = JSON.stringify({ sdp: receiverPC.localDescription.sdp, type: receiverPC.localDescription.type });
        const packedKey = await pack_key(sdpData);
        
        document.getElementById('answerKey').value = packedKey;
        generateChunkedQR('answerQR', 'answerQRNote', packedKey);
        setStep('r', 3);
        showStatus('recvStatus', 'info', 'Соединение готово. Ожидание файла...', true);
        document.getElementById('recvProgress').classList.add('visible');
    } catch (e) {
        if (receiverPC) { receiverPC.close(); receiverPC = null; }
        showStatus('recvStatus', 'error', 'Ошибка создания ответа: ' + e.message);
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

function generateChunkedQR(containerId, noteId, dataStr) {
    stopQRCycler();
    const container = document.getElementById(containerId);
    const note = document.getElementById(noteId);
    container.innerHTML = '';
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

        scanStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } 
        });
        
        const video = document.getElementById('scanVideo');
        video.srcObject = scanStream;
        await video.play();
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

function startJsQRLoop() {
    const video = document.getElementById('scanVideo');
    const canvas = document.getElementById('scanCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function tick() {
        if (!scanStream) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            if (scanDetector) {
                try {
                    const codes = await scanDetector.detect(video);
                    if (codes && codes.length > 0 && codes[0].rawValue) {
                        processScannedChunk(codes[0].rawValue);
                    }
                } catch (err) {
                    scanDetector = null;
                }
            }

            const w = Math.min(video.videoWidth || 640, 960);
            const h = Math.round(w * ((video.videoHeight || 480) / (video.videoWidth || 640)));
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
    scanRafId = requestAnimationFrame(tick);
}

function processScannedChunk(data) {
    const status = document.getElementById('scanStatus');

    if (data.startsWith('P2P|')) {
        const parts = data.split('|');
        if (parts.length === 4) {
            const total = parseInt(parts[1]);
            const idx = parseInt(parts[2]);
            const payload = parts[3];

            totalExpectedChunks = total;
            scannedChunks[idx] = payload;

            const collected = Object.keys(scannedChunks).length;
            status.textContent = `Собрано частей: ${collected} из ${total}`;
            status.style.color = 'var(--blue)';

            if (collected === total) {
                let fullData = '';
                for (let i = 1; i <= total; i++) {
                    fullData += scannedChunks[i];
                }
                document.getElementById(scanTargetId).value = fullData;
                status.textContent = 'QR-код успешно собран!';
                status.style.color = 'var(--green)';
                setTimeout(closeScanner, 800);
            }
            return;
        }
    }

    document.getElementById(scanTargetId).value = data;
    status.textContent = 'QR-код отсканирован!';
    status.style.color = 'var(--green)';
    setTimeout(closeScanner, 500);
}

function closeScanner() {
    cancelAnimationFrame(scanRafId);
    if (scanStream) {
        scanStream.getTracks().forEach(t => t.stop());
        scanStream = null;
    }
    scanDetector = null;
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

setLang('ru');

window.setMode = setMode;
window.setLang = setLang;
window.handleDrop = handleDrop;
window.handleFile = handleFile;
window.clearFile = clearFile;
window.createOffer = createOffer;
window.applyAnswer = applyAnswer;
window.copyText = copyText;
window.switchTab = switchTab;
window.openScanner = openScanner;
window.closeScanner = closeScanner;
window.createAnswer = createAnswer;
window.fmtSize = fmtSize;
