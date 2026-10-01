import test from "node:test";
import assert from "node:assert/strict";
import { prepareInclusionMask, inclusionMaskAllows, constrainPathToInclusionMask, clusterColumnCandidates } from "../src/core.js";
import { isDuplicateGuidePoint, prepareTraceOutput, prepareRestoredTrace } from "../src/trace-output.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { translateMessage } from "../src/i18n.js";

const width = 120;
const height = 100;
const rect = { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height };

function bentMask(mode) {
  const data = new Uint8Array(width * height);
  for (let x = 20; x <= 50; x += 1) data[20 * width + x] = 1;
  for (let y = 20; y <= 50; y += 1) data[y * width + 50] = 1;
  return prepareInclusionMask(data, width, height, mode);
}

test("Pen local and strict scopes are explicit and invariant across trace orientations", () => {
  const local = bentMask("local");
  const strict = bentMask("strict");
  assert.deepEqual(local.regions, [{ left: 20, top: 20, right: 50, bottom: 50 }]);
  assert.equal(inclusionMaskAllows(local, width, 5, 60), true);
  assert.equal(inclusionMaskAllows(strict, width, 5, 60), false);
  assert.equal(inclusionMaskAllows(local, width, 30, 40), false);
  assert.equal(inclusionMaskAllows(strict, width, 50, 30), true);
  for (const inclusionMask of [local, strict]) {
    const path = [{ x: 5, y: 60 }, { x: 30, y: 40 }, { x: 50, y: 30 }];
    const results = ["horizontal", "vertical", "parametric"].map((orientation) => (
      constrainPathToInclusionMask(path, { inclusionMask, width, height, rect, orientation })
    ));
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], results[2]);
  }
});

test("separate local Pen components do not constrain the blank area between them", () => {
  const data = new Uint8Array(width * height);
  data[10 * width + 10] = 1;
  data[80 * width + 100] = 1;
  const mask = prepareInclusionMask(data, width, height);
  assert.equal(mask.regions.length, 2);
  assert.equal(inclusionMaskAllows(mask, width, 60, 45), true);
  assert.equal(prepareInclusionMask(new Uint8Array(width * height), width, height), null);
});

test("local Pen blocks sideways bypasses but permits endwise extension in either orientation", () => {
  for (const vertical of [false, true]) {
    const data = new Uint8Array(width * height);
    const pointAt = (x, y) => vertical ? { x: y, y: x } : { x, y };
    for (let x = 20; x <= 80; x += 1) for (let y = 40; y <= 48; y += 1) {
      const p = pointAt(x, y);
      data[p.y * width + p.x] = 1;
    }
    const mask = prepareInclusionMask(data, width, height, "local");
    assert.equal(mask.gates.length, 2);
    for (const [x, y, allowed] of [[50, 44, true], [50, 25, false], [50, 75, false], [10, 44, true], [90, 44, true]]) {
      const p = pointAt(x, y);
      assert.equal(inclusionMaskAllows(mask, width, p.x, p.y), allowed);
    }
    const bypass = pointAt(50, 25);
    for (const orientation of ["horizontal", "vertical", "parametric"]) {
      assert.throws(() => prepareTraceOutput([bypass], {
        inclusionMask: mask, width, height, rect, orientation, count: 100,
      }), { code: "PEN_OUTSIDE" });
    }
    const oldCurve = { path: [bypass], rawPath: [bypass] };
    const restored = prepareRestoredTrace(oldCurve, { inclusionMask: mask, width, height, rect });
    assert.equal(restored.traceStale, true, "old results must not bypass the stronger contract on restore");
    assert.equal(restored.path, oldCurve.path, "retain old coordinates for recovery");
  }
});

test("bent local Pen uses its two end directions, not a global X-only constraint", () => {
  const mask = bentMask("local");
  assert.equal(inclusionMaskAllows(mask, width, 30, 5), false, "no route above the horizontal painted section");
  assert.equal(inclusionMaskAllows(mask, width, 90, 35), false, "no route beside the vertical painted section");
  assert.equal(inclusionMaskAllows(mask, width, 10, 20), true, "extend before the first end");
  assert.equal(inclusionMaskAllows(mask, width, 50, 75), true, "extend beyond the turned end");
});

