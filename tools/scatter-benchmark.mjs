import assert from "node:assert/strict";
import { pathToData, buildPairedCurveRows } from "../src/core.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { prepareTraceOutput } from "../src/trace-output.js";
import { scatterFixtures, coincidentScatterFixture } from "./scatter-fixtures.mjs";

// One-to-one matching prevents duplicated predictions from earning extra
// recall. These separated fixtures make nearest-distance matching unambiguous.
export function measureScatter(predicted, truth, tolerance = 1.5) {
  const pairs = [];
  predicted.forEach((point, p) => truth.forEach((known, t) => {
    const error = Math.hypot(point.x - known.x, point.y - known.y);
    if (error <= tolerance) pairs.push({ p, t, error });
  }));
  pairs.sort((a, b) => a.error - b.error);
  const usedPredicted = new Set(), usedTruth = new Set(), errors = [];
  for (const pair of pairs) {
    if (usedPredicted.has(pair.p) || usedTruth.has(pair.t)) continue;
    usedPredicted.add(pair.p); usedTruth.add(pair.t); errors.push(pair.error);
  }
  return { expected: truth.length, extracted: predicted.length, matched: errors.length,
    falsePositives: predicted.length - errors.length, missed: truth.length - errors.length,
    precision: predicted.length ? errors.length / predicted.length : 0,
    recall: truth.length ? errors.length / truth.length : 0,
    maximumCenterErrorPx: errors.length ? Math.max(...errors) : null };
}

export function runScatterCase(image) {
  const start = performance.now();
  const { path } = runComputeOperation("trace-marker", {
    rect: image.rect, target: image.target, threshold: 20, anchors: image.anchors,
    strictGuideCorridor: false, automatic: false,
  }, image);
  const metrics = measureScatter(path, image.truth);
  // Output density must not interpolate or delete measured scatter centres.
  // The separate, explicit "select existing points" action is not used here.
  for (const count of [2, 100, 500]) {
    const output = prepareTraceOutput(path, { markerData: true, count, guides: image.anchors,
      rect: image.rect, width: image.width, height: image.height });
    assert.deepEqual(output.path.map(p => [p.x, p.y]), path.map(p => [p.x, p.y]), `${image.name}: resampled scatter`);
  }
  const xCalibration = { point1: image.rect.left, point2: image.rect.right, value1: 0, value2: 10, scale: "linear" };
  const yCalibration = { point1: image.rect.bottom, point2: image.rect.top, value1: 0, value2: 1, scale: "linear" };
  const data = pathToData(path, xCalibration, yCalibration);
  assert.equal(data.length, path.length, `${image.name}: calibration dropped observations`);
  data.forEach((point, index) => {
    const expectedX = (path[index].x - image.rect.left) / (image.rect.right - image.rect.left) * 10;
    const expectedY = (image.rect.bottom - path[index].y) / (image.rect.bottom - image.rect.top);
    assert.ok(Math.abs(point.dataX - expectedX) < 1e-10 && Math.abs(point.dataY - expectedY) < 1e-10,
      `${image.name}: calibrated coordinates`);
  });
  const rows = buildPairedCurveRows([{ label: "Scatter", data }]);
  assert.equal(rows.length, path.length + 2, `${image.name}: export row count`);
  assert.equal(new Set(rows.slice(2).map(row => row.join(","))).size, path.length, `${image.name}: export merged records`);
  assert.ok(path.every(point => point.observed && point.marker), `${image.name}: invented point`);
  return { name: image.name, ...metrics, elapsedMs: +(performance.now() - start).toFixed(2) };
}

export function runScatterBenchmark({ check = false } = {}) {
  const reports = scatterFixtures().map(image => runScatterCase(image));
  const failures = reports.filter(report => report.falsePositives || report.missed || report.maximumCenterErrorPx > 1.5);
  // Coincident records are intentionally not required to pass full recall.
  const ambiguous = runScatterCase(coincidentScatterFixture());
  const summary = { cases: reports.length, passing: reports.length - failures.length,
    measuredMarkers: reports.reduce((sum, r) => sum + r.expected, 0),
    failures, reports, ambiguous,
    limitation: "Touching/overlapping symbols and hidden coincident records are not certified by these separated-marker tests." };
  console.log(JSON.stringify(summary, null, 2));
  if (check) assert.equal(failures.length, 0, `${failures.length} scatter accuracy gates failed`);
  return summary;
}

if (process.argv[1]?.endsWith("/scatter-benchmark.mjs")) runScatterBenchmark({ check: process.argv.includes("--check") });
