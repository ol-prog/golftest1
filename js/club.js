// Tracking the club head through the swing.
//
// The club head is the fastest-moving, furthest-from-the-body part of the
// picture, so for each frame we take the moving pixels that are furthest from
// the golfer's centre and weight them towards the extremity. A continuity gate
// stops the track jumping to a passing golfer or a flapping flag.

import { diff } from './motion.js';
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
  const maxJump = Math.max(12, Math.hypot(w, h) * 0.22);

  for (let i = Math.max(1, from); i <= to; i++) {
    const { mask, count } = diff(gray[i - 1], gray[i], w, h, threshold);
    if (count < 4) {
      track.push({ i, p: null, conf: 0 });
      prev = null;
      continue;
    }

    // Pass 1: how far does the motion reach from the body?
    let maxD = 0;
    for (let y = 0, idx = 0; y < h; y++) {
      const dy = y - body.y;
      for (let x = 0; x < w; x++, idx++) {
        if (!mask[idx]) continue;
        const dx = x - body.x;
        const d = dx * dx + dy * dy;
        if (d > maxD) maxD = d;
      }
    }
    maxD = Math.sqrt(maxD);
    if (maxD < 4) {
      track.push({ i, p: null, conf: 0 });
      continue;
    }

    // Pass 2: weighted centroid of the outer shell of the motion, which is the
    // club head (and the last stretch of shaft attached to it).
    const shell = maxD * 0.72;
    const pred = prev ? { x: prev.x + vel.x, y: prev.y + vel.y } : null;
    let sw = 0, sx = 0, sy = 0, sn = 0;
    let gatedSw = 0, gatedSx = 0, gatedSy = 0, gatedN = 0;
    let onEdge = 0;
    for (let y = 0, idx = 0; y < h; y++) {
      const dy = y - body.y;
      for (let x = 0; x < w; x++, idx++) {
        if (!mask[idx]) continue;
        const dx = x - body.x;
        const d = Math.hypot(dx, dy);
        if (d < shell) continue;
        if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2) onEdge++;
        const wgt = d * d;
        sw += wgt; sx += x * wgt; sy += y * wgt; sn++;
        if (pred) {
          const jump = Math.hypot(x - pred.x, y - pred.y);
          if (jump < maxJump) {
            gatedSw += wgt; gatedSx += x * wgt; gatedSy += y * wgt; gatedN++;
          }
        }
      }
    }

    let p = null;
    let conf = 0;
    // When the club swings out of shot the outer edge of the motion is the
    // frame border, and following it would draw a rectangle rather than a
    // swing. Better to report nothing for those frames.
    if (sn > 0 && onEdge / sn > 0.15) {
      track.push({ i, p: null, conf: 0, offFrame: true });
      prev = null;
      vel = { x: 0, y: 0 };
      continue;
    }
    if (gatedN >= 3) {
      p = { x: gatedSx / gatedSw, y: gatedSy / gatedSw };
      conf = clamp(gatedN / Math.max(1, sn), 0.25, 1);
    } else if (sn >= 3) {
      // Nothing near the prediction: accept the raw extremity but mark it down,
      // and reset the velocity so one bad frame does not poison the next.
      p = { x: sx / sw, y: sy / sw };
      conf = pred ? 0.2 : 0.6;
      vel = { x: 0, y: 0 };
    }

    if (p) {
      if (prev) {
        vel = { x: (p.x - prev.x) * 0.7 + vel.x * 0.3, y: (p.y - prev.y) * 0.7 + vel.y * 0.3 };
      }
      prev = p;
    }
    track.push({ i, p, conf });
  }
  return track;
}

/** Fill short gaps and lightly smooth the track so angles are not noise-driven. */
export function cleanTrack(track, smoothHalf = 1) {
  const pts = track.map((t) => (t.p ? { ...t.p } : null));
  // Linear interpolation across gaps of up to 4 frames.
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]) continue;
    let a = i - 1;
    while (a >= 0 && !pts[a]) a--;
    let b = i + 1;
    while (b < pts.length && !pts[b]) b++;
    if (a < 0 || b >= pts.length || b - a > 5) continue;
    const t = (i - a) / (b - a);
    pts[i] = { x: pts[a].x + (pts[b].x - pts[a].x) * t, y: pts[a].y + (pts[b].y - pts[a].y) * t };
  }
  const xs = smooth(pts.map((p) => (p ? p.x : NaN)), smoothHalf);
  const ys = smooth(pts.map((p) => (p ? p.y : NaN)), smoothHalf);
  return pts.map((p, i) => (p && Number.isFinite(xs[i]) ? { x: xs[i], y: ys[i] } : null));
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
 * Least-squares quadratic through (t, v), returning the value and slope at
 * t = 0. Fitting a curve and taking its tangent is far steadier than measuring
 * the chord between two frames: at 240fps a club head still moves close to
 * twenty centimetres between one frame and the next.
 */
function quadraticSlope(ts, vs) {
  const n = ts.length;
  if (n < 3) return null;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i], v = vs[i];
    const t2 = t * t;
    s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
    b0 += v; b1 += v * t; b2 += v * t2;
  }
  // Solve the 3x3 normal equations by Cramer's rule.
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-12) return null;
  const d1 = s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - b1 * s2);
  return { slope: d1 / det };
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
  if (arc && here && arc.rms < arc.r * 0.04 && arc.r > 6) {
    const rx = here.x - arc.cx;
    const ry = here.y - arc.cy;
    const rn = Math.hypot(rx, ry) || 1;
    let tx = -ry / rn;
    let ty = rx / rn;
    // Orient the tangent along the direction the club is actually travelling.
    if (tx * vx + ty * vy < 0) { tx = -tx; ty = -ty; }
    const speed = Math.hypot(vx, vy);
    vx = tx * speed;
    vy = ty * speed;
    out.arcRadiusPx = arc.r;
    out.arcFitRms = arc.rms;
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
