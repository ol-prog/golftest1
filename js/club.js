// Tracking the club head through the swing.
//
// The club head is the fastest-moving, furthest-from-the-body part of the
// picture, so for each frame we take the moving pixels that are furthest from
// the golfer's centre and weight them towards the extremity. A continuity gate
// stops the track jumping to a passing golfer or a flapping flag.

import { diff, blobs, refineAround } from './motion.js';
import { clamp, deg, fitLine, smooth } from './util.js';

/**
 * Estimate where the golfer's body is, in analysis-frame pixels.
 * Uses the pose hip/shoulder centre when we have it, otherwise the median of
 * the per-frame motion centroids, which sits on the body because the body is
 * present in every frame while the club sweeps past.
 */
export function estimateBodyCentre(motionCx, motionCy, from, to, poseCentre) {
  if (poseCentre) return poseCentre;
  const xs = [];
  const ys = [];
  for (let i = from; i <= to; i++) {
    xs.push(motionCx[i]);
    ys.push(motionCy[i]);
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  const mid = (a) => a[Math.floor(a.length / 2)] || 0;
  return { x: mid(xs), y: mid(ys) };
}

/**
 * Track the club head from `from` to `to` (frame indices into `gray`).
 * Returns one entry per frame; `p` is null where nothing convincing moved.
 */
export function trackClub(gray, w, h, from, to, threshold, body) {
  const track = [];
  let prev = null;
  let vel = { x: 0, y: 0 };
  const diagonal = Math.hypot(w, h);
  const maxJump = diagonal * 0.2;
  const baseTipRadius = Math.max(2.5, diagonal * 0.018);
  const minBlob = Math.max(4, Math.round(w * h * 0.00012));

  for (let i = Math.max(1, from); i <= to; i++) {
    const { mask, mag, count } = diff(gray[i - 1], gray[i], w, h, threshold);
    if (count < 4) {
      track.push({ i, p: null, conf: 0 });
      prev = null;
      vel = { x: 0, y: 0 };
      continue;
    }

    // Group the motion, and for each group note the point furthest from the
    // golfer. The club head is the tip of the moving mass, not its middle —
    // averaging over the shaft is what used to pull the line inwards and make
    // it wobble as more or less of the shaft came into view.
    // Once the club is moving, hand the blob finder the direction of travel so
    // it can pick the leading edge of the motion smear rather than either end
    // of it at random — that ambiguity is what used to break the line through
    // the downswing, where the club is fastest and the smear longest.
    const speed = Math.hypot(vel.x, vel.y);
    const dir = speed > 0.8 ? { x: vel.x / speed, y: vel.y / speed } : null;
    const found = blobs(mask, w, h, minBlob, body, mag, dir);
    if (!found.length) {
      track.push({ i, p: null, conf: 0 });
      continue;
    }

    const pred = prev ? { x: prev.x + vel.x, y: prev.y + vel.y } : null;
    let best = null;
    let bestScore = -Infinity;
    let offFrame = false;

    for (const b of found) {
      const tip = b.hasLead ? { x: b.leadX, y: b.leadY } : { x: b.farX, y: b.farY };
      const tipOnEdge = tip.x <= 1 || tip.y <= 1 || tip.x >= w - 2 || tip.y >= h - 2;
      // Reach from the body, and how hard the pixels moved. The club head wins
      // on both counts against a swaying flag or a golfer in the next bay.
      const strength = Math.log1p(b.weight / 255);
      let score = b.farD * strength;
      let jump = 0;
      if (pred) {
        jump = Math.hypot(tip.x - pred.x, tip.y - pred.y);
        // Prefer continuity strongly, but never rule a blob out completely:
        // a hard rejection is what makes a track drop the club and never
        // recover it.
        score *= jump > maxJump ? 0.05 : 1 + 2 * (1 - jump / maxJump);
      }
      if (tipOnEdge) score *= 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = { b, tip, jump, tipOnEdge };
      }
    }

    if (!best) {
      track.push({ i, p: null, conf: 0 });
      continue;
    }
    if (best.tipOnEdge) offFrame = true;

    // The leading edge of the smear is where the club was when the shutter
    // closed, not where it was during the frame. Averaging back over roughly
    // half the distance it travelled recovers the middle of the exposure, which
    // is what the frame's timestamp actually refers to.
    const tipRadius = Math.max(baseTipRadius, speed * 0.5);
    const refined = refineAround(mask, mag, w, h, best.tip.x, best.tip.y, tipRadius)
      || best.tip;

    // Confidence feeds the smoother's weighting, so it needs to mean something:
    // how well the point continued the previous motion, and how much moved.
    let conf = clamp(Math.log1p(best.b.weight / 255) / 6, 0.1, 1);
    if (pred) conf *= clamp(1 - best.jump / maxJump, 0.05, 1);
    if (offFrame) conf *= 0.3;

    if (prev) {
      vel = {
        x: (refined.x - prev.x) * 0.6 + vel.x * 0.4,
        y: (refined.y - prev.y) * 0.6 + vel.y * 0.4,
      };
    }
    prev = refined;
    track.push({ i, p: refined, conf, offFrame });
  }
  return track;
}

