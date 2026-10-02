#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  assessPathQuality,
  buildPairedCurveRows,
  detectPlotRect,
  estimateColorThreshold,
  pathToData,
  prepareInclusionMask,
  sampleRepresentativeColor,
  snapTargetPoint,
} from "../src/core.js";
import { decodePng } from "./png-decode.mjs";
import { runComputeOperation } from "../src/compute-engine.js";
import { prepareTraceOutput } from "../src/trace-output.js";

const here = dirname(fileURLToPath(import.meta.url));
const images = join(here, "..", "images");
const cases = [
  {
    image: "fig1.png",
    name: "fig1 green peak",
    anchors: [[276, 85]],
    expected: [[100, 354], [276, 85], [450, 282], [530, 307]],
    minimumSpan: 450,
    minimumObservedFraction: 0.98,
    maxJump: 16,
    maxGap: 18,
  },
  {
    image: "fig1.png",
    name: "fig1 green steep-side near click",
    anchors: [[254, 147]],
    expectedOrientation: "horizontal",
    expected: [[100, 354], [276, 85], [450, 282], [530, 307]],
    minimumSpan: 450,
    minimumObservedFraction: 0.96,
    maxJump: 14,
    maxGap: 24,
  },
  {
    image: "fig1.png",
    name: "fig1 orange solid",
    anchors: [[280, 173]],
    expected: [[100, 313], [276, 171], [360, 252], [450, 289]],
    minimumSpan: 450,
    minimumObservedFraction: 0.85,
    maxJump: 14,
    maxGap: 18,
  },
  {
    image: "fig1.png",
    name: "fig1 blue solid",
    anchors: [[134, 132]],
    expected: [[100, 115], [180, 160], [276, 211], [360, 289], [530, 352]],
    minimumSpan: 450,
    minimumObservedFraction: 0.7,
    maxJump: 14,
    maxGap: 20,
  },
  {
    image: "fig1.png",
    name: "fig1 red solid through occlusion",
    anchors: [[100, 203], [250, 197], [370, 238], [500, 296], [540, 312]],
    exclusions: [{ left: 388, top: 42, right: 545, bottom: 220 }],
    expected: [[430, 265], [540, 312]],
    strictGuideCorridor: true,
    targetStyle: "line",
    maxJump: 14,
    maxGap: 24,
  },
  {
    image: "fig1.png",
    name: "fig1 red dashed avoids solid and legend",
    anchors: [[100, 225], [190, 211], [310, 255], [500, 343], [540, 352]],
    exclusions: [{ left: 388, top: 42, right: 545, bottom: 220 }],
    expected: [[170, 214], [310, 255], [430, 315]],
    strictGuideCorridor: true,
    targetStyle: "dashed",
    maxJump: 14,
    maxGap: 24,
  },
];

// Match the reported blue-dashed/blue-solid confusion with two partial Pen
// strokes. The strokes must constrain their sections without cropping away
// the rest of the curve, including the unpainted gap between them.
cases.push({
  image: "fig1.png", name: "fig1 blue dashed with partial local Pen",
  anchors: [[140, 153.5], [240, 209], [260, 225]],
  expected: [[90, 141.5], [130, 150], [170, 168.5], [200, 185], [240, 209], [280, 238], [340, 277]],
  expectedOrientation: "vertical", targetStyle: "dashed", minimumSpan: 450, maxJump: 14, maxGap: 24,
  penStrokes: [[[95, 147], [130, 151], [160, 166]],
    [[211, 197], [240, 209], [260, 225], [280, 238], [320, 265], [354, 284]]],
});

const partialPenCase = cases.at(-1);
for (const penWidth of [8, 12, 24]) for (const guideCount of [1, 3]) {
  cases.push({ ...partialPenCase, penWidth,
    name: `fig1 blue dashed local Pen ${penWidth}px / ${guideCount} guides`,
    anchors: partialPenCase.anchors.slice(0, guideCount),
  });
}
function localPenMask(strokes, width, height, diameter = 20) {
  if (!strokes) return null;
  const data = new Uint8Array(width * height);
  const radius = diameter / 2;
  for (const points of strokes) for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1], [x1, y1] = points[index];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const x = x0 + (x1 - x0) * step / steps, y = y0 + (y1 - y0) * step / steps;
      for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, y + radius); yy += 1) {
        for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, x + radius); xx += 1) {
          if (Math.hypot(xx - x, yy - y) <= radius) data[yy * width + xx] = 1;
        }
      }
    }
  }
  return prepareInclusionMask(data, width, height, "local");
}

