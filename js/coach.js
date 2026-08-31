// Turning measurements into plain English.
//
// Everything here is rule-based and runs offline. The tone to aim for is an
// honest observer with a phone camera, not a launch monitor: where a number is
// a projection or an estimate, the note says so.

import { fmt0, fmt1, ratioLabel } from './util.js';

const note = (level, title, text, priority = 0) => ({ level, title, text, priority });

/** Tempo: the ratio of backswing time to downswing time. */
function tempoNotes(r) {
  const t = r.timing;
  const out = [];
  if (!t || !Number.isFinite(t.tempoRatio)) return out;
  const ratio = t.tempoRatio;
  const label = ratioLabel(ratio);

  if (ratio >= 2.7 && ratio <= 3.3) {
    out.push(note('good', `Tempo ${label}`,
      'That sits right in the 3:1 window most tour players fall into — your backswing takes about three times as long as the downswing. Whatever you are doing to produce that, keep it.', 1));
  } else if (ratio >= 2.3) {
    out.push(note('watch', `Tempo ${label} — slightly quick from the top`,
      'A touch faster than the classic 3:1. Not a fault on its own, but if you are seeing pulls or a steep strike, it is usually the first thing to slow down. Try counting "one-two" back and "three" down.', 3));
  } else if (ratio < 2.3) {
    out.push(note('watch', `Tempo ${label} — rushing the transition`,
      'Your downswing is long relative to your backswing, which normally means you are hitting at the ball from the top rather than letting it fall into place. Speed you add here rarely reaches the ball. A slower, fuller backswing usually fixes the ratio without you thinking about the downswing at all.', 5));
  } else if (ratio <= 3.8) {
    out.push(note('watch', `Tempo ${label} — a little unhurried`,
      'Slightly longer backswing than the 3:1 benchmark. Often a sign of a backswing that drifts rather than winds up. Worth checking you are still finishing your turn rather than just slowing down.', 2));
  } else {
    out.push(note('watch', `Tempo ${label} — very long backswing`,
      'Your backswing is taking a long time relative to the downswing. That often costs stored energy, because the change of direction is where speed comes from. Try shortening the backswing slightly and keeping the same effort down.', 3));
  }

  if (r.slomo && (r.slomo.source === 'manual' || r.slomo.autoConfident)) {
    out.push(note('info', 'Swing timing',
      `Takeaway to the top ${fmt2s(t.backswingSec)}, top to impact ${fmt2s(t.downswingSec)}. A typical full swing is around 0.8 s back and 0.25 s down.`, 0));
  }
  return out;
}

