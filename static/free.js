// static/free.js
//
// Free Practice: nessun copione, nessun passo da seguire. L'utente fa un segno
// qualunque e la schermata gli dice che cosa ha letto.
//
// Stessa idea della lezione — l'occhio sta sulla propria immagine — ma qui
// l'informazione arriva DOPO il gesto invece che prima, quindi il box del
// segno sta sotto la webcam e non sopra. Accanto alla camera compare una demo
// solo se l'utente sceglie un segno dalla libreria: quando non serve, quello
// spazio torna alla webcam.

import { SignSession } from './session.js';
import { Speech } from './speech.js';
import { LibraryDrawer } from './library.js';

const $ = (id) => document.getElementById(id);

const HINT_MS = 2400;

/**
 * Sotto quanta confidenza un gesto non viene mostrato come segno riconosciuto.
 *
 * Il classificatore risponde SEMPRE qualcosa: ogni cattura produce un argmax,
 * anche quando l'utente si e' solo grattato il naso. Senza una soglia il
 * Free Practice nomina un segno per ogni movimento, e la parola grande a
 * schermo suggerisce una sicurezza che non c'e'.
 *
 * 45% e' un punto di partenza, non una verita': il softmax di questo modello
 * non e' calibrato, per questo la soglia si regola da un pannello invece di
 * stare fissa nel codice.
 */
const DEFAULT_MIN_CONF = 45;
const CONF_KEY = 'duosl.confMin';

const DISCARD_HINT = {
  troppo_breve: 'Hold the sign a little longer',
  mani_non_visibili: 'Keep your hands in frame',
};

const CAMERA_TROUBLE = {
  denied: {
    icon: '#i-camera',
    title: 'Camera access needed',
    text: 'Free practice reads your signs from the webcam. Allow camera access in your browser’s address bar, then try again.',
  },
  nocam: {
    icon: '#i-alert',
    title: 'No camera found',
    text: 'Connect a webcam and try again, sign recognition needs a live video feed.',
  },
  busy: {
    icon: '#i-alert',
    title: 'Camera already in use',
    text: 'Another app seems to be using the webcam. Close it and try again.',
  },
  unknown: {
    icon: '#i-alert',
    title: 'Could not start the camera',
    text: 'Something went wrong while opening the webcam. Try again.',
  },
};


export class FreeView {
  constructor({ onExit }) {
    this.onExit = onExit;

    this.el = {
      screen: $('app-screen'),
      exit: $('free-exit'),
      voiceToggle: $('free-voice'),
      voiceLabel: $('free-voice-label'),

      stage: $('free-stage'),
      demoCol: $('free-demo-col'),
      demoTag: $('free-demo-tag'),
      demo: $('free-demo-video'),
      demoClose: $('free-demo-close'),
      demoPlay: $('free-demo-play'),
      demoSlow: $('free-demo-slow'),
      demoMirror: $('free-demo-mirror'),

      cam: $('free-cam-card'),
      webcam: $('free-webcam'),
      overlay: $('free-overlay'),
      badgeText: $('free-badge-text'),
      hint: $('free-hint'),
      cover: $('free-cover'),
      coverIcon: $('free-cover-icon'),
      coverTitle: $('free-cover-title'),
      coverText: $('free-cover-text'),
      coverActions: $('free-cover-actions'),

      debugToggle: $('free-debug-toggle'),
      debug: $('free-debug-panel'),
      dbgMin: $('free-dbg-min'),
      dbgMinValue: $('free-dbg-min-value'),
      dbgLast: $('free-dbg-last'),
      dbgConf: $('free-dbg-conf'),

      result: $('free-result'),
      resultWord: $('free-result-word'),
      speak: $('free-speak'),
      conf: $('free-conf'),
      confFill: $('free-conf-fill'),
      confValue: $('free-conf-value'),
    };

    this.session = null;
    this.troubled = false;
    this.pinned = null;
    this.lastLabel = null;
    this.userPausedDemo = false;
    this.hintTimer = null;

    // Soglia in 0..1. L'ultimo messaggio si tiene da parte per poter
    // rivalutare cio' che e' gia' a schermo quando si muove lo slider: e'
    // quello che rende chiaro a cosa serve, senza doverlo spiegare.
    this.minConf = DEFAULT_MIN_CONF / 100;
    this.lastMsg = null;

    this.library = new LibraryDrawer({ onPin: (sign) => this._pin(sign) });
    this._onKey = this._onKey.bind(this);
  }

