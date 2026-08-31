// Finding the four moments that matter in a swing: address (start of the
// takeaway), top of the backswing, impact, and finish.
//
// The signal we work from is inter-frame motion energy. A golf swing has a very
// distinctive shape in that signal: quiet, a rising backswing hump, a dip at the
// transition, then a sharp spike at impact.

import { diff } from './motion.js';
import { smooth, argmax, clamp, mean } from './util.js';

/**
 * One sweep over the frame stack producing the motion-energy curve plus, per
 * frame, where the motion was. energy[0] is 0 (no previous frame to compare).
 */
export function computeEnergy(gray, w, h, threshold, times = null) {
  const n = gray.length;
  const energy = new Float64Array(n);
  const count = new Float64Array(n);
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const px = w * h;

  // Frames captured during playback can be unevenly spaced when the decoder
  // drops one, which would otherwise read as a burst of motion. Scaling each
  // difference by how long it spans puts every frame back on the same footing.
  let nominalDt = 0;
  if (times && times.length > 2) {
    const deltas = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 1e-6) deltas.push(d);
    }
    deltas.sort((a, b) => a - b);
    nominalDt = deltas[Math.floor(deltas.length / 2)] || 0;
  }

  for (let i = 1; i < n; i++) {
    const d = diff(gray[i - 1], gray[i], w, h, threshold);
    const dt = times ? times[i] - times[i - 1] : 0;
    const scale = nominalDt > 0 && dt > 1e-6 ? nominalDt / dt : 1;
    energy[i] = (d.energy / px) * scale;
    count[i] = d.count / px;
    cx[i] = d.cx;
    cy[i] = d.cy;
  }
  if (n > 1) {
    energy[0] = energy[1];
    cx[0] = cx[1];
    cy[0] = cy[1];
  }
  return { energy, count, cx, cy };
}

/** Percentile of a copy of `arr` (0..1). */
function percentile(arr, p) {
  const a = Array.from(arr).sort((x, y) => x - y);
  if (!a.length) return 0;
  return a[clamp(Math.floor(a.length * p), 0, a.length - 1)];
}

/**
 * Split the energy curve into contiguous above-threshold runs, then stitch back
 * together runs that are only separated by a short gap. The pause at the top of
 * the backswing reads as complete stillness on a slow-motion clip — identical to
 * standing at address — so without the stitching a swing arrives here as two
 * separate events. A gap only counts as a real boundary when it is long
 * relative to the activity either side of it.
 */
function pickSwingSegment(sm, floorV, peakV) {
  const gate = floorV + 0.12 * (peakV - floorV);
  let runs = [];
  let start = -1;
  for (let i = 0; i < sm.length; i++) {
    if (sm[i] > gate) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, sm.length - 1]);
  if (!runs.length) return [0, sm.length - 1];

  const merged = [runs[0]];
  for (let i = 1; i < runs.length; i++) {
    const prev = merged[merged.length - 1];
    const next = runs[i];
    const gap = next[0] - prev[1] - 1;
    const shorter = Math.min(prev[1] - prev[0] + 1, next[1] - next[0] + 1);
    if (gap <= Math.max(2, shorter * 0.4)) merged[merged.length - 1] = [prev[0], next[1]];
    else merged.push(next);
  }

  let best = merged[0];
  let bestScore = -Infinity;
  for (const [a, b] of merged) {
    if (b - a < 2) continue;
    const slice = Array.from(sm.slice(a, b + 1));
    const pk = Math.max(...slice);
    const avg = mean(slice);
    // Peakiness x height: a swing spikes far above its own average.
    const score = pk * (pk / Math.max(1e-6, avg));
    if (score > bestScore) {
      bestScore = score;
      best = [a, b];
    }
  }
  return best;
}

/**
 * The top of the backswing is a dip in motion flanked by the backswing hump on
 * one side and the downswing on the other. Scoring candidate minima by
 * prominence — how far each sits below the higher of the peaks either side —
 * picks that dip out and ignores the shallow wobbles inside a slow takeaway.
 */