const fmt2s = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} s` : '--');

/** Swing plane and path, which only really read from down the line. */
function pathNotes(r) {
  const out = [];
  const c = r.club || {};
  if (r.view !== 'dtl') return out;

  if (Number.isFinite(c.planeShiftDeg) && c.planeFitQuality > 0.65) {
    const s = c.planeShiftDeg;
    if (s > 4) {
      out.push(note('watch', `Downswing ${fmt1(s)}° steeper than your backswing`,
        'The club is coming down on a more upright line than it went back on — the classic over-the-top signature. It usually shows up as a pull or a slice, and a steeper, deeper divot. Feel the club drop behind your hands at the start of the downswing rather than out towards the ball.', 5));
    } else if (s < -4) {
      out.push(note('good', `Downswing ${fmt1(-s)}° shallower than your backswing`,
        'The club is shallowing on the way down rather than steepening. That is the direction good players move, and it is what lets you hit the inside of the ball.', 1));
    } else {
      out.push(note('good', 'Backswing and downswing on a matched plane',
        `Your downswing plane is within ${fmt1(Math.abs(s))}° of your backswing plane, so the club is tracking back down close to the line it went up on.`, 1));
    }
  }

  if (Number.isFinite(c.impactDirectionDeg) && c.trackCoverage > 0.6 && c.deliveryMeasurable !== false) {
    const d = c.impactDirectionDeg;
    if (d < -3) {
      out.push(note('watch', 'Club exiting left through the ball',
        'Through impact the club head is working across the ball towards your front side — an out-to-in tendency. With an open face that is the standard slice; with a square one it is a pull. This is measured from a flat picture rather than in 3D, so treat it as a direction, not a number of degrees of path.', 4));
    } else if (d > 3) {
      out.push(note('info', 'Club working out through the ball',
        'The club head is travelling away from you through impact — an in-to-out tendency, which produces draws when the face is square-ish and pushes or blocks when it is open. Measured from a flat picture, so read it as a direction rather than an exact path number.', 2));
    } else {
      out.push(note('good', 'Club travelling straight through the ball',
        'No obvious across-the-ball movement through impact in this view.', 1));
    }
  }
  return out;
}

/** Strike quality, which reads from a face-on camera. */
function strikeNotes(r) {
  const out = [];
  const c = r.club || {};
  if (r.view !== 'faceon') return out;
  if (c.deliveryMeasurable === false) return out;

  if (Number.isFinite(c.lowPointOffsetCm)) {
    const d = c.lowPointOffsetCm;
    if (d > 2) {
      out.push(note('good', `Low point ${fmt0(d)} cm past the ball`,
        'The club is still descending at the ball and bottoming out in front of it. That is ball-then-turf, which is exactly what you want with an iron.', 1));
    } else if (d < -2) {
      out.push(note('watch', `Low point ${fmt0(-d)} cm behind the ball`,
        'The club is bottoming out before it reaches the ball, which is where fat shots and thin shots both come from — you either catch the ground first or catch the ball on the way up. Pressure into your lead foot through the downswing is the usual fix.', 5));
    } else {
      out.push(note('info', 'Low point right at the ball',
        'The club is bottoming out level with the ball. Fine off a tee, but with irons off the turf you want it a couple of centimetres past.', 2));
    }
  }

  if (Number.isFinite(c.attackAngleDeg)) {
    const a = c.attackAngleDeg;
    if (a < -8) {
      out.push(note('watch', `Steep angle of attack (${fmt1(a)}°)`,
        'You are hitting down on it steeply. That produces deep divots, high spin and a loss of distance, and it punishes any low point error.', 3));
    } else if (a < -1) {
      out.push(note('good', `Descending strike (${fmt1(a)}°)`,
        'A normal iron delivery — hitting down on the ball and compressing it.', 1));
    } else if (a > 3) {
      out.push(note('info', `Ascending strike (${fmt1(a)}°)`,
        'You are hitting up on it. Right for a driver off a tee; with an iron off the ground it usually means thin contact.', 2));
    }
  }
  return out;
}

/** Body movement, from pose at the four key frames. */
function bodyNotes(r) {
  const out = [];
  const b = r.body;
  if (!b) return out;

  if (Number.isFinite(b.headLiftCm) && Math.abs(b.headLiftCm) > 4) {
    if (b.headLiftCm > 4) {
      out.push(note('watch', `Standing up ${fmt0(b.headLiftCm)} cm through the ball`,
        'Your head is noticeably higher at impact than at address. That is early extension — the hips push towards the ball and you lose the space your arms need. It shows up as thins, blocks and hooks in the same round.', 4));
    } else {
      out.push(note('watch', `Dropping ${fmt0(-b.headLiftCm)} cm into impact`,
        'Your head is lower at impact than at address. A small amount is normal; this much usually means you are diving at the ball and will catch the ground before it.', 3));
    }
  }

  if (Number.isFinite(b.headSwayCm)) {
    const s = b.headSwayCm;
    if (s > 7) {
      out.push(note('watch', `Head slid ${fmt0(s)} cm towards the target`,
        'Your head moves down the line through the swing rather than staying centred. A little shift is fine, but this much makes the low point move with it, so strike becomes timing-dependent.', 3));
    } else if (s < -7) {
      out.push(note('watch', `Head hung ${fmt0(-s)} cm back off the ball`,
        'Your head stays behind where it started through impact, which usually means your weight never got to your lead side. Expect fats, thins and a high weak flight.', 4));
    } else {
      out.push(note('good', 'Head stayed centred',
        'Very little lateral head movement between address and impact, which keeps your low point in the same place every time.', 1));
    }
  }

  if (Number.isFinite(b.spineChangeDeg) && Math.abs(b.spineChangeDeg) > 8) {
    out.push(note('watch', `Posture changed ${fmt0(Math.abs(b.spineChangeDeg))}° from address to impact`,
      'Your spine angle at impact is noticeably different from the one you set up with. Holding the angle you address the ball with is one of the biggest strike-consistency levers there is.', 3));
  }

  if (r.view === 'faceon' && Number.isFinite(b.shoulderTurnDeg)) {
    const t = b.shoulderTurnDeg;
    if (t < 60) {
      out.push(note('watch', `Limited shoulder turn (about ${fmt0(t)}°)`,
        'Your shoulders look under-turned at the top, which caps how much speed you can produce and pushes you into using your arms. This is estimated from how narrow your shoulders appear on camera, so treat it as a rough guide.', 3));
    } else if (t > 75) {
      out.push(note('good', `Good shoulder turn (about ${fmt0(t)}°)`,
        'A full turn away from the ball at the top. Estimated from your shoulder width on camera, so it is a guide rather than an exact figure.', 1));
    }
  }

  if (Number.isFinite(b.leadArmTopDeg) && b.leadArmTopDeg < 145) {
    out.push(note('watch', `Lead arm folding at the top (${fmt0(b.leadArmTopDeg)}°)`,
      'Your lead arm bends noticeably at the top, which shortens your radius and makes the strike harder to repeat. Width in the backswing is usually easier to feel than to think about — try keeping the club head as far from your head as you can going back.', 2));
  }

  if (Number.isFinite(b.hipShiftCm) && b.hipShiftCm < 1) {
    out.push(note('watch', 'Very little weight shift towards the target',
      'Your hips are in almost the same place at impact as at address. Most strike problems trace back to this — the low point follows your lead hip, so if it never moves forward the club bottoms out behind the ball.', 4));
  }
  return out;
}

/** Ball flight, only where the frame rate was actually high enough. */
function ballNotes(r) {
  const out = [];
  const b = r.ball || {};
  if (!b.tracked) {
    if (b.reason) out.push(note('info', 'No ball flight measured', b.reason, 0));
    return out;
  }
  if (Number.isFinite(b.startLineDeg)) {
    const d = b.startLineDeg;
    const dir = d > 0 ? 'right' : 'left';
    if (Math.abs(d) < 1.5) {
      out.push(note('good', 'Ball started on the camera line',
        'The ball set off straight down the line the phone was pointing. If you lined the phone up on your target, that is a square start line.', 1));
    } else {
      out.push(note('info', `Ball started ${fmt1(Math.abs(d))}° ${dir} of the camera line`,
        `Start line is mostly a face-angle read: the ball leaves close to where the face was pointing. This is measured against the phone's line, so it only means "${dir} of target" if the phone was set up on the target line.`, 2));
    }
  }
  if (Number.isFinite(b.launchAngleDeg)) {
    out.push(note('info', `Launch angle about ${fmt1(b.launchAngleDeg)}°`,
      'Measured over the first few frames of flight, assuming the phone was roughly level. Mid-irons usually launch in the high teens; a driver in the low teens.', 1));
  }
  if (Number.isFinite(b.speedMph)) {
    out.push(note('info', `Ball speed roughly ${fmt0(b.speedMph)} mph`,
      'A rough estimate from how far the ball travels across the frame, scaled by your height. Any sideways component to the flight makes this read low, so use it to compare shots rather than as an absolute number.', 0));
  }
  return out;
}

