// static/lessons.js
//
// La scelta della lezione, disegnata come un percorso.
//
// Non e' decorazione: le lezioni hanno un ordine e si sbloccano l'una con
// l'altra, e una fila di bottoni tutti uguali non lo diceva. Su un percorso
// invece si legge a colpo d'occhio da dove sei passato, dove sei adesso e
// quanto manca — e ogni informazione sta su un canale suo, cosi' non si
// confondono fra loro:
//
//   dove sei stato   -> spunta verde sul nodo
//   dove devi andare -> alone ambra attorno al prossimo
//   cosa hai scelto  -> l'omino in piedi sul nodo
//
// I nodi vengono dai dati (/api/progress -> lectures/*.json): aggiungere una
// lezione non richiede di toccare ne' questo file ne' l'HTML.

import { Progress } from './progress.js';

const $ = (id) => document.getElementById(id);

const FREE_ID = '__free__';

/* --- Geometria del percorso -------------------------------------------
   Le misure qui sotto sono in px alla scala di riferimento (disco 92). La
   scala vera la decide _applyScale() in base all'ALTEZZA disponibile e poi
   la scrive in --disc: da li' il CSS ricava dischi, icone, testi, anelli e
   tratteggio. Un solo numero governa tutto.

   La larghezza NON entra nel calcolo: il percorso continua oltre il bordo
   ed e' giusto che sia cosi', si scorre. Rimpicciolire tutto per farci
   stare anche le lezioni future avrebbe fatto l'opposto di quel che serve. */
const BASE_DISC = 92;
const MIN_K = 0.60;      /* sotto questa scala i nomi non si leggono piu' */
const MAX_K = 1.28;      /* sopra, i dischi diventano goffi */
const FREE_X = 100;      // il nodo del free practice sta staccato, a sinistra
const FREE_Y = 250;
const FIRST_X = 290;     // dove comincia il percorso vero
const STEP_X = 160;
const PAD_RIGHT = 40;
const TAIL_X = 108;      // la strada che prosegue oltre l'ultimo cerchio
const MID_Y = 244;
const CANVAS_H = 492;
/** Scostamenti dal centro: e' l'onda del percorso, si ripete ogni quattro. */
const WAVE = [0, 130, -120, 20];

/**
 * Lezioni che non esistono ancora.
 *
 * DuoSL e' una demo con quattro lezioni: questi cerchi vuoti in fondo, piu'
 * la strada che si perde dopo l'ultimo, dicono che il percorso e' pensato per
 * continuare senza fingere che ci sia gia' qualcosa dietro. Non si aprono in
 * nessun modo e non spiegano nulla: il disegno basta.
 *
 * Due e non piu': con tre il percorso non entrava piu' in una schermata sola
 * e compariva la barra di scorrimento.
 */
const COMING_SOON = 2;

/** icona nel file della lezione -> simbolo dello sprite */
const ICONS = {
  wave: '#i-hand',
  people: '#i-people',
  chat: '#i-chat',
  heart: '#i-heart',
  hand: '#i-hand',
};

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};


export class LessonPath {
  constructor({ onStartLesson, onStartFree, onExit }) {
    this.onStartLesson = onStartLesson;
    this.onStartFree = onStartFree;
    this.onExit = onExit;

    this.el = {
      screen: $('lectures-screen'),
      back: $('lectures-back-btn'),
      subtitle: $('path-subtitle'),
      scroll: $('path-scroll'),
      canvas: $('path-canvas'),
      lines: $('path-lines'),
      hint: $('path-hint'),
      start: $('path-start'),
      startName: $('path-start-name'),
    };

    this.lessons = [];
    this.states = [];
    this.selected = null;
    this.starting = false;
    this.avatar = null;
    this._onKey = this._onKey.bind(this);
  }

  // ------------------------------------------------------------------ ciclo

