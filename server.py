import os
import json
import base64
import asyncio
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

app = FastAPI()

# Caricamento client
client = live_translation.get_client('.env')

app.mount("/static", StaticFiles(directory="static"), name="static")

MODEL_PATH = 'models/best_model200.keras'
ENCODER_PATH = 'models/index_to_gloss_200.json'

# Carica modello ed encoder
model = tf.keras.models.load_model(MODEL_PATH)
with open(ENCODER_PATH, 'r', encoding='utf-8') as f:
    gloss_dict = json.load(f)
    encoder = {k: v for k, v in gloss_dict.items()}
    gloss_to_index = {gloss: int(idx) for idx, gloss in encoder.items()}

mp_drawing = mp.solutions.drawing_utils
mp_holistic = mp.solutions.holistic

holistic = mp_holistic.Holistic(
    static_image_mode=False,
    model_complexity=1,    
    enable_segmentation=False,
    refine_face_landmarks=False,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.9
)

def get_prediction_vector(frame_bgr):
    """
    Prende un frame BGR (numpy array) e restituisce il vettore di probabilità
    grezzo del modello (shape (num_classi,)), senza argmax/soglia/lookup.
    Condiviso sia dal path di riconoscimento libero che dal motore lezione,
    così il modello viene interrogato una sola volta per frame in entrambi i casi.
    """
    # Per questa demo, facciamo inference su una “mini-sequenza” di 1 frame.

    # 1) Estrai landmark
    image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    results = holistic.process(image_rgb)

    landmarks = live_translation.extract_landmarks(results)        # shape (N, 2)
    data_processed = live_translation.preprocess(landmarks)        # normalizzazione

    # 2) Prepara input per il modello: (batch, T, features), T=150 (pad_video),
    # features = N*2 appiattito. Il modello si aspetta esattamente (1, 150, 172).
    landmark_array = data_processed[np.newaxis, ...]  # (1, N, 2)
    padded_array = preprocessing.pad_video(landmark_array)  # (150, N, 2)
    reshape_array = padded_array.reshape(padded_array.shape[0], -1)  # (150, N*2)
    model_input = np.expand_dims(reshape_array, axis=0)  # (1, 150, N*2)

    # 3) Inference
    prediction = model.predict(model_input, verbose=0)
    return prediction[0]


def predict_sign_from_frame(frame_bgr, threshold: float = 1.2, complexity: int = 1):
    """
    Prende un frame BGR (numpy array) e restituisce:
      - predicted_gloss: str o None
      - confidence: float
    Usa la stessa logica di start_live_feed, ma semplificata per un singolo frame/sequenza.
    """
    prediction = get_prediction_vector(frame_bgr)
    predicted_index = int(np.argmax(prediction))
    confidence = float(prediction[predicted_index])

    if confidence >= threshold:
        gloss = encoder.get(str(predicted_index), "UNKNOWN")
    else:
        gloss = None

    return gloss, confidence


@app.get("/")
async def get_index():
    return FileResponse(os.path.join("static", "index.html"))



@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    lesson_name = websocket.query_params.get("lesson")
    session = None

    if lesson_name:
        try:
            lesson = lesson_engine.load_lesson(lesson_name, gloss_to_index)
            session = lesson_engine.LessonSession(lesson, gloss_to_index)
        except lesson_engine.LessonLoadError as e:
            await websocket.close(code=1008, reason=str(e))
            return

    await websocket.accept()

    try:
        while True:
            # Il frontend invia JSON: { "image": "data:image/jpeg;base64,..." }
            data = await websocket.receive_json()
            image_b64 = data["image"]

            # Rimuovi eventuale prefix "data:image/...;base64,"
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]

            image_bytes = base64.b64decode(image_b64)
            nparr = np.frombuffer(image_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is None:
                await websocket.send_json({"error": "Failed to decode image"})
                continue

            if session is not None:
                # Modalità lezione: confronta solo con il segno target corrente,
                # nessun argmax globale sul vettore di predizione.
                prediction = get_prediction_vector(frame)
                result = session.process_prediction(prediction)
                await websocket.send_json({
                    "mode": "lesson",
                    "lesson_id": session.lesson.id,
                    "step_index": result.step_index,
                    "total_steps": result.total_steps,
                    "target_gloss": result.target_gloss,
                    "target_display": result.target_display,
                    "accuracy": result.accuracy,
                    "hold_progress": result.hold_progress,
                    "advanced": result.advanced,
                    "completed": result.completed,
                })
            else:
                # Modalità libera (legacy): riconoscimento del segno più probabile.
                gloss, conf = predict_sign_from_frame(frame, threshold=1.2, complexity=1)
                await websocket.send_json({
                    "gloss": gloss,
                    "confidence": conf
                })

    except WebSocketDisconnect:
        print("Client disconnected")