import test from "node:test";
import assert from "node:assert/strict";

import { traceCurveThroughAnchors, prepareInclusionMask, inclusionMaskAllows } from "../src/core.js";
import { prepareRestoredTrace, prepareTraceOutput } from "../src/trace-output.js";
import { createComputeClient } from "../src/compute-client.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { traceParametricCurve } from "../src/parametric-trace.js";

function whiteImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = 255;
    rgba[index + 1] = 255;
    rgba[index + 2] = 255;
    rgba[index + 3] = 255;
  }
  return { rgba, width, height };
}

function setPixel(image, x, y, color) {
  const index = (y * image.width + x) * 4;
  image.rgba[index] = color.r;
  image.rgba[index + 1] = color.g;
  image.rgba[index + 2] = color.b;
}

function fillRect(image, rect, color) {
  for (let y = Math.ceil(rect.top); y <= Math.floor(rect.bottom); y += 1) {
    for (let x = Math.ceil(rect.left); x <= Math.floor(rect.right); x += 1) {
      setPixel(image, x, y, color);
    }
  }
}

function drawParametricStroke(image, pointAt, color, samples = 6000, radius = 0) {
  for (let index = 0; index <= samples; index += 1) {
    const point = pointAt(index / samples);
    const centerX = Math.round(point.x);
    const centerY = Math.round(point.y);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (Math.hypot(offsetX, offsetY) > radius + 0.25) continue;
        setPixel(image, centerX + offsetX, centerY + offsetY, color);
      }
    }
  }
}

function drawPatternedParametricStroke(
  image,
  pointAt,
  color,
  { samples = 9000, onLength = 10, offLength = 6, segments = null } = {},
) {
  const pattern = segments ?? [onLength, offLength];
  const patternLength = pattern.reduce((sum, length) => sum + length, 0);
  const paintsAt = (distance) => {
    let phase = distance % patternLength;
    for (let index = 0; index < pattern.length; index += 1) {
      if (phase < pattern[index]) return index % 2 === 0;
      phase -= pattern[index];
    }
    return false;
  };
  let previous = pointAt(0);
  let arcLength = 0;
  for (let index = 0; index <= samples; index += 1) {
    const point = pointAt(index / samples);
    if (index > 0) arcLength += Math.hypot(point.x - previous.x, point.y - previous.y);
    if (paintsAt(arcLength)) {
      setPixel(image, Math.round(point.x), Math.round(point.y), color);
    }
    previous = point;
  }
}

test("automatic black tracing protects a confirmed frame without cropping near-axis data", () => {
  const image = whiteImage(240, 160), target = { r: 8, g: 8, b: 8 };
  const rect = { left: 10, top: 10, right: 229, bottom: 149, width: 220, height: 140 };
  fillRect(image, { left: 10, top: 10, right: 229, bottom: 11 }, target);
  fillRect(image, { left: 10, top: 148, right: 229, bottom: 149 }, target);
  fillRect(image, { left: 10, top: 10, right: 11, bottom: 149 }, target);
  fillRect(image, { left: 228, top: 10, right: 229, bottom: 149 }, target);
  for (let x = 35; x <= 205; x++) setPixel(image, x, Math.round(142 - (x - 35) * 0.63), target);
  const anchors = [{ x: 110, y: Math.round(142 - 75 * 0.63), anchorId: "a", userGuided: true }];
  const result = runComputeOperation("trace-line", { rect, target, anchors, threshold: 5,
    targetStyle: "line", maxJump: 8, maxGap: 12, orientationMode: "auto" }, image);
  assert.equal(result.orientation, "horizontal");
  assert.ok(result.path.length >= 170);
  assert.ok(result.path.every(point => Math.abs(point.y - (142 - (point.x - 35) * 0.63)) <= 0.6));
  assert.ok(result.path.some(point => point.x === 35 && point.y === 142), "valid point close to lower axis was cropped");
});

test("frame protection respects explicit edge guides and does not treat L-shaped ink as a frame", () => {
  const image = whiteImage(150, 100), target = { r: 8, g: 8, b: 8 };
  const rect = { left: 5, top: 5, right: 144, bottom: 94, width: 140, height: 90 };
  fillRect(image, { left: 5, top: 5, right: 144, bottom: 5 }, target);
  fillRect(image, { left: 5, top: 5, right: 5, bottom: 94 }, target);
  const seed = { x: 50, y: 5, anchorId: "edge", userGuided: true };
  let result = runComputeOperation("trace-line", { rect, target, anchors: [seed], threshold: 5,
    targetStyle: "line", maxJump: 8, maxGap: 12, orientationMode: "horizontal" }, image);
  assert.ok(result.path.length >= 130);
  assert.ok(result.path.some(point => point.anchorId === "edge" && point.y === 5));
  fillRect(image, { left: 144, top: 5, right: 144, bottom: 94 }, target);
  fillRect(image, { left: 5, top: 94, right: 144, bottom: 94 }, target);
  result = runComputeOperation("trace-line", { rect, target, anchors: [seed], threshold: 5,
    targetStyle: "line", maxJump: 8, maxGap: 12, orientationMode: "horizontal" }, image);
  assert.ok(result.path.length >= 130, "explicit edge guide must override automatic frame protection");
  const data = new Uint8Array(image.width * image.height);
  for (let x = 5; x <= 144; x++) data[5 * image.width + x] = 1;
  result = runComputeOperation("trace-line", { rect, target, anchors: [{ ...seed, y: 6 }], threshold: 5,
    inclusionMask: prepareInclusionMask(data, image.width, image.height, "strict"),
    targetStyle: "line", maxJump: 8, maxGap: 12, orientationMode: "horizontal" }, image);
  assert.ok(result.path.length >= 130, "painted edge must remain available");
});

test("confirmed black frame protection tolerates a one- or two-pixel outer fringe", () => {
  for (const fringe of [1, 2]) {
    const image = whiteImage(240, 160), target = { r: 8, g: 8, b: 8 };
    const rect = { left: 10, top: 10, right: 229, bottom: 149, width: 220, height: 140 };
    const left = rect.left + fringe, right = rect.right - fringe;
    const top = rect.top + fringe, bottom = rect.bottom - fringe;
    fillRect(image, { left, right, top, bottom: top + 1 }, target);
    fillRect(image, { left, right, top: bottom - 1, bottom }, target);
    fillRect(image, { left, right: left + 1, top, bottom }, target);
    fillRect(image, { left: right - 1, right, top, bottom }, target);
    for (let x = 35; x <= 205; x++) setPixel(image, x, Math.round(142 - (x - 35) * 0.63), target);
    const result = runComputeOperation("trace-line", { rect, target, threshold: 5,
      anchors: [{ x: 110, y: Math.round(142 - 75 * 0.63), anchorId: "a" }],
      targetStyle: "line", maxJump: 8, maxGap: 12, orientationMode: "auto" }, image);
    assert.ok(result.path.length >= 170);
    assert.ok(result.path.every(point => Math.abs(point.y - (142 - (point.x - 35) * 0.63)) <= 0.6));
  }
});

