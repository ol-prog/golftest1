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

## Reading a report

Three panes, because the whole thing used to be one very long scroll:

- **Numbers** — tempo, the measurements, the timeline the tempo split is read
  off, and the slow-motion factor.
- **Swing path** — the clip with the tracer on it, and the still frames with the
  swing arc and your body angles drawn over them.
- **Tips** — what to work on, everything the app noticed, and how to get better
  footage next time.

The verdict sits above all three, because it is the one thing worth reading on
every shot and it should not be behind a tab.

---

## Your profile

After your first swing has been analysed — never before — the app offers to keep
a profile. It is a name, your handedness, and your height.

It is worth having for a concrete reason rather than a sentimental one: height
is what turns pixels into centimetres and miles per hour, and handedness sets
which way "towards the target" is. Without them those figures are working off an
assumption.

There is no account in the usual sense, and the app does not pretend otherwise.
There is no server behind it, so there is no email, no password, and nothing to
sign in to. The profile is a record on your phone, and deleting it is one tap in
settings.

Declining is an answer: it is asked once and then left alone. The profile is
still there in settings whenever you actually want it.

---

## The swing tracer

Play the clip back and one smooth line draws itself along your club head as it
goes — blue through the backswing, orange coming down, red through the finish,
with the ball flight carrying on in green after impact.

The line is a **fitted curve, not raw detections**. A club head cannot teleport,
so a detection that disagrees sharply with its neighbours is wrong rather than
interesting. Every point is refitted from a local weighted quadratic, points that
disagree with that fit are discarded, and the fit is repeated without them. What
gets drawn is the arc that survives.

Three things it does that a naive tracker does not:

- **It takes the leading edge of the club, not the middle of the shaft.** A
  phone shutter is open long enough that a fast club smears across the frame, so
  the moving blob spans where the club was and where it now is. Picking the
  point that is both furthest from your body and furthest along the direction of
  travel finds the head; averaging over the blob finds a spot part-way up the
  shaft that wanders as more or less of the shaft comes into view.
- **It refuses to follow the ball.** After impact the ball leaves from exactly
  where the club head is, fast and in a straight line — the one thing a
  continuity tracker will happily follow instead of the club. Once the flight is
  known, any club detection sitting on it is thrown out and the arc re-fitted.
- **It breaks rather than bridges.** Where the club genuinely could not be
  found, the line stops. A line drawn across a gap is a guess the viewer cannot
  tell apart from a measurement.

The ball line is the **fitted parabola** of the flight, not a join-the-dots of
where the ball was seen. A struck ball is a projectile, so that shape is the
right one, and fitting it lets the line carry on past the last frame the ball was
visible in — which is what makes a tracer read as a shot rather than a few dots.

If the line does not follow your club head, that is your signal to distrust the
plane and path figures on that shot.

Quarter and half speed are there because a downswing is a quarter of a second
and you cannot see a transition at full speed. **Replay** jumps back to address
rather than to the start of the file, which matters on a slow-motion clip where
the swing might not start for ten seconds.

The tracer needs the clip itself, so clips are kept on the phone. Slow-motion
footage is large — a 1080p 240fps clip runs to tens of megabytes — so when
storage starts filling up the app drops the video from the oldest shots first
and tells you it did. The measurements and key frames for those shots stay.

---

## Body angles

The body overlay draws the handful of lines a coach would actually draw on a
still: your spine against a vertical through your hips, your shoulder and hip
lines, your knees, and where your head is. On any frame other than address it
also ghosts in the spine angle you set up with, so a loss of posture is visible
rather than something to hold in your head between screens.

A thirty-three point skeleton looks impressive and tells you nothing you can act
on, so it is gone.

Nothing is drawn unless the detection actually looks like a person standing over
a ball — feet below head, hips between shoulders and feet, sensible proportions,
a spine that is not lying on its side. The pose model returns thirty-three points
whether or not there is a golfer to find, and angle lines through a bad detection
look authoritative and are wrong.

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

The app suppresses measurements rather than guessing. Angle of attack and club
path are only reported when the fitted swing arc is clean enough to take a
tangent from — without that test the same swing came back as four degrees
descending on one reading and twenty ascending on the next, and a number that
unstable is worse than no number. If the frame rate is too
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
| `js/tracer.js` | Draws the fitted club-head path and ball flight over the clip, in step with playback. |
| `tools/harden-vendor.mjs` | Strips telemetry from the vendored model code, and verifies it stays stripped. |

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
| Angle of attack | −6.0° to +1.6° | −4.0° |
| Launch angle | 18.9°–19.0° | 19.0° |
| Plane shift (symmetrical swing) | −0.4° | 0° |
| Ball position | within 0.6% of frame width | — |

Club-head tracking is measured against the arc the fixture actually drew,
including a version with motion blur, sensor noise, a golfer moving in the next
bay and a flag in the wind:

| | Clean | With blur and clutter |
|---|---|---|
| Median error | 0.16% of frame width | 0.14% |
| 95th percentile | 1.0% | 1.0% |
| Through the downswing | 0.17% median, 0.80% worst | 0.09% median, 0.55% worst |
| Frame-to-frame jitter | 0.14% | 0.11% |

Repeated runs of the same clip agree to within a tenth of a degree on launch
angle and a hundredth on tempo. At 30fps, without slo-mo, tempo lands around
2.78 against a true 3.04, which is the quantisation limit when a downswing is
only eight frames long.

---

## Tests

```
node test/smoke.mjs
```

Covers the security and privacy guarantees — the content security policy, the
absence of any outbound URL in the vendored library, and HTML escaping — plus
that every module loads and exports what its importers reach for, and the pure
analysis functions: degenerate and empty inputs, slow-motion
factor recovery, and an analytic check that the delivery tangent on a known
circular arc comes back exactly level at the bottom and exactly 10° descending
ten degrees before it.

---

## Privacy and security

Swings are video of you. The app is built so that footage never leaves your
phone, and so that the claim is something you can check rather than something
you have to take on trust.

- **No backend, no account, no analytics.** Clips, key frames, reports and your
  profile live in the phone's own storage. There is no server to send them to.
- **A content security policy the page enforces on itself.** `connect-src 'self'`
  means the browser will refuse any outbound connection, whatever a dependency
  might try; `script-src 'self'` means no third-party code can run at all.
- **The body-tracking library's telemetry has been removed.** MediaPipe Tasks
  batches usage logs to a Google endpoint. It is stripped out of the vendored
  bundle by `tools/harden-vendor.mjs`, which can be re-run and re-checked after
  any update to the library, and the tests fail if an outbound URL reappears.
- **Everything rendered is escaped.** Nothing shown today comes from anywhere but
  your own phone, but stored data rendered as markup is how apps grow injection
  bugs quietly, so the boundary is escaped now rather than later.
- **No referrer is sent** and the page cannot be navigated away by a form.

This is verified rather than asserted: the test suite runs a complete analysis
in a browser with every non-local request blocked, and fails if a single
off-origin request is attempted or a single policy violation is raised.

Two things worth being straight about:

- **Anyone with your unlocked phone can open the app and watch your swings.**
  There is no lock on the app itself. Settings → Delete all shots removes
  everything.
- **Clickjacking protection needs a real host.** `frame-ancestors` and
  `X-Frame-Options` can only be set as HTTP headers, and GitHub Pages does not
  let you set headers. It is a low risk for an app with nothing to click, but it
  is not zero, and it is not something a static host can fix.
