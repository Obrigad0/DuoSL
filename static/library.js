// static/library.js
//
// La libreria dei segni: un pannello laterale con quello che l'utente ha
// incontrato nelle lezioni, ognuno col suo video.
//
// Non e' un modale. La pagina sotto resta viva e usabile mentre e' aperto —
// e' esattamente il motivo per cui e' un drawer che RESTRINGE il palco invece
// di una finestra che lo copre: durante il free training la webcam non deve
// mai sparire.

import { Progress } from './progress.js';

const $ = (id) => document.getElementById(id);

const SECTIONS = [
  { status: 'known',  title: 'Known',     icon: '#i-check' },
  { status: 'review', title: 'To review', icon: '#i-retry' },
];

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};


export class LibraryDrawer {
  /**
   * @param {object} opts
   * @param {(sign: object|null) => void} opts.onPin  segno scelto, o null se staccato
   */
  constructor({ onPin }) {
    this.onPin = onPin;

    this.el = {
      screen: $('app-screen'),
      drawer: $('library-drawer'),
      toggle: $('free-library'),
      close: $('lib-close'),
      title: $('lib-title'),
      body: $('lib-body'),
      count: $('library-count'),
      filters: document.querySelectorAll('.lib-filters .seg'),
    };

    this.signs = [];
    this.byGloss = new Map();
    this.filter = 'all';
    this.pinned = null;
    this.open = false;
  }

  // ------------------------------------------------------------------ ciclo

  /** @param {AbortSignal} signal ciclo di vita posseduto da FreeView */
  mount(signal) {
    const opt = { signal };
    this.el.toggle.addEventListener('click', () => this.toggle(), opt);
    this.el.close.addEventListener('click', () => this.setOpen(false), opt);

    this.el.filters.forEach((btn) => {
      btn.addEventListener('click', () => this._setFilter(btn.dataset.filter), opt);
    });

    this._reset();
    this.refresh();
  }

  /**
   * Riporta il pannello com'era all'ingresso.
   * Il DOM sta in index.html e sopravvive all'uscita dalla schermata: senza
   * questo, rientrando ci si ritroverebbe addosso il filtro e l'apertura
   * lasciati dalla volta prima.
   */
  _reset() {
    this.filter = 'all';
    this.pinned = null;
    this.setOpen(false, { silent: true });
    this._syncFilterButtons();
  }

  // ------------------------------------------------------------------- dati

  async refresh() {
    const data = await Progress.load();
    this.signs = (data && data.signs) || [];
    this.byGloss = new Map(this.signs.map((s) => [s.gloss, s]));

    const summary = (data && data.summary) || { known: 0, review: 0 };
    this.el.count.textContent = String(summary.known + summary.review);

    this._render();
  }

  /** Il nome leggibile di un gloss, se l'utente lo ha gia' incontrato. */
  displayOf(gloss) {
    const sign = this.byGloss.get(gloss);
    return sign ? sign.display : null;
  }

  // ---------------------------------------------------------- apri / chiudi

  toggle() { this.setOpen(!this.open); }

  setOpen(open, { silent = false } = {}) {
    this.open = open;
    this.el.screen.classList.toggle('lib-open', open);
    this.el.toggle.setAttribute('aria-expanded', String(open));

    // Fuori dal flusso quando e' chiuso: senza questo le card restano
    // raggiungibili col tab anche a pannello invisibile.
    this.el.drawer.inert = !open;
    this.el.drawer.setAttribute('aria-hidden', String(!open));

    if (silent) return;
    if (open) this.el.title.focus();
    else this.el.toggle.focus();
  }

  // --------------------------------------------------------------- rendering

  _setFilter(filter) {
    this.filter = filter;
    this._syncFilterButtons();
    this._render();
  }