test("background compute engine preserves the synchronous line-tracing result", () => {
  const image = whiteImage(70, 44);
  const target = { r: 25, g: 135, b: 210 };
  for (let x = 4; x <= 65; x += 1) {
    const y = Math.round(12 + x * 0.3);
    setPixel(image, x, y, target);
  }
  const options = {
    rect: { left: 4, top: 4, right: 65, bottom: 39, width: 62, height: 36 },
    anchors: [{ x: 8, y: 14 }, { x: 60, y: 30 }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 4,
    maxGap: 8,
    targetStyle: "line",
  };
  const expected = traceCurveThroughAnchors({ ...options, ...image });
  const result = runComputeOperation("trace-line", {
    ...options,
    refinementMode: "off",
    orientationMode: "horizontal",
  }, image);
  assert.equal(result.targetStyle, "line");
  assert.equal(result.orientation, "horizontal");
  assert.deepEqual(result.path.map(({ traceOrientation, parametricOrder, ...point }) => point), expected);
  assert.ok(result.path.every((point, index) => (
    point.traceOrientation === "horizontal" && point.parametricOrder === index
  )));
});

test("steep ordinary peaks with nearby guides do not require a 2D Pen route", () => {
  const image = whiteImage(240, 200);
  const target = { r: 57, g: 79, b: 124 };
  const curveY = x => 178 - 158 * Math.exp(-(((x - 94) / 8) ** 2))
    - 50 * Math.exp(-(((x - 182) / 26) ** 2));
  drawParametricStroke(image, t => ({ x: 12 + 214 * t, y: curveY(12 + 214 * t) }), target, 12000, 1);
  // A separate same-colour legend must not make this ordinary y(x) peak
  // require a mixed-direction model.
  fillRect(image, { left: 30, right: 52, top: 30, bottom: 32 }, target);
  const anchors = [30, 84, 87, 182, 220].map((x, index) => ({
    x, y: curveY(x), anchorId: `peak-${index}`,
  }));
  const options = {
    rect: { left: 10, top: 10, right: 230, bottom: 190, width: 221, height: 181 },
    anchors, target, threshold: 5, maxJump: 20, maxGap: 12,
    targetStyle: "line", refinementMode: "full", inclusionMask: null,
  };
  const expected = runComputeOperation("trace-line", { ...options, orientationMode: "horizontal" }, image);
  for (const guides of [anchors, [...anchors].reverse()]) {
    const result = runComputeOperation("trace-line", { ...options, anchors: guides, orientationMode: "auto" }, image);
    assert.equal(result.orientation, "horizontal");
    assert.deepEqual(result.path, expected.path);
    for (const guide of guides) assert.ok(result.path.some(p => p.anchorId === guide.anchorId
      && p.x === guide.x && p.y === guide.y));
    const sampled = prepareTraceOutput(result.path, {
      guides, count: 100, orientation: result.orientation, rect: options.rect,
      width: image.width, height: image.height,
    }).path;
    assert.equal(sampled.length, 100);
    assert.ok(sampled.some(p => p.x > 210), "the descending side and far tail remain available");
  }
});

test("a genuinely disconnected unpainted 2D route does not ask users to repair a Pen", () => {
  const image = whiteImage(180, 160);
  const anchors = [{ x: 20, y: 45 }, { x: 120, y: 35 }, { x: 120, y: 130 }]
    .map((point, index) => ({ ...point, anchorId: `disconnected-${index}` }));
  assert.throws(() => runComputeOperation("trace-line", {
    rect: { left: 5, top: 5, right: 174, bottom: 154, width: 170, height: 150 },
    anchors, target: { r: 10, g: 10, b: 10 }, threshold: 5,
    maxJump: 8, maxGap: 3, targetStyle: "line", orientationMode: "auto",
    inclusionMask: null,
  }, image), error => {
    assert.match(error.message, /无法连续连接全部引导点/);
    assert.doesNotMatch(error.message, /Pen|补涂/);
    return true;
  });
});

test("automatic line tracing switches to the vertical frame for a near-vertical curve", () => {
  const image = whiteImage(76, 112);
  const target = { r: 35, g: 155, b: 85 };
  const curveX = (y) => Math.round(37 + 6 * Math.sin((y - 8) / 13));
  for (let y = 7; y <= 104; y += 1) setPixel(image, curveX(y), y, target);
  const rect = { left: 4, top: 6, right: 70, bottom: 105, width: 67, height: 100 };
  const result = runComputeOperation("trace-line", {
    rect,
    anchors: [{ x: curveX(55), y: 55, anchorId: "seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 3,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "off",
    orientationMode: "auto",
  }, image);

  assert.equal(result.orientation, "vertical");
  assert.ok(result.path.length >= 95);
  assert.ok(result.path.at(-1).y - result.path[0].y >= 96);
  assert.ok(result.path.every((point) => Math.abs(point.x - curveX(Math.round(point.y))) <= 0.6));
  assert.ok(new Set(result.path.map((point) => point.x)).size < result.path.length / 3);
  assert.ok(result.path.every((point, index) => (
    point.traceOrientation === "vertical" && point.parametricOrder === index
  )));
});

test("vertical tracing preserves every manually placed guide exactly", () => {
  const image = whiteImage(70, 104);
  const target = { r: 105, g: 65, b: 205 };
  const curveX = (y) => Math.round(31 + 4 * Math.sin(y / 11));
  for (let y = 5; y <= 98; y += 1) setPixel(image, curveX(y), y, target);
  const anchors = [
    { x: curveX(18), y: 18, anchorId: "guide-a" },
    { x: curveX(82), y: 82, anchorId: "guide-b" },
  ];
  const result = runComputeOperation("trace-line", {
    rect: { left: 4, top: 4, right: 65, bottom: 99, width: 62, height: 96 },
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 3,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "vertical",
  }, image);

  assert.equal(result.orientation, "vertical");
  for (const guide of anchors) {
    const retained = result.path.find((point) => point.anchorId === guide.anchorId);
    assert.ok(retained, `missing ${guide.anchorId}`);
    assert.equal(retained.x, guide.x);
    assert.equal(retained.y, guide.y);
    assert.equal(retained.anchor, true);
  }
});

test("local Pen tails do not reconnect to same-colour frame lines through forbidden pixels", () => {
  for (const vertical of [false, true]) {
    for (const guided of [false, true]) {
      const image = whiteImage(300, 300);
      const target = { r: 17, g: 17, b: 17 };
      const rect = { left: 10, top: 10, right: 290, bottom: 290, width: 281, height: 281 };
      const transform = (x, y) => vertical ? { x: y, y: x } : { x, y };
      const data = new Uint8Array(image.width * image.height);
      for (const edge of [9, 10, 289, 290]) for (let along = 9; along <= 290; along += 1) {
        setPixel(image, edge, along, target); setPixel(image, along, edge, target);
      }
      for (let x = 30; x <= 269; x += 1) for (const y of [139, 140]) {
        const point = transform(x, y);
        setPixel(image, point.x, point.y, target);
      }
      for (let x = 18; x <= 282; x += 1) for (let y = 128; y <= 152; y += 1) {
        if (Math.hypot(x - Math.max(30, Math.min(270, x)), y - 140) <= 12) {
          const painted = transform(x, y);
          data[painted.y * image.width + painted.x] = 1;
        }
      }
      const inclusionMask = prepareInclusionMask(data, image.width, image.height, "local");
      const anchors = (guided ? [50, 180, 240] : [50]).map((x, index) => ({
        ...transform(x, 140), anchorId: `guide-${index}`, userGuided: true,
      }));
      const result = runComputeOperation("trace-line", {
        rect, anchors, target, threshold: 5, inclusionMask,
        maxJump: 14, maxGap: 24, targetStyle: "line", refinementMode: "full", orientationMode: "auto",
      }, image);
      const orientation = vertical ? "vertical" : "horizontal";
      assert.equal(result.orientation, orientation, JSON.stringify({vertical, guided}));
      assert.ok(result.path.length >= 235, "retain the whole isolated stroke");
      assert.ok(result.path.every(point => Math.abs((vertical ? point.x : point.y) - 140) < 1),
        JSON.stringify({vertical, guided, outside: result.path.filter(point => Math.abs((vertical ? point.x : point.y) - 140) >= 1).map(point=>({x:point.x,y:point.y})).slice(0, 5)}));
      const output = prepareTraceOutput(result.path, {
        inclusionMask, width: image.width, height: image.height, rect, orientation, guides: anchors, count: 100,
      });
      assert.equal(output.path.length, 100);
      assert.ok(output.path.every(point => inclusionMaskAllows(inclusionMask, image.width, point.x, point.y)));
    }
  }
});

test("a Pen corridor is transposed into row-local constraints for vertical tracing", () => {
  const image = whiteImage(68, 94);
  const target = { r: 210, g: 75, b: 145 };
  const maskData = new Uint8Array(image.width * image.height);
  const maskColumns = new Uint8Array(image.width);
  for (let y = 5; y <= 88; y += 1) {
    setPixel(image, 30, y, target);
    setPixel(image, 36, y, target);
    for (let x = 35; x <= 37; x += 1) {
      maskData[y * image.width + x] = 1;
      maskColumns[x] = 1;
    }
  }
  const result = runComputeOperation("trace-line", {
    rect: { left: 4, top: 4, right: 63, bottom: 89, width: 60, height: 86 },
    anchors: [{ x: 36, y: 46, anchorId: "seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: { data: maskData, columns: maskColumns },
    maxJump: 8,
    maxGap: 2,
    targetStyle: "line",
    refinementMode: "off",
    orientationMode: "vertical",
  }, image);

  assert.equal(result.orientation, "vertical");
  assert.ok(result.path.length >= 80);
  assert.ok(result.path.filter((point) => point.observed && !point.anchor).every((point) => point.x === 36));
});

test("automatic tracing selects an ordered closed path instead of one half of a loop", () => {
  const image = whiteImage(104, 104);
  const target = { r: 20, g: 125, b: 205 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 52 + Math.cos(angle) * 31, y: 52 + Math.sin(angle) * 27 };
  }, target);
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 96, bottom: 96, width: 89, height: 89 },
    anchors: [{ x: 83, y: 52, anchorId: "loop-seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.closed, true);
  assert.ok(result.parametricDiagnostics.topologyConfidence >= 0.86);
  assert.ok(result.path.length >= 140);
  assert.ok(result.parametricDiagnostics.arcLength >= 165);
  assert.ok(new Set(result.path.map((point) => Math.round(point.x))).size < result.path.length / 2);
  assert.ok(new Set(result.path.map((point) => Math.round(point.y))).size < result.path.length / 2);
  assert.ok(result.path.every((point, index) => (
    point.traceOrientation === "parametric"
    && point.closedPath
    && point.parametricOrder === index
  )));
  const seed = result.path.find((point) => point.anchorId === "loop-seed");
  assert.deepEqual({ x: seed.x, y: seed.y }, { x: 83, y: 52 });
});

test("closed-path tracing centres a thick loop and preserves guide order exactly", () => {
  const image = whiteImage(120, 108);
  const target = { r: 155, g: 65, b: 195 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 54 + Math.sin(angle) * 23 };
  }, target, 7000, 2);
  const anchors = [
    { x: 96, y: 54, anchorId: "right" },
    { x: 60, y: 31, anchorId: "top" },
  ];
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 112, bottom: 100, width: 105, height: 93 },
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.simpleCycle, true);
  const retained = anchors.map((guide) => result.path.find((point) => point.anchorId === guide.anchorId));
  assert.deepEqual(retained.map((point) => [point.x, point.y]), [[96, 54], [60, 31]]);
  assert.ok(retained[1].parametricOrder > 0);
  assert.ok(retained[1].parametricOrder < result.path.length / 2);
  const ellipseError = result.path.reduce((sum, point) => {
    const normalizedRadius = Math.hypot((point.x - 60) / 36, (point.y - 54) / 23);
    return sum + Math.abs(normalizedRadius - 1);
  }, 0) / result.path.length;
  assert.ok(ellipseError < 0.04);
});