/**
 * Turn raw detections into the single smooth arc a swing actually traces.
 *
 * A club head cannot teleport, so any detection that disagrees sharply with its
 * neighbours is wrong rather than interesting. Each point is refitted from a
 * local weighted quadratic, the points that disagree with that fit by more than
 * a few robust deviations are thrown out, and the fit is repeated without them.
 * Three passes is enough to shed the odd frame where the tracker latched onto a
 * shadow, a second golfer, or the ball.
 *
 * Returns positions plus a per-point `ok` flag: where support runs out the
 * answer is nothing at all, because a line drawn through a gap is a guess the
 * viewer cannot tell from a measurement.
 */
export function smoothTrack(track, {
  half = 3, iterations = 3, rejectAt = 2.5, absFloor = 3, maxHalf = 8,
} = {}) {
  const n = track.length;
  const rawX = new Float64Array(n);
  const rawY = new Float64Array(n);
  const weight = new Float64Array(n);
  let present = 0;
  for (let i = 0; i < n; i++) {
    const t = track[i];
    if (t && t.p) {
      rawX[i] = t.p.x;
      rawY[i] = t.p.y;
      weight[i] = Math.max(0.05, t.conf || 0.5);
      present++;
    }
  }

  let outX = Float64Array.from(rawX);
  let outY = Float64Array.from(rawY);
  const valid = new Uint8Array(n);
  // Never discard more than a fifth of what was found. Beyond that the fit is
  // no longer correcting the data, it is replacing it.
  const rejectionBudget = Math.floor(present * 0.2);
  let rejected = 0;

  for (let pass = 0; pass < iterations; pass++) {
    const nextX = new Float64Array(n);
    const nextY = new Float64Array(n);
    valid.fill(0);
    for (let i = 0; i < n; i++) {
      // Start tight. Widen only where the track is sparse, so a short gap gets
      // bridged by the arc either side of it while dense stretches stay
      // faithful to their own frames.
      let h = half;
      let ts = [];
      let xs = [];
      let ys = [];
      let ws = [];
      let before = 0;
      let after = 0;
      for (;;) {
        ts = []; xs = []; ys = []; ws = []; before = 0; after = 0;
        for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) {
          if (weight[j] <= 0) continue;
          ts.push(j - i); xs.push(rawX[j]); ys.push(rawY[j]); ws.push(weight[j]);
          if (j < i) before++;
          else if (j > i) after++;
        }
        if (ts.length >= 5 || h >= maxHalf) break;
        h += 2;
      }
      // A quadratic through three points fits them exactly and means nothing,
      // and a widened window must bracket the gap rather than run off the end
      // of the track.
      if (ts.length < 4) continue;
      if (h > half && (before < 2 || after < 2)) continue;
      const fx = quadFit(ts, xs, ws);
      const fy = quadFit(ts, ys, ws);
      if (!fx || !fy) continue;
      nextX[i] = fx.value;
      nextY[i] = fy.value;
      valid[i] = 1;
    }
    outX = nextX;
    outY = nextY;

    if (pass === iterations - 1 || rejected >= rejectionBudget) break;

    const residuals = [];
    for (let i = 0; i < n; i++) {
      if (!valid[i] || weight[i] <= 0) continue;
      residuals.push({ i, r: Math.hypot(rawX[i] - outX[i], rawY[i] - outY[i]) });
    }
    if (residuals.length < 6) break;
    const sorted = residuals.map((e) => e.r).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const spread = sorted.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
    const mad = spread[Math.floor(spread.length / 2)] || 1e-6;
    // The absolute floor is what stops a good track eating itself: when every
    // point sits within a pixel of the curve the robust spread collapses, and a
    // purely relative threshold then starts throwing away the places where the
    // arc genuinely bends fastest.
    const limit = Math.max(median + rejectAt * 1.4826 * mad, absFloor);
    // Worst first, so the budget is spent on the points that deserve it.
    residuals.sort((a, b) => b.r - a.r);
    for (const { i, r } of residuals) {
      if (rejected >= rejectionBudget) break;
      if (r <= limit) break;
      weight[i] = 0;
      rejected++;
    }
  }

  const points = [];
  for (let i = 0; i < n; i++) {
    points.push(valid[i] ? { x: outX[i], y: outY[i] } : null);
  }
  points.rejected = rejected;
  return points;
}

