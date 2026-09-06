// static/app.js
//
// Punto d'ingresso: decide quale schermata mostrare e la tiene in vita.
//
//   ?lesson=<id>  -> schermata lezione   (LessonView, ridisegnata)
//   ?mode=free    -> Free Training       (schermata di prova, in attesa del suo turno)
//   nessuno       -> menu

import { SignSession } from './session.js';
import { LessonView } from './lesson.js';

const $ = (id) => document.getElementById(id);

const menuScreen = $('menu-screen');
const lecturesScreen = $('lectures-screen');
const appScreen = $('app-screen');

let lessonView = null;

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');


/* ============================== Free Training ==============================
   Non ridisegnato in questo passaggio: stessa interfaccia di prima, ma la
   camera e il socket passano ora da SignSession, condiviso con la lezione. */

const free = {
  session: null,
  cameraFailed: false,

  start() {
    if (this.session && this.session.isRunning) return;
    this.cameraFailed = false;

    this.session = new SignSession({
      lesson: null,
      video: $('free-webcam'),
      canvas: $('free-overlay'),
      // Il socket si apre prima che la camera risponda: se il permesso e' stato
      // negato, "Connected" non deve cancellare l'avviso.
      onOpen: () => {
        if (this.cameraFailed) return;
        $('message').value = 'Connected to sign model.';
      },
      onStatus: (m) => {
        $('capture-dot').classList.toggle('active', m.capturing);
        const movement = typeof m.movement === 'number' ? m.movement.toFixed(2) : '--';
        $('capture-text').textContent = `${m.capturing ? 'Capturing' : 'Not Capturing'} · ${movement}`;
        if (m.discarded) {
          $('message').value = m.discarded === 'mani_non_visibili'
            ? 'Hands not visible, capture discarded'
            : 'Capture too short, discarded';
        }
      },
      onRecognition: (m) => {
        $('message').value = `Detected sign: ${m.gloss} (conf: ${(m.confidence * 100).toFixed(0)}%)`;
      },
      onClose: () => { $('message').value = 'Disconnected from model server.'; },
      onError: (kind) => {
        if (kind === 'socket') return;
        this.cameraFailed = true;
        $('message').value = kind === 'denied'
          ? 'Camera permission denied — allow access and press Start again.'
          : 'Error: could not access webcam.';
      },
    });

    this.session.start();
    $('message').value = 'Camera active. Sending frames to model...';
    $('start-btn').textContent = 'Stop Camera';
  },

  stop() {
    if (this.session) { this.session.stop(); this.session = null; }
    $('message').value = '';
    $('capture-text').textContent = 'Not Capturing';
    $('capture-dot').classList.remove('active');
    $('start-btn').textContent = 'Start Camera';
  },

  toggle() {
    if (this.session && this.session.isRunning) this.stop();
    else this.start();
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
  show(appScreen);
}

function leaveFree() {
  free.stop();
  hide(appScreen);

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

  // Menu e selezione lezione: comportamento invariato
  $('lessons-btn').addEventListener('click', () => { hide(menuScreen); show(lecturesScreen); });
  $('lectures-back-btn').addEventListener('click', () => { hide(lecturesScreen); show(menuScreen); });
  $('free-btn').addEventListener('click', () => { location.search = 'mode=free'; });

  document.querySelectorAll('.lecture-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Niente ricarica: la lezione e' una schermata, non una pagina.
      const id = btn.dataset.lesson;
      const url = new URL(location);
      url.searchParams.set('lesson', id);
      history.pushState({}, '', url);
      goToLesson(id);
    });
  });

  $('start-btn').addEventListener('click', () => free.toggle());
  $('back-btn').addEventListener('click', leaveFree);

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
