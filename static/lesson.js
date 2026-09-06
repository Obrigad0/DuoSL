// static/lesson.js
//
// La schermata di lezione: possiede il proprio DOM e una macchina a stati
// esplicita, alimentata dai messaggi che arrivano da SignSession.
//
// L'idea portante e' che durante la pratica l'utente guarda due soli oggetti,
// la demo e la propria immagine. Percio' lo stato non vive in un pannello di
// testo altrove, ma nell'anello attorno al video: colore, spessore e movimento,
// che e' quello che la visione periferica sa leggere.

import { SignSession } from './session.js';
import { Speech } from './speech.js';

const ADVANCE_DELAY_MS = 1200;   // quanto resta a schermo il verdetto positivo
const SKIP_AFTER_WRONG = 2;      // errori consecutivi prima di offrire lo skip
const HINT_MS = 2400;
const VERDICT_HOLD_MS = 900;     // durata dell'anello colorato dopo un tentativo

const $ = (id) => document.getElementById(id);

/** Testi degli scarti: sono suggerimenti, non errori dell'utente. */
const DISCARD_HINT = {
  troppo_breve: 'Hold the sign a little longer',
  mani_non_visibili: 'Keep your hands in frame',
};

const CAMERA_TROUBLE = {
  denied: {
    icon: '#i-camera',
    title: 'Camera access needed',
    text: 'DuoSL reads your signs from the webcam. Allow camera access in your browser’s address bar, then try again.',
  },
  nocam: {
    icon: '#i-alert',
    title: 'No camera found',
    text: 'Connect a webcam and try again — sign recognition needs a live video feed.',
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


export class LessonView {
  constructor(lessonId, { onExit }) {
    this.lessonId = lessonId;
    this.onExit = onExit;

    this.el = {
      screen: $('lesson-screen'),
      exit: $('lesson-exit'),
      progress: $('lesson-progress'),
      count: $('lesson-count'),
      voiceToggle: $('voice-toggle'),
      debugToggle: $('debug-toggle'),

      word: $('sign-word'),
      speakWord: $('speak-word'),
      demo: $('demo-video'),
      demoMissing: $('demo-missing'),
      demoPlay: $('demo-play'),
      demoSlow: $('demo-slow'),
      demoMirror: $('demo-mirror'),

      cam: $('cam-card'),
      webcam: $('webcam'),
      overlay: $('overlay'),
      badgeText: $('cam-badge-text'),
      hint: $('cam-hint'),
      cover: $('cam-cover'),
      coverIcon: $('cover-icon'),
      coverTitle: $('cover-title'),
      coverText: $('cover-text'),
      coverActions: $('cover-actions'),

      feedback: $('feedback'),
      fbText: $('fb-text'),
      fbAgain: $('fb-again'),
      fbSkip: $('fb-skip'),
      fbTimer: $('fb-timer'),

      debug: $('debug-panel'),
      dbgFill: $('dbg-fill'),
      dbgMovement: $('dbg-movement'),
      dbgState: $('dbg-state'),
      dbgLast: $('dbg-last'),
      dbgConf: $('dbg-conf'),
      dbgDiscarded: $('dbg-discarded'),
      dbgCaptures: $('dbg-captures'),
      dbgMarkEnter: $('dbg-mark-enter'),
      dbgMarkExit: $('dbg-mark-exit'),
    };

    this.steps = [];
    this.stepStatus = [];
    this.skipped = new Set();
    this.currentIndex = 0;
    this.totalSteps = 0;
    this.wrongStreak = 0;
    this.captures = 0;
    this.completed = false;
    this.troubled = false;
    this.resumeAt = 0;   // step da ripristinare dopo una riconnessione
    this.userPausedDemo = false;

    this.thresholds = { enter: 1.4, exit: 0.9 };  // sovrascritte da lesson_meta
    this.advanceTimer = null;
    this.hintTimer = null;
    this.verdictTimer = null;

    this.preloader = document.createElement('video');
    this.preloader.preload = 'auto';
    this.preloader.muted = true;

    this.session = null;
    this._onKey = this._onKey.bind(this);
  }

  // ------------------------------------------------------------------ ciclo

  mount() {
    this.el.screen.classList.remove('hidden');
    this._wire();
    this._restorePrefs();
    this._start();
    document.addEventListener('keydown', this._onKey);
    this._installDevHook();
  }

  unmount() {
    document.removeEventListener('keydown', this._onKey);
    if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
    this._clearTimers();
    Speech.stop();
    if (this.session) { this.session.stop(); this.session = null; }
    this.el.demo.pause();
    this.el.screen.classList.add('hidden');
    delete window.__duosl;
  }

  _start() {
    this._setCamState('connecting');
    this.el.badgeText.textContent = 'Starting camera…';

    this.session = new SignSession({
      lesson: this.lessonId,
      video: this.el.webcam,
      canvas: this.el.overlay,
      onStatus: (m) => this._onStatus(m),
      onLesson: (m) => this._onLesson(m),
      onLessonMeta: (m) => this._onLessonMeta(m),
      onError: (kind) => this._onTrouble(kind),
      onClose: () => this._onDisconnected(),
      onOpen: () => {
        // Il socket puo' aprirsi dopo che la camera e' gia' fallita: in quel
        // caso la lezione si carica, ma l'avviso sulla camera deve restare.
        if (this.troubled) return;
        this._hideCover();
        this._setCamState('ready');
      },
    });
    this.session.start();
  }

  /** Rigioca la lezione da capo (pulsante "Practice again"). */
  _restart() {
    this._teardownSession();
    this.stepStatus = this.steps.map(() => 'pending');
    this.skipped.clear();
    this.currentIndex = 0;
    this.resumeAt = 0;
    this.captures = 0;
    this._renderProgress();
    this._start();
  }

  /**
   * Riprende dopo una caduta di connessione SENZA perdere i passi gia' fatti.
   *
   * Il socket che cade porta con se' la sessione lato server, e quella nuova
   * ripartirebbe dal primo segno: ricominciare da capo per un problema di rete
   * e' una punizione che l'utente non si e' meritato. Lo stato vero resta qui
   * nel client, e a riconnessione avvenuta lo si rimanda al server con `goto`.
   */
  _reconnect() {
    this.resumeAt = this.currentIndex;
    this._teardownSession();
    this._start();
  }

  _teardownSession() {
    this._clearTimers();
    this._hideFeedback();
    this._hideCover();
    if (this.session) this.session.stop();
    this.wrongStreak = 0;
    this.completed = false;
    this.troubled = false;
  }

  // ------------------------------------------------------------------ setup

  _wire() {
    this.el.exit.addEventListener('click', () => this.onExit());

    this.el.voiceToggle.addEventListener('click', () => this._toggleVoice());
    this.el.debugToggle.addEventListener('click', () => this._toggleDebug());

    this.el.speakWord.addEventListener('click', () => {
      // Richiesta esplicita: parla anche a dettatura spenta.
      const label = this._currentLabel();
      if (label) Speech.speakNow(label);
    });

    this.el.demoPlay.addEventListener('click', () => this._toggleDemoPlay());
    this.el.demoSlow.addEventListener('click', () => this._toggleDemoSlow());
    this.el.demoMirror.addEventListener('click', () => this._toggleDemoMirror());

    this.el.fbAgain.addEventListener('click', () => this._watchAgain());
    this.el.fbSkip.addEventListener('click', () => this._skip());

    // Se il video finisce fuori loop (sorgente senza loop pulito), riparte.
    this.el.demo.addEventListener('ended', () => this.el.demo.play().catch(() => {}));

    // Tornando su una scheda lasciata in secondo piano il browser ha sospeso
    // il video: senza questo la demo resta congelata e sembra rotta. Non si
    // tocca se e' stato l'utente a metterla in pausa.
    this._onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.userPausedDemo || !this.el.demo.getAttribute('src')) return;
      this.el.demo.play().catch(() => {});
    };
    document.addEventListener('visibilitychange', this._onVisible);
  }

  _restorePrefsSafe(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }

  _restorePrefs() {
    Speech.init();
    this._syncVoiceButton();
    if (!Speech.supported) {
      this.el.voiceToggle.disabled = true;
      $('voice-label').textContent = 'No voice';
      this.el.voiceToggle.title = 'This browser has no speech synthesis';
    }

    if (this._restorePrefsSafe('duosl.mirrorDemo', 'off') === 'on') {
      this.el.demo.classList.add('mirrored');
      this.el.demoMirror.setAttribute('aria-pressed', 'true');
    }
  }

  // ------------------------------------------------- messaggi dal server

  _onLessonMeta(msg) {
    this.steps = msg.steps || [];
    this.totalSteps = this.steps.length;
    this.stepStatus = this.steps.map(() => 'pending');

    if (msg.thresholds) this.thresholds = msg.thresholds;
    this._renderThresholdMarks();

    this.el.progress.innerHTML = '';
    this.steps.forEach((step, i) => {
      const li = document.createElement('li');
      li.dataset.state = 'pending';
      li.title = `Step ${i + 1}: ${step.display}`;
      li.innerHTML =
        `<span class="step-dot">` +
          `<svg class="icon"><use href="#i-check"></use></svg>` +
        `</span>` +
        `<span class="step-name"></span>`;
      li.querySelector('.step-name').textContent = step.display;
      this.el.progress.appendChild(li);
    });

    // Se stiamo riconnettendo, il server ha aperto una sessione nuova che
    // riparte da zero: gli si dice a che punto eravamo, cosi' l'utente non
    // perde i passi gia' fatti.
    if (this.resumeAt > 0 && this.session) {
      this.session.goto(this.resumeAt);
      this.resumeAt = 0;
    }

    this._renderProgress();
  }

  _onLesson(msg) {
    this.totalSteps = msg.total_steps;

    // Un tentativo e' stato valutato
    if (msg.attempted_display) {
      this.captures++;

      if (msg.correct) {
        this.wrongStreak = 0;
        this._setCamState('correct');
        this._hideHint();
        this._showFeedback({
          kind: 'correct',
          text: `Nice! ${msg.attempted_display}`,
          autoMs: ADVANCE_DELAY_MS,
        });
        Speech.say('Correct');

        // Il verdetto resta a schermo, poi si passa oltre. Il server ha gia'
        // avanzato: msg.target_* e' lo step SUCCESSIVO.
        this.advanceTimer = setTimeout(() => {
          this.advanceTimer = null;
          this._hideFeedback();
          if (msg.completed) this._showCompletion();
          else this._renderStep(msg);
        }, ADVANCE_DELAY_MS);
        return;
      }

      // Tentativo non riconosciuto come il segno richiesto
      this.wrongStreak++;
      this._setCamState('wrong');
      this._hideHint();
      this._showFeedback({
        kind: 'wrong',
        text: `Not quite — that looked like ${msg.last_gloss}`,
        again: true,
        skip: this.wrongStreak >= SKIP_AFTER_WRONG,
      });
      Speech.say(`Not quite. That looked like ${msg.last_gloss}`);
      this._updateDebug({ last: msg.last_gloss, conf: msg.last_confidence });
      return;
    }

    // Nessun tentativo: messaggio iniziale, oppure esito di uno skip
    if (msg.completed) { this._showCompletion(); return; }
    this._renderStep(msg);
  }

  _onStatus(msg) {
    this._updateDebug({ movement: msg.movement });

    // Il verdetto tiene l'anello colorato per un attimo: gli status che
    // arrivano nel frattempo non devono cancellarlo.
    const state = this.el.cam.dataset.state;
    const holding = state === 'correct' || state === 'wrong' || this.verdictTimer;

    if (!holding && !this.completed && !this._coverVisible()) {
      this._setCamState(msg.capturing ? 'capturing' : 'ready');
    }

    if (msg.discarded) {
      this._showHint(DISCARD_HINT[msg.discarded] || 'Capture discarded');
      this._updateDebug({ discarded: msg.discarded });
    }
  }

  _onTrouble(kind) {
    if (kind === 'socket') return;   // la chiusura arriva subito dopo, gestita li'
    this.troubled = true;
    const info = CAMERA_TROUBLE[kind] || CAMERA_TROUBLE.unknown;
    this._setCamState(kind === 'denied' ? 'denied' : 'nocam');
    this.el.badgeText.textContent = 'Camera off';
    this._showCover({
      icon: info.icon,
      title: info.title,
      text: info.text,
      actions: [{ label: 'Try again', primary: true, onClick: () => this._reconnect() }],
    });
  }

  _onDisconnected() {
    if (this.completed) return;      // la lezione e' finita: non e' un errore
    this._setCamState('disconnected');
    this.el.badgeText.textContent = 'Disconnected';
    this._showCover({
      icon: '#i-alert',
      title: 'Connection lost',
      text: 'The link to the recognition server dropped. Reconnecting keeps the steps you have already done.',
      actions: [{ label: 'Reconnect', primary: true, onClick: () => this._reconnect() }],
    });
  }

  // ------------------------------------------------------------- rendering

  _renderStep(msg) {
    this.currentIndex = msg.step_index;
    this.wrongStreak = 0;

    for (let i = 0; i < this.stepStatus.length; i++) {
      if (i < this.currentIndex && this.stepStatus[i] === 'pending') {
        this.stepStatus[i] = this.skipped.has(i) ? 'skipped' : 'done';
      }
    }
    this._renderProgress();

    const step = this.steps[this.currentIndex];
    const label = (step && step.display) || msg.target_display || '';
    const demoUrl = (step && step.demo_url) || msg.target_demo_url || null;

    this.el.word.textContent = label;
    this.el.word.classList.remove('is-new');
    void this.el.word.offsetWidth;          // forza il riavvio dell'animazione
    this.el.word.classList.add('is-new');

    this._setDemo(demoUrl);
    this._preloadNext();

    // Il contenuto della lezione si carica anche a camera bloccata: in quel
    // caso l'anello NON deve tornare "ready", o l'avviso a schermo direbbe una
    // cosa e il bordo del video un'altra.
    if (!this.troubled && !this._coverVisible()) this._setCamState('ready');

    // Solo il nome del segno: la posizione nella lezione la dice gia' lo
    // stepper, e una frase lunga arriva quando l'utente ha gia' ricominciato.
    Speech.say(label);
  }

  _renderProgress() {
    const items = this.el.progress.children;
    for (let i = 0; i < items.length; i++) {
      const status = this.stepStatus[i];
      items[i].dataset.state =
        (i === this.currentIndex && !this.completed) ? 'current'
        : status === 'done' ? 'done'
        : status === 'skipped' ? 'skipped'
        : 'pending';
    }
    const shown = Math.min(this.currentIndex + 1, this.totalSteps || 1);
    this.el.count.textContent = this.completed
      ? `${this.totalSteps} of ${this.totalSteps}`
      : `${shown} of ${this.totalSteps || '—'}`;
  }

  _setDemo(url) {
    const hasDemo = !!url;
    this.el.demo.hidden = !hasDemo;
    this.el.demoMissing.hidden = hasDemo;
    this.el.demoPlay.disabled = !hasDemo;
    this.el.demoSlow.disabled = !hasDemo;
    this.el.demoMirror.disabled = !hasDemo;

    if (!hasDemo) { this.el.demo.removeAttribute('src'); return; }
    if (this.el.demo.getAttribute('src') === url) { this.el.demo.currentTime = 0; return; }

    this.el.demo.src = url;
    this.userPausedDemo = false;
    this.el.demo.play().catch(() => {});
    this.el.demoPlay.setAttribute('aria-pressed', 'false');
  }

  /** Scalda la cache col video successivo: nessun buco al cambio step. */
  _preloadNext() {
    const next = this.steps[this.currentIndex + 1];
    if (next && next.demo_url) this.preloader.src = next.demo_url;
  }

  // ------------------------------------------------------------- controlli

  _toggleDemoPlay() {
    if (this.el.demo.paused) {
      this.userPausedDemo = false;
      this.el.demo.play().catch(() => {});
      this.el.demoPlay.setAttribute('aria-pressed', 'false');
    } else {
      this.userPausedDemo = true;   // distinta dalla pausa imposta dal browser
      this.el.demo.pause();
      this.el.demoPlay.setAttribute('aria-pressed', 'true');
    }
  }

  _toggleDemoSlow() {
    const slow = this.el.demoSlow.getAttribute('aria-pressed') !== 'true';
    this.el.demo.playbackRate = slow ? 0.5 : 1;
    this.el.demoSlow.setAttribute('aria-pressed', String(slow));
  }

  _toggleDemoMirror() {
    const on = this.el.demo.classList.toggle('mirrored');
    this.el.demoMirror.setAttribute('aria-pressed', String(on));
    try { localStorage.setItem('duosl.mirrorDemo', on ? 'on' : 'off'); } catch { /* ignora */ }
  }

  /** Nome del segno corrente, con ripiego sul testo a schermo. */
  _currentLabel() {
    const step = this.steps[this.currentIndex];
    if (step && step.display) return step.display;
    const shown = this.el.word.textContent.trim();
    return shown && shown !== 'All done' ? shown : '';
  }

  _syncVoiceButton() {
    const on = Speech.enabled;
    this.el.voiceToggle.setAttribute('aria-pressed', String(on));
    // Lo stato si legge dal testo, non solo dall'icona e dal colore: con la
    // sola icona non si capiva se fosse accesa.
    $('voice-label').textContent = on ? 'Voice on' : 'Voice off';
  }

  _toggleVoice() {
    const on = Speech.toggle();
    this._syncVoiceButton();
    // Conferma udibile immediata: accendere e non sentire nulla fino al
    // prossimo step lasciava il dubbio che non funzionasse.
    if (on) {
      const label = this._currentLabel();
      Speech.speakNow(label ? `Voice on. Sign: ${label}` : 'Voice on');
    }
  }

  _toggleDebug() {
    const open = this.el.debug.hidden;
    this.el.debug.hidden = !open;
    this.el.debugToggle.setAttribute('aria-pressed', String(open));

    // _updateDebug esce subito a pannello chiuso, quindi all'apertura le righe
    // che cambiano di rado (lo stato) mostrerebbero un valore vecchio finche'
    // non cambia da solo. Si riallinea qui.
    if (open) this._updateDebug({ state: this.el.cam.dataset.state });
  }

  _watchAgain() {
    this.userPausedDemo = false;
    this.el.demo.currentTime = 0;
    this.el.demo.playbackRate = 0.5;
    this.el.demoSlow.setAttribute('aria-pressed', 'true');
    this.el.demo.play().catch(() => {});
    this.el.demoPlay.setAttribute('aria-pressed', 'false');
  }

  _skip() {
    this.skipped.add(this.currentIndex);
    this._hideFeedback();
    if (this.session) this.session.skip();
  }

  // ------------------------------------------------------- stato del video

  _setCamState(state) {
    this.el.cam.dataset.state = state;
    this._updateDebug({ state });

    const labels = {
      idle: 'Camera off',
      connecting: 'Starting camera…',
      ready: 'Ready',
      capturing: 'Capturing',
      correct: 'Correct',
      wrong: 'Try again',
      discarded: 'Discarded',
      disconnected: 'Disconnected',
      denied: 'Camera blocked',
      nocam: 'No camera',
    };
    if (labels[state]) this.el.badgeText.textContent = labels[state];

    // Il colore del verdetto va tenuto un attimo, altrimenti il prossimo
    // messaggio di status (20 volte al secondo) lo spegne subito.
    if (state === 'correct' || state === 'wrong') {
      clearTimeout(this.verdictTimer);
      this.verdictTimer = setTimeout(() => {
        this.verdictTimer = null;
        if (this.el.cam.dataset.state === state && !this.completed) {
          this._setCamState('ready');
        }
      }, VERDICT_HOLD_MS);
    }
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

  // ---------------------------------------------------------- feedback

  _showFeedback({ kind, text, again = false, skip = false, autoMs = 0 }) {
    this.el.feedback.dataset.kind = kind;
    this.el.fbText.textContent = text;
    this.el.fbAgain.hidden = !again;
    this.el.fbSkip.hidden = !skip;
    this.el.feedback.hidden = false;

    this.el.fbTimer.classList.remove('run');
    if (autoMs) {
      this.el.fbTimer.style.animationDuration = `${autoMs}ms`;
      void this.el.fbTimer.offsetWidth;
      this.el.fbTimer.classList.add('run');
    }
  }

  _hideFeedback() {
    this.el.feedback.hidden = true;
    this.el.fbTimer.classList.remove('run');
  }

  // ------------------------------------------------------------- coperture

  _coverVisible() { return !this.el.cover.hidden; }

  _showCover({ icon, title, text, actions = [], signs = null, tone = null }) {
    if (tone) this.el.cover.dataset.tone = tone;
    else delete this.el.cover.dataset.tone;
    this.el.coverIcon.querySelector('use').setAttribute('href', icon);
    this.el.coverTitle.textContent = title;
    this.el.coverText.textContent = text || '';
    this.el.coverText.hidden = !text;

    const old = this.el.cover.querySelector('.cover-signs');
    if (old) old.remove();
    if (signs && signs.length) {
      const ul = document.createElement('ul');
      ul.className = 'cover-signs';
      signs.forEach(s => {
        const li = document.createElement('li');
        li.dataset.ok = String(s.ok);
        li.textContent = s.ok ? `✓ ${s.label}` : `– ${s.label}`;
        ul.appendChild(li);
      });
      this.el.coverText.after(ul);
    }

    this.el.coverActions.innerHTML = '';
    actions.forEach(a => {
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

  _showCompletion() {
    this.completed = true;
    this._clearTimers();
    this._hideFeedback();
    this._hideHint();
    this.currentIndex = this.totalSteps;

    for (let i = 0; i < this.stepStatus.length; i++) {
      if (this.stepStatus[i] === 'pending') {
        this.stepStatus[i] = this.skipped.has(i) ? 'skipped' : 'done';
      }
    }
    this._renderProgress();

    const done = this.stepStatus.filter(s => s === 'done').length;
    this.el.demo.pause();
    this.el.word.textContent = 'All done';
    this._setCamState('idle');

    this._showCover({
      icon: '#i-check',
      tone: 'ok',
      title: 'Lesson complete',
      text: `${done} of ${this.totalSteps} signs recognised.`,
      signs: this.steps.map((s, i) => ({ label: s.display, ok: this.stepStatus[i] === 'done' })),
      actions: [
        { label: 'Practice again', primary: true, onClick: () => this._restart() },
        { label: 'Back to lessons', onClick: () => this.onExit() },
      ],
    });

    Speech.say('Lesson complete');
    if (this.session) this.session.stop();
  }

  // ------------------------------------------------------------ diagnostica

  _renderThresholdMarks() {
    const max = this.thresholds.enter * 2.2;
    this.el.dbgMarkEnter.style.left = `${(this.thresholds.enter / max) * 100}%`;
    this.el.dbgMarkExit.style.left = `${(this.thresholds.exit / max) * 100}%`;
    this.el.dbgMarkEnter.querySelector('b').textContent = `enter ${this.thresholds.enter}`;
    this.el.dbgMarkExit.querySelector('b').textContent = `exit ${this.thresholds.exit}`;
  }

  _updateDebug({ movement, state, last, conf, discarded }) {
    if (this.el.debug.hidden) return;

    if (movement !== undefined) {
      const max = this.thresholds.enter * 2.2;
      this.el.dbgFill.style.width = `${Math.min(100, (movement / max) * 100)}%`;
      this.el.dbgMovement.textContent = movement.toFixed(2);
    }
    if (state !== undefined) this.el.dbgState.textContent = state;
    if (last !== undefined) this.el.dbgLast.textContent = last;
    if (conf !== undefined) this.el.dbgConf.textContent = `${(conf * 100).toFixed(0)}%`;
    if (discarded !== undefined) this.el.dbgDiscarded.textContent = discarded;
    this.el.dbgCaptures.textContent = String(this.captures);
  }

  // -------------------------------------------------------------- tastiera

  _onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Space e Invio su un controllo a fuoco appartengono al controllo.
    const onControl = e.target.closest && e.target.closest('button, a, input, select, textarea');

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.onExit();
        break;
      case ' ':
        if (onControl) return;
        e.preventDefault();
        this._toggleDemoPlay();
        break;
      case 'r': case 'R':
        if (onControl) return;
        this._watchAgain();
        break;
      case 's': case 'S':
        if (onControl || this.el.fbSkip.hidden) return;
        this._skip();
        break;
      case 'v': case 'V':
        if (onControl) return;
        this._toggleVoice();
        break;
      case 'd': case 'D':
        if (onControl) return;
        this._toggleDebug();
        break;
    }
  }

  _clearTimers() {
    clearTimeout(this.advanceTimer); this.advanceTimer = null;
    clearTimeout(this.hintTimer);    this.hintTimer = null;
    clearTimeout(this.verdictTimer); this.verdictTimer = null;
  }

  // ------------------------------------------------------------- sviluppo

  /**
   * Permette di esercitare ogni stato visivo senza webcam ne' modello, cosa
   * altrimenti impossibile in un browser headless. Resta utile poi come
   * strumento di debug:  __duosl.simulate('wrong')
   */
  _installDevHook() {
    window.__duosl = {
      simulate: (kind) => {
        const step = this.steps[this.currentIndex];
        const label = step ? step.display : 'HELLO';
        switch (kind) {
          case 'capturing': this._setCamState('capturing'); break;
          case 'ready':     this._setCamState('ready'); break;
          case 'correct':
            this._onLesson({
              step_index: Math.min(this.currentIndex + 1, this.totalSteps),
              total_steps: this.totalSteps,
              target_display: (this.steps[this.currentIndex + 1] || {}).display || null,
              target_demo_url: (this.steps[this.currentIndex + 1] || {}).demo_url || null,
              attempted_display: label,
              last_gloss: label,
              last_confidence: 0.93,
              correct: true,
              advanced: true,
              completed: this.currentIndex + 1 >= this.totalSteps,
            });
            break;
          case 'wrong':
            this._onLesson({
              step_index: this.currentIndex,
              total_steps: this.totalSteps,
              target_display: label,
              attempted_display: label,
              last_gloss: 'FINE',
              last_confidence: 0.44,
              correct: false,
              advanced: false,
              completed: false,
            });
            break;
          case 'discarded':   this._onStatus({ capturing: false, movement: 0.3, discarded: 'troppo_breve' }); break;
          case 'disconnected': this._onDisconnected(); break;
          case 'denied':      this._onTrouble('denied'); break;
          case 'nocam':       this._onTrouble('nocam'); break;
          case 'completed':   this._showCompletion(); break;
          default: console.warn('stati: capturing ready correct wrong discarded disconnected denied nocam completed');
        }
      },
      view: this,
    };
  }
}
