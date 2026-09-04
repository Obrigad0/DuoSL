# capture_mode/server.py
#
# Versione alternativa del server: invece della finestra scorrevole continua
# (versione principale in ../server.py), riparte dalla logica originale di
# ../programma originale/utils/live_translation.py -> start_live_feed():
# movement score + media mobile esponenziale (EMA) per capire quando l'utente
# sta facendo un segno ("Capturing") e quando si e' fermato ("Not Capturing").
# Il modello viene interrogato UNA sola volta per gesto isolato, appena
# catturato per intero - non ad ogni frame - proprio come nell'originale.
#
# Riusa modello e lezioni dalla cartella principale (../models, ../lectures)
# cosi' non c'e' nulla da duplicare o tenere sincronizzato a mano.
#
# Da questa cartella: uvicorn server:app --reload --host 0.0.0.0 --port 8001

import json
import asyncio
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import cv2
import mediapipe as mp
import numpy as np
import tensorflow as tf

from utils import live_translation
from utils import preprocessing_split as preprocessing
from utils import lesson_engine

BASE_DIR = Path(__file__).resolve().parent
MODEL_PATH = BASE_DIR.parent / "models" / "best_model200.keras"
ENCODER_PATH = BASE_DIR.parent / "models" / "index_to_gloss_200.json"
LECTURES_DIR = BASE_DIR.parent / "lectures"

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

model = tf.keras.models.load_model(str(MODEL_PATH))
with open(ENCODER_PATH, "r", encoding="utf-8") as f:
    gloss_dict = json.load(f)
    encoder = {k: v for k, v in gloss_dict.items()}
    gloss_to_index = {gloss: int(idx) for idx, gloss in encoder.items()}

mp_holistic = mp.solutions.holistic
holistic = mp_holistic.Holistic(
    static_image_mode=False,
    model_complexity=0,
    enable_segmentation=False,
    refine_face_landmarks=False,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.9,
)

# --- costanti tunabili, fedeli all'originale ---
MOVEMENT_THRESHOLD = 1.2   # come 'threshold' in start_live_feed: soglia sul movement score smussato (EMA)
MAX_STORED_FRAMES = 30     # come nell'originale: buffer massimo di frame reali accumulati per una cattura
EMA_ALPHA = 0.3


def extract_frame_landmarks(frame_bgr):
    image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    results = holistic.process(image_rgb)
    landmarks = live_translation.extract_landmarks(results)
    data_processed = live_translation.preprocess(landmarks)
    return data_processed, results


def classify_capture(landmark_stored):
    """Prende il clip isolato accumulato durante una cattura e lo classifica UNA volta, come l'originale."""
    landmark_array = np.array(landmark_stored)
    padded_array = preprocessing.pad_video(landmark_array)
    reshape_array = padded_array.reshape(padded_array.shape[0], -1)
    model_input = np.expand_dims(reshape_array, axis=0)
    prediction = model.predict(model_input, verbose=0)
    return prediction[0]


def hand_landmarks_payload(results):
    def hand_points(hand_landmarks):
        if hand_landmarks is None:
            return None
        return [[lm.x, lm.y] for lm in hand_landmarks.landmark]

    return {
        "left": hand_points(results.left_hand_landmarks),
        "right": hand_points(results.right_hand_landmarks),
    }


@app.get("/")
async def get_index():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    lesson_name = websocket.query_params.get("lesson")
    session = None

    if lesson_name:
        try:
            lesson = lesson_engine.load_lesson(lesson_name, gloss_to_index, lectures_dir=str(LECTURES_DIR))
            session = lesson_engine.LessonSession(lesson, gloss_to_index, encoder)
        except lesson_engine.LessonLoadError as e:
            await websocket.close(code=1008, reason=str(e))
            return

    await websocket.accept()

    # Stesso pattern della versione principale: un task separato tiene solo
    # l'ultimo frame arrivato, i frame vecchi non elaborati vengono scartati.
    latest_frame = {"data": None}
    disconnected = False

    async def receiver():
        nonlocal disconnected
        try:
            while True:
                image_bytes = await websocket.receive_bytes()
                nparr = np.frombuffer(image_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is not None:
                    latest_frame["data"] = frame
        except Exception:
            disconnected = True

    receiver_task = asyncio.create_task(receiver())

    landmark_stored = []
    ema_score = None
    counter = 0

    try:
        while not disconnected:
            frame = latest_frame["data"]
            if frame is None:
                await asyncio.sleep(0.005)
                continue
            latest_frame["data"] = None

            # MediaPipe + movement score girano su OGNI frame disponibile (economico,
            # nessuna chiamata al modello) cosi' skeleton e stato Capturing restano fluidi.
            data_processed, results = await asyncio.to_thread(extract_frame_landmarks, frame)
            landmark_stored.append(data_processed)
            landmark_stored = landmark_stored[-MAX_STORED_FRAMES:]
            landmarks_payload = hand_landmarks_payload(results)

            capturing = False
            capture_message = None

            if len(landmark_stored) > 5:
                score = live_translation.movement_score(np.array(landmark_stored[-5:]))
                ema_score = live_translation.update_ema(score, ema_score, alpha=EMA_ALPHA)

                if ema_score > MOVEMENT_THRESHOLD:
                    counter += 1
                    capturing = True
                elif counter > 0:
                    # Il movimento si e' appena fermato: il gesto e' completo, classificalo UNA volta.
                    counter = 0
                    prediction = await asyncio.to_thread(classify_capture, landmark_stored)

                    if session is not None:
                        result = session.on_capture(prediction)
                        capture_message = {
                            "type": "lesson",
                            "step_index": result.step_index,
                            "total_steps": result.total_steps,
                            "target_gloss": result.target_gloss,
                            "target_display": result.target_display,
                            "last_gloss": result.last_gloss,
                            "last_confidence": result.last_confidence,
                            "correct": result.correct,
                            "advanced": result.advanced,
                            "completed": result.completed,
                        }
                    else:
                        predicted_index = int(np.argmax(prediction))
                        confidence = float(prediction[predicted_index])
                        gloss = encoder.get(str(predicted_index), "UNKNOWN")
                        capture_message = {"type": "recognition", "gloss": gloss, "confidence": confidence}

            if disconnected:
                break

            try:
                await websocket.send_json({
                    "type": "status",
                    "capturing": capturing,
                    "landmarks": landmarks_payload,
                })
                if capture_message is not None:
                    await websocket.send_json(capture_message)
            except (WebSocketDisconnect, RuntimeError):
                break
    finally:
        receiver_task.cancel()
        print("Client disconnected")
