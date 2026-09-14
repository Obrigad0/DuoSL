// static/tutorial.js
//
// Istruzioni base per il riconoscimento via webcam

const $ = (id) => document.getElementById(id);

const SEEN_KEY = 'duosl.tutorialSeen';
const SLIDES_COUNT = 3; // deve combaciare col numero di .tutorial-slide in index.html

class Tutorial {
  constructor() {
    this.el = {
      screen: $('tutorial-screen'),
      close: $('tutorial-close'),
      slides: [...document.querySelectorAll('.tutorial-slide')],
      dots: [...document.querySelectorAll('.tutorial-dot')],
      prev: $('tutorial-prev'),
      next: $('tutorial-next'),
      skip: $('tutorial-skip'),
    };
    this.index = 0;
    this.onDone = null;
    this._ac = null;
    this._onKey = this._onKey.bind(this);
  }

  /** Vero mentre l'overlay e' a schermo: le schermate sotto smettono di
   *  ascoltare la tastiera, altrimenti un Esc chiuderebbe anche loro. */
  get isOpen() { return this._ac !== null; }

  static hasBeenSeen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; }
    catch { return false; }
  }

  /**
   * Apre l'overlay
   */
  open(onDone = null) {
    if (this._ac) return;               // gia' aperto, non riaprire due volte
    this.index = 0;
    this.onDone = onDone;

    this._ac = new AbortController();
    const opt = { signal: this._ac.signal };
    this.el.close.addEventListener('click', () => this._close(), opt);
    this.el.skip.addEventListener('click', () => this._close(), opt);
    this.el.prev.addEventListener('click', () => this._go(this.index - 1), opt);
    this.el.next.addEventListener('click', () => this._advance(), opt);
    this.el.dots.forEach((d, i) => d.addEventListener('click', () => this._go(i), opt));
    document.addEventListener('keydown', this._onKey, opt);

    this._render();
    this.el.screen.classList.remove('hidden');
  }

  _advance() {
    if (this.index === SLIDES_COUNT - 1) this._close();
    else this._go(this.index + 1);
  }

  _go(i) {
    if (i < 0 || i >= SLIDES_COUNT) return;
    this.index = i;
    this._render();
  }

  _render() {
    this.el.slides.forEach((s, i) => { s.hidden = i !== this.index; });
    this.el.dots.forEach((d, i) => d.setAttribute('aria-current', String(i === this.index)));
    this.el.prev.hidden = this.index === 0;
    this.el.next.innerHTML = this.index === SLIDES_COUNT - 1
      ? 'Got it <svg class="icon"><use href="#i-check"></use></svg>'
      : 'Next <svg class="icon"><use href="#i-arrow-right"></use></svg>';
  }

  _close() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignora */ }
    if (this._ac) { this._ac.abort(); this._ac = null; }
    this.el.screen.classList.add('hidden');
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }

  _onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); this._close(); }
  }
}

export const tutorial = new Tutorial();
export { Tutorial };