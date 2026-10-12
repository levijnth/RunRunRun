import { test } from "node:test";
import assert from "node:assert/strict";
import * as geo from "../js/geo.js";

// ~1 m of latitude in degrees.
const M = 1 / 111195;

test("haversine: one degree of latitude is ~111.2 km", () => {
  const d = geo.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 111195) < 10, d);
});

test("evaluateFix accepts the first accurate fix", () => {
  assert.equal(geo.evaluateFix(null, { lat: 0, lon: 0, t: 0, acc: 5 }).accept, true);
});

test("evaluateFix rejects inaccurate fixes", () => {
  const r = geo.evaluateFix(null, { lat: 0, lon: 0, t: 0, acc: 100 });
  assert.deepEqual([r.accept, r.reason], [false, "inaccurate"]);
});

test("evaluateFix rejects impossible jumps", () => {
  const last = { lat: 0, lon: 0, t: 0 };
  const r = geo.evaluateFix(last, { lat: 100 * M, lon: 0, t: 1000, acc: 5 });
  assert.equal(r.reason, "jump");
});

test("evaluateFix ignores jitter while standing still", () => {
  const last = { lat: 0, lon: 0, t: 0 };
  const r = geo.evaluateFix(last, { lat: 1.5 * M, lon: 0, t: 1000, acc: 5 });
  assert.equal(r.reason, "too-close");
});

test("evaluateFix accepts normal running movement", () => {
  const last = { lat: 0, lon: 0, t: 0 };
  const r = geo.evaluateFix(last, { lat: 15 * M, lon: 0, t: 5000, acc: 5 });
  assert.equal(r.accept, true);
  assert.ok(Math.abs(r.distance - 15) < 0.1);
});

// Straight line north at a steady pace; returns points with cumulative d/e.
function steadyRun(meters, secPerKm, stepM = 10) {
  const pts = [];
  for (let d = 0; d <= meters; d += stepM) {
    pts.push({ lat: d * M, lon: 0, d, e: (d / 1000) * secPerKm * 1000, t: 0 });
  }
  return pts;
}

test("computeSplits: steady 5:00/km over 2.5 km", () => {
  const splits = geo.computeSplits(steadyRun(2500, 300), "km");
  assert.equal(splits.length, 3);
  assert.ok(Math.abs(splits[0].ms - 300000) < 1);
  assert.ok(Math.abs(splits[1].ms - 300000) < 1);
  assert.equal(splits[2].partial, true);
  assert.ok(Math.abs(splits[2].fraction - 0.5) < 1e-9);
  assert.ok(Math.abs(splits[2].ms - 150000) < 1);
});

test("computeSplits interpolates when a point jumps past a boundary", () => {
  const pts = [
    { d: 0, e: 0 },
    { d: 900, e: 270000 },
    { d: 1100, e: 330000 },
  ];
  const [first] = geo.computeSplits(pts, "km");
  assert.ok(Math.abs(first.ms - 300000) < 1);
});

test("computeSplits in miles", () => {
  const splits = geo.computeSplits(steadyRun(3300, 300, 5), "mi");
  assert.equal(splits.filter((s) => !s.partial).length, 2);
  assert.ok(Math.abs(splits[0].ms - 1609.344 * 300) < 1600);
});

test("recentPace uses the last window only", () => {
  const slow = steadyRun(1000, 400);
  const fastStart = slow.at(-1);
  const fast = steadyRun(1000, 250).slice(1).map((p) => ({ ...p, d: p.d + fastStart.d, e: p.e + fastStart.e }));
  const pace = geo.recentPace([...slow, ...fast], "km", 30000);
  assert.ok(Math.abs(pace - 250) < 1, pace);
});

test("recentPace is null with no movement", () => {
  assert.equal(geo.recentPace([{ d: 0, e: 0 }], "km"), null);
});

test("formatters", () => {
  assert.equal(geo.formatDuration(65000), "1:05");
  assert.equal(geo.formatDuration(3723000), "1:02:03");
  assert.equal(geo.formatPace(332.4), "5:32");
  assert.equal(geo.formatPace(null), "–:––");
  assert.equal(geo.formatPace(5000), "–:––");
  assert.equal(geo.formatDistance(1609.344, "mi"), "1.00");
  assert.equal(geo.formatDistance(5432, "km"), "5.43");
});

test("projectRoute fits points inside the box", () => {
  const { lines, start, end } = geo.projectRoute([steadyRun(500, 300), steadyRun(200, 300)], 320, 200, 16);
  assert.equal(lines.length, 2);
  for (const [x, y] of [start, end]) {
    assert.ok(x >= 16 && x <= 304 && y >= 16 && y <= 184, `${x},${y}`);
  }
});

test("toGPX produces one trkseg per segment", () => {
  const run = {
    startedAt: Date.UTC(2026, 0, 1),
    segments: [
      [{ lat: 1, lon: 2, t: Date.UTC(2026, 0, 1), alt: 10 }],
      [{ lat: 1.001, lon: 2, t: Date.UTC(2026, 0, 1, 0, 1), alt: null }],
    ],
  };
  const gpx = geo.toGPX(run, "Test & run");
  assert.equal(gpx.match(/<trkseg>/g).length, 2);
  assert.match(gpx, /<name>Test &amp; run<\/name>/);
  assert.match(gpx, /<ele>10\.0<\/ele>/);
});
