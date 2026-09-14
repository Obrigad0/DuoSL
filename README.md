# DuoSL

DuoSL is a small game for learning Sign Language. You make the sign in front of
your webcam, the model watches, and the screen tells you straight away whether
it recognised what you meant to say.


> This is a demo. It is a prototype built to see how live sign recognition can
> carry an interactive lesson, not a finished learning platform.

## What is in it

* **Four lessons in a fixed order**, each one unlocked by finishing the one
  before it: Introduction, People and Identity, Interactions, Feelings. Between
  them they cover 23 distinct signs.
* **Free Practice**, with no script: sign anything and the screen names what it
  read, with a confidence threshold you can move yourself.
* **A library** of every sign you have met, split between the ones you got
  right and the ones you skipped, each with a video you can replay next to your
  webcam.
* **Progress kept on disk**, so closing the browser costs you nothing.

## Requirements

* **Python 3.11.** Not newer: mediapipe and tensorflow do not publish wheels
  for the later versions yet.
* **A real webcam.** Lessons open the camera as soon as you enter and the
  browser asks for permission. A sandboxed or headless browser will not work.
* Nothing else. No API key, no account, no `.env` file: the server talks to no
  external service.

## Install

```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

On macOS and Linux the second line is `source venv/bin/activate`.

## Run

From the project root, with the environment active:

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

Open http://localhost:8000/ and pick **Lessons** or **Free Practice** from the
menu. `Ctrl+C` in the terminal stops the server.

You can also land straight on a screen:

```
http://localhost:8000/?lesson=lesson1    one lesson, by file name
http://localhost:8000/?mode=free         free practice
```

## Before your first sign

The model is not asked on every frame. It collects frames while you move and
classifies once, on the whole gesture, the moment you hold still. The verdict
arrives when you finish the sign, not while you are making it. If nothing seems
to happen while your hands are moving, that is the design and not a fault.

Press `H` on any screen to open the tutorial built into the app.