test("automatic tracing follows both arms of an open hairpin in one ordered path", () => {
  const image = whiteImage(112, 112);
  const target = { r: 20, g: 165, b: 115 };
  drawParametricStroke(image, (fraction) => {
    const parameter = fraction * 2 - 1;
    return {
      x: 25 + 55 * parameter * parameter,
      y: 54 + 32 * parameter,
    };
  }, target, 7000);
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 104, bottom: 104, width: 97, height: 97 },
    anchors: [{ x: 25, y: 54, anchorId: "hairpin-seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "open-path");
  assert.equal(result.parametricDiagnostics.closed, false);
  assert.equal(result.parametricDiagnostics.simplePath, true);
  assert.ok(result.path.length >= 115);
  assert.ok(result.path.every((point) => !point.closedPath));
  assert.ok(Math.abs(result.path[0].x - 80) <= 1.2);
  assert.ok(Math.abs(result.path.at(-1).x - 80) <= 1.2);
  assert.ok(Math.abs(result.path[0].y - result.path.at(-1).y) >= 62);
  assert.ok(new Set(result.path.map((point) => Math.round(point.x))).size < result.path.length / 2);
  const seed = result.path.find((point) => point.anchorId === "hairpin-seed");
  assert.deepEqual({ x: seed.x, y: seed.y }, { x: 25, y: 54 });
});

test("explicit two-dimensional tracing traverses every edge of a self-intersecting loop", () => {
  const image = whiteImage(136, 116);
  const target = { r: 210, g: 85, b: 45 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return {
      x: 68 + Math.sin(angle) * 42,
      y: 58 + Math.sin(angle * 2) * 30,
    };
  }, target, 9000);
  const anchors = [
    { x: 104, y: 84, anchorId: "right-lobe" },
    { x: 32, y: 84, anchorId: "left-lobe" },
  ];
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 128, bottom: 108, width: 121, height: 101 },
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "self-intersecting-cycle");
  assert.equal(result.parametricDiagnostics.eulerianCycle, true);
  assert.equal(result.parametricDiagnostics.closed, true);
  assert.ok(result.path.length >= 250);
  assert.ok(result.path.every((point) => point.closedPath && point.topologyReview));
  const centerVisits = result.path.filter((point) => Math.hypot(point.x - 68, point.y - 58) <= 2.2);
  assert.ok(centerVisits.length >= 2);
  assert.ok(Math.min(...result.path.map((point) => point.x)) <= 27);
  assert.ok(Math.max(...result.path.map((point) => point.x)) >= 109);
  for (const guide of anchors) {
    const retained = result.path.find((point) => point.anchorId === guide.anchorId);
    assert.deepEqual({ x: retained.x, y: retained.y }, { x: guide.x, y: guide.y });
  }

  const automatic = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 128, bottom: 108, width: 121, height: 101 },
    anchors: [anchors[0]],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image);
  assert.notEqual(automatic.orientation, "parametric", "branched topology stays explicit");
});