// Ordinary target selection must tolerate a near click without requiring Pen,
// extra guides, or a manually chosen direction. Keep the original six cases and
// their accuracy gates; add independent cases rather than averaging errors.
const steepCase = cases[1];
for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
  cases.push({
    ...steepCase,
    name: `${steepCase.name} (${dx >= 0 ? "+" : ""}${dx}, ${dy >= 0 ? "+" : ""}${dy} px)`,
    anchors: [[steepCase.anchors[0][0] + dx, steepCase.anchors[0][1] + dy]],
  });
}

function assertGuides(path, guides, name) {
  for (const guide of guides) {
    assert.ok(path.some((point) => point.anchorId === guide.anchorId
      && point.x === guide.x && point.y === guide.y), `${name}: guide ${guide.anchorId} moved or disappeared`);
  }
}

function assertGeometry(path, config, stage, { interpolate = false } = {}) {
  const name = `${config.name} / ${stage}`;
  assert.ok(path.length > 0, `${name}: trace is empty`);
  assert.ok(path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)), `${name}: non-finite coordinates`);
  const xValues = path.map((point) => point.x);
  const horizontalSpan = Math.max(...xValues) - Math.min(...xValues);
  assert.ok(horizontalSpan >= (config.minimumSpan ?? 400),
    `${name}: expected at least ${config.minimumSpan ?? 400} px span, received ${horizontalSpan}`);
  let maximumError = 0;
  for (const [expectedX, expectedY] of config.expected ?? []) {
    // Preserve the dense raw-path nearest-column check. Display/export paths
    // have fewer points, so evaluate their piecewise-linear geometry at that X
    // instead of treating an intentional sampling interval as tracing error.
    const nearest = path.reduce((best, point) => (
      Math.abs(point.x - expectedX) < Math.abs(best.x - expectedX) ? point : best
    ));
    let actualY = nearest.y;
    if (interpolate) {
      const leftIndex = path.findIndex((point, index) => index + 1 < path.length
        && point.x <= expectedX + 1e-7 && path[index + 1].x >= expectedX - 1e-7);
      assert.ok(leftIndex >= 0, `${name}: expected x=${expectedX} is outside sampled path`);
      const left = path[leftIndex], right = path[leftIndex + 1];
      actualY = right.x === left.x ? left.y
        : left.y + (right.y - left.y) * (expectedX - left.x) / (right.x - left.x);
    }
    const error = Math.abs(actualY - expectedY);
    maximumError = Math.max(maximumError, error);
    assert.ok(error <= 3, `${name}: expected y≈${expectedY} at x=${expectedX}, received ${actualY}`);
  }
  return { points: path.length, horizontalSpan, maximumError };
}