/** Kept for callers that only want positions. */
export function cleanTrack(track, smoothHalf = 3, absFloor = 3) {
  return smoothTrack(track, { half: Math.max(2, smoothHalf), absFloor });
}

/** Frame-to-frame speed of the club head, in analysis pixels per second. */
export function clubSpeedSeries(points, times, offset) {
  const speed = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dt = times[offset + i] - times[offset + i - 1];
    if (!a || !b || !(dt > 0)) continue;
    speed[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }
  return smooth(speed, 1);
}



/**
 * Algebraic circle fit through arc points. The club head genuinely travels on a
 * near-circle around the golfer, so fitting that circle and taking its tangent
 * at the ball gives the delivery direction without the bias a straight-line or
 * polynomial fit picks up from the curvature it is ignoring.
 */
function fitCircle(pts) {
  const n = pts.length;
  if (n < 5) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my, z = u * u + v * v;
    sxx += u * u; sxy += u * v; syy += v * v; sxz += u * z; syz += v * z;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-9) return null;
  const uc = (syy * sxz - sxy * syz) / (2 * det);
  const vc = (sxx * syz - sxy * sxz) / (2 * det);
  const cx = uc + mx, cy = vc + my;
  let r = 0;
  for (const p of pts) r += Math.hypot(p.x - cx, p.y - cy);
  r /= n;
  let rms = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - cx, p.y - cy) - r;
    rms += d * d;
  }
  rms = Math.sqrt(rms / n);
  return { cx, cy, r, rms };
}

/**
 * Weighted least-squares quadratic through (t, v), returning the fitted value
 * and slope at t = 0. Fitting a curve and reading it at a point is far steadier
 * than measuring between two samples: at 240fps a club head still moves close to
 * twenty centimetres from one frame to the next.
 */
function quadFit(ts, vs, ws) {
  const n = ts.length;
  if (n < 3) return null;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    const v = vs[i];
    const wt = ws ? ws[i] : 1;
    if (wt <= 0) continue;
    const t2 = t * t;
    s0 += wt; s1 += wt * t; s2 += wt * t2; s3 += wt * t2 * t; s4 += wt * t2 * t2;
    b0 += wt * v; b1 += wt * v * t; b2 += wt * v * t2;
  }
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-12) return null;
  const d0 = b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - s3 * b2) + s2 * (b1 * s3 - s2 * b2);
  const d1 = s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - b1 * s2);
  return { value: d0 / det, slope: d1 / det };
}

function quadraticSlope(ts, vs) {
  const fit = quadFit(ts, vs, null);
  return fit ? { slope: fit.slope } : null;
}

/**
 * Angle of a fitted run of arc points, in degrees from horizontal, measured so
 * that a steeper (more upright) segment reads as a larger number.
 */
function segmentAngle(points) {
  const usable = points.filter(Boolean);
  if (usable.length < 4) return null;
  const fit = fitLine(usable);
  if (!fit || fit.r2 < 0.6) return null;
  const a = Math.abs(deg(Math.atan2(fit.dirY, fit.dirX)));
  return { angle: a > 90 ? 180 - a : a, r2: fit.r2, n: usable.length };
}

/**
 * The shaft plane is only comparable between backswing and downswing if both
 * are measured at the same place in the swing. Fitting "the middle of the
 * backswing" against "the middle of the downswing" compares different parts of
 * a curve and reports a difference even for a perfectly symmetrical swing, so
 * instead take the band of heights between roughly hip and shoulder and fit
 * whatever passes through it on the way up and on the way down.
 */
function planeInBand(points, from, to, yLow, yHigh) {
  const band = [];
  for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) {
    const p = points[i];
    if (p && p.y >= yLow && p.y <= yHigh) band.push(p);
  }
  return segmentAngle(band);
}

/** Median gap between captured frames, in clip seconds. */
function medianStep(times, from, to) {
  const gaps = [];
  for (let i = from + 1; i <= to && i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1e-6) gaps.push(d);
  }
  if (!gaps.length) return 1 / 30;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Derive the geometric measurements from a cleaned track.
 * `idx` holds track-relative indices for the swing events; `factor` is the
 * slow-motion stretch, needed because every window here is a span of real time
 * and a frame is worth eight times less of it on a 240fps clip.
 */
