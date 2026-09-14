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

<details>
<summary><b>The lesson path</b></summary>

Lessons are not a list, they are a path. Each node says one thing, on a channel
of its own, so that two nodes never say the same thing twice:

```
green tick       done
amber halo       the next one to do, never more than one at a time
grey padlock     still closed, and the dotted line leading to it is grey too,
                 so you can see how far you can currently get
dotted outline   a lesson that does not exist in this demo. There are two,
                 faded, and after the last one the road carries on and
                 disappears into a gradient. They never open and they say
                 nothing: the drawing is the whole message
```

**Unlock rule:** a lesson opens once the one before it has been completed at
least once. The first one is always open. The theme sits above an open node,
the lesson number below. Closed lessons keep their name hidden, though it
appears on hover and screen readers announce it anyway.

The **boat** resting on a node is the lesson you have selected. It hops across
when you pick another one, and it sails into the circle when you press Start.
Click a closed lesson and nothing bad happens: the ring blinks grey and a line
underneath reads "Finish X to unlock this lesson".

**Free Practice** is the detached node on the left, the one with the lighthouse
behind it. It is not part of the path and it is always available. You can tell
it apart by the lighthouse, by having no number, and by being the only thing on
screen that moves on its own: the glow around it is the lighthouse beam, and it
breathes slowly.

On a narrow window the path runs off the screen, which is intended. It is a
path, so it scrolls, but what scrolls is its own lane and never the page.

```
Left, Right   move between the nodes you can reach
H             tutorial
Esc           back to the menu
```

When a lesson ends you come back here and the screen reloads itself. If you
just unlocked the next one, you watch it open. If the lesson you had selected
was the one you just finished, the selection moves on by itself.

</details>

<details>
<summary><b>Inside a lesson</b></summary>

The sign to make sits at the top, centred, in large type: it is the most
important thing on the screen, so it is where you look first. Below it, your
webcam on the right, the largest element on the page because you are the point,
and the demo video on the left, smaller, on the same baseline.

The row of dots along the top says where you are. A filled dot with a tick is
done, a large dot with a halo is where you are now, with the name of the sign
underneath, a grey outline is still ahead, a pale outline was skipped.

Capture state is the **ring around your video**, not a panel of text, because
while you practise you are already looking at that spot:

```
thin grey ring        still, not recording
pulsing teal ring     movement detected, collecting frames
green with a tick     recognised, moving on by itself
amber with an arrow   not recognised, and it tells you what it read instead
```

Under the demo: pause, 0.5x and mirror. After two failed attempts a **Skip this
sign** button appears, because the model is not infallible and one stubborn
sign should not end your lesson.

The arrow inside the teal badge, paired with the speaker on the other side,
takes you **back to the previous sign** to try it again. On the first sign of a
lesson it stays in place but greyed out: if it vanished, the badge would shrink
while you are still reading the word inside it.

Going back erases nothing. Dots that are already green stay green and the
library never demotes a sign. It works the other way round too: go back to a
sign you skipped, do it right this time, and the dot turns from skipped to
done.

Some signs arrive with the **demo covered**: instead of the video you find
"Demo hidden" and a "Show me the sign" button. These are signs you already met
earlier in the same lesson, and the point is to try them from memory. The
caption above the word changes to "From memory, no demo this time", so it is
clear the video is missing on purpose rather than broken. Uncovering it is
always allowed and costs nothing: it is an exercise, not a gate. Once uncovered
a fourth pill appears under the video to hide it again. All four lessons use
this, from four signs up to eight.

**Voice off / Voice on** at the top right reads the sign out loud. If your
system has no English voices installed the default one is used and still
pronounces the names. The speaker icon next to the word repeats it on demand,
even with the voice off. **Debug** next to it opens the diagnostics described
further down: it is there to tune the thresholds, not to take the lesson.

If the connection drops, **Reconnect** picks up at the step you were on rather
than starting over.

```
Space   pause and play the demo       V     voice on and off
R       replay at half speed          D     diagnostics panel
S       skip the step, when offered   H     tutorial
Left    back to the previous sign     Esc   leave the lesson
```

On a sign shown from memory, `R` uncovers the demo. Pausing the lesson does
not: that would be a way around the exercise.

</details>

<details>
<summary><b>Free Practice</b></summary>

No script: make any sign and the screen tells you what it read. Same visual
language as a lesson, but the information arrives after the gesture instead of
before it, so the sign box sits below the webcam rather than above.