test("ordered guides route an explicit two-dimensional hairpin past an unsupported spur", () => {
  const image = whiteImage(118, 112);
  const target = { r: 65, g: 105, b: 220 };
  drawParametricStroke(image, (fraction) => {
    const parameter = fraction * 2 - 1;
    return {
      x: 28 + 58 * parameter * parameter,
      y: 54 + 32 * parameter,
    };
  }, target, 7000);
  for (let x = 10; x <= 28; x += 1) setPixel(image, x, 54, target);
  const anchors = [
    { x: 74, y: 25, anchorId: "upper-arm" },
    { x: 74, y: 83, anchorId: "lower-arm" },
  ];
  const result = runComputeOperation("trace-line", {
    rect: { left: 6, top: 8, right: 110, bottom: 104, width: 105, height: 97 },
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "guided-branched-path");
  assert.equal(result.parametricDiagnostics.guidedBranchedPath, true);
  assert.equal(result.parametricDiagnostics.closed, false);
  assert.ok(result.path.every((point) => point.topologyReview && !point.closedPath));
  assert.ok(Math.min(...result.path.map((point) => point.x)) >= 24, "unguided left spur is excluded");
  assert.ok(Math.abs(result.path[0].x - 86) <= 1.2);
  assert.ok(Math.abs(result.path.at(-1).x - 86) <= 1.2);
  for (const guide of anchors) {
    const retained = result.path.find((point) => point.anchorId === guide.anchorId);
    assert.deepEqual({ x: retained.x, y: retained.y }, { x: guide.x, y: guide.y });
  }
});

test("unordered guides and a Pen corridor recover a curve that turns vertical through same-color ink", () => {
  const image = whiteImage(156, 124);
  const target = { r: 8, g: 8, b: 8 };
  const rect = { left: 10, top: 10, right: 144, bottom: 112, width: 135, height: 103 };
  const curvePoint = (fraction) => {
    if (fraction <= 0.68) {
      const progress = fraction / 0.68;
      return {
        x: 10 + 88 * progress,
        y: 62 - 25 * Math.sin(Math.PI * progress),
      };
    }
    const progress = (fraction - 0.68) / 0.32;
    return { x: 98, y: 62 + 50 * progress };
  };
  // The target touches the left and bottom axes and crosses another black
  // curve, matching a common log-log regime diagram. Globally this is one
  // branched black graph rather than a simple y(x) or x(y) path.
  drawParametricStroke(image, (fraction) => ({ x: 10 + 134 * fraction, y: 92 - 70 * fraction }), target, 5000);
  drawParametricStroke(image, curvePoint, target, 9000);
  for (let x = rect.left; x <= rect.right; x += 1) {
    setPixel(image, x, rect.top, target);
    setPixel(image, x, rect.bottom, target);
  }
  for (let y = rect.top; y <= rect.bottom; y += 1) {
    setPixel(image, rect.left, y, target);
    setPixel(image, rect.right, y, target);
  }

  const data = new Uint8Array(image.width * image.height);
  const columns = new Uint8Array(image.width);
  const rows = new Uint8Array(image.height);
  const paint = (point, radius = 5) => {
    for (let y = Math.floor(point.y - radius); y <= Math.ceil(point.y + radius); y += 1) {
      for (let x = Math.floor(point.x - radius); x <= Math.ceil(point.x + radius); x += 1) {
        if (x < 0 || x >= image.width || y < 0 || y >= image.height) continue;
        if (Math.hypot(x - point.x, y - point.y) > radius) continue;
        data[y * image.width + x] = 1;
        columns[x] = 1;
        rows[y] = 1;
      }
    }
  };
  for (let index = 0; index <= 2400; index += 1) paint(curvePoint(index / 2400));
  // Match realistic interaction: users add guides where they notice a problem,
  // not necessarily from one curve endpoint to the other.
  const anchors = [0.29, 0.68, 0.96, 0.82, 0.05, 0.55].map((fraction, index) => {
    const point = curvePoint(fraction);
    return { ...point, anchorId: `mixed-${index}` };
  });
  const result = runComputeOperation("trace-line", {
    rect,
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: { data, columns, rows },
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "guided-branched-path");
  assert.equal(result.parametricDiagnostics.guidedBranchedPath, true);
  assert.equal(result.parametricDiagnostics.closed, false);
  assert.ok(result.path.every((point) => point.topologyReview && !point.closedPath));
  assert.ok(Math.min(...result.path.map((point) => point.x)) <= 11.5);
  assert.ok(Math.max(...result.path.map((point) => point.x)) <= 104);
  assert.ok(Math.max(...result.path.map((point) => point.y)) >= 110.5);
  const vertical = result.path.filter((point) => point.y >= 72);
  assert.ok(vertical.length >= 35);
  const maximumVerticalDeviation = Math.max(...vertical.map((point) => Math.abs(point.x - 98)));
  const centeredVerticalFraction = vertical.filter((point) => Math.abs(point.x - 98) <= 2.2).length
    / vertical.length;
  assert.ok(centeredVerticalFraction >= 0.9);
  assert.ok(maximumVerticalDeviation <= 5.2, `vertical endpoint deviation ${maximumVerticalDeviation}`);
  for (const guide of anchors) {
    const retained = result.path.find((point) => point.anchorId === guide.anchorId);
    assert.deepEqual({ x: retained.x, y: retained.y }, { x: guide.x, y: guide.y });
  }

  const partialData = data.slice();
  const partialColumns = columns.slice();
  const partialRows = new Uint8Array(image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < 68; x += 1) partialData[y * image.width + x] = 0;
    for (let x = 68; x < image.width; x += 1) {
      if (partialData[y * image.width + x]) partialRows[y] = 1;
    }
  }
  partialColumns.fill(0, 0, 68);
  assert.throws(() => runComputeOperation("trace-line", {
    rect,
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: { data: partialData, columns: partialColumns, rows: partialRows },
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image), /二维 Pen 路径不连续/);

  // Shading must not become a black foreground component. Four unordered
  // guides should resolve the mixed-direction route even without a full Pen.
  const shaded = { ...image, rgba: image.rgba.slice() };
  for (let y = rect.top + 1; y < rect.bottom; y += 1) {
    for (let x = rect.left + 1; x < rect.right; x += 1) {
      const offset = (y * image.width + x) * 4;
      if (shaded.rgba[offset] !== 255) continue;
      const background = x >= 65 ? [96, 103, 121] : [129, 167, 185];
      shaded.rgba.set(background, offset);
    }
  }
  const fourGuides = [0.29, 0.62, 0.96, 0.82].map((fraction, index) => ({
    ...curvePoint(fraction), anchorId: `shaded-${index}`,
  }));
  // The border is antialiased differently over light/dark backgrounds. Only
  // part of it matches black; frame rejection must use local contrast rather
  // than the target-colour threshold or the leftover part becomes a false tail.
  for (let x = rect.left; x <= rect.right; x += 1) {
    const edge = x >= 65 ? { r: 29, g: 31, b: 36 } : { r: 65, g: 84, b: 93 };
    setPixel(shaded, x, rect.top, edge); setPixel(shaded, x, rect.bottom, edge);
  }
  for (const inclusionMask of [null,
    prepareInclusionMask(data, image.width, image.height, "strict"),
    prepareInclusionMask(partialData, image.width, image.height, "local"),
  ]) {
    const result = runComputeOperation("trace-line", {
      rect, anchors: fourGuides, target, threshold: 9, maxJump: 8, maxGap: 3,
      targetStyle: "line", refinementMode: "full", orientationMode: "auto", inclusionMask,
    }, shaded);
    assert.equal(result.orientation, "parametric");
    const output = prepareTraceOutput(result.path, {
      count: 100, parameters: { samplingMode: "geometry" }, orientation: result.orientation,
      guides: fourGuides, inclusionMask, width: image.width, height: image.height, rect,
    }).path;
    assert.equal(output.length, 100);
    const vertical = output.filter(point => point.y > 68 && point.y < rect.bottom - 6);
    assert.ok(vertical.length >= 15);
    assert.ok(vertical.every(point => Math.abs(point.x - 98) <= 2.2));
    if (inclusionMask?.mode !== "strict") {
      assert.ok(output.filter(point => point.y > 68).every(point => Math.abs(point.x - 98) <= 2.2),
        "an antialiased axis must not become a tail of the target curve");
    }
    assert.ok(output.every(point => point.anchor || inclusionMaskAllows(inclusionMask, image.width, point.x, point.y)));
    for (const guide of fourGuides) assert.ok(output.some(point => point.anchorId === guide.anchorId
      && point.x === guide.x && point.y === guide.y));
  }
});

function sameColorCrossingFixture(transposed = false) {
  const image = whiteImage(220, 220);
  const target = { r: 24, g: 100, b: 190 };
  const transform = (point) => transposed ? { ...point, x: point.y, y: point.x } : { ...point };
  const paint = (x, y) => {
    const point = transform({ x, y });
    setPixel(image, point.x, point.y, target);
  };
  for (let x = 12; x <= 182; x += 1) {
    for (let y = 59; y <= 61; y += 1) paint(x, y);
  }
  // The interfering branch is longer than the desired straight continuation.
  for (let y = 12; y <= 204; y += 1) {
    for (let x = 104; x <= 106; x += 1) paint(x, y);
  }
  const data = new Uint8Array(image.width * image.height);
  for (let y = 51; y <= 69; y += 1) {
    for (let x = 80; x <= 130; x += 1) {
      const point = transform({ x, y });
      data[point.y * image.width + point.x] = 1;
    }
  }
  return {
    image, transform,
    options: {
      rect: { left: 8, top: 8, right: 211, bottom: 211, width: 204, height: 204 },
      target, threshold: 9, targetStyle: "line", refinementMode: "full", maxJump: 14, maxGap: 24,
      inclusionMask: prepareInclusionMask(data, image.width, image.height, "local"),
    },
  };
}

test("guided same-color crossings prefer continuity over a longer interfering branch", () => {
  for (const transposed of [false, true]) {
    const { image, options, transform } = sameColorCrossingFixture(transposed);
    const anchors = [20, 65, 91].map((x, index) => transform({ x, y: 60, anchorId: `cross-${index}` }));
    for (const orientationMode of ["auto", "parametric"]) {
      const result = runComputeOperation("trace-line", { ...options, anchors, orientationMode }, image);
      assert.equal(result.orientation, "parametric");
      assert.equal(result.parametricDiagnostics.topology, "guided-branched-path");
      const path = result.path.map(transform);
      assert.ok(Math.min(...path.map(point => point.x)) <= 14);
      assert.ok(Math.max(...path.map(point => point.x)) >= 180, "reach the target's far endpoint");
      assert.ok(path.every(point => Math.abs(point.y - 60) < 1.5), "do not turn into the same-color branch");
      const output = prepareTraceOutput(result.path, {
        count: 100, orientation: result.orientation, guides: anchors, ...options,
        width: image.width, height: image.height,
      }).path;
      assert.equal(output.length, 100);
      for (const guide of anchors) assert.ok(output.some(point => point.anchorId === guide.anchorId
        && point.x === guide.x && point.y === guide.y));
    }
  }
});

test("explicit guides can still turn at a same-color crossing", () => {
  for (const transposed of [false, true]) {
    const { image, options, transform } = sameColorCrossingFixture(transposed);
    // This tests guide-directed routing without a contradictory straight Pen.
    // A horizontal painted section now intentionally forbids a sideways exit.
    options.inclusionMask = null;
    const anchors = [{ x: 20, y: 60 }, { x: 65, y: 60 }, { x: 105, y: 130 }, { x: 105, y: 180 }]
      .map((point, index) => transform({ ...point, anchorId: `turn-${index}` }));
    for (const orientationMode of ["auto", "parametric"]) {
      const result = runComputeOperation("trace-line", { ...options, anchors, orientationMode }, image);
      assert.equal(result.orientation, "parametric");
      const path = result.path.map(transform);
      assert.ok(Math.min(...path.map(point => point.x)) <= 14);
      assert.ok(Math.max(...path.map(point => point.y)) >= 201, "follow the explicitly guided turn");
      assert.ok(path.every(point => Math.abs(point.y - 60) < 1.5 || Math.abs(point.x - 105) < 1.5));
      for (const guide of anchors) assert.ok(result.path.some(point => point.anchorId === guide.anchorId
        && point.x === guide.x && point.y === guide.y));
    }
  }
});

test("local Pen keeps inferred and resampled points off a nearby same-color branch", () => {
  for (const vertical of [false, true]) {
    const image = whiteImage(160, 160);
    const transform = point => vertical ? { ...point, x: point.y, y: point.x } : { ...point };
    const target = { r: 20, g: 80, b: 220 };
    const paint = (x, y) => { const p = transform({ x, y }); setPixel(image, p.x, p.y, target); };
    for (let x = 10; x <= 150; x += 1) {
      paint(x, 38);
      if (x < 50 || x > 80) paint(x, 50);
    }
    const data = new Uint8Array(image.width * image.height);
    for (let x = 30; x <= 110; x += 1) for (let y = 46; y <= 54; y += 1) {
      const p = transform({ x, y }); data[p.y * image.width + p.x] = 1;
    }
    const inclusionMask = prepareInclusionMask(data, image.width, image.height, "local");
    const rect = { left: 5, top: 5, right: 154, bottom: 154, width: 150, height: 150 };
    const anchors = [20, 135].map((x, index) => transform({ x, y: 50, anchorId: `local-${index}` }));
    for (const targetStyle of ["line", "dashed"]) {
      const result = runComputeOperation("trace-line", {
        rect, anchors, target, threshold: 5, inclusionMask, targetStyle, maxGap: 24, maxJump: 14,
        refinementMode: "full", orientationMode: "auto",
      }, image);
      const outputOptions = { rect, guides: anchors, inclusionMask, width: image.width, height: image.height,
        orientation: result.orientation };
      const displayed = prepareTraceOutput(result.path, { ...outputOptions, count: 100 }).path;
      const exported = prepareTraceOutput(displayed, { ...outputOptions, count: 200 }).path;
      for (const source of [result.path, displayed, exported]) {
        const path = source.map(transform);
        assert.ok(Math.min(...path.map(p => p.x)) <= 11 && Math.max(...path.map(p => p.x)) >= 149);
        assert.ok(path.filter(p => p.x >= 30 && p.x <= 110).every(p => Math.abs(p.y - 50) <= 4));
        for (const guide of anchors) assert.ok(source.some(p => p.anchorId === guide.anchorId
          && p.x === guide.x && p.y === guide.y));
      }
    }
  }
});

test("parametric guides on blank pixels remain exact but are not image observations", () => {
  const image = whiteImage(120, 112);
  const target = { r: 185, g: 75, b: 125 };
  drawParametricStroke(image, fraction => ({
    x: 60 + 36 * Math.cos(fraction * Math.PI * 2), y: 55 + 25 * Math.sin(fraction * Math.PI * 2),
  }), target, 8000);
  const anchors = [{ x: 96, y: 55, anchorId: "ink" }, { x: 93, y: 55, anchorId: "blank" }];
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors, target, threshold: 5, orientationMode: "parametric",
  }, image);
  const blank = result.path.find(point => point.anchorId === "blank");
  assert.deepEqual({ x: blank.x, y: blank.y }, { x: 93, y: 55 });
  assert.equal(blank.observed, false);
  assert.equal(blank.imageObserved, false);
  assert.ok(blank.confidence <= 0.55);
  const ink = result.path.find(point => point.anchorId === "ink");
  assert.equal(ink.observed, true);
  assert.equal(ink.imageObserved, true);
});

