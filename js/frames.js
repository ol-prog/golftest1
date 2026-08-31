// Turning a video file into analysable frames.
//
// Two passes: a cheap coarse scan across the whole clip to find roughly where
// the swing happens, then a frame-accurate pass over just that window. This
// keeps memory bounded (a 240fps slo-mo clip can hold thousands of frames) and
// keeps analysis to a few seconds on a phone.

import { toGray } from './motion.js';
import { nextTick } from './util.js';

/** Load a Blob/File into a video element that is ready to be drawn. */
export function loadVideo(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.defaultMuted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    video.src = url;
    video._objectUrl = src instanceof Blob ? url : null;

    const done = () => {
      if (!video.videoWidth || !video.videoHeight) {
        reject(new Error('That file does not look like a video this browser can decode.'));
        return;
      }
      resolve(video);
    };
    video.addEventListener('loadedmetadata', () => {
      // Safari sometimes reports metadata before the first frame is decodable.
      if (video.readyState >= 2) done();
      else video.addEventListener('loadeddata', done, { once: true });
    }, { once: true });
    video.addEventListener('error', () => reject(new Error('Could not read that video file.')), { once: true });
    setTimeout(() => reject(new Error('Timed out loading that video.')), 30000);
  });
}

export function releaseVideo(video) {
  try {
    video.pause();
    if (video._objectUrl) URL.revokeObjectURL(video._objectUrl);
    video.removeAttribute('src');
    video.load();
  } catch { /* already gone */ }
}

/**
 * iOS Safari will happily draw a blank canvas from a video that has never been
 * played. A brief muted play/pause primes the decoder. Must be called from a
 * user gesture chain, which is why analysis always starts from a tap.
 */
export async function primeDecoder(video) {
  try {
    video.muted = true;
    const p = video.play();
    if (p && typeof p.then === 'function') await p;
    await new Promise((r) => setTimeout(r, 60));
    video.pause();
  } catch {
    /* autoplay refused; seeking usually still works */
  }
  try {
    video.currentTime = 0;
    await waitForSeek(video);
  } catch { /* ignore */ }
}

function waitForSeek(video, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('seeked', ok);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // A missed 'seeked' is recoverable: the frame is usually there anyway.
      resolve();
    }, timeoutMs);
    video.addEventListener('seeked', ok, { once: true });
  });
}

/** Seek to `t` and wait until the frame at that time is drawable. */
export async function seekTo(video, t) {
  const target = Math.max(0, Math.min(t, Math.max(0, video.duration - 1e-3)));
  if (Math.abs(video.currentTime - target) < 1e-4 && video.readyState >= 2) return;
  video.currentTime = target;
  await waitForSeek(video);
}

/**
 * Measure the video's true frame interval by watching presented frames.
 * Falls back to 30fps where requestVideoFrameCallback is unavailable.
 */
export async function detectFrameRate(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') {
    return { fps: 30, measured: false };
  }
  const times = [];
  const startAt = Math.min(0.1, Math.max(0, video.duration * 0.1));
  await seekTo(video, startAt);
  const collected = new Promise((resolve) => {
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime);
      if (times.length >= 16) resolve();
      else video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    setTimeout(resolve, 2500);
  });
  try {
    video.muted = true;
    await video.play();
  } catch { /* fall through to the default */ }
  await collected;
  video.pause();

  const deltas = [];
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > 1e-4 && d < 0.5) deltas.push(d);
  }
  if (deltas.length < 4) return { fps: 30, measured: false };
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  const fps = 1 / median;
  // Snap to the common capture rates so tiny measurement errors do not
  // propagate into every timing figure.
  const known = [24, 25, 30, 50, 60, 120, 240];
  let best = fps;
  for (const k of known) {
    if (Math.abs(k - fps) / k < 0.08) { best = k; break; }
  }
  return { fps: best, measured: true };
}

/** Draw the current video frame into a scratch canvas and return greyscale. */
function grabGray(video, ctx, w, h) {
  ctx.drawImage(video, 0, 0, w, h);
  return toGray(ctx.getImageData(0, 0, w, h), w, h);
}