test("multiple local strokes leave their intervening gap open and retain erased holes", () => {
  const data = new Uint8Array(width * height);
  for (const [start, end] of [[10, 40], [80, 110]]) {
    for (let y = 40; y <= 48; y += 1) for (let x = start; x <= end; x += 1) data[y * width + x] = 1;
  }
  for (let y = 43; y <= 45; y += 1) for (let x = 23; x <= 25; x += 1) data[y * width + x] = 0;
  const mask = prepareInclusionMask(data, width, height, "local");
  assert.equal(inclusionMaskAllows(mask, width, 60, 44), true);
  assert.equal(inclusionMaskAllows(mask, width, 30, 20), false);
  assert.equal(inclusionMaskAllows(mask, width, 95, 20), false);
  assert.equal(inclusionMaskAllows(mask, width, 24, 44), false);
});

test("a closed local Pen loop has no external exit and uses only painted pixels", () => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const radius = Math.hypot(x - 60, y - 50);
    if (radius >= 17 && radius <= 21) data[y * width + x] = 1;
  }
  const mask = prepareInclusionMask(data, width, height, "local");
  assert.equal(mask.gates.length, 0);
  assert.deepEqual(mask.allowed, data);
});

test("small raster-edge corrections are inferred; distant points fail without modifying the input", () => {
  const inclusionMask = bentMask("strict");
  const source = [{ x: 50.7, y: 30, observed: true, imageObserved: true, uncertaintyPx: 0.1, confidence: 1 }];
  const result = prepareTraceOutput(source, { inclusionMask, width, height, rect });
  assert.equal(result.path[0].observed, false);
  assert.equal(result.path[0].imageObserved, false);
  assert.ok(result.path[0].uncertaintyPx >= 0.7);
  assert.ok(result.path[0].confidence < 0.5);
  assert.equal(source[0].x, 50.7);
  const distant = [{ x: 99, y: 30, observed: true }];
  assert.throws(() => prepareTraceOutput(distant, { inclusionMask, width, height, rect }), { code: "PEN_OUTSIDE" });
  assert.deepEqual(distant, [{ x: 99, y: 30, observed: true }]);
});

test("a stale outside flag is cleared when a point is now inside the Pen", () => {
  const result = prepareTraceOutput([{ x: 50, y: 30, corridorOutside: true }], {
    inclusionMask: bentMask("strict"), width, height, rect,
  });
  assert.equal(result.path[0].corridorOutside, undefined);
});

test("legacy project/draft validation keeps invalid data and flags both raw and sampled path errors", () => {
  const options = { inclusionMask: bentMask("strict"), width, height, rect };
  const valid = [{ x: 50, y: 30 }];
  const invalid = [{ x: 99, y: 30 }];
  for (const curve of [{ path: invalid, rawPath: valid }, { path: valid, rawPath: invalid }]) {
    const result = prepareRestoredTrace(curve, options);
    assert.equal(result.traceStale, true);
    assert.equal(result.path, curve.path);
    assert.equal(result.rawPath, curve.rawPath);
    assert.match(result.traceError, /Pen/);
  }
  assert.equal(prepareRestoredTrace({ path: valid, rawPath: valid }, options).traceStale, false);
  const pending = { path: valid, traceStale: true, traceError: "pending settings" };
  assert.deepEqual(prepareRestoredTrace(pending, options), pending);
});

test("local Pen assistance does not apply a false image-centre preference outside its region", () => {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  rgba.set([0, 0, 0, 255], (60 * width + 5) * 4);
  const candidates = clusterColumnCandidates(rgba, width, 5, 0, height - 1,
    { r: 0, g: 0, b: 0 }, 9, [], bentMask("local"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].corridorCenterDistance, 0);
  assert.equal(candidates[0].corridorHalfWidth, null);
});

test("a forced single-axis resample must not silently drop guides in the same column", () => {
  const path = [
    { x: 10, y: 10, anchor: true, anchorId: "top" },
    { x: 10, y: 60, anchor: true, anchorId: "bottom" },
  ];
  assert.throws(() => prepareTraceOutput(path, { count: 100, orientation: "horizontal" }), { code: "MISSING_GUIDE" });
  const result = prepareTraceOutput(path, { count: 100, orientation: "parametric" });
  for (const guide of path) assert.ok(result.path.some(p => p.anchorId === guide.anchorId && p.y === guide.y));
});

for (const orientation of ["horizontal", "vertical", "parametric"]) {
  test(`${orientation} density edits and export preserve the exact guide`, () => {
    const source = [
      { x: 0, y: 0, observed: true },
      { x: 5.25, y: 20.75, anchor: true, anchorId: "peak", userGuided: true },
      { x: 10, y: 0, observed: true },
    ].map((point) => orientation === "vertical" ? { ...point, x: point.y, y: point.x } : point);
    const guide = source[1];
    const displayed = prepareTraceOutput(source, { orientation, count: 100 }).path;
    const exported = prepareTraceOutput(displayed, { orientation, count: 200 }).path;
    for (const path of [displayed, exported]) {
      assert.equal(path.filter((point) => point.anchorId === "peak").length, 1);
      const retained = path.find((point) => point.anchorId === "peak");
      assert.equal(retained.x, guide.x);
      assert.equal(retained.y, guide.y);
    }
  });
}

