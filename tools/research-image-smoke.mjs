#!/usr/bin/env node
// Optional checks for the three user-supplied scientific screenshots. These
// images are NOT redistributed in the repository; pass local paths explicitly.
import assert from "node:assert/strict";
import { decodePng } from "./png-decode.mjs";
import { detectPlotRects, estimateColorThreshold, sampleRepresentativeColor, snapTargetPoint } from "../src/core.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { prepareTraceOutput } from "../src/trace-output.js";

const paths = process.argv.slice(2);
if (paths.length !== 3 || paths.includes("--help")) {
  console.log("Usage: node tools/research-image-smoke.mjs dispersion.png four-panels.png three-panels.png\nImages remain local. Checks panel detection, sparse circles, dotted curves and frame rejection.\nDense merged markers and separating a black fit from black scatter are not certified by these checks.");
  process.exit(paths.includes("--help") ? 0 : 1);
}
const images = paths.map(decodePng);
const panels = images.map(image => detectPlotRects(image.rgba, image.width, image.height));
const expectedPanels = [
  [[68, 38, 579, 396]],
  [[234, 34, 606, 316], [704, 34, 1076, 316], [234, 314, 606, 596], [704, 314, 1076, 596]],
  [[79, 78, 575, 286], [79, 327, 575, 535], [79, 575, 575, 783]],
];
for (let index = 0; index < images.length; index++) for (const [left, top, right, bottom] of expectedPanels[index]) {
  assert.ok(panels[index].some(rect => Math.max(Math.abs(left - rect.left), Math.abs(top - rect.top),
    Math.abs(right - rect.right), Math.abs(bottom - rect.bottom)) <= 2), `image ${index}: panel missing`);
}
const cases = [
  { image: 0, panel: 0, name: "orange circles / midrange pick", click: [401, 135], style: "markers", checks: [[272, 190.3], [399.5, 133.5], [450.5, 81]], minimumSpan: 360 },
  { image: 0, panel: 0, name: "orange circles / high-range pick", click: [451, 81], style: "markers", checks: [[272, 190.3], [399.5, 133.5], [450.5, 81]], minimumSpan: 360 },
  { image: 1, panel: 3, name: "orange dotted / midrange pick", click: [798, 550], style: "dotted", checks: [[798, 550], [897, 570]], minimumSpan: 320 },
  // An uncertain short local ruler may deliberately fall back to line mode.
  // Gate the recovered geometry, not an exact label, for this subpixel pick.
  { image: 1, panel: 3, name: "orange dotted / tail pick", click: [897, 570], checks: [[798, 550], [897, 570]], minimumSpan: 320 },
  { image: 1, panel: 2, name: "black solid / lower-left panel", click: [323, 428], noFrame: true, minimumSpan: 300 },
  { image: 2, panel: 0, name: "orange dashed / top panel", click: [327, 150], style: "dashed", checks: [[327, 149]], minimumSpan: 360 },
  { image: 2, panel: 0, name: "black fit / frame protection", click: [395, 121], noFrame: true, minimumSpan: 350 },
];
const reports = [];
for (const config of cases) {
  const image = images[config.image], bounds = expectedPanels[config.image][config.panel];
  const rect = panels[config.image].find(area => Math.abs(area.left - bounds[0]) <= 2 && Math.abs(area.top - bounds[1]) <= 2
    && Math.abs(area.right - bounds[2]) <= 2 && Math.abs(area.bottom - bounds[3]) <= 2);
  const click = { x: config.click[0], y: config.click[1] };
  const target = sampleRepresentativeColor(image.rgba, image.width, image.height, click);
  const seed = { ...snapTargetPoint({ ...image, rect, point: click, target,
    threshold: estimateColorThreshold(image.rgba, image.width, image.height, click, target) }), anchorId: "guide-1", userGuided: true };
  const threshold = estimateColorThreshold(image.rgba, image.width, image.height, seed, target);
  const start = performance.now();
  const classification = runComputeOperation("classify-target", { rect, seed, target, threshold }, image);
  const style = classification.markerInference.detected ? "markers" : classification.lineInference.style;
  if (config.style) assert.equal(style, config.style, config.name);
  const result = runComputeOperation(style === "markers" ? "trace-marker" : "trace-line", {
    rect, anchors: [seed], seed, target, threshold, automatic: style === "markers",
    targetStyle: style, maxJump: 14, maxGap: 24, orientationMode: "auto", refinementMode: "full",
    autoPatternedStyle: ["dotted", "dashed", "dashdot"].includes(style), autoStyleConfidence: classification.lineInference?.confidence,
  }, image);
  const path = result.path;
  assert.ok(path.length > 0 && path.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)), config.name);
  const span = Math.max(...path.map(point => point.x)) - Math.min(...path.map(point => point.x));
  assert.ok(span >= config.minimumSpan, `${config.name}: span ${span}`);
  for (const [x, y] of config.checks ?? []) {
    const error = Math.min(...path.map(point => Math.hypot(point.x - x, point.y - y)));
    assert.ok(error <= 2, `${config.name}: visible-ink landmark (${x}, ${y}) error ${error}`);
  }
  if (config.noFrame) assert.ok(path.every(point => point.anchor || !point.observed
    || (point.y > rect.top + 2 && point.y < rect.bottom - 2)), `${config.name}: frame exported as observed ink`);
  if (style === "markers") {
    assert.ok(path.every(point => point.marker && point.observed), config.name);
    assert.ok(path.every(point => Math.hypot(point.x - 317, point.y - 320.5) > 20), `${config.name}: legend dot exported`);
  } else {
    const output = prepareTraceOutput(path, { count: 100, guides: [seed], orientation: result.orientation,
      width: image.width, height: image.height, rect, parameters: { samplingMode: "geometry" } });
    assert.equal(output.path.length, 100, config.name);
    assert.ok(output.path.some(point => point.anchorId === seed.anchorId && point.x === seed.x && point.y === seed.y), config.name);
  }
  reports.push({ name: config.name, style, points: path.length, horizontalSpanPx: span,
    orientation: result.orientation ?? "markers", elapsedMs: +(performance.now() - start).toFixed(2) });
}
console.log(JSON.stringify({ panelChecks: 8, extractionChecks: reports.length, reports,
  limits: ["No numerical ground truth is available for the scientific data.", "Checks cover selected visible ink, not recovery of all occluded markers.",
    "Black fit/scatter separation, touching blue disks, and overlapping red stars remain unverified for full one-click recovery."] }, null, 2));
