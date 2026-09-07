# utils/progress_store.py
#
# La memoria dell'utente: quali lezioni ha completato, quali segni conosce e
# quali ha saltato. E' l'unico stato del progetto che sopravvive al riavvio.
#
# Due cose distinte, tenute deliberatamente separate:
#
#   CATALOGO  = contenuto. Deriva da lectures/*.json e si ricostruisce ad ogni
#               avvio. Sa che HELLO si mostra "HELLO" e ha /demos/hello.mp4.
#   PROGRESSO = stato dell'utente. Sta in data/progress.json e contiene SOLO
#               status, contatori e date per gloss.
#
# Il progresso non duplica nulla del catalogo: se domani si corregge un
# display_text in una lezione, la correzione si vede subito ovunque invece di
# restare sbagliata per sempre dentro la memoria.

import json
import os
import re
import glob
import random
from datetime import datetime, timezone

VERSION = 1

KNOWN = "known"     # segno riconosciuto correttamente almeno una volta
REVIEW = "review"   # segno incontrato ma saltato, mai riuscito


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def empty():
    return {"version": VERSION, "updated_at": None, "lessons": {}, "signs": {}}


def _natural_key(path):
    """
    lesson2 prima di lesson10.

    L'ordine dei file decide l'ordine del percorso e quindi quale lezione
    sblocca quale: con l'ordinamento alfabetico semplice, alla decima lezione
    il percorso si sarebbe silenziosamente riordinato.
    """
    name = os.path.basename(path)
    return [int(part) if part.isdigit() else part.lower()
            for part in re.split(r"(\d+)", name)]


def _short_title(name):
    """"Lesson 3 - Interactions" -> "Interactions": e' cio' che sta sopra al nodo."""
    return name.split(" - ", 1)[1].strip() if " - " in name else name


def build_catalog(lectures_dir):
    """
    gloss -> {display, demo_url, lessons: [...]} leggendo le lezioni.

    Un gloss puo' comparire in piu' lezioni (YOUR sta in lesson1 e lesson2):
    vince la prima occorrenza per display e demo, e le lezioni si accumulano.
    """
    signs = {}
    lessons = {}

    for path in sorted(glob.glob(os.path.join(lectures_dir, "*.json")), key=_natural_key):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            # Una lezione illeggibile non deve impedire di catalogare le altre.
            continue

        lesson_id = data.get("id") or os.path.splitext(os.path.basename(path))[0]
        steps = data.get("steps") or []
        name = data.get("name", lesson_id)
        lessons[lesson_id] = {
            "name": name,
            # Titolo e icona stanno nel file della lezione, non nel client:
            # aggiungere una lezione non deve richiedere di toccare il JS.
            "title": data.get("title") or _short_title(name),
            "icon": data.get("icon") or "wave",
            "total": len(steps),
        }

        for step in steps:
            gloss = step.get("gloss")
            if not gloss:
                continue
            entry = signs.get(gloss)
            if entry is None:
                entry = {
                    "display": step.get("display_text") or gloss,
                    "demo_url": step.get("demo_url"),
                    "lessons": [],
                }
                signs[gloss] = entry
            if entry["demo_url"] is None and step.get("demo_url"):
                entry["demo_url"] = step["demo_url"]
            if lesson_id not in entry["lessons"]:
                entry["lessons"].append(lesson_id)

    return {"signs": signs, "lessons": lessons}


