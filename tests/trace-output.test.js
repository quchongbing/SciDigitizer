import test from "node:test";
import assert from "node:assert/strict";
import { prepareInclusionMask, inclusionMaskAllows, constrainPathToInclusionMask, clusterColumnCandidates } from "../src/core.js";
import { isDuplicateGuidePoint, prepareTraceOutput, prepareRestoredTrace, selectExistingDataPoints } from "../src/trace-output.js";
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
  assert.equal(inclusionMaskAllows(local, width, 5, 20), true);
  assert.equal(inclusionMaskAllows(local, width, 5, 60), false, "an end gate is not an unrestricted half-plane");
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

test("local Pen eraser cuts remain forbidden after splitting a stroke in either orientation", () => {
  for (const vertical of [false, true]) {
    const data = new Uint8Array(width * height);
    const erased = new Uint8Array(data.length);
    const transform = (x, y) => vertical ? { x: y, y: x } : { x, y };
    for (let x = 10; x <= 90; x += 1) for (let y = 43; y <= 51; y += 1) {
      const p = transform(x, y);
      (x >= 45 && x <= 55 ? erased : data)[p.y * width + p.x] = 1;
    }
    const mask = prepareInclusionMask(data, width, height, "local", { erased });
    assert.equal(mask.regions.length, 1);
    assert.equal(mask.gates.length, 2);
    const forbidden = transform(50, 47);
    const bypass = transform(50, 20);
    const edge = transform(45, 47);
    const extension = transform(5, 47);
    assert.equal(inclusionMaskAllows(mask, width, forbidden.x, forbidden.y), false);
    assert.equal(inclusionMaskAllows(mask, width, bypass.x, bypass.y), false);
    assert.equal(inclusionMaskAllows(mask, width, extension.x, extension.y), true);
    for (const orientation of ["horizontal", "vertical", "parametric"]) {
      // Deliberate erasure is not a raster-edge error, even just 1 px from ink.
      assert.throws(() => prepareTraceOutput([edge], {
        inclusionMask: mask, width, height, rect, orientation,
      }), { code: "PEN_OUTSIDE" });
      assert.throws(() => prepareTraceOutput([forbidden], {
        inclusionMask: mask, width, height, rect, orientation, count: 100,
      }), { code: "PEN_OUTSIDE" });
    }
  }
});

test("repainting restores erased pixels without changing the supplied erasure raster", () => {
  const data = new Uint8Array(width * height);
  const erased = new Uint8Array(data.length);
  for (let x = 20; x <= 90; x += 1) data[40 * width + x] = 1;
  erased[40 * width + 50] = 1;
  const mask = prepareInclusionMask(data, width, height, "local", { erased });
  assert.equal(inclusionMaskAllows(mask, width, 50, 40), true);
  assert.equal(mask.erased[40 * width + 50], 0);
  assert.equal(erased[40 * width + 50], 1);
  assert.throws(() => prepareInclusionMask(data, width, height, "local", {
    erased: new Uint8Array(1),
  }), /Invalid Pen erasure dimensions/);
});

test("continuous Pen validation detects a one-pixel cut independently of output density and direction", () => {
  for (const scope of ["local", "strict"]) for (const orientation of ["horizontal", "vertical", "parametric"]) {
    const transform = (x, y) => orientation === "vertical" ? { x: y, y: x } : { x, y };
    const data = new Uint8Array(width * height), erased = new Uint8Array(data.length);
    for (let x = 5; x <= 95; x += 1) for (let y = 18; y <= 22; y += 1) {
      const p = transform(x, y);
      (x === 50 ? erased : data)[p.y * width + p.x] = 1;
    }
    const inclusionMask = prepareInclusionMask(data, width, height, scope, { erased });
    const path = [transform(5, 20), transform(95, 20)];
    for (const count of [null, 2, 3, 50, 100, 101, 200]) {
      assert.throws(() => prepareTraceOutput(path, {
        inclusionMask, width, height, rect, orientation, count,
      }), { code: "PEN_OUTSIDE" }, JSON.stringify({ scope, orientation, count }));
    }
    const outsideGuide = { ...transform(0, 20), anchor: true, userGuided: true, anchorId: "outside" };
    assert.throws(() => prepareTraceOutput([outsideGuide, path[1]], {
      inclusionMask, width, height, rect, orientation,
    }), { code: "PEN_OUTSIDE" }, "an outside guide cannot exempt an internal eraser cut");
    const retained = prepareRestoredTrace({ path, rawPath: path }, { inclusionMask, width, height, rect });
    assert.equal(retained.traceStale, true);
    assert.equal(retained.path, path, "keep legacy data recoverable, but do not export the invalid connection");
  }
});

test("continuous validation checks disconnected components and the last closed-path edge", () => {
  const mask = bentMask("strict");
  assert.throws(() => prepareTraceOutput([{ x: 20, y: 20 }, { x: 50, y: 50 }], {
    inclusionMask: mask, width, height, rect, count: null,
  }), { code: "PEN_OUTSIDE" });
  const closed = [{ x: 20, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50, closedPath: true }];
  assert.throws(() => prepareTraceOutput(closed, {
    inclusionMask: mask, width, height, rect, count: 2, orientation: "parametric",
  }), { code: "PEN_OUTSIDE" });
});

