# capture_mode/utils/lesson_engine.py
#
# Motore lezione adattato alla logica a "cattura" dell'originale: invece di
# controllare l'accuracy in continuazione e richiedere di tenere il segno per
# N secondi (versione principale), qui il modello viene interrogato UNA volta
# sola quando un gesto isolato e' stato catturato per intero (movimento
# iniziato e poi fermato). Se il segno riconosciuto (argmax, come
# nell'originale, nessuna soglia di confidenza) combacia col target dello
# step corrente, si avanza subito.

import json
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np


@dataclass
class LessonStep:
    gloss: str
    display_text: Optional[str] = None

    def label(self) -> str:
        return self.display_text or self.gloss


@dataclass
class Lesson:
    id: str
    name: str
    steps: list[LessonStep]


class LessonLoadError(Exception):
    pass


def load_lesson(name: str, gloss_to_index: dict, lectures_dir: str = "lectures") -> Lesson:
    """Load and validate lectures/<name>.json against the model's known gloss vocabulary."""
    path = os.path.join(lectures_dir, f"{name}.json")
    if not os.path.isfile(path):
        raise LessonLoadError(f"Lesson '{name}' not found: {path}")

    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    lesson_id = raw.get("id")
    if lesson_id != name:
        raise LessonLoadError(
            f"Lesson id '{lesson_id}' in {path} does not match filename '{name}'"
        )

    raw_steps = raw.get("steps") or []
    if not raw_steps:
        raise LessonLoadError(f"Lesson '{name}' has no steps: {path}")

    steps = []
    for i, raw_step in enumerate(raw_steps):
        gloss = raw_step.get("gloss")
        if gloss not in gloss_to_index:
            raise LessonLoadError(
                f"Lesson '{name}' step {i}: unknown gloss '{gloss}' (not in model vocabulary)"
            )
        steps.append(LessonStep(gloss=gloss, display_text=raw_step.get("display_text")))

    return Lesson(id=lesson_id, name=raw.get("name", lesson_id), steps=steps)


@dataclass
class CaptureResult:
    """
    Attenzione alla distinzione, e' quella che prima causava un bug:
      - target_*    = cosa l'utente deve fare ADESSO (gia' aggiornato se ha appena avanzato)
      - attempted_* = cosa era richiesto nel tentativo appena valutato (None nel messaggio iniziale)
    """
    step_index: int
    total_steps: int
    target_gloss: Optional[str]
    target_display: Optional[str]
    attempted_gloss: Optional[str]
    attempted_display: Optional[str]
    last_gloss: str
    last_confidence: float
    correct: bool
    advanced: bool
    completed: bool


class LessonSession:
    """Avanza di uno step ad ogni cattura (gesto isolato) il cui argmax combacia col target."""

    def __init__(self, lesson: Lesson, gloss_to_index: dict, index_to_gloss: dict):
        self.lesson = lesson
        self.gloss_to_index = gloss_to_index
        self.index_to_gloss = index_to_gloss

        self.current_step_index = 0
        self.completed = False

    @property
    def current_step(self) -> Optional[LessonStep]:
        if self.completed or self.current_step_index >= len(self.lesson.steps):
            return None
        return self.lesson.steps[self.current_step_index]

    def current_state(self) -> CaptureResult:
        """Stato attuale senza alcun tentativo: serve a dire subito all'utente qual e' il primo segno."""
        step = self.current_step
        return CaptureResult(
            step_index=self.current_step_index,
            total_steps=len(self.lesson.steps),
            target_gloss=step.gloss if step else None,
            target_display=step.label() if step else None,
            attempted_gloss=None,
            attempted_display=None,
            last_gloss="",
            last_confidence=0.0,
            correct=False,
            advanced=False,
            completed=self.completed,
        )

    def on_capture(self, prediction_vector: np.ndarray) -> CaptureResult:
        """Chiamato una volta per ogni gesto isolato catturato (movimento iniziato e poi fermato)."""
        predicted_index = int(np.argmax(prediction_vector))
        last_gloss = self.index_to_gloss.get(str(predicted_index), "UNKNOWN")
        last_confidence = float(prediction_vector[predicted_index])

        attempted = self.current_step
        if attempted is None:
            self.completed = True
            return CaptureResult(
                step_index=len(self.lesson.steps),
                total_steps=len(self.lesson.steps),
                target_gloss=None,
                target_display=None,
                attempted_gloss=None,
                attempted_display=None,
                last_gloss=last_gloss,
                last_confidence=last_confidence,
                correct=False,
                advanced=False,
                completed=True,
            )

        correct = (last_gloss == attempted.gloss)
        if correct:
            self.current_step_index += 1
            if self.current_step_index >= len(self.lesson.steps):
                self.completed = True

        # Il target riportato e' quello da fare ORA, quindi va letto DOPO l'avanzamento.
        next_step = self.current_step

        return CaptureResult(
            step_index=self.current_step_index,
            total_steps=len(self.lesson.steps),
            target_gloss=next_step.gloss if next_step else None,
            target_display=next_step.label() if next_step else None,
            attempted_gloss=attempted.gloss,
            attempted_display=attempted.label(),
            last_gloss=last_gloss,
            last_confidence=last_confidence,
            correct=correct,
            advanced=correct,
            completed=self.completed,
        )
