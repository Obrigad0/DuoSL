// static/progress.js
//
// Client delle rotte /api/progress: la memoria di cosa l'utente ha imparato.
//
// Regola unica e non negoziabile: NIENTE qui dentro puo' rompere quello che
// sta intorno. Un salvataggio fallito e' seccante; una lezione che si pianta
// perche' il salvataggio e' fallito e' inaccettabile. Percio' ogni errore
// viene ingoiato e le funzioni non lanciano mai.

const HEADERS = { 'Content-Type': 'application/json' };

async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const Progress = {
  /** Lo stato completo: segni col loro status, lezioni, conteggi. */
  async load() {
    try {
      const res = await fetch('/api/progress');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  /**
   * Esito di un segno. `status` e' 'known' (riuscito) o 'review' (saltato).
   * Lato server lo status si promuove soltanto: un known non torna review.
   */
  markSign(gloss, status, lesson = null) {
    if (!gloss) return Promise.resolve(null);
    return post('/api/progress/sign', { gloss, status, lesson });
  },

  /** Una lezione portata a termine. */
  markLesson(lesson, done, total) {
    return post('/api/progress/lesson', { lesson, done, total });
  },

  reset() {
    return post('/api/progress/reset', {});
  },

  /** Riempie la memoria come se tutte le lezioni fossero state fatte. */
  fillDemo() {
    return post('/api/progress/demo', {});
  },
};

export const KNOWN = 'known';
export const REVIEW = 'review';
