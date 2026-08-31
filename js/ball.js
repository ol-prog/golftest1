// Ball detection and launch measurement.
//
// The ball is found by exploiting the one thing that is certain about it: it is
// sitting still and bright before impact, and gone immediately after. Tracking
// it afterwards only works on high frame-rate footage — at 30fps the ball
// crosses the whole frame between two frames — so everything here reports a
// confidence and the caller is expected to hide low-confidence results.

import { diff, blobs } from './motion.js';
import { clamp, deg, fitLine } from './util.js';

/**
 * Locate the ball at rest, by differencing a frame from just before impact
 * against one from after the ball has gone. We keep only small, compact regions
 * that got noticeably darker (white ball replaced by grass or mat).
 */
export function findBallAtRest(grayPre, grayPost, w, h, near, threshold, searchRadius) {
  const searchR = searchRadius || Math.max(20, w * 0.18);
  const mask = new Uint8Array(w * h);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (near && Math.hypot(x - near.x, y - near.y) > searchR) continue;
      const drop = grayPre[i] - grayPost[i];
      // Brighter before than after, and bright in absolute terms.
      if (drop > threshold && grayPre[i] > 110) mask[i] = 1;
    }
  }
  const found = blobs(mask, w, h, 3);
  if (!found.length) return null;

  const maxSide = Math.max(4, w * 0.06);
  let best = null;
  let bestScore = -Infinity;
  for (const b of found) {
    if (b.w > maxSide || b.h > maxSide) continue;
    const aspect = Math.min(b.w, b.h) / Math.max(b.w, b.h);
    const fill = b.n / Math.max(1, b.w * b.h);
    const nearness = near ? 1 - clamp(Math.hypot(b.cx - near.x, b.cy - near.y) / searchR, 0, 1) : 0.5;
    // Round, solid, and close to where the club bottomed out.
    const score = aspect * 1.2 + fill + nearness * 1.5;
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!best) return null;
  return {
    x: best.cx,
    y: best.cy,
    radiusPx: Math.max(best.w, best.h) / 2,
    confidence: clamp((bestScore - 1.2) / 2.2, 0, 1),
  };
}

/**
 * Follow the ball for the first few frames after impact.
 * Returns the sampled positions, which the caller turns into a launch vector.
 */
export function trackBall(gray, w, h, impactIdx, origin, threshold, maxFrames = 30) {
  const path = [{ x: origin.x, y: origin.y, i: impactIdx }];
  let prev = { x: origin.x, y: origin.y };
  let dir = null;
  const maxSide = Math.max(5, w * 0.07);

  for (let k = 1; k <= maxFrames; k++) {
    const i = impactIdx + k;
    if (i >= gray.length) break;
    const { mask } = diff(gray[i - 1], gray[i], w, h, threshold);
    const found = blobs(mask, w, h, 3);
    let best = null;
    let bestScore = -Infinity;
    for (const b of found) {
      if (b.w > maxSide || b.h > maxSide) continue;
      const dx = b.cx - prev.x;
      const dy = b.cy - prev.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.5) continue;
      // Once we have a direction, the ball must keep going that way.
      let straightness = 0.5;
      if (dir) {
        const n = Math.hypot(dx, dy) || 1;
        straightness = (dx / n) * dir.x + (dy / n) * dir.y;
        if (straightness < 0.7) continue;
      }
      const aspect = Math.min(b.w, b.h) / Math.max(b.w, b.h);
      const score = straightness * 2 + aspect;
      if (score > bestScore) { bestScore = score; best = { x: b.cx, y: b.cy, dist, dx, dy }; }
    }
    if (!best) break;
    const n = best.dist || 1;
    dir = { x: best.dx / n, y: best.dy / n };
    path.push({ x: best.x, y: best.y, i });
    prev = { x: best.x, y: best.y };
  }
  return path;
}

/**
 * Turn a ball path into a launch measurement.
 * `angle` is the camera view: from face-on we read a launch angle above the
 * horizontal; from down-the-line we read a start line left or right of vertical.
 */
