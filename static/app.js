// static/app.js
//
// Punto d'ingresso: decide quale schermata mostrare e la tiene in vita.
//
//   ?lesson=<id>  -> schermata lezione   (LessonView)
//   ?mode=free    -> Free Training       (FreeView)
//   nessuno       -> menu

import { LessonView } from './lesson.js';
import { FreeView } from './free.js';
import { Progress } from './progress.js';

const $ = (id) => document.getElementById(id);

const menuScreen = $('menu-screen');
const lecturesScreen = $('lectures-screen');
const appScreen = $('app-screen');

let lessonView = null;
let freeView = null;

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');


/* ======================= Pannello debug del menu ==========================
   Unico posto da cui si azzera la memoria dei progressi. I listener si
   agganciano una volta sola al caricamento della pagina, quindi qui non serve
   l'AbortController che governa lezione e free training. */

const menuDebug = {
  init() {
    $('menu-debug-toggle').addEventListener('click', () => this.toggle());
    $('menu-reset').addEventListener('click', () => this.confirm(true));
    $('menu-reset-no').addEventListener('click', () => this.confirm(false));
    $('menu-reset-yes').addEventListener('click', () => this.doReset());
  },

  toggle() {
    const btn = $('menu-debug-toggle');
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $('menu-debug-panel').hidden = !open;
    this.confirm(false);
    if (open) this.refresh();
  },

  /** Conferma in due passi: il reset cancella tutto e non si torna indietro. */
  confirm(asking) {
    $('menu-reset-wrap').hidden = asking;
    $('menu-reset-confirm').hidden = !asking;
  },

  async refresh() {
    const data = await Progress.load();
    const line = $('menu-progress-line');

    if (!data) {
      line.textContent = 'Progress unavailable — is the server running?';
      return;
    }

    const s = data.summary;
    line.innerHTML =
      `<b>${s.lessons_completed}</b> of ${s.lessons_total} lessons completed<br>` +
      `<b>${s.known}</b> signs known · <b>${s.review}</b> to review`;
  },

  async doReset() {
    await Progress.reset();
    this.confirm(false);
    this.refresh();
  },
};


/* ================================ Navigazione ============================= */

function goToLesson(lessonId) {
  hide(menuScreen);
  hide(lecturesScreen);
  hide(appScreen);

  lessonView = new LessonView(lessonId, { onExit: leaveLesson });
  lessonView.mount();
}

function leaveLesson() {
  if (lessonView) { lessonView.unmount(); lessonView = null; }

  const url = new URL(location);
  url.searchParams.delete('lesson');
  history.replaceState({}, '', url);

  show(lecturesScreen);
}

function goToFree() {
  hide(menuScreen);
  hide(lecturesScreen);

  freeView = new FreeView({ onExit: leaveFree });
  freeView.mount();
}

function leaveFree() {
  if (freeView) { freeView.unmount(); freeView = null; }

  const url = new URL(location);
  url.searchParams.delete('mode');
  history.replaceState({}, '', url);

  show(menuScreen);
}


/* =============================== Avvio =================================== */

function init() {
  const params = new URLSearchParams(location.search);
  const lesson = params.get('lesson');
  const mode = params.get('mode');

  $('lessons-btn').addEventListener('click', () => { hide(menuScreen); show(lecturesScreen); });
  $('lectures-back-btn').addEventListener('click', () => { hide(lecturesScreen); show(menuScreen); });

  // Come le lezioni: niente ricarica della pagina. Prima faceva
  // location.search = 'mode=free', che ricaricava tutto — modello di
  // navigazione diverso dal resto dell'app senza motivo.
  $('free-btn').addEventListener('click', () => {
    const url = new URL(location);
    url.searchParams.set('mode', 'free');
    history.pushState({}, '', url);
    goToFree();
  });

  document.querySelectorAll('.lecture-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.lesson;
      const url = new URL(location);
      url.searchParams.set('lesson', id);
      history.pushState({}, '', url);
      goToLesson(id);
    });
  });

  menuDebug.init();

  if (lesson) {
    goToLesson(lesson);
  } else if (mode === 'free') {
    goToFree();
  } else {
    show(menuScreen);
    hide(lecturesScreen);
    hide(appScreen);
  }
}

init();
