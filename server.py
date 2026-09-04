import os
import json
import asyncio
import time
from collections import deque
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

# Quanti frame REALI tenere nel buffer per ogni connessione prima di darli al
# modello (pad_video li ripete fino a 150). ~4.5s a 10fps: abbastanza per
# coprire un segno intero (anche velocissimo) senza trascinarsi troppo
# contesto vecchio. Tunabile.
FRAME_BUFFER_LENGTH = 45

# model.predict() costa ~90ms a chiamata (misurato): chiamarlo su ogni frame
# fa accumulare ritardo. Lo scheletro (MediaPipe) resta fluido su ogni frame,
# la classificazione viene limitata a questo ritmo. Tunabile.
PREDICT_INTERVAL_SECONDS = 0.15

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
    model_complexity=0,    # 0 = più veloce, come nel demo originale (live feel > accuratezza marginale)
    enable_segmentation=False,
    refine_face_landmarks=False,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.9
)

def extract_frame_landmarks(frame_bgr):
    """
    Prende un frame BGR e restituisce (data_processed, results):
      - data_processed: landmark normalizzati pronti per il modello, shape (N, 2)
      - results: risultato grezzo di MediaPipe Holistic (serve per lo skeleton overlay)
    """
    image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    results = holistic.process(image_rgb)

    landmarks = live_translation.extract_landmarks(results)        # shape (N, 2)
    data_processed = live_translation.preprocess(landmarks)        # normalizzazione
    return data_processed, results


def get_prediction_vector(frame_buffer):
    """
    Prende il buffer (deque) degli ultimi frame REALI di landmark già preprocessati
    per questa connessione e restituisce il vettore di probabilità grezzo del modello
    (shape (num_classi,)), senza argmax/soglia/lookup.

    A differenza di prima, il modello vede un vero pezzo di movimento (fino a
    FRAME_BUFFER_LENGTH frame reali, ripetuti da pad_video fino a 150) invece
    di un singolo frame fermo ripetuto 150 volte.
    """
    landmark_array = np.array(frame_buffer)  # (T, N, 2), T = frame reali nel buffer finora
    padded_array = preprocessing.pad_video(landmark_array)  # (150, N, 2)
    reshape_array = padded_array.reshape(padded_array.shape[0], -1)  # (150, N*2)
    model_input = np.expand_dims(reshape_array, axis=0)  # (1, 150, N*2)

    prediction = model.predict(model_input, verbose=0)
    return prediction[0]


def hand_landmarks_payload(results):
    """Coordinate normalizzate (0-1) dei landmark delle mani, per disegnare lo skeleton lato client."""
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
    frame_buffer = deque(maxlen=FRAME_BUFFER_LENGTH)

    # Il receiver gira in parallelo e tiene SOLO l'ultimo frame arrivato: se il
    # loop di elaborazione è indietro, i frame intermedi vengono scartati
    # invece di accumularsi in coda (altrimenti il ritardo cresce senza fine).
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
            # Disconnessione (o qualunque errore di trasporto): tratta come fine connessione,
            # altrimenti il loop principale resterebbe a girare in eterno in attesa di un frame
            # che non arriverà più.
            disconnected = True

    receiver_task = asyncio.create_task(receiver())

    last_predict_time = 0.0

    try:
        while not disconnected:
            frame = latest_frame["data"]
            if frame is None:
                await asyncio.sleep(0.005)
                continue
            latest_frame["data"] = None  # consumato

            # MediaPipe gira su ogni frame disponibile e lo skeleton viene
            # mandato SUBITO (path veloce, ~20-40ms) senza aspettare il
            # modello. La classificazione (~90ms) è un messaggio separato,
            # mandato solo quando è pronta: così non rallenta mai lo skeleton.
            data_processed, results = await asyncio.to_thread(extract_frame_landmarks, frame)
            frame_buffer.append(data_processed)
            landmarks = hand_landmarks_payload(results)

            if disconnected:
                break

            try:
                await websocket.send_json({"type": "landmarks", "landmarks": landmarks})
            except (WebSocketDisconnect, RuntimeError):
                break

            now = time.monotonic()
            if now - last_predict_time < PREDICT_INTERVAL_SECONDS:
                continue
            last_predict_time = now

            prediction = await asyncio.to_thread(get_prediction_vector, frame_buffer)

            if disconnected:
                break

            try:
                if session is not None:
                    # Modalità lezione: confronta solo con il segno target corrente,
                    # nessun argmax globale sul vettore di predizione.
                    result = session.process_prediction(prediction)
                    await websocket.send_json({
                        "type": "lesson",
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
                    # Modalità libera: mostra sempre il segno più probabile (top guess)
                    # e la sua confidence, senza soglia di gating.
                    predicted_index = int(np.argmax(prediction))
                    confidence = float(prediction[predicted_index])
                    gloss = encoder.get(str(predicted_index), "UNKNOWN")
                    await websocket.send_json({
                        "type": "recognition",
                        "gloss": gloss,
                        "confidence": confidence,
                    })
            except (WebSocketDisconnect, RuntimeError):
                # La connessione si è chiusa proprio mentre stavamo per rispondere: normale, esci.
                break
    finally:
        receiver_task.cancel()
        print("Client disconnected")