// Body tracking via MediaPipe Pose Landmarker.
//
// The runtime and the model are vendored into this repo rather than pulled from
// a CDN, so the app works on a driving range with no signal. Loading is lazy and
// every caller must tolerate it failing: the swing analysis degrades to
// club-and-ball only rather than breaking.

import { clamp, deg } from './util.js';

const WASM_DIR = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const BUNDLE = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url).href;
const MODEL = new URL('../vendor/mediapipe/models/pose_landmarker_lite.task', import.meta.url).href;

export const LM = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftFoot: 31, rightFoot: 32,
};

let landmarkerPromise = null;

export function poseAvailable() {
  return landmarkerPromise !== null;
}

/** Load the model once. Resolves to null if it cannot be loaded. */
export function loadPose() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const vision = await import(/* @vite-ignore */ BUNDLE);
    const fileset = await vision.FilesetResolver.forVisionTasks(WASM_DIR);
    return vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
      minPoseDetectionConfidence: 0.4,
      minPosePresenceConfidence: 0.4,
      minTrackingConfidence: 0.4,
      outputSegmentationMasks: false,
    });
  })().catch(async (err) => {
    // GPU delegate is the usual failure on older iOS; retry on CPU once.
    try {
      const vision = await import(/* @vite-ignore */ BUNDLE);
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_DIR);
      return await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
      });
    } catch {
      console.warn('Pose model unavailable, continuing without body tracking', err);
      return null;
    }
  });
  return landmarkerPromise;
}

/**
 * Run pose on a canvas holding one frame.
 * Returns landmarks in pixel coordinates for that canvas, or null.
 */
export function detectOn(landmarker, canvas) {
  if (!landmarker) return null;
  let res;
  try {
    res = landmarker.detect(canvas);
  } catch {
    return null;
  }
  const lms = res && res.landmarks && res.landmarks[0];
  if (!lms) return null;
  return lms.map((p) => ({
    x: p.x * canvas.width,
    y: p.y * canvas.height,
    z: p.z,
    v: p.visibility ?? 1,
  }));
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) });

/** Interior angle at vertex b, in degrees. */
function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const n1 = Math.hypot(v1.x, v1.y);
  const n2 = Math.hypot(v2.x, v2.y);
  if (n1 < 1e-6 || n2 < 1e-6) return null;
  const cos = clamp((v1.x * v2.x + v1.y * v2.y) / (n1 * n2), -1, 1);
  return deg(Math.acos(cos));
}

/** A compact summary of one posed frame. */
export function poseSummary(lms) {
  if (!lms) return null;
  const sh = mid(lms[LM.leftShoulder], lms[LM.rightShoulder]);
  const hip = mid(lms[LM.leftHip], lms[LM.rightHip]);
  const ank = mid(lms[LM.leftAnkle], lms[LM.rightAnkle]);
  const shoulderWidth = Math.hypot(
    lms[LM.leftShoulder].x - lms[LM.rightShoulder].x,
    lms[LM.leftShoulder].y - lms[LM.rightShoulder].y,
  );
  const hipWidth = Math.hypot(
    lms[LM.leftHip].x - lms[LM.rightHip].x,
    lms[LM.leftHip].y - lms[LM.rightHip].y,
  );
  // Spine tilt from vertical: 0 is standing straight up.
  const spineDx = sh.x - hip.x;
  const spineDy = hip.y - sh.y;
  const spineTiltDeg = deg(Math.atan2(spineDx, Math.max(1e-6, spineDy)));
  return {
    shoulders: sh,
    hips: hip,
    ankles: ank,
    head: { x: lms[LM.nose].x, y: lms[LM.nose].y, v: lms[LM.nose].v },
    shoulderWidth,
    hipWidth,
    spineTiltDeg,
    forwardBendPx: Math.hypot(sh.x - hip.x, sh.y - hip.y),
    leftKneeDeg: jointAngle(lms[LM.leftHip], lms[LM.leftKnee], lms[LM.leftAnkle]),
    rightKneeDeg: jointAngle(lms[LM.rightHip], lms[LM.rightKnee], lms[LM.rightAnkle]),
    leftArmDeg: jointAngle(lms[LM.leftShoulder], lms[LM.leftElbow], lms[LM.leftWrist]),
    rightArmDeg: jointAngle(lms[LM.rightShoulder], lms[LM.rightElbow], lms[LM.rightWrist]),
    stanceDeg: deg(Math.atan2(
      lms[LM.rightAnkle].y - lms[LM.leftAnkle].y,
      lms[LM.rightAnkle].x - lms[LM.leftAnkle].x,
    )),
    ankleToNosePx: Math.hypot(ank.x - lms[LM.nose].x, ank.y - lms[LM.nose].y),
    hands: mid(lms[LM.leftWrist], lms[LM.rightWrist]),
    raw: lms,
  };
}

