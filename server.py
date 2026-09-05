# server.py
#
# Il riconoscimento riparte dalla logica dell'originale
# ("programma originale"/utils/live_translation.py -> start_live_feed()):
# movement score + media mobile esponenziale (EMA) per capire quando l'utente
# sta facendo un segno ("Capturing") e quando si e' fermato ("Not Capturing").
# Il modello viene interrogato UNA sola volta per gesto isolato, appena
# catturato per intero - non ad ogni frame - proprio come nell'originale.
#
# Rispetto all'originale la segmentazione e' pero' resa robusta (isteresi,
# debounce, hangover, gate sulla presenza delle mani, durata minima, buffer
# pulito ad ogni cattura): vedi la sezione "costanti tunabili" piu' sotto.
#
# Modello e lezioni stanno in models/ e lectures/ accanto a questo file.
#
# uvicorn server:app --reload --host 0.0.0.0 --port 8000

import json
import asyncio
from collections import deque
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
MODEL_PATH = BASE_DIR / "models" / "best_model200.keras"
ENCODER_PATH = BASE_DIR / "models" / "index_to_gloss_200.json"
LECTURES_DIR = BASE_DIR / "lectures"

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.middleware("http")
async def no_cache_assets(request, call_next):
    """
    Niente cache su pagina e asset statici.
    Durante lo sviluppo il browser continuava a servire copie vecchie di
    app.js/style.css, facendo sembrare rotto codice che era gia' corretto.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


model = tf.keras.models.load_model(str(MODEL_PATH))
with open(ENCODER_PATH, "r", encoding="utf-8") as f:
    gloss_dict = json.load(f)
    encoder = {k: v for k, v in gloss_dict.items()}
    gloss_to_index = {gloss: int(idx) for idx, gloss in encoder.items()}

mp_drawing = mp.solutions.drawing_utils
mp_holistic = mp.solutions.holistic
holistic = mp_holistic.Holistic(
    static_image_mode=False,
    model_complexity=0,
    enable_segmentation=False,
    refine_face_landmarks=False,
    min_detection_confidence=0.6,
    min_tracking_confidence=0.9,
)

# --- costanti tunabili ---
# L'originale aveva una sola soglia (1.2) e chiudeva la cattura al primo frame
# sotto soglia. Qui la segmentazione usa gli accorgimenti standard della voice
# activity detection, che e' lo stesso problema applicato ai gesti.
MOVEMENT_ENTER_THRESHOLD = 1.4   # isteresi: soglia per ENTRARE in Capturing
MOVEMENT_EXIT_THRESHOLD = 0.9    # soglia (piu' bassa) per USCIRE
ENTER_FRAMES = 2                 # debounce: frame consecutivi sopra soglia per iniziare
EXIT_FRAMES = 3                  # hangover: frame consecutivi sotto soglia per chiudere
MIN_CAPTURE_FRAMES = 6           # sotto questa lunghezza la cattura e' rumore -> scartata
REQUIRE_HAND = True              # si entra in Capturing solo se almeno una mano e' rilevata
PRE_ROLL_FRAMES = 3              # frame precedenti tenuti: il gesto inizia un attimo prima di essere rilevato
MOTION_WINDOW = 5                # su quanti frame si calcola il movimento (come l'originale)
MAX_STORED_FRAMES = 30           # come nell'originale: tetto ai frame accumulati per una cattura
EMA_ALPHA = 0.3
JPEG_QUALITY = 80                # qualita' del frame annotato rimandato al client

# Layout dei landmark restituiti da extract_landmarks(): 86 punti in totale.
LEFT_HAND_SLICE = slice(12, 33)   # 21 punti
RIGHT_HAND_SLICE = slice(33, 54)  # 21 punti
HAND_WEIGHT = 3                   # come nell'originale: le mani pesano 3x nel movimento


def movement_score_masked(frames, left_flags, right_flags):
    """
    Come movement_score() dell'originale (media degli spostamenti fra frame
    consecutivi, mani pesate 3x), con una differenza importante: il blocco di
    una mano contribuisce solo se quella mano e' stata rilevata in ENTRAMBI i
    frame della coppia.

    Senza questa maschera, nell'istante in cui una mano appare o sparisce i suoi
    21 punti saltano di colpo fra (0,0) e le coordinate vere: con peso 3x e' uno
    spike enorme che fa scattare un falso "Capturing".
    """
    diffs = []
    for i in range(len(frames) - 1):
        diff = np.linalg.norm(frames[i + 1] - frames[i], axis=1)
        weighted = diff.copy()

        if left_flags[i] and left_flags[i + 1]:
            weighted[LEFT_HAND_SLICE] *= HAND_WEIGHT
        else:
            weighted[LEFT_HAND_SLICE] = 0.0

        if right_flags[i] and right_flags[i + 1]:
            weighted[RIGHT_HAND_SLICE] *= HAND_WEIGHT
        else:
            weighted[RIGHT_HAND_SLICE] = 0.0

        diffs.append(float(np.sum(weighted)))

    return float(np.mean(diffs)) if diffs else 0.0


def process_frame(frame_bgr):
    """
    Come process_frame() dell'originale: estrae i landmark E disegna lo scheletro
    delle mani SUL frame stesso, con il renderer di MediaPipe (stile di default:
    alone bianco + centro rosso, connessioni bianco-grigio, punti sotto soglia di
    visibility/presence scartati automaticamente).

    Restituisce (landmark preprocessati, JPEG annotato, mano sx rilevata, mano dx rilevata).

    NB: a differenza dell'originale il frame NON viene ribaltato prima dell'analisi,
    cosi' i landmark dati al modello restano identici a prima. Lo specchio e' solo
    visivo, applicato via CSS all'immagine finita (che essendo una sola immagine
    non puo' disallinearsi dallo scheletro).
    """
    image_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    results = holistic.process(image_rgb)

    mp_drawing.draw_landmarks(frame_bgr, results.left_hand_landmarks, mp_holistic.HAND_CONNECTIONS)
    mp_drawing.draw_landmarks(frame_bgr, results.right_hand_landmarks, mp_holistic.HAND_CONNECTIONS)
    ok, buf = cv2.imencode(".jpg", frame_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])

    landmarks = live_translation.extract_landmarks(results)
    data_processed = live_translation.preprocess(landmarks)

    has_left = results.left_hand_landmarks is not None
    has_right = results.right_hand_landmarks is not None
    return data_processed, (buf.tobytes() if ok else None), has_left, has_right


def classify_capture(landmark_stored):
    """Prende il clip isolato accumulato durante una cattura e lo classifica UNA volta, come l'originale."""
    landmark_array = np.array(landmark_stored)
    padded_array = preprocessing.pad_video(landmark_array)
    reshape_array = padded_array.reshape(padded_array.shape[0], -1)
    model_input = np.expand_dims(reshape_array, axis=0)
    prediction = model.predict(model_input, verbose=0)
    return prediction[0]


