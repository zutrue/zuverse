// Ported from the Zuops Video Ad Copier tests.
// plus a couple of explicit option checks for the port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameTimeFor, shotsFromDiffs } from "../src/cuts.mjs";

/** A run of quiet frame differences with jumps at the given times. */
function diffs(duration, jumps, noise = 0.05) {
  const out = [];
  for (let t = 0.1; t < duration - 0.05; t += 0.1) {
    const at = Math.round(t * 10) / 10;
    const jump = jumps.find((j) => Math.abs(j.t - at) < 0.05);
    out.push({ t: at, hd: jump ? jump.hd : noise, ld: jump ? 0.3 : 0.1 });
  }
  return out;
}

test("cuts: the air duct ad's 12 shots, from its real peaks", () => {
  // The histogram peaks measured on the TikTok source (hd), plus the busy
  // spinning-brush section that must not split a shot.
  const jumps = [
    { t: 2.3, hd: 0.584 }, { t: 4.3, hd: 0.189 }, { t: 6.3, hd: 0.342 }, { t: 9.3, hd: 0.185 },
    { t: 11.8, hd: 0.191 }, { t: 13.8, hd: 0.236 }, { t: 14.3, hd: 0.125 }, { t: 15.9, hd: 0.266 },
    { t: 16.2, hd: 0.202 }, { t: 17.6, hd: 0.15 }, { t: 17.8, hd: 0.385 }, { t: 19.0, hd: 0.244 },
    { t: 19.8, hd: 0.173 }, { t: 20.5, hd: 0.346 }, { t: 20.8, hd: 0.714 },
  ];
  const shots = shotsFromDiffs(diffs(22.6, jumps, 0.049), 22.6);
  assert.deepStrictEqual(
    shots.map((s) => [s.start, s.end]),
    [[0, 2.3], [2.3, 4.3], [4.3, 6.3], [6.3, 9.3], [9.3, 11.8], [11.8, 13.8], [13.8, 15.9], [15.9, 17.8], [17.8, 19], [19, 19.8], [19.8, 20.8], [20.8, 22.6]],
  );
});

test("cuts: motion inside a shot is not a cut; one take stays one shot", () => {
  assert.deepStrictEqual(shotsFromDiffs(diffs(10, [], 0.08), 10), [{ start: 0, end: 10 }]);
  // A busy clip raises the bar (3x its median change).
  assert.equal(shotsFromDiffs(diffs(10, [{ t: 5, hd: 0.2 }], 0.09), 10).length, 1);
  assert.equal(shotsFromDiffs(diffs(10, [{ t: 5, hd: 0.4 }], 0.09), 10).length, 2);
  // Nothing at the very start or end, and a cap on the number of shots.
  assert.equal(shotsFromDiffs(diffs(10, [{ t: 0.2, hd: 0.9 }, { t: 9.9, hd: 0.9 }]), 10).length, 1);
  const many = Array.from({ length: 30 }, (_, i) => ({ t: 1 + i * 0.9, hd: 0.5 }));
  assert.equal(shotsFromDiffs(diffs(30, many), 30).length, 16);
  assert.deepStrictEqual(shotsFromDiffs([], 7.25), [{ start: 0, end: 7.3 }]);
});

test("frame time: a little way into the shot, clear of the cut", () => {
  assert.equal(frameTimeFor({ start: 2.3, end: 4.3 }), 2.7);
  assert.equal(frameTimeFor({ start: 19, end: 19.8 }), 19.2);
});

// Added for the port: the options, spelled out.
test("cuts: spikes closer than minShot are one cut (the stronger one), and maxShots caps the count", () => {
  // 4.0 and 4.3 are 0.3 s apart: one cut, at the stronger spike.
  const close = diffs(10, [{ t: 4.0, hd: 0.4 }, { t: 4.3, hd: 0.7 }]);
  assert.deepStrictEqual(shotsFromDiffs(close, 10), [{ start: 0, end: 4.3 }, { start: 4.3, end: 10 }]);
  // With a smaller minShot they are two cuts.
  assert.deepStrictEqual(shotsFromDiffs(close, 10, { minShot: 0.2 }).map((s) => s.start), [0, 4, 4.3]);
  // Four clear spikes, capped at three shots: the two strongest cuts are kept, in time order.
  const four = diffs(10, [{ t: 2, hd: 0.5 }, { t: 4, hd: 0.9 }, { t: 6, hd: 0.4 }, { t: 8, hd: 0.8 }]);
  assert.deepStrictEqual(shotsFromDiffs(four, 10).length, 5);
  assert.deepStrictEqual(shotsFromDiffs(four, 10, { maxShots: 3 }), [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 }]);
  // No length, no shots.
  assert.deepStrictEqual(shotsFromDiffs([], 0), []);
});