export function clubMetrics(points, times, offset, idx, handed, factor = 1) {
  const out = {};
  const step = medianStep(times, offset, offset + points.length - 1);
  // Frames covering a given number of real seconds.
  const framesFor = (seconds) => clamp(Math.round((seconds * factor) / step), 2, Math.max(2, Math.round(points.length * 0.2)));

  // The club is momentarily still at the top, so the frame differencing can
  // lose it there; take the extremes of the tracked arc rather than trusting any
  // single frame to be present.
  const extreme = (from, to, pick) => {
    let best = null;
    for (let i = Math.max(0, from); i <= Math.min(points.length - 1, to); i++) {
      const p = points[i];
      if (!p) continue;
      if (best === null || pick(p.y, best)) best = p.y;
    }
    return best;
  };
  const yTop = extreme(idx.address, idx.top, (y, b) => y < b);
  const yBall = extreme(Math.max(0, idx.top), idx.impact, (y, b) => y > b);

  // Shaft plane, compared over a common height band.
  if (yTop != null && yBall != null && yBall - yTop > 4) {
    const yLow = yTop + 0.45 * (yBall - yTop);
    const yHigh = yTop + 0.9 * (yBall - yTop);
    const back = planeInBand(points, idx.address, idx.top, Math.min(yLow, yHigh), Math.max(yLow, yHigh));
    const down = planeInBand(points, idx.top, idx.impact, Math.min(yLow, yHigh), Math.max(yLow, yHigh));
    out.backswingPlaneDeg = back ? back.angle : null;
    out.downswingPlaneDeg = down ? down.angle : null;
    out.planeShiftDeg = back && down ? down.angle - back.angle : null;
    out.planeFitQuality = Math.min(back ? back.r2 : 0, down ? down.r2 : 0);
    out.planeDebug = {
      yLow: Math.min(yLow, yHigh), yHigh: Math.max(yLow, yHigh), yTop, yBall,
      backN: back ? back.n : 0, downN: down ? down.n : 0,
    };
  } else {
    out.planeFitQuality = 0;
  }

  // The club head sweeps a circle around the golfer. Fitting that circle over
  // the whole delivery — not the few frames at the ball, where a short arc
  // barely constrains a centre — gives a stable curve to take the tangent from.
  const arcFrom = clamp(idx.top + Math.round((idx.impact - idx.top) * 0.35), 0, points.length - 1);
  const arcTo = clamp(idx.impact + framesFor(0.06), 0, points.length - 1);
  const arcPts = [];
  for (let i = arcFrom; i <= arcTo; i++) if (points[i]) arcPts.push(points[i]);
  out.arc = fitCircle(arcPts);

  Object.assign(out, deliveryMetrics(points, times, offset, idx.impact, handed, framesFor, out.arc));

  // Low point of the arc: the deepest point within about a tenth of a second
  // of real time either side of impact.
  const loSpan = framesFor(0.09);
  const loA = clamp(idx.impact - loSpan, 0, points.length - 1);
  const loB = clamp(idx.impact + loSpan, 0, points.length - 1);
  let lowIdx = null;
  let lowY = -Infinity;
  for (let i = loA; i <= loB; i++) {
    if (points[i] && points[i].y > lowY) { lowY = points[i].y; lowIdx = i; }
  }
  out.lowPointIndex = lowIdx;
  out.lowPoint = lowIdx != null ? points[lowIdx] : null;

  const speed = clubSpeedSeries(points, times, offset);
  let peak = 0;
  const sA = clamp(idx.impact - framesFor(0.05), 0, speed.length - 1);
  const sB = clamp(idx.impact + framesFor(0.02), 0, speed.length - 1);
  for (let i = sA; i <= sB; i++) peak = Math.max(peak, speed[i]);
  out.peakSpeedPxPerSec = Math.max(peak, out.impactSpeedPxPerSec || 0);
  out.speedSeries = speed;

  // How much of the swing we actually managed to follow.
  const tracked = points.filter(Boolean).length;
  out.trackCoverage = points.length ? tracked / points.length : 0;

  return out;
}

/**
 * Direction, steepness and speed of the club at one moment of the arc.
 *
 * Both x and y are fitted as curves against time and the tangent taken at the
 * chosen frame. The window is deliberately narrow — a club head covers about a
 * metre of arc in twenty-five milliseconds, so anything wider stops measuring
 * the delivery and starts measuring the whole swing.
 */
