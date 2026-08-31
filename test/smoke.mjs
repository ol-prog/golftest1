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

const checks = [];
const ok = (name, cond) => checks.push(`${cond ? 'ok  ' : 'FAIL'} ${name}`);

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
ok(`arc tangent at bottom is level (${d.attackAngleDeg?.toFixed(1)}°)`, Math.abs(d.attackAngleDeg) < 2);
const d2 = club.deliveryMetrics(pts, times, 0, 20, 'right', framesFor);
ok(`arc tangent 10° before bottom descends (${d2.attackAngleDeg?.toFixed(1)}°)`, d2.attackAngleDeg < -6 && d2.attackAngleDeg > -14);

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
