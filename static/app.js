// app.js

const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const messageInput = document.getElementById('message');
const startBtn = document.getElementById('start-btn');
const clearBtn = document.getElementById('clear-btn');
const signsListEl = document.getElementById('signs-list');

let stream = null;
let ws = null;
let sendingInterval = null;

// Lista dei segni rilevati
let detectedSigns = [];

function resizeOverlay() {
  if (!video.videoWidth) return;
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
}

video.addEventListener('loadeddata', resizeOverlay);

function connectWebSocket() {
  const protocol = 'ws:';
  const host = 'localhost:8000';
  ws = new WebSocket(`${protocol}//${host}/ws`);

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
    const { gloss, confidence } = msg;

    if (gloss) {
      messageInput.value = `Detected: ${gloss} (conf: ${confidence.toFixed(2)})`;
      addSign(gloss);
    } else {
      messageInput.value = `No confident sign (conf: ${confidence.toFixed(2)})`;
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed');
    messageInput.value = 'Disconnected from model server.';
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    messageInput.value = 'WebSocket error.';
  };
}

function addSign(gloss) {
  detectedSigns.push(gloss);
  renderSignsList();
}

function renderSignsList() {
  signsListEl.innerHTML = '';
  detectedSigns.forEach((sign) => {
    const div = document.createElement('div');
    div.className = 'sign-item';
    div.textContent = sign;
    signsListEl.appendChild(div);
  });
  // scroll to bottom
  signsListEl.scrollTop = signsListEl.scrollHeight;
}

function clearSigns() {
  detectedSigns = [];
  renderSignsList();
  messageInput.value = '';
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

      const dataURL = canvas.toDataURL('image/jpeg', 0.8);

      ws.send(JSON.stringify({ image: dataURL }));
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
clearBtn.addEventListener('click', clearSigns);