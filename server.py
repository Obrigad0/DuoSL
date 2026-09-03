# server.py
# uvicorn server:app --reload --host 0.0.0.0 --port 8000

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

# Import del tuo modulo esistente
from utils import live_translation
from utils import preprocessing_split as preprocessing

app = FastAPI()

# Caricamento client (non strettamente necessario per la sola inference,
# ma lo teniamo per coerenza col tuo codice)
client = live_translation.get_client('.env')

app.mount("/static", StaticFiles(directory="static"), name="static")

MODEL_PATH = 'models/best_model200.keras'
ENCODER_PATH = 'models/index_to_gloss_200.json'

# Carica modello ed encoder una volta all’avvio
model = tf.keras.models.load_model(MODEL_PATH)
with open(ENCODER_PATH, 'r', encoding='utf-8') as f:
    gloss_dict = json.load(f)
    encoder = {k: v for k, v in gloss_dict.items()}

# Configura MediaPipe Holistic (stesso setup di start_live_feed)
mp_drawing = mp.solutions.drawing_utils
mp_holistic = mp.solutions.holistic

holistic = mp_holistic.Holistic(
    static_image_mode=False,
    model_complexity=1,          # puoi cambiarlo se vuoi
    enable_segmentation=False,
    refine_face_landmarks=False,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.9
)

def predict_sign_from_frame(frame_bgr, threshold: float = 1.2, complexity: int = 1):
    """
    Prende un frame BGR (numpy array) e restituisce:
      - predicted_gloss: str o None
      - confidence: float
    Usa la stessa logica di start_live_feed, ma semplificata per un singolo frame/sequenza.
    """
    # Per questa demo, facciamo inference su una “mini-sequenza” di 1 frame.
    # In una versione più avanzata, potresti mantenere uno storico di frame
    # lato server (es. ultimi 30) e fare inference solo quando il movimento supera threshold.

    # 1) Estrai landmark
    image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    results = holistic.process(image_rgb)

    landmarks = live_translation.extract_landmarks(results)        # shape (N, 2)
    data_processed = live_translation.preprocess(landmarks)        # normalizzazione

    # 2) Prepara input per il modello
    # Il modello si aspetta: (batch, T, features) con T fisso e features = N*2 appiattito
    # In start_live_feed usano 30 frame e padding. Qui facciamo una versione semplificata:
    #   - consideriamo 1 frame
    #   - applichiamo pad_video per arrivare a T=30 (come fai in handle_capture_logic)
    landmark_array = data_processed[np.newaxis, ...]  # (1, N, 2)
    padded_array = preprocessing.pad_video(landmark_array)  # (30, N, 2)
    reshape_array = padded_array.reshape(padded_array.shape[0], -1)  # (30, N*2)
    model_input = np.expand_dims(reshape_array, axis=0)  # (1, 30, N*2)

    # 3) Inference
    prediction = model.predict(model_input, verbose=0)
    predicted_index = int(np.argmax(prediction[0]))
    confidence = float(prediction[0, predicted_index])

    # 4) Decodifica gloss
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

            # Inference
            gloss, conf = predict_sign_from_frame(frame, threshold=1.2, complexity=1)

            # Risposta
            await websocket.send_json({
                "gloss": gloss,
                "confidence": conf
            })

    except WebSocketDisconnect:
        print("Client disconnected")