  // ------------------------------------------------------------------ ciclo

  mount() {
    // Come in lezione: la schermata vive in index.html e non viene ricreata,
    // mentre una FreeView nasce ad ogni ingresso. Senza questo i listener si
    // accumulerebbero e dalla seconda visita un click ne eseguirebbe due.
    this._ac = new AbortController();

    this.el.screen.classList.remove('hidden');
    this._resetUi();
    this._wire();
    this._restorePrefs();
    this.library.mount(this._ac.signal);
    this._start();
    document.addEventListener('keydown', this._onKey, { signal: this._ac.signal });
    this._installDevHook();
  }

  /**
   * Stessa scorciatoia della lezione: senza camera non c'e' modo di far
   * arrivare un riconoscimento, e senza riconoscimento non si vede il box del
   * segno. window.__duoslFree.simulate('HELLO', 0.93)
   */
  _installDevHook() {
    window.__duoslFree = {
      simulate: (gloss, confidence = 0.9) => this._onRecognition({ gloss, confidence }),
      /** Soglia in percentuale, come lo slider: __duoslFree.minConf(70) */
      minConf: (pct) => this._setMinConf(pct),
      view: this,
    };
  }

  /** Riporta il DOM condiviso allo stato di partenza. */
  _resetUi() {
    this.pinned = null;
    this.lastLabel = null;
    this.userPausedDemo = false;
    this.troubled = false;
    this.lastMsg = null;

    this.el.debug.hidden = true;
    this.el.debugToggle.setAttribute('aria-pressed', 'false');

    this.el.screen.classList.remove('has-pinned');
    this.el.demoCol.hidden = true;
    this.el.demo.removeAttribute('src');
    this.el.demo.playbackRate = 1;
    this.el.demoSlow.setAttribute('aria-pressed', 'false');
    this.el.demoPlay.setAttribute('aria-pressed', 'false');

    this._showResult(null);
    this._hideHint();
    this._hideCover();
    this._setCamState('idle');
  }

  unmount() {
    if (this._ac) { this._ac.abort(); this._ac = null; }
    clearTimeout(this.hintTimer);
    Speech.stop();
    if (this.session) { this.session.stop(); this.session = null; }
    this.el.demo.pause();
    this.el.screen.classList.add('hidden');
    delete window.__duoslFree;
  }

  _start() {
    this._setCamState('connecting');
    this.el.badgeText.textContent = 'Starting camera…';

    this.session = new SignSession({
      lesson: null,
      video: this.el.webcam,
      canvas: this.el.overlay,
      onStatus: (m) => this._onStatus(m),
      onRecognition: (m) => this._onRecognition(m),
      onError: (kind) => this._onTrouble(kind),
      onClose: () => this._onDisconnected(),
      onOpen: () => {
        // Il socket si apre prima che la camera risponda: se il permesso e'
        // stato negato, "Ready" non deve cancellare l'avviso.
        if (this.troubled) return;
        this._hideCover();
        this._setCamState('ready');
      },
    });
    this.session.start();
  }

  _restart() {
    if (this.session) this.session.stop();
    this.troubled = false;
    this._hideCover();
    this._start();
  }

  // ------------------------------------------------------------------ setup

