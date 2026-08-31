// Live capture: camera preview, framing guide, and three ways to start a
// recording — tap, countdown, or hands-free motion trigger.
//
// The hands-free mode is built for a phone propped against a bag: it waits for
// you to walk in, waits again until you settle over the ball, starts recording
// there, then stops shortly after the swing. Because recording starts while you
// are still at address, the clip always contains the whole swing without any
// buffering tricks.

import { toGray } from './motion.js';

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* keep looking */ }
  }
  return '';
}

export function captureSupported() {
  return Boolean(
    navigator.mediaDevices
    && navigator.mediaDevices.getUserMedia
    && typeof MediaRecorder !== 'undefined',
  );
}

export class Capture {
  constructor(videoEl, opts = {}) {
    this.video = videoEl;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.state = 'idle';
    this.onState = opts.onState || (() => {});
    this.onClip = opts.onClip || (() => {});
    this.onLevel = opts.onLevel || (() => {});
    this.autoStopSec = opts.autoStopSec || 3;
    this._raf = null;
    this._timers = [];
    this._analysis = null;
  }

  setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }

  async start() {
    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // A higher rate makes impact much easier to place; the browser gives us
        // what it can.
        frameRate: { ideal: 60 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();
    const track = this.stream.getVideoTracks()[0];
    this.settings = track ? track.getSettings() : {};
    this.setState('ready');
    return this.settings;
  }

  stop() {
    this._clearTimers();
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch { /* already stopped */ }
    this.recorder = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.video.srcObject = null;
    this.setState('idle');
  }

  _clearTimers() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  _later(fn, ms) {
    const t = setTimeout(fn, ms);
    this._timers.push(t);
    return t;
  }

  /** Begin a recording now. Resolves when the clip is delivered. */
  _beginRecording() {
    if (this.recorder && this.recorder.state === 'recording') return;
    const mimeType = pickMimeType();
    this.chunks = [];
    try {
      this.recorder = mimeType
        ? new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 8_000_000 })
        : new MediaRecorder(this.stream);
    } catch {
      this.recorder = new MediaRecorder(this.stream);
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const type = this.recorder && this.recorder.mimeType ? this.recorder.mimeType : 'video/mp4';
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      if (blob.size > 1000) this.onClip(blob);
      this.setState('ready');
    };
    this.recorder.start(250);
    this.setState('recording');
  }

  _endRecording() {
    try {
      if (this.recorder && this.recorder.state === 'recording') this.recorder.stop();
    } catch { /* ignore */ }
  }

  /** Tap to start, tap to stop. */
  toggleManual() {
    if (this.recorder && this.recorder.state === 'recording') this._endRecording();
    else this._beginRecording();
  }

  /** Countdown, then record for a fixed window. */
  startTimer(seconds = 10, recordFor = 6) {
    this._clearTimers();
    let left = seconds;
    this.setState('counting', left);
    const tick = () => {
      left -= 1;
      if (left > 0) {
        this.setState('counting', left);
        this._later(tick, 1000);
      } else {
        this._beginRecording();
        this._later(() => this._endRecording(), recordFor * 1000);
      }
    };
    this._later(tick, 1000);
  }

  /**
   * Hands-free. Watches the preview for: someone arriving, then settling over
   * the ball, then swinging.
   */
  startAuto() {
    this._clearTimers();
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = Math.max(2, Math.round((96 * this.video.videoHeight) / Math.max(1, this.video.videoWidth)));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let prev = null;
    let phase = 'waiting';   // waiting -> settling -> rolling -> swung
    let stillSince = 0;
    let arrivedAt = 0;
    let recordStart = 0;
    let swungAt = 0;
    let baseline = 0;
    let samples = 0;
    let lastSample = 0;

    this.setState('auto-waiting');

    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      // Sample at roughly 15Hz; the preview does not need every frame.
      if (now - lastSample < 66) return;
      lastSample = now;
      if (!this.video.videoWidth) return;

      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      const gray = toGray(ctx.getImageData(0, 0, canvas.width, canvas.height), canvas.width, canvas.height);
      if (!prev) { prev = gray; return; }

      let sum = 0;
      for (let i = 0; i < gray.length; i++) sum += Math.abs(gray[i] - prev[i]);
      const level = sum / gray.length;
      prev = gray;

      // Learn what "nothing happening" looks like for this scene and light.
      if (samples < 45) {
        baseline = (baseline * samples + level) / (samples + 1);
        samples++;
        this.onLevel(0, phase);
        return;
      }
      const still = baseline + 1.6;
      const moving = baseline + 5;
      const swing = baseline + 16;
      this.onLevel(Math.min(1, level / Math.max(1, swing)), phase);

      if (phase === 'waiting') {
        if (level > moving) {
          phase = 'settling';
          arrivedAt = now;
          stillSince = 0;
          this.setState('auto-settling');
        }
      } else if (phase === 'settling') {
        if (level < still) {
          if (!stillSince) stillSince = now;
          if (now - stillSince > 600) {
            phase = 'rolling';
            recordStart = now;
            this._beginRecording();
            this.setState('auto-rolling');
          }
        } else {
          stillSince = 0;
          // Someone wandered past rather than settling over a ball.
          if (now - arrivedAt > 25000) {
            phase = 'waiting';
            this.setState('auto-waiting');
          }
        }
      } else if (phase === 'rolling') {
        if (level > swing) {
          phase = 'swung';
          swungAt = now;
          this.setState('auto-swing');
        } else if (now - recordStart > 30000) {
          // Nothing happened; drop it and start again rather than filling
          // storage with 30 seconds of a golfer thinking about it.
          this.chunks = [];
          this._endRecording();
          phase = 'waiting';
          this.setState('auto-waiting');
        }
      } else if (phase === 'swung') {
        if (now - swungAt > this.autoStopSec * 1000) {
          this._endRecording();
          phase = 'waiting';
          prev = null;
          samples = 0;
          baseline = 0;
          this.setState('auto-waiting');
        }
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  stopAuto() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._clearTimers();
    this._endRecording();
    this.setState('ready');
  }
}
