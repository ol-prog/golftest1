// Drawing the analysis back onto the picture: club-head trace, pose skeleton,
// ball, and the motion-energy timeline that the tempo split comes from.
//
// Report coordinates are normalised by frame width, so multiplying by the
// canvas width is all that is ever needed.

const POSE_BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 31], [28, 32],
];

const COL = {
  back: '#4cc2ff',
  down: '#ffb020',
  through: '#ff6b6b',
  ball: '#ffffff',
  ballPath: '#7bf1a8',
  pose: '#c9a6ff',
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

function line(ctx, pts, colour, width, w) {
  const usable = pts.filter(Boolean);
  if (usable.length < 2) return;
  ctx.beginPath();
  ctx.lineWidth = width;
  ctx.strokeStyle = colour;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  usable.forEach((p, i) => {
    const x = p.x * w;
    const y = p.y * w;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
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
    drawPose(ctx, report.poseFrames[showPose], w);
  }

  if (showBall && report.ball && report.ball.rest) {
    const b = report.ball.rest;
    ctx.beginPath();
    ctx.strokeStyle = COL.ball;
    ctx.lineWidth = Math.max(1.5, stroke * 0.6);
    ctx.arc(b.x * w, b.y * w, Math.max(4, w / 90), 0, Math.PI * 2);
    ctx.stroke();
    if (report.ball.path && report.ball.path.length > 1) {
      ctx.setLineDash([stroke * 2, stroke * 1.5]);
      line(ctx, report.ball.path, COL.ballPath, stroke * 0.8, w);
      ctx.setLineDash([]);
    }
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

export function drawPose(ctx, landmarks, w) {
  ctx.save();
  ctx.strokeStyle = COL.pose;
  ctx.fillStyle = COL.pose;
  ctx.lineWidth = Math.max(1.5, w / 320);
  for (const [a, b] of POSE_BONES) {
    const pa = landmarks[a];
    const pb = landmarks[b];
    if (!pa || !pb || pa.v < 0.3 || pb.v < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x * w, pa.y * w);
    ctx.lineTo(pb.x * w, pb.y * w);
    ctx.stroke();
  }
  for (const p of landmarks) {
    if (!p || p.v < 0.4) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * w, Math.max(1.5, w / 420), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
