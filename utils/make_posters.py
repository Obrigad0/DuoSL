# utils/make_posters.py
#
# Genera le anteprime statiche dei video demo, una per file, dentro
# lectures/demos/posters/. Servono alla libreria dei segni del Free Practice:
# senza, il pannello si apre su venticinque riquadri vuoti, perche' i filmati
# non vengono scaricati finche' non ci passi sopra col mouse.
#
# Si lancia a mano, dalla radice del progetto:
#
#     python utils/make_posters.py            solo le anteprime che mancano
#     python utils/make_posters.py --force    rifa' tutto
#
# Le anteprime prodotte vanno versionate insieme ai video: sono servite dal
# mount /demos che esiste gia', e quel percorso non passa dal no-store, quindi
# il browser se le tiene in cache.
#
# Usa OpenCV, che il progetto ha gia' fra le dipendenze per il riconoscimento:
# nessun ffmpeg, nessuna libreria nuova.

import glob
import os
import sys

import cv2

DEMOS_DIR = os.path.join("lectures", "demos")
POSTERS_DIR = os.path.join(DEMOS_DIR, "posters")

# Il fotogramma si cerca a meta' gesto, non all'inizio: il primo fotogramma e'
# quasi sempre la posa di riposo, uguale per tutti i segni e quindi inutile per
# riconoscerli in una griglia.
SAMPLE_FROM = 0.25
SAMPLE_TO = 0.65
SAMPLES = 5

LONG_SIDE = 320      # il riquadro nel pannello e' ~154px, il doppio basta e avanza
JPEG_QUALITY = 72


def _sharpness(frame):
    """Quanto e' a fuoco: varianza del laplaciano, il solito indice."""
    grigio = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.Laplacian(grigio, cv2.CV_64F).var()


def _best_frame(path):
    """
    Il fotogramma piu' nitido fra alcuni presi a meta' clip.

    I demo girano a 10 fps: preso a caso, il fotogramma centrale ha buone
    probabilita' di essere mosso, e una mano sfocata in anteprima e' peggio di
    nessuna anteprima. Se ne guardano cinque e si tiene il migliore.
    """
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        return None

    totale = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    migliore, punteggio = None, -1.0

    for i in range(SAMPLES):
        quota = SAMPLE_FROM + (SAMPLE_TO - SAMPLE_FROM) * (i / max(1, SAMPLES - 1))
        indice = int(totale * quota) if totale > 0 else 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, indice)
        ok, frame = cap.read()
        if not ok:
            continue
        p = _sharpness(frame)
        if p > punteggio:
            migliore, punteggio = frame, p

    # Clip cortissime o senza conteggio dei fotogrammi: si ripiega sul primo.
    if migliore is None:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ok, frame = cap.read()
        migliore = frame if ok else None

    cap.release()
    return migliore


def _resize(frame):
    """Rimpicciolisce mantenendo la proporzione nativa del video."""
    h, w = frame.shape[:2]
    lato = max(w, h)
    if lato <= LONG_SIDE:
        return frame
    k = LONG_SIDE / lato
    return cv2.resize(frame, (round(w * k), round(h * k)), interpolation=cv2.INTER_AREA)


def main(force=False):
    if not os.path.isdir(DEMOS_DIR):
        print("Non trovo %s: lancia lo script dalla radice del progetto." % DEMOS_DIR)
        return 1

    os.makedirs(POSTERS_DIR, exist_ok=True)

    video = sorted(glob.glob(os.path.join(DEMOS_DIR, "*.mp4")))
    if not video:
        print("Nessun video in %s." % DEMOS_DIR)
        return 1

    scritti = saltati = falliti = 0
    peso = 0

    for src in video:
        nome = os.path.splitext(os.path.basename(src))[0]
        dest = os.path.join(POSTERS_DIR, nome + ".jpg")

        if os.path.isfile(dest) and not force:
            saltati += 1
            peso += os.path.getsize(dest)
            continue

        frame = _best_frame(src)
        if frame is None:
            print("  ! %-24s non riesco a leggerlo" % (nome + ".mp4"))
            falliti += 1
            continue

        ok = cv2.imwrite(dest, _resize(frame),
                         [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY])
        if not ok:
            print("  ! %-24s non riesco a scriverlo" % (nome + ".mp4"))
            falliti += 1
            continue

        kb = os.path.getsize(dest) / 1024
        peso += os.path.getsize(dest)
        scritti += 1
        print("  + %-24s %5.1f KB" % (nome + ".jpg", kb))

    print()
    print("%d scritte, %d gia' presenti, %d fallite. In tutto %.0f KB in %s"
          % (scritti, saltati, falliti, peso / 1024, POSTERS_DIR))
    if saltati and not force:
        print("Per rifare anche quelle che ci sono gia': --force")
    return 1 if falliti else 0


if __name__ == "__main__":
    sys.exit(main(force="--force" in sys.argv))