test("sparse point circles use their dense geometry on restore and export, not shortcut chords", () => {
  const geometryPath = [{ x: 20, y: 20 }, { x: 50, y: 20 }, { x: 50, y: 50 }];
  const options = { inclusionMask: bentMask("strict"), width, height, rect, orientation: "parametric" };
  const sparse = prepareTraceOutput(geometryPath, { ...options, count: 2 }).path;
  assert.equal(sparse.length, 2);
  const exported = prepareTraceOutput(sparse, { ...options, geometryPath, count: 100 });
  assert.equal(exported.path.length, 100);
  assert.ok(exported.path.every(p => inclusionMaskAllows(options.inclusionMask, width, p.x, p.y)));
  const restored = prepareRestoredTrace({ path: sparse, rawPath: geometryPath }, options);
  assert.equal(restored.traceStale, false);
  assert.throws(() => prepareTraceOutput(sparse, { ...options, geometryPath: [{ x: NaN, y: 20 }] }), {
    code: "INVALID_PATH",
  });
});

test("discrete markers are not connected by continuous Pen validation", () => {
  const data = new Uint8Array(width * height);
  data[20 * width + 20] = data[80 * width + 90] = 1;
  const path = [{ x: 20, y: 20 }, { x: 90, y: 80 }];
  const options = { inclusionMask: prepareInclusionMask(data, width, height, "strict"), width, height, rect };
  assert.equal(prepareTraceOutput(path, { ...options, markerData: true, count: 100 }).path.length, 2);
  assert.throws(() => prepareTraceOutput(path, options), { code: "PEN_OUTSIDE" });
});

test("reducing discrete markers retains guides and remains exportable and restorable", () => {
  const raw = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i * 9, y: 30 + i, marker: true,
    ...([3, 5, 8].includes(i) ? { anchor: true, userGuided: true, anchorId: `g${i}` } : {}),
  }));
  const data = new Uint8Array(width * height);
  for (const p of raw) data[p.y * width + p.x] = 1;
  const options = { markerData: true, inclusionMask: prepareInclusionMask(data, width, height, "strict"), width, height, rect };
  for (const count of [1, 2, 3, 4, 5, 7, 11, 50]) {
    const path = selectExistingDataPoints(raw, count);
    assert.equal(path.length, Math.min(raw.length, Math.max(count, 3)));
    assert.equal(new Set(path.map(p => p.x)).size, path.length);
    for (const p of path) assert.ok(raw.some(source => source.x === p.x && source.y === p.y));
    for (const guide of raw.filter(p => p.anchor)) assert.ok(path.some(p => p.anchorId === guide.anchorId));
    assert.doesNotThrow(() => prepareTraceOutput(path, { ...options, geometryPath: raw, count: 200 }));
    assert.equal(prepareRestoredTrace({ path, rawPath: raw, traceStale: false }, options).traceStale, false);
  }
});

test("a guide outside Pen stays exact and must also exist in the dense geometry", () => {
  const guide = { x: 0, y: 20, anchor: true, anchorId: "outside", userGuided: true };
  const path = [guide, { x: 20, y: 20 }, { x: 50, y: 20 }];
  const options = { inclusionMask: bentMask("strict"), width, height, rect };
  assert.equal(prepareTraceOutput(path, options).path[0].x, guide.x);
  assert.throws(() => prepareTraceOutput(path, { ...options, geometryPath: path.slice(1) }), { code: "MISSING_GUIDE" });
});

test("draft and project restoration checks stored guides even if the old result was marked valid", () => {
  const guide = { x: 40, y: 20, anchorId: "saved-guide", userGuided: true };
  const regular = [{ x: 20, y: 20 }, { x: 50, y: 20 }];
  const complete = [regular[0], { ...guide, anchor: true }, regular[1]];
  for (const markerData of [false, true]) {
    for (const [path, rawPath] of [[regular, regular], [regular, complete], [complete, regular]]) {
      const curve = { path, rawPath, anchors: [guide], traceStale: false };
      const restored = prepareRestoredTrace(curve, { markerData, rect, width, height });
      assert.equal(restored.traceStale, true, "missing guides must not be silently accepted");
      assert.equal(restored.path, path, "failed validation must preserve recoverable coordinates");
    }
    assert.equal(prepareRestoredTrace({
      path: complete, rawPath: complete, anchors: [guide], traceStale: false,
    }, { markerData, rect, width, height }).traceStale, false);
  }
  // Marker guides select an existing measured centre, unlike continuous-line
  // anchors, whose exact coordinates are part of the output contract.
  const markerGuide = { ...guide, x: 40.4, y: 20.4 };
  assert.equal(prepareRestoredTrace({
    path: complete, rawPath: complete, anchors: [markerGuide],
  }, { markerData: true, rect, width, height }).traceStale, false);
  assert.equal(prepareRestoredTrace({
    path: complete, rawPath: complete, anchors: [markerGuide],
  }, { rect, width, height }).traceStale, true);
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
  rgba.set([0, 0, 0, 255], (20 * width + 5) * 4);
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