export function launchFromPath(path, view, handed, effectiveFps, pxPerCm, measureCount = 10) {
  if (path.length < 3) {
    return { ok: false, reason: 'The ball moved out of frame too quickly to measure.' };
  }
  // Measure from the first stretch of flight only. Following the ball further
  // makes a better-looking tracer, but gravity has started bending the flight by
  // then and would drag the launch angle down.
  const measured = path.slice(0, Math.max(3, measureCount));
  const fit = fitLine(measured.map((p) => ({ x: p.x, y: p.y })));
  if (!fit || fit.r2 < 0.9) {
    return { ok: false, reason: 'The ball flight was too short to measure a reliable line.' };
  }
  // Orient the fitted direction along actual travel.
  let dx = fit.dirX;
  let dy = fit.dirY;
  const travelX = measured[measured.length - 1].x - measured[0].x;
  const travelY = measured[measured.length - 1].y - measured[0].y;
  if (dx * travelX + dy * travelY < 0) { dx = -dx; dy = -dy; }

  const out = { ok: true, points: path, r2: fit.r2 };
  const sign = handed === 'left' ? -1 : 1;

  if (view === 'faceon') {
    // Screen y grows downward, so a rising ball has negative dy.
    out.launchAngleDeg = deg(Math.atan2(-dy, Math.abs(dx)));
  } else {
    // Down the line, sideways movement off vertical is the start line.
    out.startLineDeg = deg(Math.atan2(sign * dx, -dy));
  }

  // Ball speed, if we know both the scale and the real frame interval.
  if (pxPerCm && effectiveFps) {
    const first = measured[0];
    const last = measured[measured.length - 1];
    const frames = last.i - first.i;
    if (frames > 0) {
      const pxPerFrame = Math.hypot(last.x - first.x, last.y - first.y) / frames;
      const cmPerSec = (pxPerFrame / pxPerCm) * effectiveFps;
      out.ballSpeedMph = (cmPerSec / 100) * 2.23694;
    }
  }
  return out;
}

/**
 * Fit the ball flight and extend it to the edge of the picture.
 *
 * A struck ball is a projectile, so in a level-camera view its path is a
 * parabola. Fitting that shape does two things a polyline through detections
 * cannot: it smooths away the frame-to-frame wobble of finding a small fast
 * object, and it lets the line carry on past the last frame the ball was
 * visible in — which is what makes a broadcast tracer read as a shot rather
 * than a few dots.
 *
 * Returns points in pixel coordinates, each with the clip time at which the
 * ball reaches it, so the tracer can draw it in step with playback.
 */
export function flightCurve(path, w, h, samples = 64) {
  const pts = path.filter((p) => p && Number.isFinite(p.t));
  if (pts.length < 3) return null;

  const first = pts[0];
  const last = pts[pts.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  // Fit against whichever axis the ball actually travels along, so a shot that
  // climbs almost vertically up the frame is as well behaved as one across it.
  const alongX = Math.abs(dx) >= Math.abs(dy);
  const us = pts.map((p) => (alongX ? p.x : p.y));
  const vs = pts.map((p) => (alongX ? p.y : p.x));

  const n = us.length;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
  const u0 = us[0];
  for (let i = 0; i < n; i++) {
    const u = us[i] - u0;
    const v = vs[i];
    const u2 = u * u;
    s1 += u; s2 += u2; s3 += u2 * u; s4 += u2 * u2;
    b0 += v; b1 += v * u; b2 += v * u2;
  }
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-9) return null;
  const c0 = (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - s3 * b2) + s2 * (b1 * s3 - s2 * b2)) / det;
  const c1 = (s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - b1 * s2)) / det;
  const c2 = (s0 * (s2 * b2 - s3 * b1) - s1 * (s1 * b2 - b1 * s2) + b0 * (s1 * s3 - s2 * s2)) / det;

  const at = (u) => {
    const d = u - u0;
    const v = c0 + c1 * d + c2 * d * d;
    return alongX ? { x: u, y: v } : { x: v, y: u };
  };

  // Walk outwards from the last detection until the curve leaves the frame.
  const step = (us[n - 1] - u0) >= 0 ? Math.max(1, w / 90) : -Math.max(1, w / 90);
  let end = us[n - 1];
  const limit = Math.max(w, h) * 2;
  for (let guard = 0; guard < limit; guard++) {
    const next = end + step;
    const p = at(next);
    if (p.x < -2 || p.x > w + 2 || p.y < -2 || p.y > h + 2) break;
    end = next;
  }

  const out = [];
  for (let i = 0; i <= samples; i++) {
    const u = u0 + ((end - u0) * i) / samples;
    out.push(at(u));
  }

  // Time along the curve: the ball covers ground at very nearly constant speed
  // over the short stretch we can see, so distance travelled maps linearly onto
  // time, fitted from the detections and carried on past them.
  const dist = [0];
  for (let i = 1; i < out.length; i++) {
    dist.push(dist[i - 1] + Math.hypot(out[i].x - out[i - 1].x, out[i].y - out[i - 1].y));
  }
  const nearestDist = (p) => {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < out.length; i++) {
      const d = Math.hypot(out[i].x - p.x, out[i].y - p.y);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return dist[bestI];
  };
  let sd = 0, st = 0, sdd = 0, sdt = 0;
  for (const p of pts) {
    const d = nearestDist(p);
    sd += d; st += p.t; sdd += d * d; sdt += d * p.t;
  }
  const m = pts.length;
  const denom = m * sdd - sd * sd;
  const secondsPerPx = Math.abs(denom) > 1e-9 ? (m * sdt - sd * st) / denom : 0;
  const t0 = (st - secondsPerPx * sd) / m;

  return out.map((p, i) => ({ x: p.x, y: p.y, t: t0 + secondsPerPx * dist[i] }));
}
