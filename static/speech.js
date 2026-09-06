// static/speech.js
//
// Annunci vocali opzionali, sopra la Web Speech API (nativa, nessuna dipendenza).
//
// Perche' esistono: durante la pratica la vista e' satura — l'utente confronta
// la demo con la propria immagine. L'udito invece e' libero, quindi la voce non
// compete per la stessa risorsa attentiva ma ne aggiunge una.
//
// Perche' sono spenti di default: il pubblico dell'app si sovrappone alla
// comunita' sorda. La voce e' un'aggiunta, mai l'unico canale — tutto quello
// che viene pronunciato resta scritto a schermo.
//
// L'implementazione e' piu' difensiva di quanto sembri necessario perche'
// speechSynthesis ha tre difetti noti, tutti presenti su Chrome/Windows:
//   1. speak() chiamato subito dopo cancel() viene ingoiato senza errori;
//   2. l'utterance raccolta dal GC interrompe la voce a meta';
//   3. la coda puo' restare in stato "paused" e da li' non parla piu' nulla.

const STORAGE_KEY = 'duosl.voice';

export const Speech = {
  supported: typeof window !== 'undefined' && 'speechSynthesis' in window,
  enabled: false,
  lastError: null,

  _voice: null,
  _keepAlive: null,   // difetto 2: senza un riferimento vivo il GC tronca la voce
  _pending: null,

  init() {
    if (!this.supported) return;

    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) === 'on';
    } catch {
      this.enabled = false;   // finestra privata, storage bloccato: pazienza
    }

    // getVoices() e' quasi sempre vuoto al primo giro: l'elenco arriva dopo.
    this._pickVoice();
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      this._pickVoice();
      // Se qualcosa era stato chiesto prima che le voci fossero pronte, lo dice ora.
      if (this._pending) { const t = this._pending; this._pending = null; this.speakNow(t); }
    });
  },

  _pickVoice() {
    const voices = window.speechSynthesis.getVoices() || [];
    this._voice = voices.find(v => v.lang === 'en-US')
               || voices.find(v => v.lang && v.lang.startsWith('en'))
               || voices[0]
               || null;
  },

  get voiceName() { return this._voice ? this._voice.name : null; },

  setEnabled(on) {
    this.enabled = !!on;
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off'); } catch { /* ignora */ }
    if (!this.enabled) this.stop();
  },

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  },

  stop() {
    if (!this.supported) return;
    this._pending = null;
    window.speechSynthesis.cancel();
  },

  /** Parla solo se la dettatura e' accesa. */
  say(text) {
    if (this.enabled) this.speakNow(text);
  },

  /**
   * Parla comunque: e' il pulsante "ripeti la parola", che deve funzionare
   * anche a dettatura spenta perche' e' una richiesta esplicita.
   */
  speakNow(text) {
    if (!this.supported || !text) return;

    const synth = window.speechSynthesis;

    // Difetto 3: una coda rimasta in pausa non parla piu'.
    if (synth.paused) synth.resume();

    // Le voci non sono ancora arrivate: si rimanda a voiceschanged invece di
    // parlare a vuoto.
    if (!this._voice && synth.getVoices().length === 0) {
      this._pending = text;
      // Alcuni browser popolano l'elenco solo dopo la prima chiamata a getVoices
      setTimeout(() => {
        this._pickVoice();
        if (this._pending === text && this._voice) { this._pending = null; this._speak(text); }
      }, 250);
      return;
    }

    // Difetto 1: cancel() immediatamente seguito da speak() perde la frase.
    // Si annulla solo se c'e' davvero qualcosa in corso, e si lascia un tick.
    if (synth.speaking || synth.pending) {
      synth.cancel();
      setTimeout(() => this._speak(text), 90);
    } else {
      this._speak(text);
    }
  },

  _speak(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.volume = 1;

    // Voce e lingua DEVONO concordare. Su un Windows italiano le uniche voci
    // installate sono italiane: assegnarne una lasciando lang='en-US' mette il
    // motore in contraddizione con se stesso, ed e' una causa nota di silenzio
    // totale. Meglio una voce italiana che pronuncia "HELLO" che nessun suono.
    if (this._voice) {
      u.voice = this._voice;
      u.lang = this._voice.lang;
    } else {
      u.lang = 'en-US';   // nessuna voce nota: decide il motore
    }

    u.onerror = (e) => {
      // "interrupted" e "canceled" sono normali: e' il nostro stesso cancel().
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.lastError = e.error;
      console.warn('[DuoSL] sintesi vocale:', e.error);
    };
    u.onend = () => { this._keepAlive = null; };

    this._keepAlive = u;
    window.speechSynthesis.speak(u);
  },
};
