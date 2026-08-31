// Screen wiring for Swing Lab.

import { $, $$, getSettings, setSetting, fmt0, fmt1, ratioLabel, fmtClock, clamp, escapeHtml } from './util.js';
import { analyseSwing } from './analyse.js';
import { coachReport } from './coach.js';
import { drawTrace, drawEnergy, drawSparkline, sizeCanvasTo } from './overlay.js';
import { Capture, captureSupported } from './capture.js';
import { Tracer } from './tracer.js';
import {
  getProfile, saveProfile, deleteProfile,
  shouldOfferProfile, declineProfile, countAnalysis, shortName,
} from './profile.js';
import {
  saveShot, listShots, getShot, deleteShot, clearShots,
  storageEstimate, requestPersistence, pruneClips, MAX_STORED_CLIP_BYTES, newId,
} from './store.js';

const state = {
  screen: 'range',
  history: [],
  pendingClip: null,
  report: null,
  shotId: null,
  clipUrl: null,
  stillUrls: {},
  stillImages: {},
  frame: 'address',
  phase: 'all',
  capture: null,
  tracer: null,
  pane: 'numbers',
  mode: getSettings().captureMode,
  cancelled: false,
};

/* ── Navigation ──────────────────────────────────────────────────── */

function go(screen, { replace = false } = {}) {
  if (!replace && state.screen !== screen) state.history.push(state.screen);
  state.screen = screen;
  document.body.dataset.screen = screen;
  $('#backBtn').hidden = screen === 'range';
  window.scrollTo(0, 0);
  if (screen !== 'camera' && state.capture) {
    state.capture.stop();
    state.capture = null;
  }
}

function back() {
  const prev = state.history.pop() || 'range';
  state.screen = prev;
  document.body.dataset.screen = prev;
  $('#backBtn').hidden = prev === 'range';
  if (prev !== 'camera' && state.capture) {
    state.capture.stop();
    state.capture = null;
  }
  if (prev === 'range') refreshSession();
}

/** Show the profile in the header and on the settings screen. */
function renderProfile() {
  const profile = getProfile();
  const chip = $('#whoChip');
  chip.hidden = !profile;
  if (profile) chip.textContent = shortName(profile);
  $('#settingsName').value = profile ? profile.name : '';
  $('#profileDelete').hidden = !profile;
  $('#profileState').textContent = profile
    ? `Saved on this phone since ${new Date(profile.createdAt).toLocaleDateString()}. It has never left it.`
    : 'No profile yet. Adding one puts your name on your shots and makes the distances and angles real rather than assumed.';
}

/**
 * Offer the profile after a swing has been analysed — never before. The whole
 * point is that the value is visible first.
 */
function maybeOfferProfile() {
  if (!shouldOfferProfile()) return;
  const s = getSettings();
  $('#profileName').value = '';
  $('#profileHanded').value = s.handed;
  $('#profileHeight').value = s.heightCm;
  $('#profileSheet').hidden = false;
  setTimeout(() => $('#profileName').focus({ preventScroll: true }), 250);
}

function closeProfileSheet() {
  $('#profileSheet').hidden = true;
}

let toastTimer = null;
function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ── Settings ────────────────────────────────────────────────────── */

function bindSettings() {
  const s = getSettings();
  document.body.classList.toggle('sunlight', s.sunlight);

  $('#clubSelect').value = s.club;
  $('#angleSelect').value = s.angle;
  $('#angleSelect2').value = s.angle;
  $('#handedSelect').value = s.handed;
  $('#heightInput').value = s.heightCm;
  $('#slomoSelect').value = s.slomo;
  $('#autoStopInput').value = s.autoStopSec;
  $('#keepClipsToggle').checked = s.keepClips;
  $('#sunlightToggle').checked = s.sunlight;

  const syncAngle = (v) => {
    setSetting('angle', v);
    $('#angleSelect').value = v;
    $('#angleSelect2').value = v;
  };
  $('#clubSelect').addEventListener('change', (e) => setSetting('club', e.target.value));
  $('#angleSelect').addEventListener('change', (e) => syncAngle(e.target.value));
  $('#angleSelect2').addEventListener('change', (e) => syncAngle(e.target.value));
  $('#handedSelect').addEventListener('change', (e) => setSetting('handed', e.target.value));
  $('#heightInput').addEventListener('change', (e) => {
    const v = clamp(Number(e.target.value) || 178, 120, 220);
    e.target.value = v;
    setSetting('heightCm', v);
  });
  $('#slomoSelect').addEventListener('change', (e) => setSetting('slomo', e.target.value));
  $('#autoStopInput').addEventListener('change', (e) => {
    const v = clamp(Number(e.target.value) || 3, 1, 10);
    e.target.value = v;
    setSetting('autoStopSec', v);
  });
  $('#keepClipsToggle').addEventListener('change', (e) => setSetting('keepClips', e.target.checked));
  $('#sunlightToggle').addEventListener('change', (e) => {
    setSetting('sunlight', e.target.checked);
    document.body.classList.toggle('sunlight', e.target.checked);
  });

  storageEstimate().then((est) => {
    if (!est || !est.usage) return;
    const mb = (est.usage / 1048576).toFixed(0);
    $('#storageNote').textContent = `Swing Lab is using about ${mb} MB on this phone.`;
  });
}