  _syncFilterButtons() {
    this.el.filters.forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.filter === this.filter));
    });
  }

  _render() {
    this.el.body.innerHTML = '';

    if (!this.signs.length) {
      this.el.body.appendChild(this._empty(
        'Your library is empty',
        'Signs you practise in the lessons show up here, with their demo video.'));
      return;
    }

    let shown = 0;
    for (const section of SECTIONS) {
      if (this.filter !== 'all' && this.filter !== section.status) continue;

      const list = this.signs.filter((s) => s.status === section.status);
      if (!list.length) continue;
      shown += list.length;

      const wrap = document.createElement('section');
      wrap.className = 'lib-section';

      const title = document.createElement('h3');
      title.className = 'lib-section-title';
      title.innerHTML = `${section.title} <span class="count">${list.length}</span>`;
      wrap.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'lib-grid';
      list.forEach((sign) => grid.appendChild(this._card(sign)));
      wrap.appendChild(grid);

      this.el.body.appendChild(wrap);
    }

    if (!shown) {
      this.el.body.appendChild(this._empty(
        'Nothing here yet',
        this.filter === 'known'
          ? 'Signs you get right in a lesson land in this group.'
          : 'Signs you skip in a lesson land in this group.'));
    }
  }

  _empty(title, text) {
    const box = document.createElement('div');
    box.className = 'lib-empty';
    box.innerHTML = `<svg class="icon"><use href="#i-hand"></use></svg>
      <strong>${title}</strong>${text}`;
    return box;
  }

  _card(sign) {
    const section = SECTIONS.find((s) => s.status === sign.status) || SECTIONS[1];

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'lib-card';
    card.dataset.gloss = sign.gloss;
    card.dataset.status = sign.status;
    card.setAttribute('aria-pressed', String(this.pinned === sign.gloss));
    card.title = sign.demo_url ? `Show ${sign.display} next to your camera` : sign.display;

    const thumb = document.createElement('div');
    thumb.className = 'lib-thumb';

    const idle = document.createElement('span');
    idle.className = 'thumb-idle';
    idle.innerHTML = '<svg class="icon"><use href="#i-hand"></use></svg>';
    thumb.appendChild(idle);

    let video = null;
    if (sign.demo_url) {
      // Nessun src e preload="none": i 25 demo pesano ~19 MB in tutto, e
      // montarli tutti caricati farebbe scaricare l'intera cartella ogni
      // volta che si apre il pannello. Il src arriva al primo hover.
      video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'none';
      thumb.appendChild(video);

      const play = () => this._play(card, video, sign.demo_url);
      const stop = () => this._stop(card, video);
      card.addEventListener('mouseenter', play);
      card.addEventListener('focus', play);
      card.addEventListener('mouseleave', stop);
      card.addEventListener('blur', stop);
      video.addEventListener('playing', () => card.classList.add('is-playing'));
    }

    const name = document.createElement('span');
    name.className = 'lib-name';
    name.innerHTML = `<span>${sign.display}</span>
      <span class="lib-badge"><svg class="icon"><use href="${section.icon}"></use></svg></span>`;

    card.appendChild(thumb);
    card.appendChild(name);

    card.addEventListener('click', () => this._choose(sign));
    return card;
  }

  _play(card, video, url) {
    if (reducedMotion()) return;
    if (!video.getAttribute('src')) {
      video.src = url;
      video.preload = 'auto';
    }
    video.play().catch(() => {});
  }

  _stop(card, video) {
    video.pause();
    try { video.currentTime = 0; } catch { /* src non ancora caricato */ }
    card.classList.remove('is-playing');
  }

  /** Un secondo click sulla stessa card la stacca: e' anche il modo di uscirne. */
  _choose(sign) {
    const same = this.pinned === sign.gloss;
    this.pinned = same ? null : sign.gloss;

    this.el.body.querySelectorAll('.lib-card').forEach((card) => {
      card.setAttribute('aria-pressed', String(card.dataset.gloss === this.pinned));
    });

    this.onPin(same ? null : sign);
  }

  /** Chiamato da fuori quando il segno viene staccato dalla ✕ sulla demo. */
  clearPinned() {
    this.pinned = null;
    this.el.body.querySelectorAll('.lib-card').forEach((card) => {
      card.setAttribute('aria-pressed', 'false');
    });
  }
}
