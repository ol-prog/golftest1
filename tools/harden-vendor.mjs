// Strip the telemetry endpoint out of the vendored MediaPipe bundle.
//
// MediaPipe Tasks batches usage logs to a Google endpoint. This app's whole
// privacy position is that nothing about a golfer's swing leaves their phone,
// so that call has to go. The Content-Security-Policy on the page blocks it
// too; this is the belt to that pair of braces, and it is here as a script so
// it can be re-applied and re-checked whenever the vendored bundle is updated.
//
//   node tools/harden-vendor.mjs          apply and verify
//   node tools/harden-vendor.mjs --check  verify only (used by the tests)

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../vendor/mediapipe/vision_bundle.mjs', import.meta.url);
const TELEMETRY = 'https://odml.pa.googleapis.com/v1/log';
// Same length is not required, but a same-origin path that does not exist keeps
// the failure inside the code path the bundle already handles: it records a
// logging error and carries on.
const NEUTERED = '/telemetry-disabled-by-swing-lab';

const checkOnly = process.argv.includes('--check');
let source = readFileSync(FILE, 'utf8');

const remaining = source.split(TELEMETRY).length - 1;
if (checkOnly) {
  const external = [...source.matchAll(/https?:\/\/[a-zA-Z0-9.\-_/]+/g)].map((m) => m[0]);
  if (remaining > 0 || external.length > 0) {
    console.error(`FAIL: vendored bundle still reaches out to: ${external.join(', ') || TELEMETRY}`);
    process.exit(1);
  }
  console.log('ok   vendored bundle contains no outbound URLs');
  process.exit(0);
}

if (remaining === 0) {
  console.log('already hardened; nothing to do');
} else {
  source = source.split(TELEMETRY).join(NEUTERED);
  writeFileSync(FILE, source);
  console.log(`removed ${remaining} telemetry endpoint reference(s)`);
}