/* ── Analysis flow ───────────────────────────────────────────────── */

function chooseAngleThenAnalyse(blob) {
  state.pendingClip = blob;
  const s = getSettings();
  if (s.angle === 'ask') {
    $('#rememberAngle').checked = false;
    go('angle');
  } else {
    runAnalysis(blob, s.angle);
  }
}

async function runAnalysis(blob, view) {
  const s = getSettings();
  state.cancelled = false;
  go('analysing');
  $('#analyseFill').style.width = '0%';
  $('#analyseStage').textContent = 'Reading the clip';

  try {
    const report = await analyseSwing(blob, {
      view,
      handed: s.handed,
      heightCm: s.heightCm,
      slomo: s.slomo,
      club: s.club,
      onProgress: (stage, frac) => {
        if (state.cancelled) return;
        $('#analyseStage').textContent = stage;
        $('#analyseFill').style.width = `${Math.round(frac * 100)}%`;
      },
    });
    if (state.cancelled) { go('range', { replace: true }); return; }

    const keepClip = s.keepClips && blob.size <= MAX_STORED_CLIP_BYTES;
    const shot = { ...report, id: newId(), clip: keepClip ? blob : null, clipType: blob.type };
    // Make room before writing, so a long session of slow-motion clips degrades
    // by forgetting the oldest video rather than by failing to save.
    const dropped = await pruneClips().catch(() => 0);
    await saveShot(shot).catch(() => toast('Could not save this shot locally, but here it is.'));
    if (!keepClip && s.keepClips) {
      toast('Clip was too large to keep, so only the analysis was saved.');
    } else if (dropped > 0) {
      toast(`Storage was filling up, so the video from ${dropped} older shot${dropped > 1 ? 's was' : ' was'} dropped. Their measurements are still there.`, 4200);
    }
    state.history = ['range'];
    countAnalysis();
    showReport(shot);
    maybeOfferProfile();
  } catch (err) {
    console.error(err);
    go('range', { replace: true });
    toast(err.message || 'That clip could not be analysed.', 5200);
  } finally {
    state.pendingClip = null;
  }
}

/* ── Report ──────────────────────────────────────────────────────── */

function releaseUrls() {
  if (state.tracer) state.tracer.stop();
  for (const url of Object.values(state.stillUrls)) URL.revokeObjectURL(url);
  state.stillUrls = {};
  state.stillImages = {};
  if (state.clipUrl) {
    URL.revokeObjectURL(state.clipUrl);
    state.clipUrl = null;
  }
}

function loadImage(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => resolve({ img: null, url });
    img.src = url;
  });
}

async function showReport(shot) {
  releaseUrls();
  state.report = shot;
  state.shotId = shot.id;
  state.frame = 'address';
  state.phase = 'all';
  go('report');
  setPane('numbers');

  for (const key of ['address', 'top', 'impact', 'finish']) {
    const blob = shot.stills && shot.stills[key];
    if (!blob) continue;
    const { img, url } = await loadImage(blob);
    state.stillUrls[key] = url;
    state.stillImages[key] = img;
  }

  $$('#frameTabs button').forEach((b) => b.classList.toggle('on', b.dataset.frame === 'address'));
  $$('#phaseTabs button').forEach((b) => b.classList.toggle('on', b.dataset.phase === 'all'));
  renderReport();
  renderClip(shot);
}

function confidenceLabel(c) {
  if (c >= 0.66) return { text: 'Good read', cls: 'high' };
  if (c >= 0.4) return { text: 'Fair read', cls: '' };
  return { text: 'Rough read', cls: 'low' };
}

function tile(label, value, note, level = '') {
  return `<div class="tile ${escapeHtml(level)}">
    <div class="tile-label">${escapeHtml(label)}</div>
    <div class="tile-value">${escapeHtml(value)}</div>
    <div class="tile-note">${escapeHtml(note || '')}</div>
  </div>`;
}

