// Low-level frame maths: greyscale conversion, blurring, inter-frame
// differencing and blob extraction. Everything works on plain typed arrays so
// it stays fast on a phone.

/**
 * Convert RGBA image data to a blurred greyscale plane.
 * The 3x3 box blur knocks back sensor noise, which otherwise dominates the
 * inter-frame difference in low light.
 */
export function toGray(imageData, w, h) {
  const src = imageData.data;
  const raw = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
    // Integer luma approximation of Rec. 601.
    raw[i] = (src[p] * 77 + src[p + 1] * 150 + src[p + 2] * 29) >> 8;
  }
  return boxBlur3(raw, w, h);
}

/** Separable 3x3 box blur, edges clamped. */
export function boxBlur3(src, w, h) {
  const tmp = new Uint8ClampedArray(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[row + (x > 0 ? x - 1 : 0)];
      const b = src[row + x];
      const c = src[row + (x < w - 1 ? x + 1 : w - 1)];
      tmp[row + x] = (a + b + c) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w;
    const mid = y * w;
    const dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      out[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[dn + x]) / 3;
    }
  }
  return out;
}

/**
 * Absolute difference between two greyscale planes.
 * Returns the thresholded mask plus summary statistics used by the event
 * detector (total energy) and the club tracker (which pixels moved).
 */
export function diff(a, b, w, h, threshold = 18) {
  const mask = new Uint8Array(w * h);
  let energy = 0;
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > threshold) {
        mask[i] = 1;
        energy += d;
        count++;
        sx += x;
        sy += y;
      }
    }
  }
  return {
    mask,
    energy,
    count,
    cx: count ? sx / count : w / 2,
    cy: count ? sy / count : h / 2,
  };
}

/**
 * Estimate a per-clip difference threshold from the quietest part of the clip,
 * so a noisy phone sensor or a windy background does not read as motion.
 */
export function noiseFloor(grayFrames, w, h, sampleCount = 12) {
  if (grayFrames.length < 3) return 18;
  const step = Math.max(1, Math.floor(grayFrames.length / sampleCount));
  const scores = [];
  for (let i = step; i < grayFrames.length; i += step) {
    const a = grayFrames[i - 1];
    const b = grayFrames[i];
    let s = 0;
    // Sample every 7th pixel: enough for a noise statistic, much cheaper.
    for (let p = 0; p < a.length; p += 7) s += Math.abs(a[p] - b[p]);
    scores.push((s * 7) / a.length);
  }
  scores.sort((x, y) => x - y);
  const quiet = scores[Math.floor(scores.length * 0.25)] || 2;
  // Threshold well above the quiet-frame average difference.
  return Math.max(10, Math.min(45, quiet * 4 + 8));
}

/**
 * Connected-component labelling over a binary mask (4-connectivity, iterative
 * flood fill so deep blobs cannot overflow the JS stack).
 */
export function blobs(mask, w, h, minPixels = 6) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let n = 0, sx = 0, sy = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      n++; sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[sp++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[sp++] = idx + w; }
    }
    if (n >= minPixels) {
      out.push({
        n, cx: sx / n, cy: sy / n,
        minX, maxX, minY, maxY,
        w: maxX - minX + 1, h: maxY - minY + 1,
      });
    }
  }
  return out;
}