const cache = new Map();
const results = [];
for (const config of cases) {
  if (!cache.has(config.image)) cache.set(config.image, decodePng(join(images, config.image)));
  const image = cache.get(config.image);
  const inclusionMask = localPenMask(config.penStrokes, image.width, image.height, config.penWidth);
  const rect = detectPlotRect(image.rgba, image.width, image.height);
  const anchors = config.anchors.map(([x, y], index) => ({ x, y, anchorId: `guide-${index + 1}`, userGuided: true }));
  const target = sampleRepresentativeColor(image.rgba, image.width, image.height, anchors[0]);
  const preliminaryThreshold = estimateColorThreshold(image.rgba, image.width, image.height, anchors[0], target);
  // Match selectTraceTarget: sample near the click, estimate/snap the first
  // guide, then estimate the final threshold at that snapped location. Later
  // manually added guides remain exactly where the user placed them.
  anchors[0] = { ...anchors[0], ...snapTargetPoint({
    rgba: image.rgba, width: image.width, height: image.height, rect,
    point: anchors[0], target, threshold: preliminaryThreshold,
    exclusions: config.exclusions ?? [],
  }) };
  const threshold = estimateColorThreshold(image.rgba, image.width, image.height, anchors[0], target);
  const started = performance.now();
  let targetStyle = config.targetStyle;
  let autoStyleConfidence = 1;
  if (!targetStyle) {
    const classified = runComputeOperation("classify-target", {
      rect, seed: anchors[0], target, threshold, exclusions: config.exclusions ?? [],
    }, image);
    assert.equal(classified.markerInference.detected, false, `${config.name}: ordinary line classified as markers`);
    targetStyle = classified.lineInference.style;
    autoStyleConfidence = classified.lineInference.confidence;
  }
  const result = runComputeOperation("trace-line", {
    rect, anchors, target, threshold,
    maxJump: config.maxJump, maxGap: config.maxGap,
    exclusions: config.exclusions ?? [],
    strictGuideCorridor: config.strictGuideCorridor ?? false,
    targetStyle,
    autoPatternedStyle: !config.targetStyle && ["dashed", "dashdot", "dotted"].includes(targetStyle),
    autoStyleConfidence,
    refinementMode: "full", orientationMode: "auto",
    avoidPaths: [], avoidanceRadius: 2.5, inclusionMask,
  }, image);
  assert.equal(result.orientation, config.expectedOrientation ?? "horizontal", `${config.name}: unexpected orientation`);
  const path = result.path;
  const rawMetrics = assertGeometry(path, config, "raw trace");
  assertGuides(path, anchors, `${config.name} / raw trace`);
  const observed = path.filter((point) => point.observed).length;
  const observedFraction = observed / path.length;
  if (Number.isFinite(config.minimumObservedFraction)) {
    assert.ok(
      observedFraction >= config.minimumObservedFraction,
      `${config.name}: observed fraction ${observedFraction.toFixed(3)} is below ${config.minimumObservedFraction}`,
    );
  }
  const outputOptions = {
    parameters: { samplingMode: "geometry" }, orientation: result.orientation,
    guides: anchors, inclusionMask, width: image.width, height: image.height, rect,
  };
  const displayed = prepareTraceOutput(path, { ...outputOptions, count: 100 }).path;
  assert.equal(displayed.length, 100, `${config.name}: output count was not retained`);
  assertGuides(displayed, anchors, `${config.name} / displayed`);
  const displayedMetrics = assertGeometry(displayed, config, "displayed", { interpolate: true });

  // Explicit manual axis values, independent of plot-frame detection. A curve
  // is successful only when the exported rows still describe its sampled path.
  const calibration = {
    x: { scale: "linear", point1: 74, point2: 549, value1: 0, value2: 8 },
    y: { scale: "linear", point1: 375, point2: 29, value1: 0, value2: 7 },
  };
  const exports = [];
  for (const count of [null, 200]) {
    const exported = prepareTraceOutput(displayed, { ...outputOptions, geometryPath: path, count }).path;
    assert.equal(exported.length, count ?? displayed.length, `${config.name}: export density was not retained`);
    assertGuides(exported, anchors, `${config.name} / export ${count ?? "curve"}`);
    const metrics = assertGeometry(exported, config, `export ${count ?? "curve"}`, { interpolate: true });
    const data = pathToData(exported, calibration.x, calibration.y);
    assert.equal(data.length, exported.length, `${config.name}: calibration dropped data points`);
    const rows = buildPairedCurveRows([{ label: config.name, data, xLabel: "k", yLabel: "W" }]);
    assert.deepEqual(rows.slice(0, 2), [[config.name, ""], ["k", "W"]]);
    assert.equal(rows.length, exported.length + 2);
    const roundTripped = rows.slice(2).map((row, index) => {
      assert.equal(row.length, 2, `${config.name}: export has unpaired columns`);
      assert.ok(row.every((value) => value !== "" && Number.isFinite(Number(value))), `${config.name}: invalid exported coordinate`);
      const point = { x: 74 + Number(row[0]) * 475 / 8, y: 375 - Number(row[1]) * 346 / 7 };
      assert.ok(Math.hypot(point.x - exported[index].x, point.y - exported[index].y) < 1e-7,
        `${config.name}: serialized coordinates differ from the displayed geometry`);
      return point;
    });
    assertGeometry(roundTripped, config, `serialized export ${count ?? "curve"}`, { interpolate: true });
    exports.push({ density: count ?? "curve", ...metrics, rows: rows.length });
  }
  const elapsedMs = performance.now() - started;
  results.push({
    name: config.name,
    click: config.anchors[0],
    seed: anchors[0],
    target,
    threshold,
    inferredStyle: targetStyle,
    tracedStyle: result.targetStyle,
    orientation: result.orientation,
    plotRect: rect,
    points: path.length,
    xRange: path.length ? [path[0].x, path.at(-1).x] : null,
    observedFraction,
    raw: rawMetrics,
    displayed: displayedMetrics,
    exports,
    quality: assessPathQuality(path, rect),
    elapsedMs,
  });
}

console.log(JSON.stringify(results, null, 2));