The box shows the word in large type and, small underneath, the confidence. It
says confidence and not accuracy on purpose: that number is the softmax of the
classifier, it is not calibrated, and it stays above 90% even when the answer
is wrong. If the model returns an index with no entry in the vocabulary the box
reads "Not recognised" rather than printing UNKNOWN.

**The recognition threshold** (the Debug button, or `D`)

The classifier always answers something. Every capture produces a sign, even
the one where you scratched your nose. With no floor, Free Practice names a
sign for every movement you make, and a word that large on the screen suggests
a certainty that is not there.

The **Minimum confidence** slider decides how sure the model has to be before
the sign is shown. Below that value the box reads "Sign not clear" instead of
the name, says nothing out loud and offers no speaker button. The percentage
stays visible, so you can see by how much it missed.

It starts at 45%, but that number is not a truth: it depends on the model and
on how the room is lit. To tune it, keep the panel open while you practise and
watch the "Last capture" and "Confidence" lines. They show the captures the
threshold threw away too, so you can see where the border runs between your
good signs and noise. Your value is saved.

Moving the slider updates the result already on the screen, with no need to
sign again.

**The library** (the Library button, or `L`)

A side panel holding the signs you have met in the lessons, split into "Known"
and "To review", with a filter at the top. It does not cover the page, it
narrows it, because the webcam must never disappear while you practise. Below
1100px of width it goes back to overlapping, since narrowing there would leave
the webcam unusable.

Each card shows a still frame taken from the middle of the gesture. Hover a
card and the video starts by itself and fades in over the still; move away and
it stops. The clips are fetched only on that first hover, because together they
weigh around 22 MB and loading them all when the panel opens would be a waste.

Click a card and the sign pins itself next to your webcam, exactly like the
demo in a lesson, with pause, 0.5x and mirror. Click the card again, or the X
on the demo, and the space goes back to the webcam.

```
L   library    Space   pause the demo
V   voice      D       recognition threshold
H   tutorial   Esc     close the library, then leave the screen
```

</details>

<details>
<summary><b>Progress and the Debug panel</b></summary>

The server keeps one file, `data/progress.json`, created on first use. It holds
the lessons you have completed and, for every sign, whether it is known or
still to review. That file is what fills the library. It belongs to your
machine and there is no reason to commit it.

A sign becomes **known** the moment you get it right in a lesson, and **to
review** if you skip it. Status is promoted and never demoted: skip a sign you
already knew and it stays known. The opposite would be unfair, given that the
one making mistakes is often the recogniser.

Saving happens at every step, not at the end of a lesson. Leave halfway through
and the signs you already did are still there.

The **Debug** button on the start menu shows the current counts and offers two
actions, both asking for confirmation twice because both overwrite:

* **Fill progress** marks all four lessons as done and splits the signs at
  random between known and to review. It is there so you can try the library
  and free practice without sitting through every lesson in front of the camera
  first. The split is random on purpose: with everything marked known the
  library would show a single section and half the screen would go untested.
* **Reset progress** clears everything.

If the file is deleted or damaged the server starts from an empty memory
without complaining, and the next write recreates it.

</details>

<details>
<summary><b>Tuning the movement detection</b></summary>

Press `D`, or the sliders icon at the top right, to open the diagnostics: live
movement drawn as a bar with both thresholds marked on it, plus state, last
prediction, confidence and the reason a capture was thrown away. It stays out
of the way of whoever is learning and within reach of whoever is tuning.

The constants live in `server.py`, in the section marked "costanti tunabili":

```
MOVEMENT_ENTER_THRESHOLD     how much movement is needed to start capturing
MOVEMENT_EXIT_THRESHOLD      below this you count as having stopped
ENTER_FRAMES, EXIT_FRAMES    consecutive frames needed to open and to close
MIN_CAPTURE_FRAMES           captures shorter than this are thrown away
REQUIRE_HAND                 when True, no capture without a hand in frame
```

Watch where the bar sits while you hold still and while you sign, set the two
thresholds accordingly, then restart the server: the panel reads them from
there.

</details>

<details>
<summary><b>Writing a new lesson</b></summary>

Copy `lectures/lesson1.json` and change:

* **`id`** must match the file name without `.json`. The order of the files
  decides the order of the path and therefore which lesson unlocks which:
  lesson2 comes before lesson10, not after.
* **`steps`** is the list of signs. Every `gloss` must exist in
  `models/index_to_gloss_200.json`, which holds 209 English glosses.
* **`title`** is optional, the short name above the node on the path. Without
  it the name is taken from `name`, so `"Lesson 3 - Interactions"` becomes
  "Interactions".