test("parametric guides inside occlusion masks cannot promote inferred pixels to observations", () => {
  const image = whiteImage(120, 112);
  const target = { r: 185, g: 75, b: 125 };
  drawParametricStroke(image, fraction => ({
    x: 60 + 36 * Math.cos(fraction * Math.PI * 2), y: 55 + 25 * Math.sin(fraction * Math.PI * 2),
  }), target, 8000);
  const anchors = [{ x: 96, y: 55, anchorId: "seed" }, { x: 60, y: 30, anchorId: "hidden" }];
  const options = {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors, target, threshold: 5, orientationMode: "parametric",
    exclusions: [{ left: 54, top: 25, right: 66, bottom: 34, width: 13, height: 10 }],
  };
  const result = runComputeOperation("trace-line", options, image);
  assert.equal(result.parametricDiagnostics.occlusionBridges, 1);
  const output = prepareTraceOutput(result.path, {
    count: 100, orientation: result.orientation, guides: anchors,
    width: image.width, height: image.height, rect: options.rect,
  }).path;
  for (const path of [result.path, output]) {
    const hidden = path.find(point => point.anchorId === "hidden");
    assert.deepEqual({ x: hidden.x, y: hidden.y }, { x: 60, y: 30 });
    assert.equal(hidden.observed, false);
    assert.equal(hidden.imageObserved, false);
    assert.equal(hidden.occlusionInferred, true);
    assert.ok(hidden.confidence <= 0.55);
  }
});