function makeCtx(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Analysis resolution: keep the clip's aspect, cap the long edge. */
export function analysisSize(video, longEdge) {
  const ar = video.videoWidth / video.videoHeight;
  let w, h;
  if (ar >= 1) { w = longEdge; h = Math.round(longEdge / ar); }
  else { h = longEdge; w = Math.round(longEdge * ar); }
  return { w: Math.max(2, w & ~1), h: Math.max(2, h & ~1) };
}


/**
 * Read frames by playing the clip and capturing each presented frame, rather
 * than seeking to each one in turn. Seeking is accurate but costs tens of
 * milliseconds a frame, which turns a three-second swing into a minute of
 * waiting; playing through is several times faster.
 *
 * The browser may drop frames when playing above normal speed. That is fine:
 * every frame is stamped with its real presentation time, so the analysis works
 * from actual timestamps rather than assuming a fixed interval.
 */
async function extractByPlayback(video, t0, t1, { longEdge, maxFrames, rate, onProgress }) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null;
  const { w, h } = analysisSize(video, longEdge);
  const ctx = makeCtx(w, h);
  const gray = [];
  const times = [];
  await seekTo(video, t0);

  const captured = await new Promise((resolve) => {
    let finished = false;
    const finish = (reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      try { video.pause(); } catch { /* ignore */ }
      video.playbackRate = 1;
      resolve(reason);
    };
    // Wall-clock guard: never let a stalled decoder hang the analysis.
    const guard = setTimeout(() => finish('timeout'), ((t1 - t0) / rate) * 1000 + 8000);

    let lastT = -Infinity;
    const onFrame = (_now, meta) => {
      const t = meta.mediaTime;
      // The decoder sometimes presents the same frame twice. Keeping both puts
      // a moment of zero motion in the middle of the swing, which reads as a
      // pause at the top and can move the whole tempo split.
      const isRepeat = t <= lastT + 1e-4;
      if (!isRepeat && t >= t0 - 1e-3 && gray.length < maxFrames) {
        lastT = t;
        ctx.drawImage(video, 0, 0, w, h);
        gray.push(toGray(ctx.getImageData(0, 0, w, h), w, h));
        times.push(t);
        if (onProgress && gray.length % 8 === 0) onProgress((t - t0) / Math.max(1e-6, t1 - t0));
      }
      if (t >= t1 - 1e-3 || gray.length >= maxFrames) { finish('done'); return; }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.addEventListener('ended', () => finish('ended'), { once: true });
    video.muted = true;
    video.playbackRate = rate;
    const p = video.play();
    if (p && typeof p.catch === 'function') p.catch(() => finish('blocked'));
  });

  if (captured === 'blocked') return null;
  return { gray, times, w, h, stride: 1, method: 'playback' };
}

/**
 * Coarse pass: sample the whole clip at ~`samplesPerSec` and return greyscale
 * frames plus their timestamps.
 */
export async function scanCoarse(video, { samplesPerSec = 12, longEdge = 128, onProgress } = {}) {
  const played = await extractByPlayback(video, 0, video.duration, {
    longEdge, maxFrames: 1400, rate: 4, onProgress,
  });
  // A quarter of the frames is still far more than the twelve a second this
  // pass was designed around, so a dropping decoder is not a problem here.
  if (played && played.gray.length >= Math.min(24, video.duration * 4)) return played;

  const { w, h } = analysisSize(video, longEdge);
  const ctx = makeCtx(w, h);
  const duration = video.duration;
  const step = 1 / samplesPerSec;
  const times = [];
  for (let t = 0; t < duration - 1e-3; t += step) times.push(t);
  const gray = [];
  for (let i = 0; i < times.length; i++) {
    await seekTo(video, times[i]);
    gray.push(grabGray(video, ctx, w, h));
    if (onProgress && i % 4 === 0) {
      onProgress(i / times.length);
      await nextTick();
    }
  }
  return { gray, times, w, h, method: 'seek' };
}

/**
 * Fine pass: every frame between t0 and t1 at the analysis resolution.
 * `maxFrames` guards against a user handing us a very long window.
 */
export async function extractRange(video, t0, t1, fps, { longEdge = 320, maxFrames = 900, onProgress } = {}) {
  const start = Math.max(0, t0);
  const end = Math.min(video.duration - 1e-3, t1);
  const expected = Math.max(1, Math.floor((end - start) * fps));

  const played = await extractByPlayback(video, start, end, {
    longEdge, maxFrames, rate: 2, onProgress,
  });
  // Only fall back to the slow path if playback gave us too little to work with.
  if (played && played.gray.length >= Math.min(expected * 0.35, maxFrames)) return played;

  const { w, h } = analysisSize(video, longEdge);
  const ctx = makeCtx(w, h);
  let step = 1 / fps;
  const wanted = Math.floor((end - start) / step) + 1;
  // Sub-sample rather than truncate, so a long window still covers the swing.
  const stride = Math.max(1, Math.ceil(wanted / maxFrames));
  step *= stride;

  const gray = [];
  const times = [];
  for (let t = start, i = 0; t <= end; t += step, i++) {
    await seekTo(video, t);
    gray.push(grabGray(video, ctx, w, h));
    times.push(video.currentTime);
    if (onProgress && i % 5 === 0) {
      onProgress((t - start) / Math.max(1e-6, end - start));
      await nextTick();
    }
  }
  return { gray, times, w, h, stride, method: 'seek' };
}

/** Capture a display-resolution still (JPEG blob) at time `t`. */
export async function grabStill(video, t, longEdge = 720, quality = 0.82) {
  const { w, h } = analysisSize(video, longEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  await seekTo(video, t);
  ctx.drawImage(video, 0, 0, w, h);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return { blob, w, h };
}
