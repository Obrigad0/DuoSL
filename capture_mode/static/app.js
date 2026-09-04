
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

// Topologia fissa delle 21 landmark di una mano (MediaPipe Hands), coppie di indici da collegare.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17]
];

// Il video e' mirrorato via CSS (transform: scaleX(-1)) per un effetto
// "specchio" naturale. Il server calcola i landmark sul frame NON mirrorato
// (quello effettivamente inviato), quindi qui capovolgiamo la coordinata x
// per farli combaciare con quello che l'utente vede a video.
function mirroredX(x) {
  return (1 - x) * overlay.width;
}

function drawHand(points, color) {
  if (!points) return;
  overlayCtx.strokeStyle = color;
  overlayCtx.fillStyle = color;
  overlayCtx.lineWidth = 3;
  overlayCtx.lineCap = 'round';

  for (const [a, b] of HAND_CONNECTIONS) {
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    overlayCtx.beginPath();
    overlayCtx.moveTo(mirroredX(ax), ay * overlay.height);
    overlayCtx.lineTo(mirroredX(bx), by * overlay.height);
    overlayCtx.stroke();
  }

  for (const [x, y] of points) {
    overlayCtx.beginPath();
    overlayCtx.arc(mirroredX(x), y * overlay.height, 4.5, 0, 2 * Math.PI);
    overlayCtx.fill();
  }
}

function drawLandmarks(landmarks) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (!landmarks) return;
  drawHand(landmarks.left, '#86efac');
  drawHand(landmarks.right, '#5eead4');
}

function setCapturing(capturing) {
  captureDot.classList.toggle('active', capturing);
  captureText.textContent = capturing ? 'Capturing' : 'Not Capturing';
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
    const msg = JSON.parse(event.data);
    if (msg.error) {
      messageInput.value = `Error: ${msg.error}`;
      return;
    }

    // Messaggio veloce (ogni frame): skeleton + stato Capturing/Not Capturing,
    // nessuna chiamata al modello coinvolta.
    if (msg.type === 'status') {
      drawLandmarks(msg.landmarks);
      setCapturing(msg.capturing);
      return;
    }

    // Messaggio raro (una volta per gesto isolato catturato).
    if (msg.type === 'lesson') {
      if (msg.completed) {
        messageInput.value = 'Lesson complete!';
        return;
      }
      const step = `Step ${msg.step_index + 1}/${msg.total_steps}`;
      const target = `Target: ${msg.target_display}`;
      const result = msg.correct
        ? `Correct! (recognized: ${msg.last_gloss})`
        : `Try again — recognized: ${msg.last_gloss}`;
      messageInput.value = `${step} — ${target} — ${result}`;
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
