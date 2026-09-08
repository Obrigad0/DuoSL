// static/app.js
//
// Punto d'ingresso: decide quale schermata mostrare e la tiene in vita.
//
//   ?lesson=<id>  -> schermata lezione   (LessonView)
//   ?mode=free    -> Free Practice       (FreeView)
//   nessuno       -> menu, da cui si arriva al percorso delle lezioni

import { LessonView } from './lesson.js';
import { FreeView } from './free.js';
import { LessonPath } from './lessons.js';
import { Progress } from './progress.js';

const $ = (id) => document.getElementById(id);

const menuScreen = $('menu-screen');
const lecturesScreen = $('lectures-screen');
const appScreen = $('app-screen');

let lessonView = null;
let freeView = null;
let lessonPath = null;

// Da dove si e' entrati nel free practice: si torna da dove si e' venuti.
let freeOrigin = 'menu';

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');


/* ======================= Pannello debug del menu ==========================
   Unico posto da cui si azzera la memoria dei progressi. I listener si
   agganciano una volta sola al caricamento della pagina, quindi qui non serve
   l'AbortController che governa le altre schermate. */

/** I due comandi del pannello. Entrambi SOVRASCRIVONO: stessa conferma. */
const DEBUG_ACTIONS = {
  fill: {
    text: 'Mark all four lessons as done, splitting the signs at random between known and to review? This replaces your current progress.',
    yes: 'Yes, fill it in',
    danger: false,
    run: () => Progress.fillDemo(),
  },
  reset: {
    text: 'Delete every lesson and sign learned so far?',
    yes: 'Yes, reset everything',
    danger: true,
    run: () => Progress.reset(),
  },
};

const menuDebug = {
  pending: null,

  init() {
    $('menu-debug-toggle').addEventListener('click', () => this.toggle());
    $('menu-fill').addEventListener('click', () => this.ask('fill'));
    $('menu-reset').addEventListener('click', () => this.ask('reset'));
    $('menu-confirm-no').addEventListener('click', () => this.ask(null));
    $('menu-confirm-yes').addEventListener('click', () => this.run());
  },

  toggle() {
    const btn = $('menu-debug-toggle');
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    $('menu-debug-panel').hidden = !open;
    this.ask(null);
    if (open) this.refresh();
  },

  /** Conferma in due passi: nessuno dei due comandi si puo' annullare dopo. */
  ask(kind) {
    this.pending = kind;
    const action = DEBUG_ACTIONS[kind];

    $('menu-dbg-actions').hidden = Boolean(action);
    $('menu-confirm').hidden = !action;
    if (!action) return;

    $('menu-confirm-text').textContent = action.text;
    const yes = $('menu-confirm-yes');
    yes.textContent = action.yes;
    yes.classList.toggle('danger', action.danger);
  },

  async run() {
    const action = DEBUG_ACTIONS[this.pending];
    if (!action) return;
    await action.run();
    this.ask(null);
    this.refresh();
  },

  async refresh() {
    const data = await Progress.load();
    const line = $('menu-progress-line');

    if (!data) {
      line.textContent = 'Progress unavailable, is the server running?';
      return;
    }

    const s = data.summary;
    line.innerHTML =
      `<b>${s.lessons_completed}</b> of ${s.lessons_total} lessons completed<br>` +
      `<b>${s.known}</b> signs known · <b>${s.review}</b> to review`;
  },

};


/* ================================ Navigazione ============================= */

/** Il percorso e' uno solo per sessione: cosi' ricorda il nodo scelto. */
function getPath() {
  if (!lessonPath) {
    lessonPath = new LessonPath({
      onStartLesson: goToLesson,
      onStartFree: () => { freeOrigin = 'path'; goToFree(); },
      onExit: leavePath,
    });
  }
  return lessonPath;
}

function goToPath() {
  hide(menuScreen);
  hide(appScreen);
  getPath().mount();
}

function leavePath() {
  getPath().unmount();
  show(menuScreen);
}

function goToLesson(lessonId) {
  hide(menuScreen);
  hide(appScreen);
  getPath().unmount();

  // Entrando da link diretto il parametro c'e' gia': ripeterlo aggiungerebbe
  // una voce di cronologia identica alla precedente.
  const url = new URL(location);
  if (url.searchParams.get('lesson') !== lessonId) {
    url.searchParams.set('lesson', lessonId);
    history.pushState({}, '', url);
  }

  lessonView = new LessonView(lessonId, { onExit: leaveLesson });
  lessonView.mount();
}

function leaveLesson() {
  if (lessonView) { lessonView.unmount(); lessonView = null; }

  const url = new URL(location);
  url.searchParams.delete('lesson');
  history.replaceState({}, '', url);

  // mount() richiama refresh(): se la lezione appena finita ne ha sbloccata
  // un'altra, il lucchetto se ne va sotto gli occhi di chi torna.
  goToPath();
}

function goToFree() {
  hide(menuScreen);
  hide(lecturesScreen);
  if (lessonPath) lessonPath.unmount();

  const url = new URL(location);
  if (url.searchParams.get('mode') !== 'free') {
    url.searchParams.set('mode', 'free');
    history.pushState({}, '', url);
  }

  freeView = new FreeView({ onExit: leaveFree });
  freeView.mount();
}

function leaveFree() {
  if (freeView) { freeView.unmount(); freeView = null; }

  const url = new URL(location);
  url.searchParams.delete('mode');
  history.replaceState({}, '', url);

  if (freeOrigin === 'path') goToPath();
  else show(menuScreen);
}


/* =============================== Avvio =================================== */

function init() {
  const params = new URLSearchParams(location.search);
  const lesson = params.get('lesson');
  const mode = params.get('mode');

  // bottone che porta al percorso delle lezioni
  $('start-btn').addEventListener('click', goToPath);

  menuDebug.init();

  if (lesson) {
    goToLesson(lesson);
  } else if (mode === 'free') {
    freeOrigin = 'menu';
    goToFree();
  } else {
    show(menuScreen);
    hide(lecturesScreen);
    hide(appScreen);
  }
}

init();