@app.get("/")
async def get_index():
    return FileResponse(str(BASE_DIR / "static" / "index.html"))


def lesson_payload(result):
    """Messaggio lezione. target_* = cosa fare ADESSO, attempted_* = cosa era richiesto nel tentativo."""
    return {
        "type": "lesson",
        "step_index": result.step_index,
        "total_steps": result.total_steps,
        "target_gloss": result.target_gloss,
        "target_display": result.target_display,
        "attempted_gloss": result.attempted_gloss,
        "attempted_display": result.attempted_display,
        "last_gloss": result.last_gloss,
        "last_confidence": result.last_confidence,
        "correct": result.correct,
        "advanced": result.advanced,
        "completed": result.completed,
    }


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

    # La classificazione (~90ms) gira in un task a parte e deposita il risultato qui:
    # se restasse dentro il loop, ad ogni gesto il video si fermerebbe per quei 90ms.
    # I messaggi vengono comunque spediti dal loop principale, cosi' non ci sono
    # send concorrenti sullo stesso websocket.
    results_queue = asyncio.Queue()
    classify_task = None

    async def classify_and_enqueue(clip):
        prediction = await asyncio.to_thread(classify_capture, clip)

        if session is not None:
            await results_queue.put(lesson_payload(session.on_capture(prediction)))
        else:
            predicted_index = int(np.argmax(prediction))
            confidence = float(prediction[predicted_index])
            gloss = encoder.get(str(predicted_index), "UNKNOWN")
            await results_queue.put({"type": "recognition", "gloss": gloss, "confidence": confidence})

    # Messaggio iniziale: dice subito qual e' il primo segno da fare,
    # senza aspettare il primo tentativo.
    if session is not None:
        await websocket.send_json(lesson_payload(session.current_state()))

    # --- stato della segmentazione, per connessione ---
    landmark_stored = []                              # clip della cattura in corso
    pre_roll = deque(maxlen=PRE_ROLL_FRAMES)          # frame appena precedenti all'inizio del gesto
    motion_frames = deque(maxlen=MOTION_WINDOW)       # finestra per il calcolo del movimento
    motion_left = deque(maxlen=MOTION_WINDOW)
    motion_right = deque(maxlen=MOTION_WINDOW)
    ema_score = None
    capturing = False
    above_count = 0
    below_count = 0

    try:
        while not disconnected:
            frame = latest_frame["data"]
            if frame is None:
                await asyncio.sleep(0.005)
                continue
            latest_frame["data"] = None

            # MediaPipe + disegno dello scheletro + movement score girano su OGNI frame
            # disponibile (economico, nessuna chiamata al modello): il frame annotato
            # torna subito al client, lo stato Capturing resta fluido.
            data_processed, annotated_jpeg, has_left, has_right = await asyncio.to_thread(process_frame, frame)

            motion_frames.append(data_processed)
            motion_left.append(has_left)
            motion_right.append(has_right)

            if len(motion_frames) >= 2:
                score = movement_score_masked(np.array(motion_frames), list(motion_left), list(motion_right))
                ema_score = live_translation.update_ema(score, ema_score, alpha=EMA_ALPHA)

            ema = ema_score if ema_score is not None else 0.0
            hand_visible = has_left or has_right

            discarded = False

            if capturing:
                landmark_stored.append(data_processed)
                if len(landmark_stored) > MAX_STORED_FRAMES:
                    landmark_stored = landmark_stored[-MAX_STORED_FRAMES:]

                # Hangover: serve una pausa vera (EXIT_FRAMES consecutivi) per chiudere,
                # cosi' una micro-pausa a meta' segno non lo spezza in due catture.
                below_count = below_count + 1 if ema < MOVEMENT_EXIT_THRESHOLD else 0

                if below_count >= EXIT_FRAMES:
                    # Gli ultimi EXIT_FRAMES frame sono la pausa che ha chiuso il gesto, non il gesto.
                    clip = landmark_stored[:-EXIT_FRAMES] if len(landmark_stored) > EXIT_FRAMES else []
                    capturing = False
                    above_count = 0
                    below_count = 0
                    landmark_stored = []

                    if len(clip) >= MIN_CAPTURE_FRAMES:
                        # Se una classificazione precedente e' ancora in corso la si aspetta,
                        # per non scavalcare l'ordine dei gesti (in pratica non capita mai:
                        # fra due catture passano molti piu' millisecondi di una predict).
                        if classify_task is not None and not classify_task.done():
                            await classify_task
                        classify_task = asyncio.create_task(classify_and_enqueue(clip))
                    else:
                        discarded = True
            else:
                pre_roll.append(data_processed)

                # Debounce + gate sulle mani: niente Capturing per il solo movimento
                # di busto o testa, e servono ENTER_FRAMES frame consecutivi.
                if ema > MOVEMENT_ENTER_THRESHOLD and (hand_visible or not REQUIRE_HAND):
                    above_count += 1
                else:
                    above_count = 0

                if above_count >= ENTER_FRAMES:
                    capturing = True
                    above_count = 0
                    below_count = 0
                    # Buffer pulito ad ogni cattura (l'originale non lo faceva: si portava
                    # dietro frame del gesto precedente), riseminato col pre-roll.
                    landmark_stored = list(pre_roll)
                    pre_roll.clear()

            if disconnected:
                break

            try:
                # Il frame annotato (immagine + scheletro gia' disegnato dentro) va per primo.
                if annotated_jpeg is not None:
                    await websocket.send_bytes(annotated_jpeg)
                await websocket.send_json({
                    "type": "status",
                    "capturing": capturing,
                    "movement": round(ema, 2),
                    "discarded": discarded,
                })
                # Risultati delle classificazioni finite in background nel frattempo.
                while not results_queue.empty():
                    await websocket.send_json(results_queue.get_nowait())
            except (WebSocketDisconnect, RuntimeError):
                break
    finally:
        receiver_task.cancel()
        if classify_task is not None:
            classify_task.cancel()
        print("Client disconnected")
