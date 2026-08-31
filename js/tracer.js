// The swing tracer: a line that draws itself along the club head as the clip
// plays, the way a TV ball-tracer does.
//
// The path is already known — it was measured during analysis — so this is
// purely a matter of drawing the part of it that has happened by the video's
// current time, and keeping that lined up with the picture underneath.

import { smoothPath } from './overlay.js';

const COL = {
  back: '#4cc2ff',
  down: '#ffb020',
  through: '#ff6b6b',
  ball: '#7bf1a8',
};

/**
 * Where the video's picture actually sits inside its element. A video element
 * letterboxes its content, so drawing on the element's full box would put the
 * tracer a few percent off the club head.
 */
function contentRect(video, cssW, cssH) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0, w: cssW, h: cssH };
  const scale = Math.min(cssW / vw, cssH / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
}

/**
 * Build the timed path from a report. Coordinates are normalised by frame
 * width; times are in clip seconds.
 */
function buildPath(report) {
  const trace = report.trace;
  if (!trace || !trace.points || !trace.times) return null;

  // Older reports predate the stored start time; recover it from a known event.
  let t0 = trace.t0;
  if (t0 == null && report.events && trace.idx) {
    t0 = report.events.address - trace.times[trace.idx.address];
  }
  if (t0 == null) return null;

  const points = [];
  for (let i = 0; i < trace.points.length; i++) {
    const p = trace.points[i];
    if (!p) { points.push(null); continue; }
    points.push({ x: p.x, y: p.y, t: t0 + trace.times[i] });
  }
  // Prefer the fitted flight curve; fall back to raw detections on reports
  // saved before it existed.
  const ballSource = (report.ball && (report.ball.flight || report.ball.path)) || [];
  const ball = ballSource.filter((p) => p && Number.isFinite(p.t));
  return { points, idx: trace.idx, ball };
}

export class Tracer {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.path = null;
    this.enabled = true;
    this.running = false;
    this._raf = null;
    this._vfc = null;
    this._tick = this._tick.bind(this);
  }

  setReport(report) {
    this.path = buildPath(report);
    this.draw();
    return Boolean(this.path);
  }

  setEnabled(on) {
    this.enabled = on;
    this.draw();
  }

  start() {
    if (this.running) return;
    this.running = true;
    // requestVideoFrameCallback lands exactly on presented frames, so the line
    // never lags the picture. Fall back to animation frames where it is missing.
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const loop = () => {
        if (!this.running) return;
        this.draw();
        this._vfc = this.video.requestVideoFrameCallback(loop);
      };
      this._vfc = this.video.requestVideoFrameCallback(loop);
    }
    this._raf = requestAnimationFrame(this._tick);
  }

  _tick() {
    if (!this.running) return;
    this.draw();
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    if (this._vfc && typeof this.video.cancelVideoFrameCallback === 'function') {
      this.video.cancelVideoFrameCallback(this._vfc);
    }
    this._vfc = null;
  }

  /** Match the canvas to the video element's current size on screen. */
  _resize() {
    const rect = this.video.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    return { dpr, cssW: rect.width * dpr, cssH: rect.height * dpr };
  }

  /**
   * Draw everything that has happened by the video's current time.
   * The trail stays on screen once drawn — a tracer you can still read at the
   * finish is more use than one that fades.
   */
  draw() {
    const size = this._resize();
    const ctx = this.ctx;
    if (!size) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.enabled || !this.path) return;

    const box = contentRect(this.video, size.cssW, size.cssH);
    const now = this.video.currentTime;
    // Coordinates were normalised by frame width, so both axes scale by width.
    const px = (p) => ({ x: box.x + p.x * box.w, y: box.y + p.y * box.w });
    const stroke = Math.max(2.5, box.w / 160);

    const { points, idx } = this.path;
    const segments = [
      [Math.max(0, idx.address), idx.top, COL.back],
      [idx.top, idx.impact, COL.down],
      [idx.impact, Math.min(points.length - 1, idx.finish), COL.through],
    ];

    let head = null;
    for (const [from, to, colour] of segments) {
      // Break the run wherever the club was never found, rather than drawing a
      // straight line across the gap and passing it off as the swing.
      const runs = [];
      let run = [];
      for (let i = from; i <= to; i++) {
        const p = points[i];
        if (!p || p.t > now) {
          if (run.length > 1) runs.push(run);
          run = [];
          if (p && p.t > now) break;
          continue;
        }
        run.push(px(p));
        head = p;
      }
      if (run.length > 1) runs.push(run);
      this._strokeRuns(runs, colour, stroke);
    }

    // Ball flight: the fitted parabola, drawn solid and bright the way a
    // broadcast tracer is, and carried on past the last frame the ball was
    // actually visible in.
    const flown = this.path.ball.filter((p) => p.t <= now).map(px);
    if (flown.length > 1) this._strokeRuns([flown], COL.ball, stroke * 1.05);

    // A bright head on the club line, so the eye can find where it is now.
    if (head) {
      const h = px(head);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.fillStyle = '#ffffff';
      ctx.arc(h.x, h.y, stroke * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Glow underneath, line on top — what keeps a thin bright line readable. */
  _strokeRuns(runs, colour, width) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colour;
    for (const pass of [0, 1]) {
      ctx.globalAlpha = pass === 0 ? 0.25 : 1;
      ctx.lineWidth = pass === 0 ? width * 3 : width;
      for (const run of runs) {
        ctx.beginPath();
        smoothPath(ctx, run);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
