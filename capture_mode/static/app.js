const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const messageInput = document.getElementById('message');
const startBtn = document.getElementById('start-btn');
const captureDot = document.getElementById('capture-dot');
const captureText = document.getElementById('capture-text');

const menuScreen = document.getElementById('menu-screen');
const appScreen = document.getElementById('app-screen');
const lessonsBtn = document.getElementById('lessons-btn');
const freeBtn = document.getElementById('free-btn');
const backBtn = document.getElementById('back-btn');

let stream = null;
let ws = null;
let sendingInterval = null;

const overlayCtx = overlay.getContext('2d');

let frameSeq = 0;

async function showAnnotatedFrame(blob) {
  const seq = ++frameSeq;
  const bitmap = await createImageBitmap(blob);

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

function setStatus(msg) {
  captureDot.classList.toggle('active', msg.capturing);
  const movement = typeof msg.movement === 'number' ? msg.movement.toFixed(2) : '--';
  captureText.textContent = `${msg.capturing ? 'Capturing' : 'Not Capturing'} · ${movement}`;

  if (msg.discarded && !pendingStepTimer) {
    messageInput.value = 'Capture too short, discarded';
  }
}

const STEP_ADVANCE_DELAY_MS = 1200;
let pendingStepTimer = null;

function stepPrompt(msg) {
  return msg.completed
    ? 'Lesson completed!'
    : `Step ${msg.step_index + 1}/${msg.total_steps} — Do: ${msg.target_display}`;
}

function showLesson(msg) {
  if (pendingStepTimer) {
    clearTimeout(pendingStepTimer);
    pendingStepTimer = null;
  }

  if (!msg.attempted_display) {
    messageInput.value = stepPrompt(msg);
    return;
  }

  if (msg.correct) {
    messageInput.value = `✓ Step ${msg.step_index}/${msg.total_steps} — ${msg.attempted_display} correct!`;
    pendingStepTimer = setTimeout(() => {
      pendingStepTimer = null;
      messageInput.value = stepPrompt(msg);
    }, STEP_ADVANCE_DELAY_MS);
    return;
  }

  messageInput.value = `${stepPrompt(msg)} — recognized: ${msg.last_gloss} ✗`;
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
    if (event.data instanceof Blob) {
      showAnnotatedFrame(event.data);
      return;
    }

    const msg = JSON.parse(event.data);
    if (msg.error) {
      messageInput.value = `Error: ${msg.error}`;
      return;
    }

    if (msg.type === 'status') {
      setStatus(msg);
      return;
    }

    if (msg.type === 'lesson') {
      showLesson(msg);
      return;
    }

    // type === 'recognition' (free mode)
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

function stopCamera() {
  if (sendingInterval) {
    clearInterval(sendingInterval);
    sendingInterval = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  if (video.srcObject) {
    video.srcObject = null;
  }
  startBtn.textContent = 'Start Camera';
  startBtn.disabled = false;
  messageInput.value = '';
  captureText.textContent = 'Not Capturing';
  captureDot.classList.remove('active');
}

function goToApp() {
  menuScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
}

function goToMenu() {
  stopCamera();
  appScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
}

// Inizializzazione: menu all'apertura
function init() {
  // Assicurati che il menu sia visibile e l'app nascosta
  menuScreen.classList.remove('hidden');
  appScreen.classList.add('hidden');

  lessonsBtn.addEventListener('click', () => {
    // per fare più lezioni, puoi cambiare URL o passare un parametro
    // Esempio: window.location.search = '?lesson=lesson1';
    // Per ora, si utilizza quello che c'è già nell'URL
    goToApp();
  });

  freeBtn.addEventListener('click', () => {
    // Per la modalità libera, rimuovi il parametro lesson
    const newUrl = window.location.pathname;
    if (window.location.search) {
      history.replaceState({}, '', newUrl);
    }
    goToApp();
  });

  backBtn.addEventListener('click', goToMenu);
}

startBtn.addEventListener('click', startCamera);

init();