class ProgressStore:
    """Lettura/scrittura di data/progress.json. Nessuna dipendenza esterna."""

    def __init__(self, path):
        self.path = str(path)

    # ------------------------------------------------------------------ disco

    def load(self):
        """
        Legge il file. Qualunque cosa vada storta -> struttura vuota.

        La memoria dei progressi non deve MAI poter impedire l'avvio o rompere
        una lezione: un file assente e' il caso normale al primo avvio, e uno
        corrotto e' comunque meno grave di un server che non parte.
        """
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError, ValueError):
            return empty()

        if not isinstance(data, dict) or data.get("version") != VERSION:
            return empty()

        data.setdefault("lessons", {})
        data.setdefault("signs", {})
        data.setdefault("updated_at", None)
        if not isinstance(data["lessons"], dict) or not isinstance(data["signs"], dict):
            return empty()
        return data

    def _save(self, data):
        """
        Scrittura atomica: file temporaneo accanto al definitivo, poi replace.

        Scrivendo direttamente sul file finale, un'interruzione a meta' (riavvio
        di --reload, chiusura della finestra) lascerebbe un JSON monco che alla
        lettura successiva farebbe perdere TUTTO il progresso.
        """
        data["version"] = VERSION
        data["updated_at"] = _now()

        directory = os.path.dirname(self.path)
        if directory:
            os.makedirs(directory, exist_ok=True)

        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        return data

    # ----------------------------------------------------------- registrazione

    def record_sign(self, gloss, status, lesson=None):
        """
        Registra l'esito di un segno.

        Lo status si PROMUOVE e non retrocede mai: chi ha gia' fatto HELLO e poi
        un giorno lo salta continua a conoscerlo. Retrocedere punirebbe l'utente
        per un fallimento del riconoscitore, che sbaglia spesso su 209 glosse.
        """
        if not gloss or status not in (KNOWN, REVIEW):
            return self.load()

        data = self.load()
        entry = data["signs"].get(gloss)
        if entry is None:
            entry = {"status": status, "correct": 0, "skipped": 0,
                     "first_at": _now(), "last_at": None}
            data["signs"][gloss] = entry

        if status == KNOWN:
            entry["correct"] = int(entry.get("correct", 0)) + 1
            entry["status"] = KNOWN
        else:
            entry["skipped"] = int(entry.get("skipped", 0)) + 1
            if entry.get("status") != KNOWN:
                entry["status"] = REVIEW

        entry["last_at"] = _now()
        if lesson:
            seen = entry.get("lessons") or []
            if lesson not in seen:
                seen.append(lesson)
            entry["lessons"] = seen

        return self._save(data)

    def record_lesson(self, lesson, done, total):
        """Una lezione portata a termine (non basta averla aperta)."""
        if not lesson:
            return self.load()

        data = self.load()
        entry = data["lessons"].get(lesson) or {"completions": 0, "best_done": 0, "total": 0}
        entry["completions"] = int(entry.get("completions", 0)) + 1
        entry["best_done"] = max(int(entry.get("best_done", 0)), int(done))
        entry["total"] = int(total)
        entry["last_at"] = _now()
        data["lessons"][lesson] = entry

        return self._save(data)

    def reset(self):
        return self._save(empty())

    def fill_demo(self, catalog, review_ratio=0.25):
        """
        Riempie la memoria come se tutte le lezioni fossero state fatte.

        Serve a provare free practice e libreria senza doverle rifare ogni
        volta a mano davanti alla webcam. I segni vengono divisi a caso fra
        riusciti e da rivedere, perche' con tutto "conosciuto" la libreria
        mostrerebbe una sezione sola e meta' della schermata resterebbe non
        provata.

        Sovrascrive: e' un comando da pannello debug, non un'aggiunta.
        """
        data = empty()
        now = _now()

        review = set()
        for gloss in catalog["signs"]:
            status = REVIEW if random.random() < review_ratio else KNOWN
            if status == REVIEW:
                review.add(gloss)
            data["signs"][gloss] = {
                "status": status,
                "correct": 0 if status == REVIEW else random.randint(1, 3),
                "skipped": random.randint(1, 2) if status == REVIEW else 0,
                "first_at": now,
                "last_at": now,
                "lessons": list(catalog["signs"][gloss]["lessons"]),
            }

        for lesson_id, meta in catalog["lessons"].items():
            # best_done coerente con i segni: quelli finiti fra i "da rivedere"
            # sono esattamente quelli che in quella lezione non sono riusciti.
            missed = sum(1 for g in review if lesson_id in catalog["signs"][g]["lessons"])
            data["lessons"][lesson_id] = {
                "completions": 1,
                "best_done": max(0, meta["total"] - missed),
                "total": meta["total"],
                "last_at": now,
            }

        return self._save(data)

    # ----------------------------------------------------------------- lettura

    def view(self, catalog):
        """
        Progresso unito al catalogo: quello che serve alla libreria dei segni.

        Restituisce solo i segni presenti nel catalogo (quelli che hanno un nome
        e un video da mostrare): un gloss rimasto in memoria dopo che la sua
        lezione e' stata rimossa non avrebbe nulla da far vedere.
        """
        data = self.load()
        signs = []

        for gloss, meta in catalog["signs"].items():
            record = data["signs"].get(gloss)
            if not record:
                continue
            signs.append({
                "gloss": gloss,
                "display": meta["display"],
                "demo_url": meta["demo_url"],
                "lessons": meta["lessons"],
                "status": record.get("status", REVIEW),
                "correct": int(record.get("correct", 0)),
                "skipped": int(record.get("skipped", 0)),
                "last_at": record.get("last_at"),
            })

        signs.sort(key=lambda s: s["display"])

        lessons = []
        for lesson_id, meta in catalog["lessons"].items():
            record = data["lessons"].get(lesson_id) or {}
            lessons.append({
                "id": lesson_id,
                "name": meta["name"],
                "title": meta["title"],
                "icon": meta["icon"],
                "total": meta["total"],
                "completions": int(record.get("completions", 0)),
                "best_done": int(record.get("best_done", 0)),
            })

        return {
            "signs": signs,
            "lessons": lessons,
            "summary": {
                "known": sum(1 for s in signs if s["status"] == KNOWN),
                "review": sum(1 for s in signs if s["status"] == REVIEW),
                "lessons_completed": sum(1 for item in lessons if item["completions"] > 0),
                "lessons_total": len(lessons),
            },
            "updated_at": data.get("updated_at"),
        }
