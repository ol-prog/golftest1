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
export function trackBall(gray, w, h, impactIdx, origin, threshold, maxFrames = 10) {
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
export function launchFromPath(path, view, handed, effectiveFps, pxPerCm) {
  if (path.length < 3) {
    return { ok: false, reason: 'The ball moved out of frame too quickly to measure.' };
  }
  const fit = fitLine(path.map((p) => ({ x: p.x, y: p.y })));
  if (!fit || fit.r2 < 0.9) {
    return { ok: false, reason: 'The ball flight was too short to measure a reliable line.' };
  }
  // Orient the fitted direction along actual travel.
  let dx = fit.dirX;
  let dy = fit.dirY;
  const travelX = path[path.length - 1].x - path[0].x;
  const travelY = path[path.length - 1].y - path[0].y;
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
    const first = path[0];
    const last = path[path.length - 1];
    const frames = last.i - first.i;
    if (frames > 0) {
      const pxPerFrame = Math.hypot(last.x - first.x, last.y - first.y) / frames;
      const cmPerSec = (pxPerFrame / pxPerCm) * effectiveFps;
      out.ballSpeedMph = (cmPerSec / 100) * 2.23694;
    }
  }
  return out;
}
