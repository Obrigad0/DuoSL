# utils/lesson_engine.py
#
# Universal lesson engine: given a lesson (an ordered list of target glosses,
# loaded from lectures/<name>.json) and a stream of per-frame model prediction
# vectors, tracks which step the user is on, how well they're currently
# matching the target sign, and when to advance/complete the lesson.
#
# Framework-agnostic on purpose: no FastAPI/WebSocket/camera code here, so it
# can be driven directly with fake prediction vectors for testing.

import json
import os
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

# --- tunable constants, adjust during testing ---
HOLD_SECONDS = 1.5
CONFIDENCE_THRESHOLD = 0.5


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
class LessonFrameResult:
    step_index: int
    total_steps: int
    target_gloss: Optional[str]
    target_display: Optional[str]
    accuracy: float
    hold_progress: float
    advanced: bool
    completed: bool


class LessonSession:
    """Per-connection state machine driving one lesson attempt."""

    def __init__(
        self,
        lesson: Lesson,
        gloss_to_index: dict,
        hold_seconds: float = HOLD_SECONDS,
        confidence_threshold: float = CONFIDENCE_THRESHOLD,
    ):
        self.lesson = lesson
        self.gloss_to_index = gloss_to_index
        self.hold_seconds = hold_seconds
        self.confidence_threshold = confidence_threshold

        self.current_step_index = 0
        self.hold_started_at: Optional[float] = None
        self.completed = False

    @property
    def current_step(self) -> Optional[LessonStep]:
        if self.completed or self.current_step_index >= len(self.lesson.steps):
            return None
        return self.lesson.steps[self.current_step_index]

    def process_prediction(self, prediction_vector: np.ndarray, now: Optional[float] = None) -> LessonFrameResult:
        if now is None:
            now = time.monotonic()

        step = self.current_step
        if step is None:
            self.completed = True
            return LessonFrameResult(
                step_index=len(self.lesson.steps),
                total_steps=len(self.lesson.steps),
                target_gloss=None,
                target_display=None,
                accuracy=0.0,
                hold_progress=0.0,
                advanced=False,
                completed=True,
            )

        target_index = self.gloss_to_index[step.gloss]
        accuracy = float(prediction_vector[target_index])

        advanced = False
        if accuracy >= self.confidence_threshold:
            if self.hold_started_at is None:
                self.hold_started_at = now
            hold_progress = min((now - self.hold_started_at) / self.hold_seconds, 1.0)
            if hold_progress >= 1.0:
                advanced = True
                self.hold_started_at = None
                self.current_step_index += 1
                if self.current_step_index >= len(self.lesson.steps):
                    self.completed = True
        else:
            self.hold_started_at = None
            hold_progress = 0.0

        next_step = self.current_step
        return LessonFrameResult(
            step_index=self.current_step_index,
            total_steps=len(self.lesson.steps),
            target_gloss=step.gloss,
            target_display=step.label(),
            accuracy=accuracy,
            hold_progress=0.0 if advanced else hold_progress,
            advanced=advanced,
            completed=self.completed and next_step is None,
        )