function findTop(L, segStart, impact) {
  const span = impact - segStart;
  if (span < 6) return Math.max(segStart + 1, impact - 2);
  const maxLeft = new Float64Array(impact + 1);
  let m = -Infinity;
  for (let i = segStart; i <= impact; i++) { m = Math.max(m, L[i]); maxLeft[i] = m; }
  const maxRight = new Float64Array(impact + 1);
  m = -Infinity;
  for (let i = impact; i >= segStart; i--) { m = Math.max(m, L[i]); maxRight[i] = m; }

  const candidates = [];
  for (let i = segStart + 1; i < impact; i++) {
    if (!(L[i] <= L[i - 1] && L[i] <= L[i + 1])) continue;
    candidates.push({ i, prom: Math.min(maxLeft[i], maxRight[i]) - L[i] });
  }
  if (!candidates.length) {
    return { index: Math.max(segStart + 1, impact - Math.round(span * 0.25)), prominence: 0 };
  }
  const bestProm = Math.max(...candidates.map((c) => c.prom));
  // Several dips can look equally deep — a long wait at address before the
  // swing is one. The transition is always the last of them, so among the dips
  // that are nearly as prominent as the best, take the latest.
  const strong = candidates.filter((c) => c.prom >= bestProm * 0.6);
  const chosen = strong[strong.length - 1];
  return { index: chosen.i, prominence: chosen.prom };
}

/**
 * Nudge an index found on the smoothed curve onto the matching extreme of the
 * raw one. Smoothing is what makes the dip and the spike findable at all, but
 * it also drags them a frame or two sideways — and at 30fps a swing is barely
 * thirty frames, so one frame is a tenth of the downswing.
 */
function refine(raw, index, window, wantMax) {
  let best = index;
  let bestV = raw[index];
  for (let i = Math.max(0, index - window); i <= Math.min(raw.length - 1, index + window); i++) {
    if (wantMax ? raw[i] > bestV : raw[i] < bestV) { bestV = raw[i]; best = i; }
  }
  // Only move if the raw curve is decisively better there. On a high frame-rate
  // clip neighbouring frames differ by noise, and chasing that noise is worse
  // than trusting the smoothed position.
  const margin = wantMax ? bestV > raw[index] * 1.1 : bestV < raw[index] * 0.9;
  return margin ? best : index;
}

/** Walk back from `from` to the last run of `run` frames below `gate`. */
function walkBackTo(L, from, gate, run) {
  let streak = 0;
  for (let i = from; i >= 0; i--) {
    if (L[i] < gate) {
      streak++;
      if (streak >= run) return Math.min(i + run - 1, from);
    } else {
      streak = 0;
    }
  }
  return 0;
}

/**
 * Detect the swing events. Returns frame indices into the supplied stack plus a
 * confidence score and any caveats worth showing the golfer.
 */