/**
 * Pixels per centimetre, from the golfer's stated height.
 * Ankle-to-nose is close to 0.90 of standing height for most adults, and both
 * points are reliably visible in a golf setup.
 */
export function pixelScale(summary, heightCm, frameHeightPx) {
  if (!summary || !heightCm || !summary.ankleToNosePx) return null;
  const px = summary.ankleToNosePx;
  // A golfer framed well enough to measure fills a decent share of the picture.
  // Anything smaller means the pose landed on something that is not a person,
  // and scaling by it would turn every centimetre figure into nonsense.
  if (frameHeightPx && px < frameHeightPx * 0.25) return null;
  if (px < 40) return null;
  // Ankles should sit below the head, and shoulders should be a sane fraction
  // of standing height apart.
  if (summary.ankles.y <= summary.head.y) return null;
  if (summary.shoulderWidth < px * 0.1 || summary.shoulderWidth > px * 0.8) return null;
  return px / (heightCm * 0.9);
}

/** Body measurements derived by comparing key frames. */
export function bodyMetrics(at, targetSign = 1) {
  const { address, top, impact } = at;
  if (!address) return null;
  const out = {};
  const swRef = address.shoulderWidth || 1;

  out.spineTiltAddressDeg = address.spineTiltDeg;
  out.spineTiltImpactDeg = impact ? impact.spineTiltDeg : null;
  out.spineChangeDeg = impact ? impact.spineTiltDeg - address.spineTiltDeg : null;

  // Head movement between address and impact, in shoulder widths. Converted to
  // centimetres later if we have a pixel scale.
  if (impact && impact.head.v > 0.3 && address.head.v > 0.3) {
    out.headSwayNorm = (impact.head.x - address.head.x) / swRef;
    out.headLiftNorm = (address.head.y - impact.head.y) / swRef;
    out.headMovePx = Math.hypot(impact.head.x - address.head.x, impact.head.y - address.head.y);
  }
  if (top && top.head.v > 0.3 && address.head.v > 0.3) {
    out.headSwayTopNorm = (top.head.x - address.head.x) / swRef;
    out.headMoveTopPx = Math.hypot(top.head.x - address.head.x, top.head.y - address.head.y);
  }

  // Rotation proxy: as the shoulders turn away from the camera their projected
  // width shrinks. Only meaningful from a face-on view.
  if (top && address.shoulderWidth > 4) {
    const ratio = clamp(top.shoulderWidth / address.shoulderWidth, 0, 1);
    out.shoulderTurnDeg = deg(Math.acos(ratio));
  }
  if (top && address.hipWidth > 4) {
    const ratio = clamp(top.hipWidth / address.hipWidth, 0, 1);
    out.hipTurnDeg = deg(Math.acos(ratio));
  }
  if (Number.isFinite(out.shoulderTurnDeg) && Number.isFinite(out.hipTurnDeg)) {
    out.xFactorDeg = out.shoulderTurnDeg - out.hipTurnDeg;
  }

  // Weight shift proxy: how far the hips travel towards the target.
  if (impact) {
    out.hipShiftNorm = (targetSign * (impact.hips.x - address.hips.x)) / swRef;
  }
  if (top) {
    out.hipSlideBackNorm = (targetSign * (address.hips.x - top.hips.x)) / swRef;
  }
  if (impact && impact.head.v > 0.3 && address.head.v > 0.3) {
    // Positive means the head drifted towards the target.
    out.headSwayNorm = (targetSign * (impact.head.x - address.head.x)) / swRef;
  }

  // Lead arm at the top: the trail arm folds, the lead arm should stay long.
  if (top) {
    out.leadArmTopDeg = Math.max(top.leftArmDeg ?? 0, top.rightArmDeg ?? 0) || null;
  }
  out.kneeFlexAddressDeg = address.leftKneeDeg != null && address.rightKneeDeg != null
    ? (address.leftKneeDeg + address.rightKneeDeg) / 2
    : null;

  out.stanceDeg = address.stanceDeg;
  return out;
}
