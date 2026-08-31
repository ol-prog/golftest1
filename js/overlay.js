// Drawing the analysis back onto the picture: club-head trace, pose skeleton,
// ball, and the motion-energy timeline that the tempo split comes from.
//
// Report coordinates are normalised by frame width, so multiplying by the
// canvas width is all that is ever needed.

const COL = {
  back: '#4cc2ff',
  down: '#ffb020',
  through: '#ff6b6b',
  ball: '#ffffff',
  ballPath: '#7bf1a8',
  pose: '#c9a6ff',
  spine: '#7bf1a8',
  head: '#ffd166',
  body: '#8a8f98',
};

/** Fit an image into a canvas, sizing the canvas to the image's aspect. */
export function sizeCanvasTo(canvas, aspect, cssWidth) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = cssWidth;
  const h = Math.round(cssWidth * aspect);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  return canvas.getContext('2d');
}

/**
 * Trace a polyline as a smooth curve, by running quadratic Beziers through the
 * midpoints of each pair of segments. A swing arc drawn as raw straight
 * segments looks like a scribble however good the underlying points are.
 */
export function smoothPath(ctx, pts) {
  const n = pts.length;
  if (n < 2) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (n === 2) { ctx.lineTo(pts[1].x, pts[1].y); return; }
  for (let i = 1; i < n - 1; i++) {
    ctx.quadraticCurveTo(
      pts[i].x, pts[i].y,
      (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2,
    );
  }
  ctx.quadraticCurveTo(pts[n - 2].x, pts[n - 2].y, pts[n - 1].x, pts[n - 1].y);
}

/**
 * Draw a run of points as one glowing curve. Gaps are breaks, not bridges: a
 * line drawn across frames where the club was never found is a guess, and it
 * should not look like a measurement.
 */
function line(ctx, pts, colour, width, w) {
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (!p) {
      if (run.length > 1) runs.push(run);
      run = [];
      continue;
    }
    run.push({ x: p.x * w, y: p.y * w });
  }
  if (run.length > 1) runs.push(run);

  for (const pass of [0, 1]) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = colour;
    ctx.globalAlpha = pass === 0 ? 0.25 : 1;
    ctx.lineWidth = pass === 0 ? width * 3 : width;
    for (const r of runs) {
      ctx.beginPath();
      smoothPath(ctx, r);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function dot(ctx, p, colour, r, w) {
  ctx.beginPath();
  ctx.fillStyle = colour;
  ctx.arc(p.x * w, p.y * w, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw the club-head trace over a still.
 * `phase` optionally limits the trace to 'back' | 'down' | 'all'.
 */
export function drawTrace(ctx, image, report, { phase = 'all', showPose = null, showBall = true } = {}) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (image) ctx.drawImage(image, 0, 0, w, h);

  const trace = report.trace;
  if (!trace) return;
  const { idx, points } = trace;
  const stroke = Math.max(2, w / 190);

  const backSeg = points.slice(Math.max(0, idx.address), idx.top + 1);
  const downSeg = points.slice(idx.top, idx.impact + 1);
  const thruSeg = points.slice(idx.impact, Math.min(points.length, idx.finish + 1));

  if (phase === 'all' || phase === 'back') line(ctx, backSeg, COL.back, stroke, w);
  if (phase === 'all' || phase === 'down') line(ctx, downSeg, COL.down, stroke * 1.15, w);
  if (phase === 'all') line(ctx, thruSeg, COL.through, stroke * 0.9, w);

  if (showPose && report.poseFrames && report.poseFrames[showPose]) {
    drawPosture(ctx, report.poseFrames[showPose], w, {
      reference: showPose === 'address' ? null : report.poseFrames.address,
      showHeadMove: showPose !== 'address',
    });
  }

  if (showBall && report.ball && report.ball.rest) {
    const b = report.ball.rest;
    ctx.beginPath();
    ctx.strokeStyle = COL.ball;
    ctx.lineWidth = Math.max(1.5, stroke * 0.6);
    ctx.arc(b.x * w, b.y * w, Math.max(4, w / 90), 0, Math.PI * 2);
    ctx.stroke();
    const flight = report.ball.flight || report.ball.path;
    if (flight && flight.length > 1) line(ctx, flight, COL.ballPath, stroke * 0.95, w);
  }

  // Key positions along the arc.
  const key = [
    [idx.address, COL.back],
    [idx.top, COL.back],
    [idx.impact, COL.down],
  ];
  for (const [i, colour] of key) {
    const p = points[i];
    if (p) dot(ctx, p, colour, Math.max(3, stroke * 1.6), w);
  }
}

const LM = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
};

/** A small label chip, so numbers stay readable over grass or sky. */
function chip(ctx, text, x, y, colour, w) {
  const size = Math.max(11, w / 34);
  ctx.font = `600 ${size}px -apple-system, system-ui, sans-serif`;
  const padX = size * 0.45;
  const tw = ctx.measureText(text).width;
  const bx = Math.min(Math.max(x, 2), ctx.canvas.width - tw - padX * 2 - 2);
  const by = Math.min(Math.max(y - size, 2), ctx.canvas.height - size * 1.6 - 2);
  ctx.fillStyle = 'rgba(6,9,14,0.72)';
  ctx.beginPath();
  const bw = tw + padX * 2;
  const bh = size * 1.5;
  // roundRect is recent; fall back to a plain box rather than throwing.
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, size * 0.35);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill();
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + size * 0.78);
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });

function seg(ctx, a, b, colour, width, w, dashed = false) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (dashed) ctx.setLineDash([width * 2.2, width * 2]);
  ctx.beginPath();
  ctx.moveTo(a.x * w, a.y * w);
  ctx.lineTo(b.x * w, b.y * w);
  ctx.stroke();
  ctx.restore();
}

/**
 * Body position as the handful of lines a coach would actually draw on a still:
 * the spine, the shoulder and hip lines, and where the head has moved to. A
 * thirty-three point skeleton looks impressive and tells you nothing you can
 * act on.
 *
 * `reference` is the same golfer at address, so the change can be shown rather
 * than just the current position.
 */
export function drawPosture(ctx, landmarks, w, { reference = null, showHeadMove = false } = {}) {
  if (!landmarks) return;
  const p = (i) => landmarks[i];
  const visible = (...idx) => idx.every((i) => p(i) && p(i).v > 0.35);
  const stroke = Math.max(2, w / 220);

  if (visible(LM.leftShoulder, LM.rightShoulder, LM.leftHip, LM.rightHip)) {
    const sh = mid(p(LM.leftShoulder), p(LM.rightShoulder));
    const hip = mid(p(LM.leftHip), p(LM.rightHip));

    // Vertical through the hips: the reference the spine angle is measured off.
    seg(ctx, { x: hip.x, y: hip.y }, { x: hip.x, y: hip.y - 0.42 }, 'rgba(233,237,243,0.4)', stroke * 0.8, w, true);

    // Shoulder and hip lines.
    seg(ctx, p(LM.leftShoulder), p(LM.rightShoulder), COL.pose, stroke * 1.4, w);
    seg(ctx, p(LM.leftHip), p(LM.rightHip), COL.pose, stroke * 1.4, w);

    // The spine itself.
    seg(ctx, hip, sh, COL.spine, stroke * 2, w);

    const tilt = Math.atan2(sh.x - hip.x, Math.max(1e-6, hip.y - sh.y)) * 180 / Math.PI;
    chip(ctx, `spine ${tilt >= 0 ? '' : '−'}${Math.abs(tilt).toFixed(0)}°`,
      hip.x * w + stroke * 4, (hip.y + sh.y) / 2 * w, COL.spine, w);

    // The same spine at address, ghosted in place, so a change of posture is
    // visible rather than something to remember between screens.
    if (reference) {
      const rsh = mid(reference[LM.leftShoulder], reference[LM.rightShoulder]);
      const rhip = mid(reference[LM.leftHip], reference[LM.rightHip]);
      const anchored = {
        x: hip.x + (rsh.x - rhip.x),
        y: hip.y + (rsh.y - rhip.y),
      };
      seg(ctx, hip, anchored, 'rgba(233,237,243,0.55)', stroke * 1.2, w, true);
    }
  }

  if (visible(LM.leftKnee, LM.rightKnee, LM.leftAnkle, LM.rightAnkle)) {
    seg(ctx, p(LM.leftHip), p(LM.leftKnee), COL.pose, stroke, w);
    seg(ctx, p(LM.leftKnee), p(LM.leftAnkle), COL.pose, stroke, w);
    seg(ctx, p(LM.rightHip), p(LM.rightKnee), COL.pose, stroke, w);
    seg(ctx, p(LM.rightKnee), p(LM.rightAnkle), COL.pose, stroke, w);
  }

  // Head: where it is, and how far it has travelled from address.
  if (p(LM.nose) && p(LM.nose).v > 0.35) {
    const head = p(LM.nose);
    ctx.save();
    ctx.strokeStyle = COL.head;
    ctx.lineWidth = stroke * 1.3;
    ctx.beginPath();
    ctx.arc(head.x * w, head.y * w, Math.max(6, w / 40), 0, Math.PI * 2);
    ctx.stroke();
    if (showHeadMove && reference && reference[LM.nose] && reference[LM.nose].v > 0.35) {
      const from = reference[LM.nose];
      seg(ctx, from, head, COL.head, stroke, w, true);
      const moved = Math.hypot(head.x - from.x, head.y - from.y);
      if (moved > 0.01) {
        chip(ctx, 'head moved', head.x * w + w / 30, head.y * w - w / 30, COL.head, w);
      }
    }
    ctx.restore();
  }
}

