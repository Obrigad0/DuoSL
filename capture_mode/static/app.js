
const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const messageInput = document.getElementById('message');
const startBtn = document.getElementById('start-btn');
const captureDot = document.getElementById('capture-dot');
const captureText = document.getElementById('capture-text');

let stream = null;
let ws = null;
let sendingInterval = null;

const overlayCtx = overlay.getContext('2d');

// Il server rimanda il frame gia' annotato (immagine + scheletro disegnato da
// MediaPipe stesso): qui lo disegniamo sul canvas, che copre il <video> live.
// Immagine e scheletro sono gli stessi pixel, quindi non possono sfasarsi.
// Lo specchio e' puramente visivo, applicato via CSS al canvas.
let frameSeq = 0;

async function showAnnotatedFrame(blob) {
  const seq = ++frameSeq;
  const bitmap = await createImageBitmap(blob);

  // Se nel frattempo e' arrivato un frame piu' recente, scarta questo.
  if (seq !== frameSeq) {
    bitmap.close();
    return;
  }

  if (overlay.width !== bitmap.width || overlay.height !== bitmap.height) {
    overlay.width = bitmap.width;
    overlay.height = bitmap.height;
  }
  overlayCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

// Mostra anche il valore di movimento (EMA) accanto allo stato: serve a tarare
// le soglie guardando i numeri reali della propria webcam, invece di indovinare.
function setStatus(msg) {
  captureDot.classList.toggle('active', msg.capturing);
  const movement = typeof msg.movement === 'number' ? msg.movement.toFixed(2) : '--';
  captureText.textContent = `${msg.capturing ? 'Capturing' : 'Not Capturing'} · ${movement}`;

  // Non sovrascrivere la conferma di uno step appena superato.
  if (msg.discarded && !pendingStepTimer) {
    messageInput.value = 'Cattura troppo breve, scartata';
  }
}

// Quando uno step viene superato mostriamo prima la conferma, e solo dopo una
// pausa passiamo alla richiesta successiva: altrimenti le due informazioni
// arrivano insieme e non si capisce di aver completato il segno.
const STEP_ADVANCE_DELAY_MS = 1200;
let pendingStepTimer = null;

function stepPrompt(msg) {
  return msg.completed
    ? 'Lezione completata!'
    : `Step ${msg.step_index + 1}/${msg.total_steps} — Fai: ${msg.target_display}`;
}

function showLesson(msg) {
  if (pendingStepTimer) {
    clearTimeout(pendingStepTimer);
    pendingStepTimer = null;
  }

  // Nessun tentativo ancora fatto: e' il messaggio iniziale della lezione.
  if (!msg.attempted_display) {
    messageInput.value = stepPrompt(msg);
    return;
  }

  if (msg.correct) {
    // step_index e' gia' avanzato, quindi lo step appena superato e' step_index (1-based).
    messageInput.value = `✓ Step ${msg.step_index}/${msg.total_steps} — ${msg.attempted_display} corretto!`;
    pendingStepTimer = setTimeout(() => {
      pendingStepTimer = null;
      messageInput.value = stepPrompt(msg);
    }, STEP_ADVANCE_DELAY_MS);
    return;
  }

  messageInput.value = `${stepPrompt(msg)} — riconosciuto: ${msg.last_gloss} ✗`;
}

function resizeOverlay() {
  if (!video.videoWidth) return;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

video.addEventListener('loadeddata', resizeOverlay);

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host || 'localhost:8001';
  const lesson = new URLSearchParams(window.location.search).get('lesson');
  const wsUrl = lesson ? `${protocol}//${host}/ws?lesson=${encodeURIComponent(lesson)}` : `${protocol}//${host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connected');
    messageInput.value = 'Connected to sign model.';
  };

  ws.onmessage = (event) => {
    // Frame annotato dal server (binario): immagine + scheletro insieme.
    if (event.data instanceof Blob) {
      showAnnotatedFrame(event.data);
      return;
    }

    const msg = JSON.parse(event.data);
    if (msg.error) {
      messageInput.value = `Error: ${msg.error}`;
      return;
    }

    // Messaggio veloce (ogni frame): stato Capturing/Not Capturing,
    // nessuna chiamata al modello coinvolta.
    if (msg.type === 'status') {
      setStatus(msg);
      return;
    }

    // Messaggio raro (una volta per gesto isolato catturato).
    if (msg.type === 'lesson') {
      showLesson(msg);
      return;
    }

    // type === 'recognition' (modalita' libera)
    const { gloss, confidence } = msg;
    messageInput.value = `Detected sign: ${gloss} (conf: ${(confidence * 100).toFixed(0)}%)`;
  };

  ws.onclose = (event) => {
    console.log('WebSocket closed');
    messageInput.value = event.reason ? `Disconnected: ${event.reason}` : 'Disconnected from model server.';
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    messageInput.value = 'WebSocket error.';
  };
}

async function startCamera() {
  if (stream) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user'
      },
      audio: false
    });

    video.srcObject = stream;
    await video.play();
    resizeOverlay();

    connectWebSocket();

    const fps = 20;
    const interval = 1000 / fps;

    sendingInterval = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!video.videoWidth) return;

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob((blob) => {
        if (blob && ws.readyState === WebSocket.OPEN) {
          ws.send(blob);
        }
      }, 'image/jpeg', 0.8);
    }, interval);

    messageInput.value = 'Camera active. Sending frames to model...';
    startBtn.textContent = 'Camera ON';
    startBtn.disabled = true;
  } catch (err) {
    console.error('Error accessing webcam:', err);
    messageInput.value = 'Error: could not access webcam.';
  }
}

startBtn.addEventListener('click', startCamera);