export function detectEvents(energy, times, smoothHalf = null) {
  const n = energy.length;
  const notes = [];
  if (n < 8) {
    return { ok: false, notes: ['The clip is too short to analyse — aim for 2 to 3 seconds around the swing.'] };
  }
  // How hard to smooth depends on how many frames the swing occupies. On a
  // 240fps clip a swing is hundreds of frames and needs real smoothing; at 30fps
  // it is barely thirty, and the pause at the top lasts one or two of them —
  // smooth that as hard and the transition disappears entirely. The first pass
  // measures the swing, the second re-reads it at the right scale.
  if (smoothHalf === null) {
    const probe = detectEvents(energy, times, 1);
    const swingFrames = probe.ok ? probe.impact - probe.address : 40;
    const half = clamp(Math.round(swingFrames / 60), 1, 4);
    return half === 1 ? probe : detectEvents(energy, times, half);
  }
  const raw = smooth(energy, smoothHalf);
  const peakRaw = Math.max(...raw);
  // A still frame can difference to exactly zero once the noise threshold is
  // applied, so the log reference is floored against the clip's own peak
  // instead of the quiet level alone.
  const quiet = Math.max(percentile(raw, 0.25), peakRaw * 0.002, 1e-5);

  // Work on a log scale. In 8x slow motion the takeaway carries a tiny fraction
  // of the energy of impact, and any linear threshold that catches impact
  // treats the whole first half of the backswing as "nothing happening".
  const L = new Float64Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.log1p(raw[i] / quiet);
  const sm = L;

  const base = percentile(L, 0.15);
  const peak = Math.max(...L);
  if (peak - base < 0.45) {
    return { ok: false, notes: ['No clear swing motion found in this clip.'] };
  }

  const [segStart, segEnd] = pickSwingSegment(L, base, peak);
  const impact = refine(energy, argmax(L, segStart, segEnd), smoothHalf + 1, true);
  // Search back from impact across the whole clip: the takeaway can start
  // below the segment gate, and clipping the search there is what puts
  // "address" halfway up the backswing.
  const found = findTop(L, 0, impact);
  const top = refine(energy, found.index, smoothHalf + 1, false);
  const prominence = found.prominence;

  // Address: the backswing has its own, much smaller, hump. Measuring the quiet
  // threshold against that hump rather than against impact is what stops the
  // takeaway being swallowed.
  const bsPeak = argmax(L, 0, Math.max(1, top - 1));
  const addressGate = base + 0.16 * Math.max(0.15, L[bsPeak] - base);
  let address = walkBackTo(L, bsPeak, addressGate, 2);
  address = clamp(address, 0, Math.max(0, top - 2));

  // Finish: the first sustained calm after impact.
  const calmGate = base + 0.14 * (L[impact] - base);
  let finish = Math.min(n - 1, segEnd);
  let calmRun = 0;
  for (let i = impact + 1; i < n; i++) {
    if (L[i] < calmGate) {
      calmRun++;
      if (calmRun >= 3) { finish = i; break; }
    } else {
      calmRun = 0;
    }
  }
  finish = clamp(finish, impact + 1, n - 1);

  // Confidence: how cleanly the transition separates the two halves, and how
  // many frames we have to place each event on.
  const dipQuality = clamp(prominence / Math.max(1e-6, L[bsPeak] - base), 0, 1);
  const spike = clamp((L[impact] - base) / Math.max(1e-6, peak - base), 0, 1);
  const framesInSwing = impact - address;
  const resolution = clamp(framesInSwing / 25, 0, 1);
  const confidence = clamp(0.45 * dipQuality + 0.3 * spike + 0.25 * resolution, 0, 1);

  if (framesInSwing < 10) {
    notes.push('Only a handful of frames cover this swing. Filming in slo-mo gives much sharper timings.');
  }
  if (dipQuality < 0.25) {
    notes.push('The transition at the top was hard to pin down, so the tempo split is approximate.');
  }
  if (impact >= n - 3) {
    notes.push('The clip ends right at impact — leave a second of follow-through in shot next time.');
  }

  return {
    ok: true,
    address, top, impact, finish,
    segStart, segEnd, bsPeak,
    confidence, notes,
    smooth: sm,
    smoothHalf,
    times,
  };
}

/**
 * iPhone slo-mo is exported as a normal-rate video with time stretched, so the
 * clip's own clock runs slow. Recover the stretch factor by comparing the
 * measured swing length against a real one, then snap to the factors an iPhone
 * can actually produce. The candidates are an octave apart, so the snap is
 * forgiving of an unusually quick or slow swing.
 */
export function estimateSlomo(videoSwingSeconds) {
  const TYPICAL_TAKEAWAY_TO_IMPACT = 1.15; // seconds, real time
  if (!Number.isFinite(videoSwingSeconds) || videoSwingSeconds <= 0) {
    return { factor: 1, confident: false };
  }
  const raw = videoSwingSeconds / TYPICAL_TAKEAWAY_TO_IMPACT;
  const candidates = [1, 2, 4, 8];
  let best = 1;
  let bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(Math.log2(raw / c));
    if (err < bestErr) { bestErr = err; best = c; }
  }
  // Within a quarter of an octave of a real candidate is a confident snap.
  return { factor: best, confident: bestErr < 0.25, raw };
}