test("an explicit occlusion mask reconnects a closed loop with tangent-aware inferred points", () => {
  const image = whiteImage(120, 112);
  const target = { r: 185, g: 75, b: 125 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
  }, target, 8000);
  const exclusion = { left: 38, top: 23, right: 82, bottom: 35, width: 45, height: 13 };
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors: [{ x: 96, y: 55, anchorId: "loop-seed" }],
    target,
    threshold: 5,
    exclusions: [exclusion],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "auto",
  }, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "closed-cycle");
  assert.equal(result.parametricDiagnostics.occlusionBridges, 1);
  assert.equal(result.parametricDiagnostics.closed, true);
  assert.ok(result.parametricDiagnostics.topologyConfidence >= 0.9);
  const inferred = result.path.filter((point) => point.occlusionInferred);
  assert.ok(inferred.length >= 30);
  assert.ok(inferred.every((point) => (
    !point.observed
    && point.origin === "occlusion-model"
    && point.inferenceMethod === "parametric-tangent-bridge"
    && point.inferenceModel === "cubic-hermite-tangent"
    && point.inferenceUncertainty >= 1
  )));
  assert.ok(Math.min(...inferred.map((point) => point.y)) <= 31.5, "endpoint tangents reconstruct the hidden arc");
  const middle = inferred[Math.floor(inferred.length / 2)];
  assert.ok(middle.inferenceUncertainty > inferred[0].inferenceUncertainty);
  const seed = result.path.find((point) => point.anchorId === "loop-seed");
  assert.deepEqual({ x: seed.x, y: seed.y }, { x: 96, y: 55 });
});

test("parametric occlusion geometry is independent of pixels hidden by the mask", () => {
  const target = { r: 185, g: 75, b: 125 };
  const exclusion = { left: 38, top: 23, right: 82, bottom: 35, width: 45, height: 13 };
  const whiteOcclusion = whiteImage(120, 112);
  drawParametricStroke(whiteOcclusion, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
  }, target, 8000);
  fillRect(whiteOcclusion, exclusion, { r: 255, g: 255, b: 255 });
  const sameColorOcclusion = {
    ...whiteOcclusion,
    rgba: new Uint8ClampedArray(whiteOcclusion.rgba),
  };
  fillRect(sameColorOcclusion, exclusion, target);
  const payload = {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors: [{ x: 96, y: 55, anchorId: "loop-seed" }],
    target,
    threshold: 5,
    exclusions: [exclusion],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  };
  const whiteResult = runComputeOperation("trace-line", payload, whiteOcclusion);
  const interferedResult = runComputeOperation("trace-line", payload, sameColorOcclusion);
  const inferredGeometry = (result) => result.path
    .filter((point) => point.occlusionInferred)
    .map((point) => ({ x: point.x, y: point.y }));

  assert.equal(whiteResult.parametricDiagnostics.occlusionBridges, 1);
  assert.equal(interferedResult.parametricDiagnostics.occlusionBridges, 1);
  assert.deepEqual(inferredGeometry(interferedResult), inferredGeometry(whiteResult));
  assert.ok(whiteResult.path.filter((point) => point.occlusionInferred)
    .every((point) => !point.centerRefined));
});

test("duplicate and overlapping occlusion boxes remain one bridge alternative", () => {
  const image = whiteImage(120, 112);
  const target = { r: 55, g: 135, b: 205 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
  }, target, 8000);
  const exclusion = { left: 38, top: 23, right: 82, bottom: 35, width: 45, height: 13 };
  const payload = {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors: [{ x: 96, y: 55, anchorId: "loop-seed" }],
    target,
    threshold: 5,
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  };
  const cases = [
    [exclusion, { ...exclusion }],
    [exclusion, { left: 40, top: 24, right: 80, bottom: 35, width: 41, height: 12 }],
  ];
  for (const exclusions of cases) {
    const result = runComputeOperation("trace-line", { ...payload, exclusions }, image);
    assert.equal(result.parametricDiagnostics.closed, true);
    assert.equal(result.parametricDiagnostics.occlusionBridges, 1);
    assert.ok(result.path.some((point) => point.occlusionInferred));
  }
});

test("parametric guide insertion preserves coincident and subpixel-near anchors in path order", () => {
  const image = whiteImage(120, 108);
  const target = { r: 155, g: 65, b: 195 };
  drawParametricStroke(image, (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 54 + Math.sin(angle) * 23 };
  }, target, 7000, 2);
  const anchors = [
    { x: 96, y: 54, anchorId: "right" },
    { x: 60, y: 31, anchorId: "top-a" },
    { x: 60, y: 31, anchorId: "top-b" },
    { x: 60.25, y: 31.05, anchorId: "top-near" },
  ];
  const result = runComputeOperation("trace-line", {
    rect: { left: 8, top: 8, right: 112, bottom: 100, width: 105, height: 93 },
    anchors,
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "line",
    refinementMode: "full",
    orientationMode: "parametric",
  }, image);
  const retained = anchors.map((anchor) => result.path.find((point) => point.anchorId === anchor.anchorId));

  assert.ok(retained.every(Boolean));
  assert.deepEqual(retained.map(({ x, y }) => [x, y]), anchors.map(({ x, y }) => [x, y]));
  assert.equal(new Set(retained.map((point) => point.parametricOrder)).size, anchors.length);
  assert.ok(retained[3].parametricOrder < retained[1].parametricOrder);
  assert.ok(retained[1].parametricOrder < retained[2].parametricOrder);
  assert.ok(retained.every((point) => point.anchor && point.userGuided && !point.centerRefined));
});

