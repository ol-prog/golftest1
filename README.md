# Swing Lab

A golf swing analyser that runs entirely in the browser on your phone. Film a
swing on the range — hands-free, with the phone propped against your bag — or
shoot it in the Camera app and upload it. You get tempo, swing plane, club path,
strike quality, body movement and ball launch, measured from the video.

Nothing is uploaded anywhere. All the analysis, including the body tracking
model, runs on the phone, so it works with no signal at all.

---

## Getting it on your phone

The app is a static site, so GitHub Pages will serve it. Two things to do on
github.com, both from a phone browser if you like:

1. **Make the repository public.** `ol-prog/golftest1` is currently private, and
   Pages on a free account only serves public repositories.
   *Settings → General → scroll to Danger Zone → Change visibility → Make
   public.*
2. **Turn Pages on.** *Settings → Pages → Source: **Deploy from a branch** →
   Branch: `claude/golf-swing-analyzer-9hr0f7` (it is the default, so it should
   already be selected) → Folder: `/ (root)` → **Save**.*

Give it a minute or two and the site will be at:

```
https://ol-prog.github.io/golftest1/
```

Open that in **Safari** on your iPhone. Pages serves over HTTPS, which iOS
requires before it will grant camera access — the app cannot work from a file or
over plain HTTP.

Then, in Safari: tap **Share → Add to Home Screen**. That gives it its own icon,
opens it full screen without the browser chrome, and keeps your shots between
visits.

Finally, on wifi before you go: open **Settings → Download for offline use**.
That caches the 28 MB body-tracking model so the app is fully functional at a
range with no signal.

---

## Filming a swing

**Slo-mo is the single biggest thing you can do for the quality of the
analysis.** At 30 frames a second a golf ball is gone in one frame and the club
head travels a metre and a half between frames, so launch angle, start line and
angle of attack simply cannot be measured. In slo-mo they can. The app detects
the slow-motion factor automatically and tells you what it assumed.

Two useful angles, and they measure different things:

| | Down the line | Face on |
|---|---|---|
| Where | Behind the ball, on the target line, about hip height, two club lengths back | Square to your toe line, level with your hands |
| Measures | Swing plane, club path across the ball, start line, alignment | Tempo, strike, low point, angle of attack, body movement, launch angle |

Either way: **turn the phone sideways, or stand well back.** A full swing arc is
wider than a portrait frame, and once the club leaves the picture that part of
the arc cannot be measured. The app tells you when this happened.

### Hands-free mode

Prop the phone against your bag or a bucket, arm hands-free mode, and walk in.
It waits for you to arrive, waits again until you settle over the ball, starts
recording there, and stops shortly after the swing. You never touch the phone
between shots.

Because recording starts while you are still at address, the clip always
contains the whole swing — there is no buffering trick that could clip the
start.

---

## What the numbers mean, and how much to trust them

Everything here is measured from a flat picture taken with one camera. That
makes some things solid and other things estimates, and the app is explicit
about which is which.

**Solid.** Ratios, angles measured within the frame, and the way a swing changes
from shot to shot.

- **Tempo** — the ratio of backswing time to downswing time. Around 3:1 is where
  most tour swings sit. This is the most reliable number the app produces, and
  it does not depend on knowing the slow-motion factor, because the factor
  cancels out of a ratio.
- **Plane shift** — how much steeper or shallower the downswing is than the
  backswing, compared over the same band of heights so it is like for like. The
  over-the-top signature.
- **Low point relative to the ball** — where the club bottoms out. Past the ball
  is ball-then-turf.
- **Angle of attack** — how steeply the club arrives, from the tangent to the
  fitted swing arc at the ball.
- **Launch angle and start line** — from the first frames of ball flight.

**Estimates.** Anything converted into real-world units — club speed, ball
speed, distances in centimetres — is scaled from the height you enter in
settings, and reads low when the movement is partly towards or away from the
camera. Use them to compare one swing against the next, not as absolute
figures.

**Rough guides.** Shoulder and hip turn are inferred from how narrow your
shoulders and hips look on camera as you turn away from it. That is a real
signal but not a real protractor.

It is a mirror with a memory, not a launch monitor.

The app suppresses measurements rather than guessing. If the frame rate is too
low to measure a delivery, or a figure comes out outside any believable range,
it says so instead of printing a number.

---

## How it works

All in vanilla JavaScript, no build step, no framework.

| File | Job |
|---|---|
| `js/frames.js` | Video into frames. Plays the clip and captures each presented frame rather than seeking to each one, which is several times faster, and stamps every frame with its real presentation time so dropped frames do not distort anything. |
| `js/motion.js` | Greyscale, blurring, inter-frame differencing, blob finding. |
| `js/events.js` | Finds address, top, impact and finish from the motion-energy curve. Works on a log scale, because in 8× slow motion the takeaway carries a tiny fraction of the energy of impact and any linear threshold treats half the backswing as nothing happening. The top is found by prominence — the dip flanked by the backswing hump on one side and the downswing on the other. |
| `js/club.js` | Tracks the club head as the fastest, furthest-from-the-body part of the moving picture, then derives plane, path, attack angle and speed. |
| `js/ball.js` | Finds the ball by the one thing that is certain about it: it is sitting still and bright before impact and gone immediately after. Then follows it for the first few frames of flight. |
| `js/pose.js` | MediaPipe Pose on the four key frames, for body angles and the pixels-to-centimetres scale. |
| `js/analyse.js` | The pipeline, plus the plausibility gate on every real-world figure. |
| `js/coach.js` | Turns measurements into plain English. Rule-based and offline. |
| `js/capture.js` | Camera, framing guide, and the three recording modes. |

Two details worth knowing:

**The strike is anchored to the ball, not to the energy peak.** The energy peak
locates impact to within a few frames, which at 240fps is several degrees of
arc — enough to turn a 4° descending strike into a 15° chop. The club head
sweeps a circle around the golfer, and the closest point of that circle to the
ball lies on the radius through it, so the tracked point nearest the detected
ball is the one actually delivered to it.

**iPhone slow motion is time-stretched, not labelled.** A 240fps clip arrives as
an ordinary 30fps video running eight times too slow, so the clip's own clock
lies. The app recovers the factor from the length of the swing and snaps it to
the factors an iPhone can actually produce, which are an octave apart and so
forgiving of an unusually quick or slow swing. You can override it on the report
if it guesses wrong; ratios and angles do not depend on it, only the times in
seconds do.

### Accuracy

Checked against synthetic swings rendered with known geometry — a chosen tempo,
a chosen angle of attack and a chosen launch angle:

| | Measured | True |
|---|---|---|
| Tempo ratio | 2.87 : 1 | 3.04 : 1 |
| Angle of attack | −2.4° | −4.0° |
| Launch angle | 19.0° | 19.0° |
| Plane shift (symmetrical swing) | −0.4° | 0° |
| Ball position | within 0.6% of frame width | — |

Repeated runs of the same clip agree to within a tenth of a degree on launch
angle and a hundredth on tempo. At 30fps, without slo-mo, tempo lands around
2.78 against a true 3.04, which is the quantisation limit when a downswing is
only eight frames long.

---

## Tests

```
node test/smoke.mjs
```

Covers the pure analysis functions: degenerate and empty inputs, slow-motion
factor recovery, and an analytic check that the delivery tangent on a known
circular arc comes back exactly level at the bottom and exactly 10° descending
ten degrees before it.

---

## Privacy

Clips, key frames and reports are stored in IndexedDB on the phone and never
leave it. There is no server, no account and no analytics. Deleting a shot, or
using **Delete all shots** in settings, removes it.
