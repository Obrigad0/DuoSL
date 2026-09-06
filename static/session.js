// static/session.js
//
// Trasporto: webcam -> WebSocket -> frame annotati e messaggi del server.
// Non sa nulla di lezioni ne' tocca il DOM oltre al proprio <video> e <canvas>:
// espone callback, cosi' la stessa sessione serve sia la schermata lezione sia
// il Free Training senza duplicare la logica di camera e socket.

const FPS = 20;
const JPEG_QUALITY = 0.92;

/** Errori della camera tradotti in categorie che la UI sa mostrare. */
function cameraErrorKind(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'nocam';
    case 'NotReadableError':      // la camera esiste ma un'altra app la tiene
      return 'busy';
    default:
      return 'unknown';
  }
}

export class SignSession {
  /**
   * @param {object} o
   * @param {string|null} o.lesson  id della lezione, null per il free training
   * @param {HTMLVideoElement} o.video   sorgente grezza della webcam
   * @param {HTMLCanvasElement} o.canvas dove finisce il frame annotato dal server
   */
  constructor(o) {
    this.lessonId = o.lesson || null;
    this.video = o.video;
    this.canvas = o.canvas;
    this.ctx = o.canvas.getContext('2d');

    this.on = {
      frame: o.onFrame || (() => {}),
      status: o.onStatus || (() => {}),
      lesson: o.onLesson || (() => {}),
      lessonMeta: o.onLessonMeta || (() => {}),
      recognition: o.onRecognition || (() => {}),
      open: o.onOpen || (() => {}),
      close: o.onClose || (() => {}),
      error: o.onError || (() => {}),
    };

    this.stream = null;
    this.ws = null;
    this.timer = null;
    this.running = false;
    // Quando e' true i frame non partono: il server non riceve nulla, quindi
    // non segmenta e non classifica. Serve al conto alla rovescia iniziale e
    // alla pausa della lezione, dove l'utente e' inquadrato ma sta guardando
    // la demo, non eseguendo il segno.
    this.paused = false;

    // I frame annotati arrivano gia' decodificati in ordine, ma createImageBitmap
    // e' asincrono: senza questo contatore un frame vecchio decodificato tardi
    // potrebbe sovrascriverne uno piu' recente.
    this.frameSeq = 0;

    // Una sola canvas di cattura riusata per tutti i frame: crearne una nuova
    // 20 volte al secondo costringe il GC a lavorare per niente.
    this.grabCanvas = document.createElement('canvas');
    this.grabCtx = this.grabCanvas.getContext('2d');
  }

  get isRunning() { return this.running; }

  async start() {
    if (this.running) return;
    this.running = true;

    // Il socket si apre PRIMA di chiedere la camera, di proposito: se il
    // permesso viene negato l'utente vede comunque di che lezione si tratta
    // (parola, demo, progresso) mentre sistema l'autorizzazione, invece di
    // trovarsi una schermata vuota.
    this._connect();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      this.on.error(cameraErrorKind(err), err);
      return;
    }

    if (!this.running) {          // fermata mentre si aspettava il permesso
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      return;
    }

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch { /* alcuni browser rifiutano play() finche' il video non e' visibile */ }

    this._pump();
  }

  stop() {
    this.running = false;

    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (this.ws) {
      // Evita che la chiusura volontaria arrivi alla UI come disconnessione
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;

    // Invalida i frame ancora in decodifica e pulisce l'ultimo fotogramma:
    // senza questo resta a schermo l'immagine dell'utente a camera spenta.
    this.frameSeq++;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Sospende/riprende l'invio dei frame senza toccare camera ne' socket. */
  setPaused(on) { this.paused = !!on; }

  _command(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  /** Chiede al server di saltare lo step corrente (solo in modalita' lezione). */
  skip() { this._command({ type: 'skip' }); }

  /** Riporta la sessione server a uno step: serve dopo una riconnessione. */
  goto(index) { this._command({ type: 'goto', index }); }

  _connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = this.lessonId
      ? `${protocol}//${location.host}/ws?lesson=${encodeURIComponent(this.lessonId)}`
      : `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => this.on.open();

    this.ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        this._paint(event.data);
        return;
      }

      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'status':      this.on.status(msg); break;
        case 'lesson':      this.on.lesson(msg); break;
        case 'lesson_meta': this.on.lessonMeta(msg); break;
        case 'recognition': this.on.recognition(msg); break;
      }
    };

    this.ws.onclose = (event) => this.on.close(event);
    this.ws.onerror = () => this.on.error('socket', null);
  }

  async _paint(blob) {
    const seq = ++this.frameSeq;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch { return; }

    if (seq !== this.frameSeq) { bitmap.close(); return; }

    if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
      this.canvas.width = bitmap.width;
      this.canvas.height = bitmap.height;
    }
    this.ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    this.on.frame();
  }

  _pump() {
    this.timer = setInterval(() => {
      if (this.paused) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (!this.video.videoWidth) return;

      const c = this.grabCanvas;
      if (c.width !== this.video.videoWidth || c.height !== this.video.videoHeight) {
        c.width = this.video.videoWidth;
        c.height = this.video.videoHeight;
      }
      this.grabCtx.drawImage(this.video, 0, 0, c.width, c.height);

      c.toBlob((blob) => {
        if (blob && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(blob);
        }
      }, 'image/jpeg', JPEG_QUALITY);
    }, 1000 / FPS);
  }
}