test("a declared dashed style reconnects repeated short gaps around a closed loop", () => {
  const image = whiteImage(120, 112);
  const target = { r: 105, g: 70, b: 205 };
  const pointAt = (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
  };
  drawPatternedParametricStroke(image, pointAt, target);
  const payload = {
    rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
    anchors: [{ x: 96, y: 55, anchorId: "dashed-loop-seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "dashed",
    refinementMode: "full",
    orientationMode: "auto",
  };
  const result = runComputeOperation("trace-line", payload, image);

  assert.equal(result.orientation, "parametric");
  assert.equal(result.parametricDiagnostics.topology, "closed-cycle");
  assert.equal(result.parametricDiagnostics.closed, true);
  assert.equal(result.parametricDiagnostics.occlusionBridges, 0);
  assert.ok(result.parametricDiagnostics.patternedBridges >= 6);
  assert.ok(result.parametricDiagnostics.patternGapConsistency >= 0.7);
  assert.ok(result.parametricDiagnostics.topologyConfidence >= 0.9);
  const inferred = result.path.filter((point) => point.patternInferred);
  assert.ok(inferred.length >= 20);
  assert.ok(inferred.every((point) => (
    !point.observed
    && !point.occlusionInferred
    && point.origin === "pattern-gap-model"
    && point.inferenceMethod === "parametric-pattern-gap"
    && point.inferenceModel === "cubic-hermite-pattern"
    && point.inferenceUncertainty >= 1
  )));
  assert.ok(Math.min(...result.path.map((point) => point.x)) <= 24.5);
  assert.ok(Math.max(...result.path.map((point) => point.x)) >= 95.5);
  assert.ok(Math.min(...result.path.map((point) => point.y)) <= 30.5);
  assert.ok(Math.max(...result.path.map((point) => point.y)) >= 79.5);
  const seed = result.path.find((point) => point.anchorId === "dashed-loop-seed");
  assert.deepEqual({ x: seed.x, y: seed.y }, { x: 96, y: 55 });

  const undeclared = runComputeOperation("trace-line", { ...payload, targetStyle: "line" }, image);
  assert.ok(undeclared.path.every((point) => !point.patternInferred));
});

test("dotted and dash-dot hairpins support explicit 2D reconnection and automatic ordering", () => {
  const cases = [
    { style: "dotted", segments: [3.5, 3.5], color: { r: 40, g: 145, b: 120 } },
    { style: "dashdot", segments: [9, 3.5, 4, 3.5], color: { r: 205, g: 90, b: 45 } },
  ];
  for (const fixture of cases) {
    const image = whiteImage(112, 112);
    const pointAt = (fraction) => {
      const parameter = fraction * 2 - 1;
      return { x: 25 + 55 * parameter * parameter, y: 54 + 32 * parameter };
    };
    drawPatternedParametricStroke(image, pointAt, fixture.color, { segments: fixture.segments });
    const payload = {
      rect: { left: 8, top: 8, right: 104, bottom: 104, width: 97, height: 97 },
      anchors: [{ x: 80, y: 22, anchorId: `${fixture.style}-hairpin-seed` }],
      target: fixture.color,
      threshold: 5,
      exclusions: [],
      strictGuideCorridor: false,
      avoidPaths: [],
      avoidanceRadius: 2.5,
      inclusionMask: null,
      maxJump: 8,
      maxGap: 3,
      targetStyle: fixture.style,
      refinementMode: "full",
      orientationMode: "auto",
    };
    const automatic = runComputeOperation("trace-line", payload, image);
    const result = runComputeOperation("trace-line", { ...payload, orientationMode: "parametric" }, image);

    assert.equal(result.orientation, "parametric", fixture.style);
    assert.equal(result.parametricDiagnostics.topology, "open-path", fixture.style);
    assert.equal(result.parametricDiagnostics.closed, false, fixture.style);
    assert.equal(result.parametricDiagnostics.simplePath, true, fixture.style);
    assert.ok(result.parametricDiagnostics.patternedBridges >= 6, fixture.style);
    assert.ok(result.parametricDiagnostics.patternGapConsistency >= 0.7, fixture.style);
    assert.ok(result.parametricDiagnostics.topologyConfidence >= 0.9, fixture.style);
    assert.ok(result.path.some((point) => point.patternInferred), fixture.style);
    assert.ok(Math.abs(result.path[0].x - 80) <= 1.5, fixture.style);
    // An open curve cannot infer past its final visible dot or dash without an
    // explicit endpoint guide; it should still recover the full second arm.
    assert.ok(Math.abs(result.path.at(-1).x - 80) <= 10, fixture.style);
    assert.ok(Math.abs(result.path[0].y - result.path.at(-1).y) >= 59, fixture.style);
    const seed = result.path.find((point) => point.anchorId === `${fixture.style}-hairpin-seed`);
    assert.deepEqual({ x: seed.x, y: seed.y }, { x: 80, y: 22 }, fixture.style);
    assert.ok(["vertical", "parametric"].includes(automatic.orientation), fixture.style);
    assert.ok(Math.max(...automatic.path.map((point) => point.y))
      - Math.min(...automatic.path.map((point) => point.y)) >= 59, fixture.style);
    assert.ok(automatic.path.some((point) => (
      point.anchorId === `${fixture.style}-hairpin-seed` && point.x === 80 && point.y === 22
    )), fixture.style);
  }
});

test("nearby same-color dashed loops are not fused without a selecting corridor", () => {
  const image = whiteImage(176, 112);
  const target = { r: 65, g: 110, b: 210 };
  const loopAt = (centerX) => (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: centerX + Math.cos(angle) * 28, y: 55 + Math.sin(angle) * 21 };
  };
  drawPatternedParametricStroke(image, loopAt(52), target, { onLength: 9, offLength: 5 });
  drawPatternedParametricStroke(image, loopAt(124), target, { onLength: 9, offLength: 5 });
  const payload = {
    rect: { left: 8, top: 8, right: 168, bottom: 104, width: 161, height: 97 },
    anchors: [{ x: 80, y: 55, anchorId: "left-loop-seed" }],
    target,
    threshold: 5,
    exclusions: [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: "dashed",
    refinementMode: "full",
    orientationMode: "auto",
  };
  const unconstrained = runComputeOperation("trace-line", payload, image);
  assert.ok(
    unconstrained.orientation !== "parametric"
      || Math.max(...unconstrained.path.map((point) => point.x)) < 91,
    "automatic mode must not present two nearby loops as one simple cycle",
  );

  const data = new Uint8Array(image.width * image.height);
  const columns = new Uint8Array(image.width);
  for (let y = payload.rect.top; y <= payload.rect.bottom; y += 1) {
    for (let x = payload.rect.left; x <= 86; x += 1) data[y * image.width + x] = 1;
  }
  columns.fill(1, payload.rect.left, 87);
  const isolated = runComputeOperation("trace-line", {
    ...payload,
    inclusionMask: { data, columns },
    orientationMode: "parametric",
  }, image);
  assert.equal(isolated.orientation, "parametric");
  assert.equal(isolated.parametricDiagnostics.topology, "closed-cycle");
  assert.ok(isolated.parametricDiagnostics.patternedBridges >= 6);
  assert.ok(Math.min(...isolated.path.map((point) => point.x)) <= 24.5);
  assert.ok(Math.max(...isolated.path.map((point) => point.x)) <= 80.5);
  assert.ok(isolated.path.every((point) => point.x <= 86));
});

test("unreconnected enlarged dashed fragments fail closed instead of claiming a complete path", () => {
  const image = whiteImage(170, 80);
  const target = { r: 45, g: 125, b: 210 };
  for (const [left, right] of [[12, 45], [75, 108], [138, 160]]) {
    for (let x = left; x <= right; x += 1) setPixel(image, x, 40, target);
  }
  const result = traceParametricCurve({
    ...image,
    rect: { left: 5, top: 15, right: 164, bottom: 65, width: 160, height: 51 },
    anchors: [{ x: 25, y: 40, anchorId: "fragment-seed" }],
    target,
    threshold: 5,
    exclusions: [],
    inclusionMask: null,
    targetStyle: "dashed",
  });

  assert.deepEqual(result.path, []);
  assert.equal(result.topologyConfidence, 0);
  assert.equal(result.reason, "pattern-reconnection-failed");
  assert.ok(result.patternedComponentCount >= 3);
});

test("automatic same-color guidance survives both scan directions, Pen, sampling and restore", () => {
  const target = { r: 220, g: 30, b: 40 };
  for (const vertical of [false, true]) for (const scope of [null, "local", "strict"]) {
    const image = whiteImage(vertical ? 100 : 240, vertical ? 240 : 100);
    const point = (x, y) => vertical ? { x: y, y: x } : { x, y };
    const paint = (x, y) => { const p = point(x, y); setPixel(image, p.x, p.y, target); };
    for (let x = 5; x <= 234; x += 1) {
      if (x < 112 || x > 188) paint(x, 50);
      if (x >= 60 && x <= 200 && x % 12 < 7) paint(x, 65);
      if (x >= 60 && x <= 200) paint(x, 5); // remote same-color annotation, excluded by Pen
    }
    const data = new Uint8Array(image.width * image.height);
    if (scope) for (let x = scope === "local" ? 80 : 5; x <= (scope === "local" ? 104 : 234); x += 1) {
      for (let y = scope === "local" ? 47 : 45; y <= (scope === "local" ? 53 : 70); y += 1) {
        const p = point(x, y); data[p.y * image.width + p.x] = 1;
      }
    }
    const inclusionMask = scope ? prepareInclusionMask(data, image.width, image.height, scope) : null;
    const rect = { left: 5, top: 5, right: image.width - 6, bottom: image.height - 6,
      width: image.width - 10, height: image.height - 10 };
    const anchors = [10.25, 50.25, 210.25].map((x, index) => ({ ...point(x, 50.125), anchorId: `guide-${index}`, userGuided: true }));
    const orientation = vertical ? "vertical" : "horizontal";
    const options = { rect, anchors, target, threshold: 5, maxJump: 14, maxGap: 24,
      targetStyle: "line", strictGuideCorridor: false, refinementMode: "full", orientationMode: orientation, inclusionMask };
    const before = JSON.stringify(anchors);
    const result = runComputeOperation("trace-line", options, image);
    assert.equal(result.orientation, orientation);
    assert.ok(result.path.some(p => p.automaticGuidance), `${orientation}/${scope}: expected a local correction`);
    const hidden = result.path.filter(p => (vertical ? p.y : p.x) > 112 && (vertical ? p.y : p.x) < 188);
    assert.ok(hidden.length > 60 && hidden.every(p => !p.observed && p.confidence <= 0.55));
    const corridor = { rect, inclusionMask, width: image.width, height: image.height, guides: anchors, orientation };
    for (const count of [20, 100, 200]) for (const samplingMode of ["uniform", "geometry"]) {
      const output = prepareTraceOutput(result.path, { ...corridor, count, parameters: { samplingMode } });
      assert.equal(output.path.length, count);
      assert.ok(output.path.some(p => p.automaticGuidance), "sampled project metadata must retain the automatic correction");
      for (const p of output.path) {
        assert.ok(Math.abs((vertical ? p.x : p.y) - 50) < 0.35, "output switched to the dashed competitor");
        if (!p.anchor) assert.ok(inclusionMaskAllows(inclusionMask, image.width, p.x, p.y));
      }
      for (const guide of anchors) assert.ok(output.path.some(p => p.anchorId === guide.anchorId && p.x === guide.x && p.y === guide.y));
      const restored = prepareRestoredTrace(JSON.parse(JSON.stringify({ ...output, anchors })), corridor);
      assert.equal(restored.traceStale, false);
      assert.deepEqual(restored.path, output.path, "restoration must preserve coordinates and guidance flags");
    }
    assert.equal(JSON.stringify(anchors), before, "automatic enhancement must not rewrite user guides");
    assert.equal(options.strictGuideCorridor, false, "automatic enhancement must not change the manual setting");
  }
});

test("automatic guidance cannot bridge an explicitly erased Pen band", () => {
  const image = whiteImage(240, 100), target = { r: 220, g: 30, b: 40 };
  const data = new Uint8Array(image.width * image.height), erased = new Uint8Array(data.length);
  for (let x = 5; x <= 234; x += 1) {
    if (x < 112 || x > 188) setPixel(image, x, 50, target);
    if (x >= 60 && x <= 200 && x % 12 < 7) setPixel(image, x, 65, target);
    for (let y = 45; y <= 70; y += 1) {
      if (x === 150) erased[y * image.width + x] = 1;
      else data[y * image.width + x] = 1;
    }
  }
  assert.throws(() => runComputeOperation("trace-line", {
    rect: { left: 5, top: 5, right: 234, bottom: 94, width: 230, height: 90 },
    anchors: [10, 50, 210].map(x => ({ x, y: 50 })), target, threshold: 5, maxJump: 14, maxGap: 24,
    targetStyle: "line", strictGuideCorridor: false, orientationMode: "horizontal",
    inclusionMask: prepareInclusionMask(data, image.width, image.height, "strict", { erased }),
  }, image), error => error.code === "PEN_OUTSIDE" || error.code === "PEN_NO_VALID_PATH");
});

test("compute client uses an explicit synchronous fallback without Worker support", async () => {
  const originalWorker = globalThis.Worker;
  try {
    delete globalThis.Worker;
    const client = createComputeClient({ workerUrl: "unused.js" });
    client.setImage(whiteImage(2, 2));
    let fallbackCalls = 0;
    const result = await client.run("trace-line", {}, () => {
      fallbackCalls += 1;
      return { path: [{ x: 1, y: 1 }] };
    });
    assert.equal(client.mode(), "synchronous");
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(result.path, [{ x: 1, y: 1 }]);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test("compute client waits for the image and returns Worker results", async () => {
  const originalWorker = globalThis.Worker;
  class FakeWorker {
    listeners = new Map();
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    postMessage(message) {
      queueMicrotask(() => {
        if (message.type === "set-image") {
          this.listeners.get("message")?.({
            data: { type: "image-ready", revision: message.revision },
          });
        } else if (message.type === "task") {
          this.listeners.get("message")?.({
            data: {
              type: "task-result",
              id: message.id,
              revision: message.revision,
              result: { source: "worker", operation: message.operation },
            },
          });
        }
      });
    }
    terminate() {}
  }
  try {
    globalThis.Worker = FakeWorker;
    const client = createComputeClient({ workerUrl: "fake-worker.js" });
    client.setImage(whiteImage(2, 2));
    const result = await client.run("trace-line", {}, () => {
      throw new Error("fallback should not run");
    });
    assert.equal(client.mode(), "worker");
    assert.deepEqual(result, { source: "worker", operation: "trace-line" });
    client.stop();
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});