/**
 * The motion-energy timeline. This is the evidence behind the tempo split, so
 * showing it lets the golfer sanity-check where "top" and "impact" landed.
 */
export function drawEnergy(canvas, report, cssWidth) {
  const height = 96;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const e = report.energy;
  if (!e || !e.values || e.values.length < 3) return;
  const vals = e.values;
  const max = Math.max(...vals) || 1;
  const pad = 8 * dpr;

  const xAt = (i) => pad + (i / (vals.length - 1)) * (w - pad * 2);
  const yAt = (v) => h - pad - (v / max) * (h - pad * 2);

  // Shade the backswing and downswing so the ratio is visible, not just stated.
  const shade = (a, b, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(xAt(a), pad * 0.5, Math.max(1, xAt(b) - xAt(a)), h - pad);
  };
  shade(e.idx.address, e.idx.top, 'rgba(76,194,255,0.16)');
  shade(e.idx.top, e.idx.impact, 'rgba(255,176,32,0.20)');

  ctx.beginPath();
  ctx.lineWidth = Math.max(1.2, dpr);
  ctx.strokeStyle = 'rgba(233,237,243,0.85)';
  vals.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const marks = [
    [e.idx.address, 'Address', COL.back],
    [e.idx.top, 'Top', COL.back],
    [e.idx.impact, 'Impact', COL.down],
    [e.idx.finish, 'Finish', COL.through],
  ];
  ctx.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  for (const [i, label, colour] of marks) {
    if (i == null || i >= vals.length) continue;
    const x = xAt(i);
    ctx.strokeStyle = colour;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(x, pad * 0.5);
    ctx.lineTo(x, h - pad * 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colour;
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, Math.min(Math.max(x + 3 * dpr, 2), w - tw - 2), 2 * dpr);
  }
}

/** Tiny tempo-trend line for the session list. */
export function drawSparkline(canvas, values, cssWidth, cssHeight = 34) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return;
  const lo = Math.min(...pts, 2.4);
  const hi = Math.max(...pts, 3.6);
  const pad = 4 * dpr;
  const xAt = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const yAt = (v) => h - pad - ((v - lo) / Math.max(1e-6, hi - lo)) * (h - pad * 2);

  // The 3:1 reference line.
  ctx.strokeStyle = 'rgba(123,241,168,0.5)';
  ctx.setLineDash([3 * dpr, 3 * dpr]);
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(pad, yAt(3));
  ctx.lineTo(w - pad, yAt(3));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.strokeStyle = COL.down;
  ctx.lineWidth = 1.8 * dpr;
  pts.forEach((v, i) => {
    const x = xAt(i);
    const y = yAt(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  pts.forEach((v, i) => {
    ctx.beginPath();
    ctx.fillStyle = COL.down;
    ctx.arc(xAt(i), yAt(v), 2 * dpr, 0, Math.PI * 2);
    ctx.fill();
  });
}
