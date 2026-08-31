// The analysis pipeline: video in, swing report out.
//
// Coordinates in the report are normalised by frame WIDTH (so x is 0..1 and y is
// 0..1/aspect). That keeps the overlay resolution-independent and lets the
// pose-derived scale, measured on a different-sized canvas, be applied directly.

import {
  loadVideo, releaseVideo, primeDecoder, detectFrameRate,
  scanCoarse, extractRange, grabStill, seekTo, analysisSize,
} from './frames.js';
import { noiseFloor } from './motion.js';
import { computeEnergy, detectEvents, estimateSlomo } from './events.js';
import {
  estimateBodyCentre, trackClub, cleanTrack, clubMetrics,
  deliveryMetrics, framesForFactory, strikeIndexFromBall,
} from './club.js';
import { findBallAtRest, trackBall, launchFromPath } from './ball.js';
import { loadPose, detectOn, poseSummary, bodyMetrics, pixelScale } from './pose.js';
import { clamp, nextTick } from './util.js';

const MPH_PER_MS = 2.23694;

/**
 * Plausible ranges for every figure that gets shown as a real-world quantity.
 * A single bad pose can scale a centimetre figure by a factor of ten, and a
 * confidently wrong number is worse than a missing one: anything outside these
 * bounds is dropped and said to be dropped rather than displayed.
 */
const PLAUSIBLE = {
  'club.speedMph': [15, 160],
  'club.lowPointOffsetCm': [-40, 40],
  'club.attackAngleDeg': [-30, 30],
  'club.planeShiftDeg': [-45, 45],
  'club.backswingPlaneDeg': [0, 90],
  'club.downswingPlaneDeg': [0, 90],
  'club.impactDirectionDeg': [-90, 90],
  'ball.speedMph': [20, 250],
  'ball.launchAngleDeg': [-15, 65],
  'ball.startLineDeg': [-35, 35],
  'body.headSwayCm': [-50, 50],
  'body.headLiftCm': [-50, 50],
  'body.headSwayTopCm': [-60, 60],
  'body.hipShiftCm': [-60, 60],
  'body.hipSlideBackCm': [-60, 60],
  'body.spineTiltAddressDeg': [-55, 55],
  'body.spineTiltImpactDeg': [-55, 55],
  'body.spineChangeDeg': [-45, 45],
  'body.shoulderTurnDeg': [10, 110],
  'body.hipTurnDeg': [0, 90],
  'body.xFactorDeg': [-30, 80],
  'body.leadArmTopDeg': [70, 180],
  'body.kneeFlexAddressDeg': [90, 180],
};

function sanitise(report) {
  const dropped = [];
  for (const [path, [lo, hi]] of Object.entries(PLAUSIBLE)) {
    const [group, key] = path.split('.');
    const obj = report[group];
    if (!obj) continue;
    const v = obj[key];
    if (v == null) continue;
    if (!Number.isFinite(v) || v < lo || v > hi) {
      obj[key] = null;
      dropped.push(path);
    }
  }
  if (dropped.length) {
    report.droppedMeasurements = dropped;
    report.warnings.push(
      `${dropped.length} measurement${dropped.length > 1 ? 's' : ''} came out outside any believable range and ${dropped.length > 1 ? 'have' : 'has'} been left out rather than shown. That usually means the body or club could not be followed cleanly — check the traced arc above.`,
    );
  }
  // Club speed is derived, so its unit-factor twin has to go with it.
  if (report.club && report.club.speedMph == null) delete report.club.speedMphPerFactor;
}


/** Grab a colour frame at time `t` into a canvas sized for the pose model. */
async function poseFrame(video, t, canvas, ctx) {
  await seekTo(video, t);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
}

/**
 * @param {Blob} file            the clip
 * @param {object} opts          { view, handed, heightCm, slomo, club, onProgress }
 */