* **`icon`** is optional, the theme of the node: `wave`, `people`, `chat` or
  `heart`. Default is `wave`.
* **`display_text`** is optional, how the gloss is shown to the user, for
  instance gloss `HOW1` displayed as `HOW`. It is also what the voice
  pronounces.
* **`demo_url`** points at the demo video, served from `lectures/demos/`.
* **`from_memory`** is optional, `false` by default. On that one sign the demo
  starts covered and the user decides whether to uncover it. Put it on any
  sign, anywhere in the lesson; it touches nothing else. It earns its place on
  a sign already met earlier in the same lesson, since that is where asking for
  it again without the video actually tests something. With no `demo_url` the
  flag does nothing, because there would be nothing to uncover.

```json
{ "gloss": "FEEL", "demo_url": "/demos/feel.mp4", "from_memory": true }
```

</details>

<details>
<summary><b>Adding demo videos</b></summary>

Videos go in `lectures/demos/` and are referenced as `/demos/<name>.mp4`.
Format is MP4 H.264. Any aspect ratio works, since the panel is square and fits
the video without cropping it. To bring a source file down in size:

```bash
ffmpeg -i input.mp4 -an -vf "scale=480:480:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2" -c:v libx264 -crf 23 -pix_fmt yuv420p -movflags +faststart lectures/demos/name.mp4
```

Video and not GIF, because a GIF in the browser can be neither paused nor
slowed down: there is no API for it.

After adding a video, regenerate the library thumbnails:

```bash
python utils/make_posters.py
```

It only does the missing ones, and `--force` redoes them all. It takes the
sharpest of a few frames from the middle of the clip, because the first frame
is almost always the rest pose and looks the same for every sign, scales it to
320px on the long side and writes it to `lectures/demos/posters/`. It uses
OpenCV, already among the dependencies, so no ffmpeg is needed here.

Commit the thumbnails along with the videos. Forget and nothing breaks: that
sign falls back to the empty tile with the little hand, because the server
sends a thumbnail only when the file is really there.

</details>

<details>
<summary><b>HTTP API</b></summary>

Useful if you want to read or set the progress by hand.

```
GET   /api/progress          full state plus counts
POST  /api/progress/sign     {gloss, status: known|review, lesson}
POST  /api/progress/lesson   {lesson, done, total}
POST  /api/progress/demo     fill the memory, what Fill progress calls
POST  /api/progress/reset    clear everything
WS    /ws                    webcam frames in, capture state and predictions out
```

The websocket is what the browser uses while you practise: it carries the
frames to the server and brings back the state of the capture and the verdict
on each gesture.

</details>

<details>
<summary><b>Project layout</b></summary>

```
server.py     FastAPI app: routes, websocket, capture segmentation and the
              tunable constants
utils/        recognition and preprocessing taken from the upstream project,
              plus the lesson engine, the progress store and the thumbnail
              script
static/       the whole client: one page, one stylesheet, one script per
              screen
lectures/     the lesson files, and demos/ with the videos and their
              thumbnails
models/       the trained GRU model and the gloss index
data/         progress.json, written at runtime
```

</details>

<details>
<summary><b>Troubleshooting</b></summary>

**The camera never starts.** The browser asks for permission the moment you
enter a lesson. If that prompt was dismissed, allow the camera for
`localhost:8000` in the site settings and reload. A browser running sandboxed
or headless has no camera to offer.

**A change to the interface does not show up.** It should: the server sends no
cache headers for the page and for `static/`. If it still happens, reload while
bypassing the cache.

**Reconnect appeared in the middle of a lesson.** The websocket dropped. Press
it and you resume at the step you were on, not at the beginning.

**Everything in the library vanished.** `data/progress.json` was deleted or
damaged. The server starts from an empty memory rather than failing, and the
next sign you get right writes the file again.

**The voice reads the signs in the wrong language.** No English voice is
installed on the system, so the default one is used. It still pronounces the
names.

**The server does not start after editing `requirements.txt`.** `openai` and
`python-dotenv` have to stay: `utils/live_translation.py` imports them at
startup. The API key they would need is only read inside `get_client()`, which
DuoSL never calls, so no key is required to run any of this.

</details>

## Credits

The recognition pipeline, the trained model and the preprocessing come from
[tobp03/live-asl-translation](https://github.com/tobp03/live-asl-translation),
released under the Apache 2.0 license, whose text is kept in `utils/LICENSE`.

The model is trained on the
[ASL Citizen dataset](https://www.microsoft.com/en-us/research/project/asl-citizen/)
by Microsoft Research.