function buildTiles(r) {
  const t = r.timing || {};
  const c = r.club || {};
  const b = r.body || {};
  const out = [];

  const ratio = t.tempoRatio;
  const tempoLevel = Number.isFinite(ratio)
    ? (ratio >= 2.7 && ratio <= 3.3 ? 'good' : 'watch')
    : '';
  out.push(tile('Tempo', ratioLabel(ratio), 'Backswing to downswing. 3:1 is the tour benchmark.', tempoLevel));

  const timesKnown = r.slomo && (r.slomo.source === 'manual' || r.slomo.autoConfident);
  out.push(tile('Swing timing',
    timesKnown ? `${t.backswingSec?.toFixed(2)}s / ${t.downswingSec?.toFixed(2)}s` : '—',
    timesKnown ? 'Back / down, in real seconds.' : 'Set the slow-motion factor below to get real seconds.'));

  if (r.view === 'dtl') {
    if (Number.isFinite(c.planeShiftDeg) && c.planeFitQuality > 0.65) {
      const s = c.planeShiftDeg;
      out.push(tile('Plane shift', `${s > 0 ? '+' : ''}${fmt1(s)}°`,
        s > 4 ? 'Steeper coming down — over the top.' : s < -4 ? 'Shallower coming down.' : 'Down matches back.',
        s > 4 ? 'watch' : 'good'));
    }
    if (Number.isFinite(c.impactDirectionDeg)) {
      const d = c.impactDirectionDeg;
      out.push(tile('Through impact',
        d < -3 ? 'Out to in' : d > 3 ? 'In to out' : 'Straight',
        'Direction the head travels across the ball.',
        d < -3 ? 'watch' : ''));
    }
    if (Number.isFinite(r.ball?.startLineDeg)) {
      out.push(tile('Start line', `${fmt1(Math.abs(r.ball.startLineDeg))}° ${r.ball.startLineDeg > 0 ? 'R' : 'L'}`,
        'Off the line the phone was pointing.'));
    }
  } else {
    if (Number.isFinite(c.lowPointOffsetCm)) {
      const d = c.lowPointOffsetCm;
      out.push(tile('Low point', `${d > 0 ? '+' : ''}${fmt0(d)} cm`,
        d > 2 ? 'Past the ball — ball then turf.' : d < -2 ? 'Behind the ball — fat and thin live here.' : 'Level with the ball.',
        d > 2 ? 'good' : d < -2 ? 'watch' : ''));
    }
    if (Number.isFinite(c.attackAngleDeg)) {
      const a = c.attackAngleDeg;
      out.push(tile('Attack angle', `${fmt1(a)}°`,
        a < -2 ? 'Hitting down on it.' : a > 2 ? 'Hitting up on it.' : 'Level at the ball.'));
    }
    if (Number.isFinite(c.speedMph)) {
      out.push(tile('Club speed', `${fmt0(c.speedMph)} mph`,
        c.speedIsLowerBound ? 'Reads low from this angle — compare shots, not absolutes.' : 'Estimated from your height. Compare shots, not absolutes.'));
    }
    if (Number.isFinite(b.shoulderTurnDeg)) {
      out.push(tile('Shoulder turn', `${fmt0(b.shoulderTurnDeg)}°`, 'Estimated from shoulder width on camera.'));
    }
    if (Number.isFinite(b.headSwayCm)) {
      out.push(tile('Head movement', `${fmt0(Math.abs(b.headSwayCm))} cm`,
        b.headSwayCm > 0 ? 'Towards the target.' : 'Away from the target.',
        Math.abs(b.headSwayCm) > 7 ? 'watch' : 'good'));
    }
  }
  if (Number.isFinite(r.ball?.launchAngleDeg)) {
    out.push(tile('Launch angle', `${fmt1(r.ball.launchAngleDeg)}°`, 'From the first frames of flight.'));
  }
  return out.join('');
}