  mount() {
    // Stesso motivo della lezione e del free practice: il DOM sta in
    // index.html e sopravvive, mentre questa vista nasce ad ogni ingresso.
    this._ac = new AbortController();
    const opt = { signal: this._ac.signal };

    this.el.screen.classList.remove('hidden');
    this.el.back.addEventListener('click', () => this.onExit(), opt);
    this.el.start.addEventListener('click', () => this._start(), opt);
    document.addEventListener('keydown', this._onKey, opt);

    // La geometria dei nodi e' calcolata in JS a partire da --disc, che il CSS
    // cambia sotto i 900px: senza ridisegnare al ridimensionamento, i dischi
    // cambiavano misura mentre le posizioni restavano quelle di prima e il
    // tratteggio finiva fuori bersaglio.
    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => { if (this._ac) this._render(); }, 160);
    }, opt);

    this.starting = false;
    this.refresh();
  }

  unmount() {
    if (this._ac) { this._ac.abort(); this._ac = null; }
    clearTimeout(this.resizeTimer);
    clearTimeout(this.hintTimer);
    this.el.screen.classList.add('hidden');
  }

  /**
   * Ricarica i progressi e ridisegna.
   *
   * Va richiamata al RITORNO da una lezione: e' il momento in cui una lezione
   * chiusa si apre, e vederlo succedere e' meta' del senso del percorso.
   */
  async refresh() {
    const data = await Progress.load();
    this.lessons = (data && data.lessons) || [];
    this.states = this._computeStates(this.lessons);

    const summary = (data && data.summary) || { lessons_completed: 0, lessons_total: 0 };
    this.el.subtitle.textContent = this.lessons.length
      ? `${summary.lessons_completed} of ${summary.lessons_total} lessons complete`
      : 'No lessons found in lectures/';

    // Alla prima apertura si parte da quella da fare; tornando da una lezione
    // si tiene quella scelta, se e' ancora scegliibile. L'eccezione e' l'unica
    // che conta davvero: se la lezione scelta era proprio quella da fare ed e'
    // appena stata completata, la scelta avanza a quella nuova invece di
    // proporre di rifare quella appena finita.
    const finished = this.selectedWasNext && this._stateOf(this.selected) === 'done';
    if (!this.selected || !this._isSelectable(this.selected) || finished) {
      this.selected = this._defaultSelection();
    }
    this.selectedWasNext = this._stateOf(this.selected) === 'next';

    this._render();
  }

  _stateOf(id) {
    const i = this.lessons.findIndex((l) => l.id === id);
    return i === -1 ? null : this.states[i];
  }

  /**
   * Una lezione e' aperta se e' la prima o se la precedente e' stata
   * completata almeno una volta. Da questa regola discendono tutti e tre gli
   * stati, e ne esiste sempre al massimo uno "prossimo".
   */
  _computeStates(lessons) {
    return lessons.map((lesson, i) => {
      const prev = lessons[i - 1];
      const unlocked = i === 0 || (prev && prev.completions > 0);
      if (!unlocked) return 'locked';
      return lesson.completions > 0 ? 'done' : 'next';
    });
  }

  _defaultSelection() {
    const next = this.states.indexOf('next');
    if (next !== -1) return this.lessons[next].id;
    if (this.lessons.length) return this.lessons[this.lessons.length - 1].id;
    return FREE_ID;
  }

  _isSelectable(id) {
    if (id === FREE_ID) return true;
    const i = this.lessons.findIndex((l) => l.id === id);
    return i !== -1 && this.states[i] !== 'locked';
  }

  // -------------------------------------------------------------- geometria