/** Practical notes about the footage itself, so the next clip is better. */
export function filmingTips(r) {
  const tips = [];
  if (r.effectiveFps && r.effectiveFps < 90) {
    tips.push('Film in slo-mo. At normal speed the ball is gone in a single frame, so launch and start line cannot be measured, and impact is only located to the nearest frame.');
  }
  if (r.timing && r.timing.framesInSwing < 20) {
    tips.push('Only a few frames covered your swing. Slo-mo, or a higher frame rate, sharpens every timing number here.');
  }
  if (r.club && r.club.offFrameFraction > 0.08) {
    tips.push('Your club swung out of shot, so part of the arc could not be measured. Step back a couple of paces, or turn the phone sideways — a full swing is wider than a portrait frame.');
  }
  if (r.club && r.club.trackCoverage < 0.6) {
    tips.push('The club head was hard to follow. A plainer background behind the swing and more light both help a lot.');
  }
  if (!r.poseOk) {
    tips.push('Your whole body was not detected. Step back so your head and feet are both comfortably inside the frame.');
  }
  if (r.ball && !r.ball.tracked && r.ball.rest == null) {
    tips.push('The ball could not be picked out. Framing it against grass rather than a mat edge or a shadow makes it much easier to find.');
  }
  if (r.view === 'dtl') {
    tips.push('For down-the-line, stand the phone directly behind the ball on the target line, about hip height and two club lengths back.');
  } else {
    tips.push('For face-on, put the phone level with your hands, square to your toe line, far enough back to keep the club in frame at the top.');
  }
  return tips;
}

/**
 * Build the full set of notes plus a single headline: the most important thing
 * to work on, or confirmation that nothing stood out.
 */
export function coachReport(r) {
  const notes = [
    ...tempoNotes(r),
    ...pathNotes(r),
    ...strikeNotes(r),
    ...bodyNotes(r),
    ...ballNotes(r),
  ].sort((a, b) => b.priority - a.priority);

  const worst = notes.find((n) => n.level === 'watch');
  const headline = worst
    ? { title: worst.title, text: worst.text }
    : {
      title: 'Nothing stood out as a fault in this one',
      text: 'The measurements that came through are all in normal ranges. Bank this swing and compare the next one against it.',
    };

  return { headline, notes, filming: filmingTips(r) };
}