test("each exported curve uses its own Pen and resampling cannot cut across an unpainted corner", () => {
  const source = [{ x: 20, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50 }];
  const options = { inclusionMask: bentMask("strict"), width, height, rect, orientation: "parametric", count: 100 };
  const exported = prepareTraceOutput(source, options).path;
  assert.ok(exported.every((point) => inclusionMaskAllows(options.inclusionMask, width, point.x, point.y)));
  assert.throws(() => prepareTraceOutput([source[0], source[2]], options), { code: "PEN_OUTSIDE" });
  const other = new Uint8Array(width * height);
  other[90 * width + 100] = 1;
  assert.throws(() => prepareTraceOutput(source, {
    ...options, inclusionMask: prepareInclusionMask(other, width, height, "strict"),
  }), { code: "PEN_OUTSIDE" });
});

test("every guide remains exact even when requested count is smaller than guide count", () => {
  const source = Array.from({ length: 5 }, (_, index) => ({
    x: index * 10, y: index * 2, anchor: true, anchorId: `a${index}`, userGuided: true,
  }));
  const result = prepareTraceOutput(source, { count: 2, guides: source }).path;
  assert.equal(result.length, 5);
  assert.deepEqual(result.map((point) => point.anchorId), source.map((point) => point.anchorId));
  assert.throws(() => prepareTraceOutput(source.slice(1), { guides: source }), { code: "MISSING_GUIDE" });
});

test("near-vertical guide entry accepts repeated X or Y but rejects an actual duplicate", () => {
  assert.equal(isDuplicateGuidePoint([{ x: 30, y: 20 }], { x: 30, y: 80 }), false);
  assert.equal(isDuplicateGuidePoint([{ x: 30, y: 20 }], { x: 90, y: 20 }), false);
  assert.equal(isDuplicateGuidePoint([{ x: 30, y: 20 }], { x: 30.1, y: 20.1 }), true);
});

test("scan-line calculation retains fractional guide positions and auto handles two guides at the same X", () => {
  const image = { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255) };
  for (let y = 5; y <= 94; y += 1) image.rgba.set([0, 0, 0], (y * width + 60) * 4);
  const guides = [{ x: 60, y: 20.25, anchorId: "a" }, { x: 60, y: 80.125, anchorId: "b" }];
  const result = runComputeOperation("trace-line", {
    rect, anchors: guides, target: { r: 0, g: 0, b: 0 }, threshold: 5,
    targetStyle: "line", refinementMode: "off", orientationMode: "auto", maxGap: 3, maxJump: 8,
  }, image);
  assert.equal(result.orientation, "vertical");
  assert.doesNotThrow(() => prepareTraceOutput(result.path, { orientation: result.orientation, count: 100, guides }));
});

test("2D refinement off really leaves the skeleton unrefined", () => {
  const image = { width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255) };
  for (let index = 0; index < 3000; index += 1) {
    const angle = index / 3000 * Math.PI * 2;
    const x = Math.round(60 + 36 * Math.cos(angle));
    const y = Math.round(50 + 23 * Math.sin(angle));
    image.rgba.set([0, 0, 0], (y * width + x) * 4);
  }
  const options = { rect, anchors: [{ x: 96, y: 50 }], target: { r: 0, g: 0, b: 0 }, threshold: 5, targetStyle: "line", orientationMode: "parametric" };
  const off = runComputeOperation("trace-line", { ...options, refinementMode: "off" }, image);
  const full = runComputeOperation("trace-line", { ...options, refinementMode: "full" }, image);
  assert.equal(off.path.some((point) => point.centerRefined), false);
  assert.ok(full.path.some((point) => point.centerRefined));
});

test("new persistent error and scope messages are fully available in English", () => {
  for (const message of [
    "路径超出 Pen 约束范围；请补涂走廊或调整引导点后重试",
    "当前结果尚未按新设置更新；请重新追踪，或撤销本次调整",
    "路径未经过全部引导点；请调整走廊或切换二维追踪",
    "涂画区段内约束 · 两端允许延伸",
  ]) assert.doesNotMatch(translateMessage(message, "en"), /\p{Script=Han}/u);
});