  _wire() {
    const opt = { signal: this._ac.signal };
    const on = (el, ev, fn) => el.addEventListener(ev, fn, opt);

    on(this.el.exit, 'click', () => this.onExit());
    on(this.el.voiceToggle, 'click', () => this._toggleVoice());
    on(this.el.debugToggle, 'click', () => this._toggleDebug());
    on(this.el.dbgMin, 'input', () => this._setMinConf(Number(this.el.dbgMin.value)));

    on(this.el.speak, 'click', () => {
      // Richiesta esplicita: parla anche a dettatura spenta.
      if (this.lastLabel) Speech.speakNow(this.lastLabel);
    });

    on(this.el.demoClose, 'click', () => {
      this.library.clearPinned();
      this._pin(null);
    });
    on(this.el.demoPlay, 'click', () => this._toggleDemoPlay());
    on(this.el.demoSlow, 'click', () => this._toggleDemoSlow());
    on(this.el.demoMirror, 'click', () => this._toggleDemoMirror());
    on(this.el.demo, 'ended', () => this.el.demo.play().catch(() => {}));

    on(document, 'visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.userPausedDemo || !this.el.demo.getAttribute('src')) return;
      this.el.demo.play().catch(() => {});
    });
  }

  _pref(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }

  _restorePrefs() {
    Speech.init();
    this._syncVoiceButton();
    if (!Speech.supported) {
      this.el.voiceToggle.disabled = true;
      this.el.voiceLabel.textContent = 'No voice';
      this.el.voiceToggle.title = 'This browser has no speech synthesis';
    }

    if (this._pref('duosl.mirrorDemo', 'off') === 'on') {
      this.el.demo.classList.add('mirrored');
      this.el.demoMirror.setAttribute('aria-pressed', 'true');
    }

    const salvata = Number(this._pref(CONF_KEY, DEFAULT_MIN_CONF));
    this._setMinConf(Number.isFinite(salvata) ? salvata : DEFAULT_MIN_CONF, false);
  }

  /* ---------------------------------------------------- soglia e pannello */

  /**
   * @param {number} pct     soglia in percentuale, 0..100
   * @param {boolean} salva  false quando il valore arriva gia' da localStorage
   */
  _setMinConf(pct, salva = true) {
    const v = Math.min(100, Math.max(0, Math.round(pct)));
    this.minConf = v / 100;

    this.el.dbgMin.value = String(v);
    this.el.dbgMinValue.textContent = `${v}%`;
    if (salva) {
      try { localStorage.setItem(CONF_KEY, String(v)); } catch { /* finestra privata */ }
    }

    // Rivaluta cio' che e' gia' a schermo: alzando la soglia oltre la
    // confidenza dell'ultimo segno, quello diventa "Sign not clear" sotto gli
    // occhi. Senza, lo slider sembrerebbe non fare niente finche' non si rifa'
    // un gesto.
    if (this.lastMsg) this._renderRecognition(false);
  }

  _toggleDebug() {
    const open = this.el.debug.hidden;
    this.el.debug.hidden = !open;
    this.el.debugToggle.setAttribute('aria-pressed', String(open));
  }

  // --------------------------------------------------------- dal riconoscitore

  _onRecognition(msg) {
    this.lastMsg = msg;
    this._updateDebug(msg);
    this._renderRecognition(true);
  }

  /**
   * Decide cosa mostrare per l'ultimo gesto catturato.
   *
   * @param {boolean} parla  la voce legge solo un gesto appena arrivato, non
   *                         una rivalutazione dovuta allo slider: sentirsi
   *                         ripetere il segno mentre si trascina la manopola
   *                         sarebbe insopportabile.
   */
  _renderRecognition(parla) {
    const msg = this.lastMsg;
    if (!msg) return;

    // "UNKNOWN" e' un indice del modello senza voce nel vocabolario: mostrarlo
    // cosi' com'e' sembrerebbe il nome di un segno.
    if (!msg.gloss || msg.gloss === 'UNKNOWN') {
      this._showResult({ label: null, confidence: msg.confidence });
      return;
    }

    // Sotto soglia: il gesto e' arrivato, ma il modello non e' abbastanza
    // sicuro. Si dice, invece di non mostrare niente: un gesto scartato in
    // silenzio e' indistinguibile da un gesto mai visto, e l'utente resterebbe
    // a chiedersi se la telecamera lo inquadra.
    if (typeof msg.confidence === 'number' && msg.confidence < this.minConf) {
      this._showResult({ label: null, confidence: msg.confidence, weak: true });
      return;
    }

    const label = this.library.displayOf(msg.gloss) || msg.gloss;
    this._showResult({ label, confidence: msg.confidence });
    if (parla) Speech.say(label);
  }

  /** Le due righe del pannello: mostrano anche cio' che la soglia ha scartato. */
  _updateDebug(msg) {
    if (this.el.debug.hidden) return;
    const label = (msg.gloss && msg.gloss !== 'UNKNOWN')
      ? (this.library.displayOf(msg.gloss) || msg.gloss)
      : 'UNKNOWN';
    this.el.dbgLast.textContent = label;
    this.el.dbgConf.textContent = typeof msg.confidence === 'number'
      ? `${Math.round(msg.confidence * 100)}%`
      : '\u2014';
  }

  _onStatus(msg) {
    const state = this.el.cam.dataset.state;
    if (state !== 'disconnected' && !this.troubled && !this._coverVisible()) {
      this._setCamState(msg.capturing ? 'capturing' : 'ready');
    }
    if (msg.discarded) this._showHint(DISCARD_HINT[msg.discarded] || 'Capture discarded');
  }

  _onTrouble(kind) {
    if (kind === 'socket') return;   // la chiusura arriva subito dopo
    this.troubled = true;
    const info = CAMERA_TROUBLE[kind] || CAMERA_TROUBLE.unknown;
    this._setCamState(kind === 'denied' ? 'denied' : 'nocam');
    this.el.badgeText.textContent = 'Camera off';
    this._showCover({
      icon: info.icon,
      title: info.title,
      text: info.text,
      actions: [{ label: 'Try again', primary: true, onClick: () => this._restart() }],
    });
  }

  _onDisconnected() {
    this._setCamState('disconnected');
    this.el.badgeText.textContent = 'Disconnected';
    this._showCover({
      icon: '#i-alert',
      title: 'Connection lost',
      text: 'The link to the recognition server dropped.',
      actions: [{ label: 'Reconnect', primary: true, onClick: () => this._restart() }],
    });
  }

  // ------------------------------------------------------- segno riconosciuto

  _showResult(result) {
    if (!result) {
      this.lastLabel = null;
      this.el.result.dataset.state = 'empty';
      this.el.resultWord.textContent = 'Make a sign';
      this.el.speak.hidden = true;
      this.el.conf.hidden = true;
      return;
    }

    const { label, confidence, weak } = result;
    this.lastLabel = label;
    this.el.result.dataset.state = label ? 'ok' : (weak ? 'weak' : 'unknown');
    this.el.resultWord.textContent = label || (weak ? 'Sign not clear' : 'Not recognised');
    this.el.speak.hidden = !label;

    this.el.resultWord.classList.remove('is-new');
    void this.el.resultWord.offsetWidth;      // riavvia l'animazione
    this.el.resultWord.classList.add('is-new');

    if (typeof confidence === 'number') {
      const pct = Math.round(confidence * 100);
      this.el.conf.hidden = false;
      this.el.confFill.style.width = `${pct}%`;
      this.el.confValue.textContent = `${pct}%`;
    } else {
      this.el.conf.hidden = true;
    }
  }

  // ------------------------------------------------------ segno dalla libreria

  /** @param {object|null} sign null stacca la demo e restituisce spazio alla webcam */
  _pin(sign) {
    this.pinned = sign;

    if (!sign) {
      this.el.screen.classList.remove('has-pinned');
      this.el.demoCol.hidden = true;
      this.el.demo.pause();
      this.el.demo.removeAttribute('src');
      return;
    }

    this.el.screen.classList.add('has-pinned');
    this.el.demoCol.hidden = false;
    this.el.demoTag.textContent = sign.display;

    if (sign.demo_url) {
      this.el.demo.src = sign.demo_url;
      this.el.demo.preload = 'auto';
      this.userPausedDemo = false;
      this.el.demoPlay.setAttribute('aria-pressed', 'false');
      this.el.demo.play().catch(() => {});
    } else {
      this.el.demo.removeAttribute('src');
    }
  }

  // ------------------------------------------------------- controlli demo

  _toggleDemoPlay() {
    const paused = this.el.demo.paused;
    if (paused) this.el.demo.play().catch(() => {});
    else this.el.demo.pause();
    this.userPausedDemo = !paused;
    this.el.demoPlay.setAttribute('aria-pressed', String(!paused));
  }

  _toggleDemoSlow() {
    const slow = this.el.demo.playbackRate !== 1;
    this.el.demo.playbackRate = slow ? 1 : 0.5;
    this.el.demoSlow.setAttribute('aria-pressed', String(!slow));
  }

  _toggleDemoMirror() {
    const on = this.el.demo.classList.toggle('mirrored');
    this.el.demoMirror.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('duosl.mirrorDemo', on ? 'on' : 'off'); } catch { /* privata */ }
  }

  // ------------------------------------------------------------------- voce

  _syncVoiceButton() {
    const on = Speech.enabled;
    this.el.voiceToggle.setAttribute('aria-pressed', String(on));
    this.el.voiceLabel.textContent = on ? 'Voice on' : 'Voice off';
  }

  _toggleVoice() {
    const on = Speech.toggle();
    this._syncVoiceButton();
    if (on) Speech.speakNow('Voice on');
  }

  // ------------------------------------------------------------ stato camera

  _setCamState(state) {
    this.el.cam.dataset.state = state;
    const labels = {
      idle: 'Camera off',
      connecting: 'Starting camera…',
      ready: 'Ready',
      capturing: 'Capturing',
      disconnected: 'Disconnected',
      denied: 'Camera blocked',
      nocam: 'No camera',
    };
    if (labels[state]) this.el.badgeText.textContent = labels[state];
  }

  _showHint(text) {
    this.el.hint.textContent = text;
    this.el.hint.hidden = false;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this._hideHint(), HINT_MS);
  }

  _hideHint() {
    clearTimeout(this.hintTimer);
    this.el.hint.hidden = true;
  }

  // -------------------------------------------------------------- coperture

  _coverVisible() { return !this.el.cover.hidden; }

  _showCover({ icon, title, text, actions = [] }) {
    this.el.coverIcon.querySelector('use').setAttribute('href', icon);
    this.el.coverTitle.textContent = title;
    this.el.coverText.textContent = text || '';
    this.el.coverText.hidden = !text;

    this.el.coverActions.innerHTML = '';
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn' : 'btn subtle';
      b.textContent = a.label;
      b.addEventListener('click', a.onClick);
      this.el.coverActions.appendChild(b);
    });

    this.el.cover.hidden = false;
  }

  _hideCover() { this.el.cover.hidden = true; }

  // -------------------------------------------------------------- tastiera

  _onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.el.screen.classList.contains('hidden')) return;

    // Space e Invio su un controllo a fuoco appartengono al controllo.
    const onControl = e.target.closest && e.target.closest('button, a, input, select, textarea');

    switch (e.key) {
      case 'Escape':
        // Prima chiude la libreria, poi esce: uscire dalla schermata mentre si
        // sfoglia la libreria sarebbe una sorpresa sgradevole.
        if (this.library.open) this.library.setOpen(false);
        else this.onExit();
        break;
      case ' ':
        if (onControl || this.el.demoCol.hidden) return;
        e.preventDefault();
        this._toggleDemoPlay();
        break;
      case 'v': case 'V':
        if (onControl) return;
        this._toggleVoice();
        break;
      case 'l': case 'L':
        if (onControl) return;
        this.library.toggle();
        break;
      case 'd': case 'D':
        if (onControl) return;
        this._toggleDebug();
        break;
    }
  }
}