/** Larghezza del percorso alla scala di riferimento. */
  _baseWidth(total) {
    return (total ? FIRST_X + (total - 1) * STEP_X : FIRST_X) + TAIL_X + PAD_RIGHT;
  }

  /**
   * Sceglie quanto grande sta il percorso e lo scrive in --disc.
   *
   * Vincolano ENTRAMBI i lati e vince il piu' stretto: il percorso deve stare
   * in una schermata sola, senza barra di scorrimento. Su un monitor grande i
   * cerchi crescono fino al massimo; su una finestra piccola rimpicciolis-
   * cono invece di finire tagliati o di far comparire la barra.
   *
   * Sotto MIN_K si smette di rimpicciolire e si torna a scorrere: a quel
   * punto i nomi non si leggerebbero piu', e un percorso illeggibile e'
   * peggio di un percorso da scorrere.
   */
  _applyScale(total) {
    const kH = (this.el.scroll.clientHeight || CANVAS_H) / CANVAS_H;
    const kW = (this.el.scroll.clientWidth || 1) / this._baseWidth(total);
    const k = Math.max(MIN_K, Math.min(MAX_K, kH, kW));
    this.el.screen.style.setProperty('--disc', `${Math.round(BASE_DISC * k)}px`);
    return k;
  }

  _geometry() {
    const total = this.lessons.length + COMING_SOON;
    const k = this._applyScale(total);

    const at = (i) => ({
      x: (FIRST_X + i * STEP_X) * k,
      y: (MID_Y + WAVE[i % WAVE.length]) * k,
    });

    const nodes = this.lessons.map((lesson, i) => ({ id: lesson.id, ...at(i) }));
    const soon = [];
    for (let i = this.lessons.length; i < total; i++) soon.push({ index: i, ...at(i) });

    const width = this._baseWidth(total) * k;
    return {
      k,
      nodes,
      soon,
      free: { id: FREE_ID, x: FREE_X * k, y: FREE_Y * k },
      width,
      height: CANVAS_H * k,
    };
  }

  // -------------------------------------------------------------- rendering

  _render() {
    const geo = this._geometry();
    this.geo = geo;

    this.el.canvas.style.width = `${geo.width}px`;
    this.el.canvas.style.height = `${geo.height}px`;
    this.el.lines.setAttribute('viewBox', `0 0 ${geo.width} ${geo.height}`);

    this._renderLines(geo);

    this.el.canvas.querySelectorAll('.path-node').forEach((n) => n.remove());
    this.el.canvas.appendChild(this._freeNode(geo.free));
    this.lessons.forEach((lesson, i) => {
      this.el.canvas.appendChild(this._lessonNode(lesson, i, geo.nodes[i]));
    });
    geo.soon.forEach((pos, j) => this.el.canvas.appendChild(this._soonNode(pos, j)));

    this._ensureAvatar();
    this._syncSelection({ animate: false });
  }

  /** Le curve fra un nodo e il successivo, colorate secondo dove portano. */
  _renderLines(geo) {
    this.el.lines.innerHTML = '';
    const all = [...geo.nodes, ...geo.soon];

    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i];
      const b = all[i + 1];
      const bend = (b.x - a.x) * 0.42;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d',
        `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`);

      const dest = this.states[i + 1];
      if (i + 1 >= geo.nodes.length) {
        path.classList.add('to-soon');
        path.style.opacity = String(this._fade(i + 1 - geo.nodes.length));
      } else if (dest === 'locked') {
        path.classList.add('to-locked');
      }
      this.el.lines.appendChild(path);
    }

    if (all.length) this._renderTail(all[all.length - 1], geo);
  }

  /**
   * Oltre l'ultimo cerchio la strada prosegue e si perde.
   *
   * E' l'unico pezzo che dice "questo percorso e' pensato per continuare"
   * senza dover scrivere niente: sfuma con un gradiente invece di fermarsi
   * netta, altrimenti sembrerebbe una linea tagliata male.
   */
  _renderTail(from, geo) {
    const NS = 'http://www.w3.org/2000/svg';
    const total = geo.nodes.length + geo.soon.length;
    const rise = (WAVE[total % WAVE.length] - WAVE[(total - 1) % WAVE.length]) * 0.30 * geo.k;   // smorzata: la strada si perde, non impenna
    const len = TAIL_X * geo.k;

    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'path-tail-fade');
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', from.x);
    grad.setAttribute('x2', from.x + len);
    ['start', 'end'].forEach((cls) => {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', cls === 'start' ? '0' : '1');
      stop.setAttribute('class', `tail-${cls}`);
      grad.appendChild(stop);
    });
    defs.appendChild(grad);
    this.el.lines.appendChild(defs);

    const tail = document.createElementNS(NS, 'path');
    tail.setAttribute('d',
      `M ${from.x} ${from.y}` +
      ` C ${from.x + len * 0.34} ${from.y},` +
      ` ${from.x + len * 0.62} ${from.y + rise},` +
      ` ${from.x + len} ${from.y + rise}`);
    tail.setAttribute('stroke', 'url(#path-tail-fade)');
    tail.classList.add('path-tail');
    this.el.lines.appendChild(tail);
  }

  /** Quanto e' sbiadito il j-esimo cerchio "in arrivo". */
  _fade(j) { return Math.max(0.3, 1 - (j + 1) * 0.22); }

  _node(id, pos, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `path-node${extraClass ? ' ' + extraClass : ''}`;
    btn.dataset.id = id;
    btn.style.setProperty('--x', `${pos.x}px`);
    btn.style.setProperty('--y', `${pos.y}px`);
    return btn;
  }

  _lessonNode(lesson, i, pos) {
    const state = this.states[i];
    const locked = state === 'locked';

    const btn = this._node(lesson.id, pos);
    btn.dataset.state = state;
    btn.setAttribute('aria-pressed', 'false');
    if (locked) btn.setAttribute('aria-disabled', 'true');

    // Il nome resta nascosto sulle lezioni chiuse — la sorpresa e' parte del
    // motivo per arrivarci — ma non a chi usa uno screen reader o il mouse.
    btn.setAttribute('aria-label', locked
      ? `Lesson ${i + 1}, ${lesson.title}, locked`
      : `Lesson ${i + 1}, ${lesson.title}`);
    btn.title = locked ? `${lesson.title} (locked)` : lesson.title;

    const icon = locked ? '#i-lock' : (ICONS[lesson.icon] || '#i-hand');
    btn.innerHTML = `
      ${locked ? '' : `<span class="node-name">${lesson.title}</span>`}
      <span class="node-ring" aria-hidden="true"></span>
      <span class="node-disc"><svg class="icon"><use href="${icon}"></use></svg></span>
      <span class="node-check" aria-hidden="true"><svg class="icon"><use href="#i-check"></use></svg></span>
      <span class="node-num">${i + 1}</span>`;

    btn.addEventListener('click', () => {
      if (locked) this._knock(btn, i);
      else this._select(lesson.id);
    }, { signal: this._ac.signal });

    return btn;
  }

  /** Cerchio vuoto in fondo: il percorso continua, ma non in questa demo. */
  _soonNode(pos, j) {
    const number = this.lessons.length + j + 1;
    const btn = this._node(`__soon${j}`, pos);
    btn.dataset.state = 'soon';
    btn.style.setProperty('--fade', String(this._fade(j)));
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-label', `Lesson ${number}, coming soon`);
    btn.title = 'Coming soon';

    btn.innerHTML = `
      <span class="node-ring" aria-hidden="true"></span>
      <span class="node-disc"><svg class="icon"><use href="#i-more"></use></svg></span>
      <span class="node-num">${number}</span>`;

    // Nessun messaggio: il cerchio punteggiato e la strada che si perde lo
    // dicono gia'. Resta solo il lampeggio, come conferma che il clic e' arrivato.
    btn.addEventListener('click', () => {
      btn.classList.remove('knock');
      void btn.offsetWidth;
      btn.classList.add('knock');
    }, { signal: this._ac.signal });

    return btn;
  }

  _freeNode(pos) {
    const btn = this._node(FREE_ID, pos, 'free-node');
    btn.dataset.state = 'free';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Free practice');
    btn.title = 'Practise any sign you like';

    // Il faro sta PRIMA del disco nel markup e dietro di lui per z-index: ne
    // spunta la torre, come faceva la palma. L'alone che respira e' la sua
    // luce, ed e' anche l'unica cosa che si muove da sola in tutta la
    // schermata: basta quella a far capire che questo nodo e' diverso.
    btn.innerHTML = `
      <img class="node-lighthouse" src="/static/lighthouse.svg" alt="" aria-hidden="true">
      <span class="free-glow" aria-hidden="true"></span>
      <span class="node-disc"><svg class="icon"><use href="#i-infinity"></use></svg></span>
      <span class="node-name">Free Practice</span>`;

    btn.addEventListener('click', () => this._select(FREE_ID), { signal: this._ac.signal });
    return btn;
  }

  _ensureAvatar() {
    if (this.avatar && this.avatar.isConnected) return;
    const el = document.createElement('span');
    el.className = 'path-avatar';
    el.id = 'path-avatar';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="avatar-inner"><img src="/static/boat.svg" alt="" aria-hidden="true"></span>';
    this.el.canvas.appendChild(el);
    this.avatar = el;
  }

  // -------------------------------------------------------------- selezione

  _select(id) {
    if (this.starting || id === this.selected) return;
    this.selected = id;
    this._clearHint();
    this._syncSelection({ animate: true });
  }

  _positionOf(id) {
    if (!this.geo) return null;
    if (id === FREE_ID) return this.geo.free;
    return this.geo.nodes[this.lessons.findIndex((l) => l.id === id)] || null;
  }

  _syncSelection({ animate }) {
    const nodes = [...this.el.canvas.querySelectorAll('.path-node')];
    nodes.forEach((n) => n.setAttribute('aria-pressed', String(n.dataset.id === this.selected)));

    const pos = this._positionOf(this.selected);
    if (pos && this.avatar) {
      this.avatar.style.setProperty('--x', `${pos.x}px`);
      this.avatar.style.setProperty('--y', `${pos.y}px`);
      if (animate && !reducedMotion()) {
        const inner = this.avatar.firstElementChild;
        inner.classList.remove('hop');
        void inner.offsetWidth;          // riavvia l'animazione
        inner.classList.add('hop');
      }
    }

    // Il percorso e' piu' largo della finestra: il nodo scelto va portato in
    // vista SEMPRE, anche al primo disegno, altrimenti si apre la schermata
    // su un pezzo di percorso che non c'entra con quello che sta per partire.
    // block:'nearest' e non 'center': centrare in verticale farebbe scorrere
    // anche la pagina, che qui non deve muoversi mai.
    if (pos) this._bringIntoView(pos, animate);

    this._syncStartButton();
  }

  /**
   * Porta il nodo scelto in vista, a un terzo da sinistra invece che al
   * centro: davanti resta piu' percorso visibile di quanto ne resti dietro,
   * ed e' quella la direzione in cui si va.
   *
   * Non si usa scrollIntoView: i nodi sono posizionati con una transform, per
   * cui il loro offset nel documento e' zero e il browser non saprebbe dove
   * portarli.
   */
  _bringIntoView(pos, animate) {
    const scroll = this.el.scroll;
    const canvasLeft = this.el.canvas.getBoundingClientRect().left
                     - scroll.getBoundingClientRect().left
                     + scroll.scrollLeft;
    const target = canvasLeft + pos.x - scroll.clientWidth * 0.36;
    const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);

    scroll.scrollTo({
      left: Math.max(0, Math.min(max, target)),
      behavior: animate ? 'smooth' : 'auto',
    });
  }

  _syncStartButton() {
    if (this.selected === FREE_ID) {
      this.el.startName.textContent = 'free practice';
      this.el.start.disabled = false;
      return;
    }
    const lesson = this.lessons.find((l) => l.id === this.selected);
    this.el.startName.textContent = lesson ? lesson.title : '';
    this.el.start.disabled = !lesson;
  }

  /** Lezione chiusa: si dice perche', senza rimproverare e senza scossoni. */
  _knock(btn, i) {
    const prev = this.lessons[i - 1];
    this._hint(prev
      ? `Finish ${prev.title} to unlock this lesson.`
      : 'This lesson is not available yet.');

    btn.classList.remove('knock');
    void btn.offsetWidth;
    btn.classList.add('knock');
  }

  _hint(text) {
    this.el.hint.textContent = text;
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this._clearHint(), 4200);
  }

  _clearHint() {
    clearTimeout(this.hintTimer);
    this.el.hint.textContent = '';
  }

  // ------------------------------------------------------------------ avvio

  _start() {
    if (this.starting || !this.selected) return;
    const go = () => {
      if (this.selected === FREE_ID) this.onStartFree();
      else this.onStartLesson(this.selected);
    };

    if (reducedMotion() || !this.avatar) { go(); return; }

    // L'omino entra nel cerchio, poi si cambia schermata: e' il ponte fra
    // "ho scelto questa" e "ci sono dentro".
    this.starting = true;
    this.el.start.disabled = true;
    const inner = this.avatar.firstElementChild;
    inner.classList.remove('hop');
    void inner.offsetWidth;
    inner.classList.add('dive');

    setTimeout(() => {
      inner.classList.remove('dive');
      this.starting = false;
      this.el.start.disabled = false;
      go();
    }, 430);
  }

  // --------------------------------------------------------------- tastiera

  _onKey(e) {
    if (this.el.screen.classList.contains('hidden')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') { this.onExit(); return; }

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Frecce fra i nodi scegliibili: il percorso e' una fila, ed e' cosi'
      // che ci si aspetta di percorrerlo.
      const ids = [FREE_ID, ...this.lessons.filter((l, i) => this.states[i] !== 'locked').map((l) => l.id)];
      const at = ids.indexOf(this.selected);
      if (at === -1) return;
      const to = e.key === 'ArrowRight' ? at + 1 : at - 1;
      if (to < 0 || to >= ids.length) return;
      e.preventDefault();
      this._select(ids[to]);
    }
  }
}