function row(label, value) {
  return value == null || value === ''
    ? ''
    : `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}
const group = (label) => `<tr class="group"><th colspan="2">${escapeHtml(label)}</th></tr>`;
const dgr = (v, d = 1) => (Number.isFinite(v) ? `${v.toFixed(d)}°` : null);
const cmv = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} cm` : null);
const sec = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} s` : null);

function buildNumbers(r) {
  const t = r.timing || {};
  const c = r.club || {};
  const b = r.body || {};
  const ball = r.ball || {};
  const timesKnown = r.slomo && (r.slomo.source === 'manual' || r.slomo.autoConfident);
  let html = '';

  html += group('Tempo');
  html += row('Ratio', ratioLabel(t.tempoRatio));
  if (timesKnown) {
    html += row('Backswing', sec(t.backswingSec));
    html += row('Downswing', sec(t.downswingSec));
    html += row('Address to finish', sec(t.totalSec));
  }
  html += row('Frames across the swing', t.framesInSwing ?? null);

  html += group('Club');
  if (r.view === 'dtl') {
    // Shaft plane and across-the-ball direction only mean anything when the
    // camera is looking down the target line.
    html += row('Backswing plane', dgr(c.backswingPlaneDeg));
    html += row('Downswing plane', dgr(c.downswingPlaneDeg));
    html += row('Plane shift', Number.isFinite(c.planeShiftDeg) ? `${c.planeShiftDeg > 0 ? '+' : ''}${c.planeShiftDeg.toFixed(1)}°` : null);
    html += row('Direction through impact', dgr(c.impactDirectionDeg));
  }
  html += row('Angle of attack', dgr(c.attackAngleDeg));
  html += row('Low point vs ball', cmv(c.lowPointOffsetCm));
  html += row('Club speed (estimate)', Number.isFinite(c.speedMph) ? `${c.speedMph.toFixed(0)} mph` : null);
  html += row('Club head followed', Number.isFinite(c.trackCoverage) ? `${Math.round(c.trackCoverage * 100)}% of frames` : null);

  if (r.poseOk) {
    html += group('Body');
    html += row('Spine tilt at address', dgr(b.spineTiltAddressDeg));
    html += row('Spine change to impact', dgr(b.spineChangeDeg));
    html += row('Shoulder turn at top', dgr(b.shoulderTurnDeg, 0));
    html += row('Hip turn at top', dgr(b.hipTurnDeg, 0));
    html += row('X-factor', dgr(b.xFactorDeg, 0));
    html += row('Lead arm at top', dgr(b.leadArmTopDeg, 0));
    html += row('Head sway to impact', cmv(b.headSwayCm));
    html += row('Head height change', cmv(b.headLiftCm));
    html += row('Hip shift to target', cmv(b.hipShiftCm));
    html += row('Knee flex at address', dgr(b.kneeFlexAddressDeg, 0));
  }

  if (ball.tracked) {
    html += group('Ball');
    html += row('Launch angle', dgr(ball.launchAngleDeg));
    html += row('Start line', dgr(ball.startLineDeg));
    html += row('Ball speed (estimate)', Number.isFinite(ball.speedMph) ? `${ball.speedMph.toFixed(0)} mph` : null);
  }

  html += group('The footage');
  html += row('Clip frame rate', r.fps ? `${Math.round(r.fps)} fps` : null);
  html += row('Slow motion', r.slomo ? `${r.slomo.factor}×${r.slomo.source === 'auto' ? ' (detected)' : ' (set by you)'}` : null);
  html += row('Effective frame rate', r.effectiveFps ? `${Math.round(r.effectiveFps)} fps` : null);
  html += row('Camera angle', r.view === 'dtl' ? 'Down the line' : 'Face on');
  return html;
}

function renderReport() {
  const r = state.report;
  if (!r) return;
  const coach = coachReport(r);

  $('#reportTitle').textContent = `${r.clubName || 'Swing'} — ${r.view === 'dtl' ? 'down the line' : 'face on'}`;
  $('#reportMeta').textContent = `${fmtClock(r.ts)} · ${Math.round(r.fps || 0)} fps · ${r.slomo ? `${r.slomo.factor}× slow motion` : ''}`;
  const conf = confidenceLabel(r.confidence ?? 0);
  const badge = $('#reportConfidence');
  badge.textContent = conf.text;
  badge.className = `confidence ${conf.cls}`;

  $('#headlineTitle').textContent = coach.headline.title;
  $('#headlineText').textContent = coach.headline.text;
  $('#verdictTitle').textContent = coach.headline.title;
  $('#tiles').innerHTML = buildTiles(r);

  const warnings = (r.warnings || []).map((w) => `<div class="note watch"><div><h3>Worth knowing</h3><p>${escapeHtml(w)}</p></div></div>`).join('');
  const notes = coach.notes.map((n) => `<div class="note ${escapeHtml(n.level)}"><div><h3>${escapeHtml(n.title)}</h3><p>${escapeHtml(n.text)}</p></div></div>`).join('');
  const caveats = (r.notes || []).map((n) => `<div class="note"><div><h3>Note</h3><p>${escapeHtml(n)}</p></div></div>`).join('');
  $('#notesList').innerHTML = warnings + notes + caveats;

  $('#numbersTable').innerHTML = buildNumbers(r);
  $('#tipsList').innerHTML = coach.filming.map((t) => `<li>${escapeHtml(t)}</li>`).join('');

  $$('#slomoTabs button').forEach((b) => b.classList.toggle('on', Number(b.dataset.factor) === (r.slomo?.factor || 1)));
  $('#slomoNote').textContent = r.slomo?.source === 'auto'
    ? `Detected as ${r.slomo.factor}× from the length of the swing${r.slomo.autoConfident ? '' : ' — but not confidently'}. Ratios and angles are right either way; only the times in seconds depend on this.`
    : `Set to ${r.slomo?.factor}×. Ratios and angles do not depend on this — only the times in seconds do.`;

  $('#poseToggle').parentElement.hidden = !r.poseOk;
  drawReportCanvases();
}

/** Switch report pane. Canvases in a hidden pane have no width, so anything
 *  that draws has to wait until its pane is showing. */
function setPane(pane) {
  state.pane = pane;
  $('#screen-report').dataset.pane = pane;
  $$('#reportTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === pane));
  window.scrollTo(0, 0);
  if (pane === 'numbers') drawReportCanvases();
  if (pane === 'path') {
    drawReportCanvases();
    if (state.tracer) state.tracer.draw();
  }
}

/** Usable width for a canvas, or 0 when its pane is not on screen. */
function paneWidth(canvas) {
  const parent = canvas.parentElement;
  return parent ? parent.clientWidth - 28 : 0;
}

function drawReportCanvases() {
  const r = state.report;
  if (!r) return;
  // Each canvas is measured against its own container: they live in different
  // panes now, and only one pane has a width at any moment.
  const traceCanvas = $('#traceCanvas');
  const traceWidth = paneWidth(traceCanvas);
  if (traceWidth > 0) {
    const aspect = r.trace?.aspect || (r.videoHeight / r.videoWidth) || 0.5625;
    const ctx = sizeCanvasTo(traceCanvas, aspect, Math.max(200, traceWidth));
    const wantPose = $('#poseToggle').checked;
    const havePose = Boolean(r.poseFrames && r.poseFrames[state.frame]);
    drawTrace(ctx, state.stillImages[state.frame], r, {
      phase: state.phase,
      showPose: wantPose && havePose ? state.frame : null,
    });
    const poseNote = $('#poseNote');
    poseNote.hidden = !wantPose || havePose;
    if (wantPose && !havePose) {
      poseNote.textContent = `Your body could not be picked out in the ${state.frame} frame, so there are no angles to draw on it. That usually means part of you was out of shot or motion-blurred.`;
    }
  }

  const energyCanvas = $('#energyCanvas');
  const energyWidth = paneWidth(energyCanvas);
  if (energyWidth > 0) drawEnergy(energyCanvas, r, Math.max(200, energyWidth));
}

function renderClip(shot) {
  const video = $('#clipVideo');
  const stage = $('#clipStage');
  const missing = $('#clipMissing');
  const controls = ['#speedRow', '#jumpRow', '#replayBtn'];

  if (state.tracer) state.tracer.stop();
  if (!shot.clip) {
    // The analysis survives even when the clip does not, so say why rather
    // than quietly dropping the whole section.
    stage.hidden = true;
    missing.hidden = false;
    missing.textContent = shot.clipPruned
      ? 'The video for this shot was cleared to make room for newer ones. Its measurements are all still here.'
      : getSettings().keepClips
        ? 'This clip was too large to keep on the phone, so there is nothing left to play. The measurements below are all from it.'
        : 'Clips are not being kept on this phone, so there is nothing to play. Turn on “Keep clips” in settings to get the tracer.';
    controls.forEach((sel) => { $(sel).style.display = 'none'; });
    video.removeAttribute('src');
    return;
  }

  stage.hidden = false;
  missing.hidden = true;
  controls.forEach((sel) => { $(sel).style.display = ''; });
  state.clipUrl = URL.createObjectURL(shot.clip);
  video.src = state.clipUrl;
  video.playbackRate = 1;
  $$('#speedRow button').forEach((b) => b.classList.toggle('on', b.dataset.rate === '1'));
  video.load();

  if (!state.tracer) state.tracer = new Tracer(video, $('#tracerCanvas'));
  const tracer = state.tracer;
  tracer.setEnabled($('#tracerToggle').checked);

  const attach = () => {
    tracer.setReport(shot);
    // Start at address rather than at whatever dead air precedes it.
    const start = shot.events && Number.isFinite(shot.events.address)
      ? Math.max(0, shot.events.address - 0.15)
      : 0;
    if (video.duration && start < video.duration) video.currentTime = start;
    tracer.draw();
  };
  if (video.readyState >= 1) attach();
  else video.addEventListener('loadedmetadata', attach, { once: true });
}

/** Play the clip from just before address. */
function replayClip() {
  const video = $('#clipVideo');
  const r = state.report;
  if (!video.src || !video.duration) return;
  const start = r && r.events && Number.isFinite(r.events.address)
    ? Math.max(0, r.events.address - 0.15)
    : 0;
  video.currentTime = Math.min(start, video.duration - 0.05);
  video.play().catch(() => {});
}

/** Recompute the numbers that depend on the slow-motion factor. */
function applySlomo(factor) {
  const r = state.report;
  if (!r || !r.timingRaw) return;
  r.slomo = { ...r.slomo, factor, source: 'manual' };
  r.effectiveFps = (r.fps || 30) * factor;
  r.timing = {
    ...r.timing,
    backswingSec: r.timingRaw.backswingSec / factor,
    downswingSec: r.timingRaw.downswingSec / factor,
    totalSec: r.timingRaw.totalSec / factor,
  };
  if (r.club && Number.isFinite(r.club.speedMphPerFactor)) {
    const mph = r.club.speedMphPerFactor * factor;
    // Same plausibility bound the analysis applies: a corrected factor can push
    // an estimate out of any believable range.
    r.club.speedMph = mph >= 15 && mph <= 160 ? mph : null;
  }
  renderReport();
  saveShot(r).catch(() => {});
}

/* ── Session list ────────────────────────────────────────────────── */

async function refreshSession() {
  let shots = [];
  try {
    shots = await listShots();
  } catch {
    /* storage unavailable; the app still works for one-off analysis */
  }
  const list = $('#shotList');
  list.innerHTML = '';
  $('#emptyState').hidden = shots.length > 0;
  $('#clearSessionBtn').hidden = shots.length === 0;

  for (const shot of shots.slice(0, 40)) {
    const btn = document.createElement('button');
    btn.className = 'shot';
    const still = shot.stills && shot.stills.impact;
    // Built as nodes, not markup: these values come back out of storage, and a
    // stored record is exactly the thing that should never be able to inject.
    if (still) {
      const img = document.createElement('img');
      img.src = URL.createObjectURL(still);
      img.alt = '';
      btn.appendChild(img);
    } else {
      btn.appendChild(document.createElement('div')).className = 'shot-img';
    }
    const main = document.createElement('div');
    main.className = 'shot-main';
    const name = document.createElement('strong');
    name.textContent = shot.clubName || 'Swing';
    const when = document.createElement('span');
    when.textContent = `${fmtClock(shot.ts)} · ${shot.view === 'dtl' ? 'Down the line' : 'Face on'}`;
    main.append(name, when);
    const tempo = document.createElement('div');
    tempo.className = 'shot-tempo';
    tempo.textContent = shot.timing && Number.isFinite(shot.timing.tempoRatio)
      ? shot.timing.tempoRatio.toFixed(1)
      : '–';
    btn.append(main, tempo);
    btn.addEventListener('click', async () => {
      const full = await getShot(shot.id);
      if (full) showReport(full);
    });
    list.appendChild(btn);
  }

  const ratios = shots
    .slice()
    .reverse()
    .map((s) => s.timing && s.timing.tempoRatio)
    .filter((v) => Number.isFinite(v));
  const card = $('#trendCard');
  if (ratios.length >= 2) {
    card.hidden = false;
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    $('#trendValue').textContent = `${ratios.length} swings · average ${avg.toFixed(1)} : 1`;
    drawSparkline($('#trendSpark'), ratios, card.clientWidth - 28);
  } else {
    card.hidden = true;
  }
}

/* ── Camera ──────────────────────────────────────────────────────── */

const MODE_HELP = {
  auto: 'Prop the phone up, walk into frame, then settle over the ball. Recording starts when you go still and stops just after the swing.',
  timer: 'Ten seconds to get set, then it records for six.',
  tap: 'Tap to start, tap again to stop.',
};

const STATUS_TEXT = {
  ready: 'Ready',
  recording: 'Recording',
  'auto-waiting': 'Waiting for you to step into frame',
  'auto-settling': 'Settle over the ball and hold still',
  'auto-rolling': 'Rolling — swing whenever you like',
  'auto-swing': 'Got it — hold on',
};

function setMode(mode) {
  state.mode = mode;
  setSetting('captureMode', mode);
  $$('#modeTabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('#modeHelp').textContent = MODE_HELP[mode];
  $('#shutterBtn').querySelector('.btn-title')?.remove();
  $('#shutterBtn').textContent = mode === 'auto' ? 'Arm it' : mode === 'timer' ? 'Start countdown' : 'Record';
  if (state.capture) state.capture.stopAuto?.();
}

async function openCamera() {
  if (!captureSupported()) {
    toast('This browser cannot record video. Film in the Camera app and upload instead.', 5000);
    return;
  }
  go('camera');
  setMode(state.mode);
  const capture = new Capture($('#preview'), {
    autoStopSec: getSettings().autoStopSec,
    onState: (s, detail) => {
      const pill = $('#camStatus');
      pill.classList.toggle('live', s === 'recording' || s === 'auto-swing');
      pill.classList.toggle('armed', s === 'auto-rolling');
      if (s === 'counting') pill.textContent = `Recording in ${detail}…`;
      else pill.textContent = STATUS_TEXT[s] || s;
      if (s === 'recording') $('#shutterBtn').textContent = 'Stop';
      else if (state.mode === 'tap') $('#shutterBtn').textContent = 'Record';
    },
    onLevel: (v) => { $('#levelFill').style.width = `${Math.round(v * 100)}%`; },
    onClip: (blob) => {
      if (state.capture) state.capture.stopAuto?.();
      chooseAngleThenAnalyse(blob);
    },
  });
  state.capture = capture;
  try {
    await capture.start();
    $('#camStatus').textContent = 'Ready';
  } catch (err) {
    console.error(err);
    toast('Camera access was refused. Check Safari’s site settings, or upload a clip instead.', 5200);
    back();
  }
}

/* ── Offline pack ────────────────────────────────────────────────── */

const OFFLINE_ASSETS = [
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/wasm/vision_wasm_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
  'vendor/mediapipe/models/pose_landmarker_lite.task',
];

async function downloadOfflinePack() {
  const btn = $('#offlineBtn');
  btn.disabled = true;
  const note = $('#offlineNote');
  try {
    const cache = await caches.open('swinglab-models-v1');
    let done = 0;
    for (const asset of OFFLINE_ASSETS) {
      note.textContent = `Downloading body-tracking model… ${done} of ${OFFLINE_ASSETS.length}`;
      await cache.add(new Request(asset, { cache: 'reload' }));
      done++;
    }
    note.textContent = 'Downloaded. Body tracking now works with no signal.';
    await requestPersistence();
  } catch (err) {
    console.error(err);
    note.textContent = 'Download failed. Try again on a better connection.';
  } finally {
    btn.disabled = false;
  }
}

/* ── Wiring ──────────────────────────────────────────────────────── */

function bindEvents() {
  $('#backBtn').addEventListener('click', back);
  $('#settingsBtn').addEventListener('click', () => go('settings'));
  $('#openCameraBtn').addEventListener('click', openCamera);
  $('#closeCamBtn').addEventListener('click', back);

  $('#fileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) chooseAngleThenAnalyse(file);
  });

  $$('#modeTabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#shutterBtn').addEventListener('click', () => {
    const c = state.capture;
    if (!c) return;
    if (state.mode === 'auto') {
      if (c.state.startsWith('auto')) { c.stopAuto(); $('#shutterBtn').textContent = 'Arm it'; }
      else { c.startAuto(); $('#shutterBtn').textContent = 'Disarm'; }
    } else if (state.mode === 'timer') {
      c.startTimer(10, 6);
    } else {
      c.toggleManual();
    }
  });

  $$('.choose-angle').forEach((b) => b.addEventListener('click', () => {
    const view = b.dataset.view;
    if ($('#rememberAngle').checked) setSetting('angle', view);
    bindSettingsValues();
    if (state.pendingClip) runAnalysis(state.pendingClip, view);
  }));

  $('#cancelAnalyseBtn').addEventListener('click', () => {
    state.cancelled = true;
    go('range', { replace: true });
  });

  $$('#reportTabs button').forEach((b) => b.addEventListener('click', () => {
    setPane(b.dataset.pane);
  }));
  $('#verdictStrip').addEventListener('click', () => setPane('tips'));

  $$('#phaseTabs button').forEach((b) => b.addEventListener('click', () => {
    state.phase = b.dataset.phase;
    $$('#phaseTabs button').forEach((x) => x.classList.toggle('on', x === b));
    drawReportCanvases();
  }));
  $$('#frameTabs button').forEach((b) => b.addEventListener('click', () => {
    state.frame = b.dataset.frame;
    $$('#frameTabs button').forEach((x) => x.classList.toggle('on', x === b));
    drawReportCanvases();
  }));
  $('#poseToggle').addEventListener('change', drawReportCanvases);
  $$('#slomoTabs button').forEach((b) => b.addEventListener('click', () => applySlomo(Number(b.dataset.factor))));

  $$('#jumpRow button').forEach((b) => b.addEventListener('click', () => {
    const r = state.report;
    const v = $('#clipVideo');
    if (!r || !r.events || !v.duration) return;
    v.pause();
    v.currentTime = clamp(r.events[b.dataset.jump] ?? 0, 0, v.duration - 0.01);
  }));
  const stepFrame = (dir) => {
    const r = state.report;
    const v = $('#clipVideo');
    if (!v.duration) return;
    v.pause();
    v.currentTime = clamp(v.currentTime + dir / (r?.fps || 30), 0, v.duration - 0.01);
  };
  $('#framePrev').addEventListener('click', () => stepFrame(-1));
  $('#frameNext').addEventListener('click', () => stepFrame(1));

  // Tracer: the redraw loop only runs while the clip is actually playing;
  // everywhere else a single redraw on the new frame is enough.
  const clip = $('#clipVideo');
  clip.addEventListener('play', () => state.tracer && state.tracer.start());
  clip.addEventListener('pause', () => state.tracer && state.tracer.stop());
  clip.addEventListener('ended', () => state.tracer && state.tracer.stop());
  for (const ev of ['seeked', 'loadeddata', 'timeupdate']) {
    clip.addEventListener(ev, () => state.tracer && state.tracer.draw());
  }
  $('#tracerToggle').addEventListener('change', (e) => {
    if (state.tracer) state.tracer.setEnabled(e.target.checked);
  });
  $('#replayBtn').addEventListener('click', replayClip);
  $$('#speedRow button').forEach((b) => b.addEventListener('click', () => {
    clip.playbackRate = Number(b.dataset.rate);
    $$('#speedRow button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  $('#anotherBtn').addEventListener('click', () => { releaseUrls(); go('range', { replace: true }); refreshSession(); });
  $('#deleteShotBtn').addEventListener('click', async () => {
    if (!state.shotId) return;
    await deleteShot(state.shotId).catch(() => {});
    releaseUrls();
    go('range', { replace: true });
    refreshSession();
    toast('Shot deleted.');
  });
  $('#clearSessionBtn').addEventListener('click', async () => {
    if (!window.confirm('Delete every shot stored on this phone?')) return;
    await clearShots().catch(() => {});
    refreshSession();
  });
  $('#clearAllBtn').addEventListener('click', async () => {
    if (!window.confirm('Delete every shot stored on this phone?')) return;
    await clearShots().catch(() => {});
    toast('All shots deleted.');
  });
  $('#offlineBtn').addEventListener('click', downloadOfflinePack);

  $('#whoChip').addEventListener('click', () => go('settings'));
  $('#profileLater').addEventListener('click', () => {
    declineProfile();
    closeProfileSheet();
  });
  $('#profileSheet').addEventListener('click', (e) => {
    // Tapping the backdrop is the same as "not now".
    if (e.target === $('#profileSheet')) {
      declineProfile();
      closeProfileSheet();
    }
  });
  $('#profileCreate').addEventListener('click', () => {
    const name = $('#profileName').value.trim();
    if (!name) {
      $('#profileName').focus();
      toast('A name is all it needs.');
      return;
    }
    const saved = saveProfile({
      name,
      handed: $('#profileHanded').value,
      heightCm: Number($('#profileHeight').value),
    });
    closeProfileSheet();
    if (!saved) {
      toast('Your phone would not let the profile be saved. Private browsing blocks it.', 5000);
      return;
    }
    bindSettings();
    renderProfile();
    toast(`Saved. Good to meet you, ${shortName(saved)}.`);
  });
  $('#settingsName').addEventListener('change', (e) => {
    const name = e.target.value.trim();
    if (!name) return;
    saveProfile({ name });
    renderProfile();
  });
  $('#profileDelete').addEventListener('click', () => {
    if (!window.confirm('Delete your profile? Your shots stay where they are.')) return;
    deleteProfile();
    renderProfile();
    toast('Profile deleted.');
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.screen === 'report') drawReportCanvases();
      if (state.screen === 'range') refreshSession();
    }, 180);
  });
}

/** Re-sync the visible controls after a setting changes elsewhere. */
function bindSettingsValues() {
  const s = getSettings();
  $('#angleSelect').value = s.angle;
  $('#angleSelect2').value = s.angle;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  });
}

requestPersistence().catch(() => {});
bindSettings();
renderProfile();
bindEvents();
setMode(getSettings().captureMode);
refreshSession();
registerServiceWorker();

// Debug hook — inspect the current report from the console.
window.__swingLab = state;