export function deliveryMetrics(points, times, offset, atIndex, handed, framesFor, arc = null) {
  const out = {};
  const span = Math.max(4, framesFor(0.02));
  const wa = clamp(atIndex - span, 0, points.length - 1);
  const wb = clamp(atIndex + span, 0, points.length - 1);
  const t0 = times[offset + atIndex];
  const ts = [];
  const xs = [];
  const ys = [];
  for (let i = wa; i <= wb; i++) {
    const p = points[i];
    if (!p) continue;
    ts.push(times[offset + i] - t0);
    xs.push(p.x);
    ys.push(p.y);
  }
  out.deliveryPoints = ts.length;
  const fx = quadraticSlope(ts, xs);
  const fy = quadraticSlope(ts, ys);
  if (!fx || !fy) {
    out.impactDirectionDeg = null;
    out.attackAngleDeg = null;
    out.travelSignX = 0;
    return out;
  }
  let vx = fx.slope;   // clip pixels per clip second
  let vy = fy.slope;

  // Prefer the tangent to a fitted arc where the fit is good: it uses every
  // point in the window rather than the two ends, and it does not flatten the
  // delivery towards the average slope the way a wide polynomial fit does.
  const here = points[atIndex];
  // Callers that measure the whole delivery pass in an arc fitted over it,
  // which is better conditioned; on its own, fall back to fitting the window.
  const localArc = arc || fitCircle(xs.map((x, i) => ({ x, y: ys[i] })));
  const arcGood = Boolean(localArc) && localArc.rms < localArc.r * 0.04 && localArc.r > 6;
  out.arcGood = arcGood;
  if (arcGood && here) {
    const rx = here.x - localArc.cx;
    const ry = here.y - localArc.cy;
    const rn = Math.hypot(rx, ry) || 1;
    let tx = -ry / rn;
    let ty = rx / rn;
    // Orient the tangent along the direction the club is actually travelling.
    if (tx * vx + ty * vy < 0) { tx = -tx; ty = -ty; }
    const speed = Math.hypot(vx, vy);
    vx = tx * speed;
    vy = ty * speed;
    out.arcRadiusPx = localArc.r;
    out.arcFitRms = localArc.rms;
  }

  const sign = handed === 'left' ? -1 : 1;
  out.impactDirectionDeg = deg(Math.atan2(sign * vx, Math.abs(vy) + 1e-6));
  // Which way along the screen the club is travelling through the ball. On a
  // face-on view that is the target direction, whichever side the phone is on,
  // so it beats assuming from handedness.
  out.travelSignX = Math.abs(vx) > 1e-3 ? Math.sign(vx) : 0;
  // Slope of travel across the ball: negative is descending.
  out.attackAngleDeg = Math.abs(vx) > Math.abs(vy) * 0.05
    ? -deg(Math.atan2(vy, Math.abs(vx)))
    : null;
  out.impactSpeedPxPerSec = Math.hypot(vx, vy);
  out.strikeIndex = atIndex;
  // How the club arrives is read off the fitted arc. Without a clean arc there
  // is no tangent worth quoting: the same swing would come back as four degrees
  // descending on one reading and twenty ascending on the next, and a number
  // that unstable is worse than none.
  if (!arcGood) {
    out.attackAngleDeg = null;
    out.impactDirectionDeg = null;
  }
  return out;
}

/**
 * Frames covering a given number of real seconds, for a track sampled at
 * `step` clip-seconds a frame and stretched by `factor`.
 */
export function framesForFactory(times, offset, length, factor) {
  const step = medianStep(times, offset, offset + length - 1);
  return (seconds) => clamp(Math.round((seconds * factor) / step), 2, Math.max(2, Math.round(length * 0.2)));
}

/**
 * The frame at which the club actually reaches the ball.
 *
 * The energy peak places impact to within a few frames, which at 240fps is a
 * good ten degrees of arc — enough to turn a four-degree descending strike into
 * a fifteen-degree chop. The club head sweeps a circle around the golfer, and
 * the closest point of that circle to the ball lies on the radius through it,
 * so the tracked point nearest the ball is the one delivered to it.
 */
export function strikeIndexFromBall(points, energyImpact, ball, framesFor) {
  if (!ball) return null;
  const span = framesFor(0.09);
  const a = clamp(energyImpact - span, 0, points.length - 1);
  const b = clamp(energyImpact + span, 0, points.length - 1);
  let best = null;
  let bestD = Infinity;
  for (let i = a; i <= b; i++) {
    const p = points[i];
    if (!p) continue;
    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