export async function analyseSwing(file, opts) {
  const {
    view = 'faceon', handed = 'right', heightCm = 178,
    slomo = 'auto', club = '', onProgress = () => {},
  } = opts;
  // The club the golfer selected, kept apart from the club *measurements*
  // stored on report.club.
  const notes = [];
  const report = {
    ts: Date.now(), view, handed, clubName: club, heightCm,
    notes, warnings: [],
  };

  const video = await loadVideo(file);
  try {
    onProgress('Reading the clip', 0.02);
    await primeDecoder(video);
    const { fps, measured } = await detectFrameRate(video);
    report.fps = fps;
    report.fpsMeasured = measured;
    report.duration = video.duration;
    report.videoWidth = video.videoWidth;
    report.videoHeight = video.videoHeight;
    if (!measured) {
      notes.push('This browser would not report the clip’s frame rate, so timings assume 30fps.');
    }

    // --- Pass 1: coarse scan to find where the swing is -------------------
    onProgress('Finding the swing', 0.06);
    const coarse = await scanCoarse(video, {
      samplesPerSec: 12,
      longEdge: 128,
      onProgress: (f) => onProgress('Finding the swing', 0.06 + f * 0.16),
    });
    const coarseThr = noiseFloor(coarse.gray, coarse.w, coarse.h);
    const coarseEnergy = computeEnergy(coarse.gray, coarse.w, coarse.h, coarseThr, coarse.times);
    const coarseEvents = detectEvents(coarseEnergy.energy, coarse.times);
    if (!coarseEvents.ok) {
      throw new Error(coarseEvents.notes[0] || 'No swing found in that clip.');
    }

    const tAddress = coarse.times[coarseEvents.address];
    const tFinish = coarse.times[coarseEvents.finish];
    const span = Math.max(0.3, tFinish - tAddress);
    const pad = clamp(span * 0.2, 0.12, 1.2);
    // Cap the fine window: a long slo-mo clip can otherwise be enormous.
    const t0 = Math.max(0, tAddress - pad);
    const t1 = Math.min(video.duration - 1e-3, Math.min(tFinish + pad, t0 + 18));
    // Kept on the report so a bad read can be diagnosed from the console.
    report.debug = {
      coarse: {
        times: coarse.times.length,
        address: tAddress, top: coarse.times[coarseEvents.top],
        impact: coarse.times[coarseEvents.impact], finish: tFinish,
        confidence: coarseEvents.confidence,
        rawEnergy: Array.from(coarseEnergy.energy).map((v) => Number(v.toFixed(4))),
        sampleTimes: coarse.times.map((t) => Number(t.toFixed(4))),
      },
      window: { t0, t1 },
    };

    // --- Pass 2: every frame across the swing -----------------------------
    onProgress('Reading every frame', 0.24);
    const fine = await extractRange(video, t0, t1, fps, {
      longEdge: 320,
      maxFrames: 900,
      onProgress: (f) => onProgress('Reading every frame', 0.24 + f * 0.34),
    });
    if (fine.gray.length < 8) throw new Error('Not enough frames around the swing to analyse.');
    if (fine.stride && fine.stride > 1) {
      notes.push('The clip was long, so frames were sampled rather than read one by one.');
    }

    const W = fine.w;
    const H = fine.h;
    const thr = noiseFloor(fine.gray, W, H);
    onProgress('Measuring motion', 0.6);
    const en = computeEnergy(fine.gray, W, H, thr, fine.times);
    const ev = detectEvents(en.energy, fine.times);
    if (!ev.ok) throw new Error(ev.notes[0] || 'No swing found in that clip.');
    notes.push(...ev.notes);
    await nextTick();

    // --- Timing and the slo-mo stretch factor -----------------------------
    const vBack = fine.times[ev.top] - fine.times[ev.address];
    const vDown = fine.times[ev.impact] - fine.times[ev.top];
    const vTotal = fine.times[ev.finish] - fine.times[ev.address];
    const auto = estimateSlomo(vBack + vDown);
    const factor = slomo === 'auto' ? auto.factor : Number(slomo) || 1;
    report.slomo = {
      factor,
      auto: auto.factor,
      autoConfident: auto.confident,
      source: slomo === 'auto' ? 'auto' : 'manual',
    };
    const effectiveFps = fps * factor;
    report.effectiveFps = effectiveFps;
    if (slomo === 'auto' && !auto.confident) {
      report.warnings.push(
        `Slow-motion factor was guessed at ${factor}x. If that is wrong the ratio is still right, but the times in seconds are not — set it by hand on the report.`,
      );
    }

    // Raw clip-time durations, so the slow-motion factor can be corrected on
    // the report without re-running the whole analysis.
    report.timingRaw = { backswingSec: vBack, downswingSec: vDown, totalSec: vTotal };
    report.timing = {
      backswingSec: vBack / factor,
      downswingSec: vDown / factor,
      totalSec: vTotal / factor,
      tempoRatio: vDown > 0 ? vBack / vDown : null,
      framesInSwing: ev.impact - ev.address,
      confidence: ev.confidence,
    };

    // --- Pose on the key frames -------------------------------------------
    onProgress('Looking at your body position', 0.64);
    const poseSize = analysisSize(video, 480);
    const poseCanvas = document.createElement('canvas');
    poseCanvas.width = poseSize.w;
    poseCanvas.height = poseSize.h;
    const poseCtx = poseCanvas.getContext('2d', { willReadFrequently: true });
    const landmarker = await loadPose();
    const at = {};
    const poseKeys = ['address', 'top', 'impact', 'finish'];
    if (landmarker) {
      for (const key of poseKeys) {
        await poseFrame(video, fine.times[ev[key]], poseCanvas, poseCtx);
        at[key] = poseSummary(detectOn(landmarker, poseCanvas));
        await nextTick();
      }
    } else {
      notes.push('Body tracking could not load, so this report covers club and ball only.');
    }
    report.poseOk = Boolean(at.address);

    // Normalised-units-per-centimetre, from the golfer's height at address.
    let unitsPerCm = null;
    if (at.address) {
      const pxPerCm = pixelScale(at.address, heightCm, poseCanvas.height);
      if (pxPerCm) unitsPerCm = pxPerCm / poseCanvas.width;
    }
    report.unitsPerCm = unitsPerCm;
    report.poseFrames = {};
    for (const key of poseKeys) {
      if (!at[key]) continue;
      report.poseFrames[key] = at[key].raw.map((p) => ({
        x: p.x / poseCanvas.width,
        y: p.y / poseCanvas.width,
        v: p.v,
      }));
    }

    // --- Club head tracking -----------------------------------------------
    onProgress('Tracing the club head', 0.72);
    let bodyCentre = null;
    if (at.address) {
      // Pose canvas -> analysis frame coordinates.
      const k = W / poseCanvas.width;
      bodyCentre = {
        x: ((at.address.shoulders.x + at.address.hips.x) / 2) * k,
        y: ((at.address.shoulders.y + at.address.hips.y) / 2) * k,
      };
    } else {
      bodyCentre = estimateBodyCentre(en.cx, en.cy, ev.address, ev.finish);
    }
    const trackFrom = Math.max(1, ev.address - 1);
    const trackTo = Math.min(fine.gray.length - 1, ev.finish + 1);
    const rawTrack = trackClub(fine.gray, W, H, trackFrom, trackTo, thr, bodyCentre);
    // More frames a second means more jitter to average away, and a centred
    // average costs no lag.
    const points = cleanTrack(rawTrack, clamp(Math.round(effectiveFps / 120), 1, 3));
    const offFrameFraction = rawTrack.length
      ? rawTrack.filter((t) => t.offFrame).length / rawTrack.length
      : 0;
    const idx = {
      address: ev.address - trackFrom,
      top: ev.top - trackFrom,
      impact: ev.impact - trackFrom,
      finish: ev.finish - trackFrom,
    };
    const cm = clubMetrics(points, fine.times, trackFrom, idx, handed, factor);
    const framesFor = framesForFactory(fine.times, trackFrom, points.length, factor);
    await nextTick();

    // --- Ball at rest -------------------------------------------------------
    // Found before the delivery numbers, because it is what they are measured
    // against: the energy peak locates impact to a few frames, which at 240fps
    // is several degrees of arc.
    onProgress('Looking for the ball', 0.8);
    report.ball = { tracked: false };
    const lowPoint = cm.lowPoint;
    const postIdx = Math.min(fine.gray.length - 1, ev.impact + Math.max(3, framesFor(0.03)));
    // Two reference frames for "before the ball left". The one just before
    // impact has the least background drift; the one just after address has the
    // club nowhere near the ball, which matters at 30fps where the club crosses
    // the whole hitting area between frames.
    const preCandidates = [
      Math.max(0, ev.impact - Math.max(2, framesFor(0.03))),
      Math.min(ev.address + 2, Math.max(0, ev.impact - 2)),
    ];
    let rest = null;
    for (const preIdx of preCandidates) {
      rest = findBallAtRest(fine.gray[preIdx], fine.gray[postIdx], W, H, lowPoint, thr);
      if (rest) break;
      // Second look with no assumption about where the club bottomed out: the
      // arc trace can be off even when the ball is perfectly visible.
      rest = findBallAtRest(fine.gray[preIdx], fine.gray[postIdx], W, H, null, thr, Math.hypot(W, H));
      if (rest) break;
    }

    const strikeIndex = rest ? strikeIndexFromBall(points, idx.impact, rest, framesFor) : null;
    if (strikeIndex != null) {
      Object.assign(cm, deliveryMetrics(points, fine.times, trackFrom, strikeIndex, handed, framesFor, cm.arc));
    }
    report.strikeIndex = strikeIndex;

    // Which way is the target on screen? Through impact the club is travelling
    // towards it, which is more reliable than guessing from which side of the
    // golfer the phone was placed. Down the line that motion is mostly vertical,
    // so there we fall back to handedness.
    const targetSign = view === 'faceon'
      ? (cm.travelSignX || (handed === 'left' ? -1 : 1))
      : (handed === 'left' ? -1 : 1);
    report.targetSign = targetSign;

    report.body = at.address ? bodyMetrics(at, targetSign) : null;
    if (report.body && unitsPerCm) {
      const swUnits = at.address.shoulderWidth / poseCanvas.width;
      const toCm = (norm) => (norm == null ? null : (norm * swUnits) / unitsPerCm);
      report.body.headSwayCm = toCm(report.body.headSwayNorm);
      report.body.headLiftCm = toCm(report.body.headLiftNorm);
      report.body.headSwayTopCm = toCm(report.body.headSwayTopNorm);
      report.body.hipShiftCm = toCm(report.body.hipShiftNorm);
      report.body.hipSlideBackCm = toCm(report.body.hipSlideBackNorm);
    }

    // Below about 90 frames a second the club moves too far between frames for
    // a delivery measurement to mean anything: at 30fps it covers a metre and a
    // half of arc, so a "descending strike" number would be invented. Say so
    // rather than printing a figure.
    const deliveryMeasurable = effectiveFps >= 90;
    if (!deliveryMeasurable) {
      cm.attackAngleDeg = null;
      cm.impactDirectionDeg = null;
      report.notes.push(
        `At ${Math.round(effectiveFps)} frames a second the club head moves too far between frames to measure how it arrives at the ball. Tempo, plane and body movement are all still solid; angle of attack and club path need slo-mo.`,
      );
    }

    report.club = {
      deliveryMeasurable,
      backswingPlaneDeg: cm.backswingPlaneDeg,
      downswingPlaneDeg: cm.downswingPlaneDeg,
      planeShiftDeg: cm.planeShiftDeg,
      planeFitQuality: cm.planeFitQuality,
      impactDirectionDeg: cm.impactDirectionDeg,
      attackAngleDeg: cm.attackAngleDeg,
      trackCoverage: cm.trackCoverage,
      planeDebug: cm.planeDebug,
      deliveryPoints: cm.deliveryPoints,
      strikeAnchoredToBall: strikeIndex != null,
      offFrameFraction,
      arcRadiusPx: cm.arc ? cm.arc.r : null,
      arcFitRms: cm.arc ? cm.arc.rms : null,
      arcUsed: cm.arcRadiusPx != null,
    };
    // Club speed: 2D and therefore an under-estimate, worst of all down the
    // line where the head is partly moving towards the camera.
    if (unitsPerCm && cm.peakSpeedPxPerSec > 0) {
      const unitsPerSec = (cm.peakSpeedPxPerSec / W) * factor;
      const msPerSec = unitsPerSec / unitsPerCm / 100;
      report.club.speedMph = msPerSec * MPH_PER_MS;
      // Scales linearly with the slow-motion factor, so keep the unit value.
      report.club.speedMphPerFactor = report.club.speedMph / factor;
      report.club.speedIsLowerBound = view !== 'faceon';
    }

    // --- Ball flight --------------------------------------------------------
    onProgress('Following the ball', 0.84);
    if (rest) {
      report.ball.rest = { x: rest.x / W, y: rest.y / W, confidence: rest.confidence };
      // Low point of the arc relative to the ball tells ball-first vs fat.
      if (lowPoint && unitsPerCm) {
        const offsetUnits = (targetSign * (lowPoint.x - rest.x)) / W;
        report.club.lowPointOffsetCm = offsetUnits / unitsPerCm;
      }
      if (effectiveFps >= 90) {
        const path = trackBall(fine.gray, W, H, trackFrom + (strikeIndex ?? idx.impact), rest, thr, 30);
        const launch = launchFromPath(
          path.map((p) => ({ ...p })), view, handed, effectiveFps,
          unitsPerCm ? unitsPerCm * W : null,
        );
        if (launch.ok) {
          report.ball.tracked = true;
          report.ball.launchAngleDeg = launch.launchAngleDeg ?? null;
          report.ball.startLineDeg = launch.startLineDeg ?? null;
          report.ball.speedMph = launch.ballSpeedMph ?? null;
          report.ball.fit = launch.r2;
          // Times come along so the tracer can draw the flight in step with
          // the video rather than all at once.
          report.ball.path = launch.points.map((p) => ({
            x: p.x / W, y: p.y / W, t: fine.times[p.i] ?? null,
          }));
        } else {
          report.ball.reason = launch.reason;
        }
      } else {
        report.ball.reason = `At ${Math.round(effectiveFps)} frames per second the ball is gone in one frame. Film in slo-mo to measure launch.`;
      }
    } else {
      report.ball.reason = 'The ball could not be picked out against the background.';
    }

    // --- Trace and stills ---------------------------------------------------
    onProgress('Drawing the swing', 0.9);
    report.trace = {
      aspect: H / W,
      // Clip time of the first tracked frame, so the tracer can line the path up
      // with playback.
      t0: fine.times[trackFrom],
      points: points.map((p, i) => (p ? { x: p.x / W, y: p.y / W, i } : null)),
      body: { x: bodyCentre.x / W, y: bodyCentre.y / W },
      idx,
      times: Array.from(fine.times.slice(trackFrom, trackTo + 1)).map((t) => t - fine.times[trackFrom]),
    };
    report.events = {
      address: fine.times[ev.address],
      top: fine.times[ev.top],
      impact: fine.times[ev.impact],
      finish: fine.times[ev.finish],
    };
    report.debug.fine = {
      rawEnergy: Array.from(en.energy).map((v) => Number(v.toFixed(4))),
      times: fine.times.map((t) => Number(t.toFixed(4))),
    };
    report.energy = {
      values: Array.from(ev.smooth).map((v) => Number(v.toFixed(4))),
      times: Array.from(fine.times),
      idx: { address: ev.address, top: ev.top, impact: ev.impact, finish: ev.finish },
    };

    report.stills = {};
    for (const key of poseKeys) {
      const still = await grabStill(video, fine.times[ev[key]], 640, 0.8);
      report.stills[key] = still.blob;
      await nextTick();
    }

    sanitise(report);

    // Overall confidence: timing is the backbone, the club trace the rest.
    report.confidence = clamp(0.6 * ev.confidence + 0.4 * clamp(cm.trackCoverage, 0, 1), 0, 1);
    onProgress('Done', 1);
    return report;
  } finally {
    releaseVideo(video);
  }
}
