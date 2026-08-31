import { readFileSync } from 'node:fs';
// Run with: node test/smoke.mjs
//
// Import every analysis module and exercise the pure functions, to catch
// anything the browser runs only on an unusual path.
import * as util from '../js/util.js';
import * as motion from '../js/motion.js';
import * as events from '../js/events.js';
import * as club from '../js/club.js';
import * as ball from '../js/ball.js';
import * as coach from '../js/coach.js';

// Every module must load and expose what its importers reach for. A missed
// export shows up in the browser only as a blank screen, because the whole
// module graph fails at once.
const MODULES = {
  '../js/util.js': ['clamp', 'smooth', 'argmax', 'fitLine', 'getSettings'],
  '../js/motion.js': ['toGray', 'diff', 'blobs', 'refineAround', 'noiseFloor'],
  '../js/events.js': ['computeEnergy', 'detectEvents', 'estimateSlomo'],
  '../js/club.js': ['trackClub', 'smoothTrack', 'cleanTrack', 'clubMetrics',
    'deliveryMetrics', 'framesForFactory', 'strikeIndexFromBall', 'estimateBodyCentre'],
  '../js/ball.js': ['findBallAtRest', 'trackBall', 'launchFromPath', 'flightCurve'],
  '../js/pose.js': ['loadPose', 'detectOn', 'poseSummary', 'bodyMetrics', 'pixelScale', 'poseLooksHuman'],
  '../js/coach.js': ['coachReport', 'filmingTips'],
  '../js/overlay.js': ['drawTrace', 'drawPosture', 'drawEnergy', 'drawSparkline', 'smoothPath', 'sizeCanvasTo'],
  '../js/frames.js': ['loadVideo', 'scanCoarse', 'extractRange', 'grabStill', 'detectFrameRate'],
  '../js/analyse.js': ['analyseSwing'],
  '../js/tracer.js': ['Tracer'],
  '../js/store.js': ['saveShot', 'listShots', 'deleteShot', 'pruneClips'],
  '../js/capture.js': ['Capture', 'captureSupported'],
  '../js/profile.js': ['getProfile', 'saveProfile', 'deleteProfile',
    'shouldOfferProfile', 'declineProfile', 'countAnalysis', 'shortName'],
};

const checks = [];
const ok = (name, cond) => checks.push(`${cond ? 'ok  ' : 'FAIL'} ${name}`);

for (const [path, names] of Object.entries(MODULES)) {
  let mod = null;
  try {
    mod = await import(path);
  } catch (err) {
    ok(`${path} imports (${err.message})`, false);
    continue;
  }
  const missing = names.filter((n) => mod[n] === undefined);
  ok(`${path} exports${missing.length ? ' — missing ' + missing.join(', ') : ''}`, missing.length === 0);
}

// --- security and privacy regressions ------------------------------------
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const directive = (name) => (csp.match(new RegExp(`${name} ([^;]+)`)) || [])[1]?.trim() || '';
ok('page declares a content security policy', csp.length > 0);
ok('no outbound connections allowed', directive('connect-src') === "'self'");
ok('no third-party script allowed', directive('script-src') === "'self' 'wasm-unsafe-eval'");
ok('no plugins or embeds', directive('object-src') === "'none'");
ok('referrer withheld', /name="referrer" content="no-referrer"/.test(html));

const bundle = readFileSync(new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url), 'utf8');
const outbound = [...bundle.matchAll(/https?:\/\/[a-zA-Z0-9.\-_/]+/g)].map((m) => m[0]);
ok(`vendored model code has no outbound URLs${outbound.length ? ' — found ' + outbound[0] : ''}`, outbound.length === 0);

ok('escapeHtml neutralises markup',
  util.escapeHtml('<img src=x onerror="alert(1)">') === '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
ok('escapeHtml handles null', util.escapeHtml(null) === '');

// Degenerate inputs must not throw.
ok('detectEvents too short', events.detectEvents(new Float64Array(4), [0, 1, 2, 3]).ok === false);
ok('detectEvents flat', events.detectEvents(new Float64Array(60).fill(1), Array.from({length: 60}, (_, i) => i / 30)).ok === false);
ok('estimateSlomo zero', events.estimateSlomo(0).factor === 1);
ok('estimateSlomo 8x', events.estimateSlomo(9.2).factor === 8);
ok('estimateSlomo real time', events.estimateSlomo(1.13).factor === 1);
ok('cleanTrack empty', club.cleanTrack([]).length === 0);
ok('cleanTrack all null', club.cleanTrack([{i:0,p:null},{i:1,p:null}]).every((p) => p === null));
ok('blobs empty', motion.blobs(new Uint8Array(100), 10, 10).length === 0);
ok('fitLine degenerate', util.fitLine([{x:1,y:1}]) === null);
ok('launch too short', ball.launchFromPath([{x:0,y:0,i:0}], 'faceon', 'right', 240, null).ok === false);

// A synthetic circular arc: the delivery tangent should come back level.
const times = [];
const pts = [];
for (let i = 0; i < 60; i++) {
  const phi = (-30 + i) * Math.PI / 180;
  times.push(i / 240);
  pts.push({ x: 100 + 80 * Math.sin(phi), y: 100 + 80 * Math.cos(phi) });
}
const framesFor = club.framesForFactory(times, 0, pts.length, 1);
const d = club.deliveryMetrics(pts, times, 0, 30, 'right', framesFor);
ok(`arc tangent at bottom is level (${d.attackAngleDeg?.toFixed(1)}°)`,
  Number.isFinite(d.attackAngleDeg) && Math.abs(d.attackAngleDeg) < 2);
const d2 = club.deliveryMetrics(pts, times, 0, 20, 'right', framesFor);
ok(`arc tangent 10° before bottom descends (${d2.attackAngleDeg?.toFixed(1)}°)`,
  Number.isFinite(d2.attackAngleDeg) && d2.attackAngleDeg < -6 && d2.attackAngleDeg > -14);

// A ragged arc must produce no angle at all rather than a confident wrong one.
const noisy = pts.map((p, i) => ({ x: p.x + (i % 2 ? 9 : -9), y: p.y + (i % 3 ? 8 : -8) }));
const d3 = club.deliveryMetrics(noisy, times, 0, 30, 'right', framesFor);
ok('a ragged arc yields no angle of attack', d3.attackAngleDeg === null);

// The coach must cope with a report that has almost nothing in it.
const bare = coach.coachReport({ view: 'faceon', timing: {}, club: {}, ball: {}, body: null });
ok('coach on an empty report', typeof bare.headline.title === 'string' && Array.isArray(bare.filming));
const full = coach.coachReport({
  view: 'dtl', timing: { tempoRatio: 2.0, backswingSec: 0.6, downswingSec: 0.3 },
  slomo: { factor: 8, source: 'auto', autoConfident: true },
  club: { planeShiftDeg: 8, planeFitQuality: 0.9, impactDirectionDeg: -6, trackCoverage: 0.9, deliveryMeasurable: true },
  ball: { tracked: true, startLineDeg: 4 }, body: { headLiftCm: 6, headSwayCm: -9, shoulderTurnDeg: 55 },
  effectiveFps: 240, poseOk: true,
});
ok(`coach finds faults (${full.notes.length} notes)`, full.notes.length >= 5 && full.headline.title.length > 0);

console.log(checks.join('\n'));
console.log(checks.some((c) => c.startsWith('FAIL')) ? '\nSOME CHECKS FAILED' : '\nall checks passed');

if (checks.some((c) => c.startsWith("FAIL"))) process.exitCode = 1;
