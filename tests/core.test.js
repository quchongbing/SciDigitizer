import test from "node:test";
import assert from "node:assert/strict";

import {
  assessCalibrationQuality,
  calibrationError,
  assessPathQuality,
  buildPairedCurveRows,
  compositedColorDistance,
  detectPlotRect,
  estimateColorThreshold,
  extractMarkerCenters,
  findPathReviewRegions,
  fitInferredPathGaps,
  includeMandatoryPoints,
  inferLineStyle,
  normalizeRect,
  pathToData,
  pixelAt,
  pixelToValue,
  refinePathCenterline,
  resamplePath,
  resamplePixelPath,
  resamplePixelPathAdaptive,
  resamplePixelPathGeometry,
  resamplePixelPathRoughness,
  sampleRepresentativeColor,
  traceCurve,
  traceCurveThroughAnchors,
  validateCalibration,
  valueStepForPixelNudge,
  valueToPixel,
} from "../src/core.js";

import {
  alignmentCorrectionDegrees,
  composeRotationDegrees,
  normalizeLineAngleDegrees,
  normalizeRotationDegrees,
  rotateImageDataQuarterTurn,
  rotatedCanvasBounds,
  splitRotationDegrees,
} from "../src/image-transform.js";

import {
  createEditSession,
  fingerprintImageData,
} from "../src/edit-session.js";

import {
  destinationToSourceHomography,
  detectFrameQuadrilateral,
  detectPerspectiveFrame,
  estimateAxisSkew,
  projectHomography,
  warpPerspectiveRgba,
} from "../src/image-geometry.js";

function whiteImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = 255;
    rgba[index + 1] = 255;
    rgba[index + 2] = 255;
    rgba[index + 3] = 255;
  }
  return rgba;
}

function setPixel(rgba, width, x, y, color = { r: 20, g: 90, b: 210 }) {
  const index = (y * width + x) * 4;
  rgba[index] = color.r;
  rgba[index + 1] = color.g;
  rgba[index + 2] = color.b;
  rgba[index + 3] = 255;
}

function drawLine(rgba, width, height, start, end, color = { r: 8, g: 8, b: 8 }, thickness = 1) {
  const steps = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(start.x + (step / steps) * (end.x - start.x));
    const y = Math.round(start.y + (step / steps) * (end.y - start.y));
    for (let offsetY = -Math.floor(thickness / 2); offsetY <= Math.floor(thickness / 2); offsetY += 1) {
      for (let offsetX = -Math.floor(thickness / 2); offsetX <= Math.floor(thickness / 2); offsetX += 1) {
        if (x + offsetX >= 0 && x + offsetX < width && y + offsetY >= 0 && y + offsetY < height) {
          setPixel(rgba, width, x + offsetX, y + offsetY, color);
        }
      }
    }
  }
}

function blendWithWhite(color, coverage) {
  return {
    r: Math.round(255 - (255 - color.r) * coverage),
    g: Math.round(255 - (255 - color.g) * coverage),
    b: Math.round(255 - (255 - color.b) * coverage),
  };
}

test("normalizeRect orders and clamps coordinates", () => {
  assert.deepEqual(
    normalizeRect({ x: 18.8, y: 17.2 }, { x: -3, y: 4.4 }, { width: 16, height: 20 }),
    { left: 0, top: 4, right: 15, bottom: 17, width: 16, height: 14 },
  );
});

test("linear calibration maps in both directions", () => {
  const calibration = { scale: "linear", point1: 10, point2: 110, value1: -2, value2: 8 };
  assert.equal(validateCalibration(calibration), true);
  assert.equal(pixelToValue(60, calibration), 3);
  assert.equal(valueToPixel(3, calibration), 60);
});

test("coordinate spinner step corresponds to one tenth of a local pixel", () => {
  const linear = { scale: "linear", point1: 10, point2: 110, value1: -2, value2: 8 };
  assert.ok(Math.abs(valueStepForPixelNudge(60, linear) - 0.01) < 1e-12);

  const logarithmic = { scale: "log", point1: 0, point2: 100, value1: 1, value2: 100 };
  const logarithmicStep = valueStepForPixelNudge(50, logarithmic);
  assert.ok(logarithmicStep > 0.04 && logarithmicStep < 0.05);

  const piecewise = {
    scale: "piecewise",
    points: [
      { pixel: 0, value: 0 },
      { pixel: 50, value: 5 },
      { pixel: 100, value: 25 },
    ],
  };
  assert.ok(Math.abs(valueStepForPixelNudge(50, piecewise) - 0.01) < 1e-12);
  assert.equal(Number.isNaN(valueStepForPixelNudge(50, null)), true);
});

test("calibration diagnostics explain equal values and incomplete axes", () => {
  assert.equal(
    calibrationError({ scale: "linear", point1: 10, point2: 80, value1: 2, value2: 2 }, "X 轴"),
    "X 轴两个端点的刻度值不能相同",
  );
  assert.equal(
    calibrationError({ scale: "linear", point1: 10, point2: undefined, value1: 0, value2: 1 }, "Y 轴"),
    "Y 轴需要点击 2 个已知刻度位置",
  );
  assert.equal(
    calibrationError({ scale: "log", point1: 10, point2: 80, value1: 0, value2: 10 }, "X 轴"),
    "X 轴为 Log10 时，两个刻度值都必须大于 0",
  );
  assert.equal(
    calibrationError({ scale: "linear", point1: 10, point2: 10.5, value1: 0, value2: 10 }, "X 轴"),
    "X 轴两个刻度位置至少需要相距 1 px",
  );
});

test("manual calibration quality reports pixel sensitivity and short reference spans", () => {
  const wide = assessCalibrationQuality({
    scale: "linear",
    point1: 10,
    point2: 90,
    value1: 0,
    value2: 8,
  }, 100);
  assert.equal(wide.grade, "good");
  assert.equal(wide.sensitivity, 0.1);
  assert.deepEqual(wide.warnings, []);

  const narrow = assessCalibrationQuality({
    scale: "linear",
    point1: 40,
    point2: 55,
    value1: 0,
    value2: 3,
  }, 100);
  assert.equal(narrow.grade, "poor");
  assert.ok(narrow.warnings.some((warning) => warning.includes("15%")));

  const logarithmic = assessCalibrationQuality({
    scale: "log",
    point1: 0,
    point2: 100,
    value1: 1,
    value2: 100,
  }, 100);
  assert.equal(logarithmic.sensitivityKind, "ratio");
  assert.ok(Math.abs(logarithmic.sensitivity - 10 ** 0.02) < 1e-12);
});

test("paired curve export uses two columns per curve and pads shorter series", () => {
  const rows = buildPairedCurveRows([
    {
      label: "red solid",
      data: [
        { dataX: 0, dataY: 1.25 },
        { dataX: 1, dataY: 2.5 },
      ],
    },
    {
      label: "red dashed",
      data: [{ dataX: 0.5, dataY: 0.75 }],
    },
  ], "k [Å⁻¹]", "S(k)");
  assert.deepEqual(rows, [
    ["red solid", "", "red dashed", ""],
    ["k [Å⁻¹]", "S(k)", "k [Å⁻¹]", "S(k)"],
    ["0", "1.25", "0.5", "0.75"],
    ["1", "2.5", "", ""],
  ]);
});

test("paired curve export falls back to x and y labels", () => {
  assert.deepEqual(
    buildPairedCurveRows([{ label: "", data: [{ dataX: 2, dataY: 3 }] }], "", " "),
    [["Curve 1", ""], ["x", "y"], ["2", "3"]],
  );
});

test("paired curve export preserves per-curve axis labels", () => {
  const rows = buildPairedCurveRows([
    { label: "left axis", xLabel: "time", yLabel: "pressure", data: [] },
    { label: "offset axis", xLabel: "time", yLabel: "temperature", data: [] },
  ]);
  assert.deepEqual(rows[1], ["time", "pressure", "time", "temperature"]);
});

test("log calibration interpolates in logarithmic space", () => {
  const calibration = { scale: "log", point1: 0, point2: 300, value1: 0.01, value2: 10 };
  assert.ok(Math.abs(pixelToValue(100, calibration) - 0.1) < 1e-12);
  assert.ok(Math.abs(valueToPixel(1, calibration) - 200) < 1e-12);
});

test("log calibration rejects non-positive reference values", () => {
  assert.equal(validateCalibration({ scale: "log", point1: 0, point2: 10, value1: 0, value2: 1 }), false);
});

test("piecewise calibration maps a broken axis in both directions", () => {
  const calibration = {
    scale: "piecewise",
    points: [
      { pixel: 300, value: 0 },
      { pixel: 180, value: 10 },
      { pixel: 60, value: 50 },
    ],
  };
  assert.equal(validateCalibration(calibration), true);
  assert.equal(pixelToValue(240, calibration), 5);
  assert.equal(pixelToValue(120, calibration), 30);
  assert.equal(valueToPixel(30, calibration), 120);
});

test("piecewise calibration rejects a value reversal in pixel order", () => {
  const calibration = {
    scale: "piecewise",
    points: [
      { pixel: 10, value: 0 },
      { pixel: 50, value: 10 },
      { pixel: 90, value: 5 },
    ],
  };
  assert.equal(validateCalibration(calibration), false);
  assert.match(calibrationError(calibration, "X 轴"), /保持单调/);
});

test("composited color distance treats antialias shades as one ink color", () => {
  const blue = { r: 0, g: 0, b: 255 };
  assert.ok(compositedColorDistance(168, 168, 255, blue) < 1e-4);
  assert.ok(compositedColorDistance(255, 40, 40, blue) > 40);
  assert.equal(compositedColorDistance(255, 255, 255, blue), Infinity);
});

test("adaptive color threshold stays below a nearby palette color", () => {
  const width = 25;
  const height = 25;
  const rgba = whiteImage(width, height);
  const red = { r: 217, g: 55, b: 69 };
  const orange = { r: 242, g: 142, b: 43 };
  for (let x = 7; x <= 17; x += 1) {
    setPixel(rgba, width, x, 12, red);
    setPixel(rgba, width, x, 16, orange);
  }
  const threshold = estimateColorThreshold(rgba, width, height, { x: 12, y: 12 }, red);
  assert.ok(threshold <= 15);
  assert.ok(compositedColorDistance(orange.r, orange.g, orange.b, red) > threshold);
});

test("representative color prefers a colored antialias stroke over a darker gray grid", () => {
  const width = 21;
  const height = 21;
  const rgba = whiteImage(width, height);
  for (let x = 3; x <= 17; x += 1) setPixel(rgba, width, x, 12, { r: 100, g: 100, b: 100 });
  for (let x = 7; x <= 13; x += 1) setPixel(rgba, width, x, 10, { r: 150, g: 210, b: 212 });
  const sampled = sampleRepresentativeColor(rgba, width, height, { x: 10, y: 10 });
  assert.ok(compositedColorDistance(sampled.r, sampled.g, sampled.b, { r: 0, g: 159, b: 166 }) < 8);
});

test("representative color recovers a clean edge when the click pixel is grid-contaminated", () => {
  const width = 21;
  const height = 21;
  const rgba = whiteImage(width, height);
  setPixel(rgba, width, 10, 10, { r: 130, g: 171, b: 165 });
  setPixel(rgba, width, 11, 9, { r: 188, g: 227, b: 222 });
  setPixel(rgba, width, 12, 9, { r: 194, g: 229, b: 225 });
  for (let x = 4; x <= 16; x += 1) setPixel(rgba, width, x, 11, { r: 120, g: 120, b: 120 });
  const sampled = sampleRepresentativeColor(rgba, width, height, { x: 10, y: 10 });
  assert.ok(compositedColorDistance(sampled.r, sampled.g, sampled.b, { r: 0, g: 159, b: 166 }) < 15);
});

test("representative color preserves a black cross over a blue curve", () => {
  const width = 21;
  const height = 21;
  const rgba = whiteImage(width, height);
  const blue = { r: 31, g: 119, b: 180 };
  const black = { r: 3, g: 3, b: 3 };
  for (let x = 3; x <= 17; x += 1) setPixel(rgba, width, x, 8, blue);
  for (let x = 7; x <= 13; x += 1) setPixel(rgba, width, x, 10, black);
  for (let y = 7; y <= 13; y += 1) setPixel(rgba, width, 10, y, black);

  const sampled = sampleRepresentativeColor(rgba, width, height, { x: 10, y: 10 });
  assert.ok(Math.max(sampled.r, sampled.g, sampled.b) <= 10);
  assert.ok(Math.max(sampled.r, sampled.g, sampled.b) - Math.min(sampled.r, sampled.g, sampled.b) <= 3);
});

test("representative color finds a black cross when scaling lands the click on an adjacent blue pixel", () => {
  const width = 21;
  const height = 21;
  const rgba = whiteImage(width, height);
  const blue = { r: 31, g: 119, b: 180 };
  const black = { r: 2, g: 2, b: 2 };
  for (let x = 3; x <= 17; x += 1) setPixel(rgba, width, x, 8, blue);
  for (let x = 7; x <= 13; x += 1) setPixel(rgba, width, x, 10, black);
  for (let y = 8; y <= 14; y += 1) setPixel(rgba, width, 10, y, black);

  assert.deepEqual(pixelAt(rgba, width, 11, 8), { ...blue, a: 255 });
  const sampled = sampleRepresentativeColor(rgba, width, height, { x: 11, y: 8 });
  assert.ok(Math.max(sampled.r, sampled.g, sampled.b) <= 10);
});

test("representative color does not let a nearby black annotation line steal a colored click", () => {
  const width = 21;
  const height = 21;
  const rgba = whiteImage(width, height);
  const red = { r: 220, g: 35, b: 45 };
  for (let x = 5; x <= 15; x += 1) setPixel(rgba, width, x, 10, red);
  for (let x = 6; x <= 14; x += 1) setPixel(rgba, width, x, 8, { r: 0, g: 0, b: 0 });

  const sampled = sampleRepresentativeColor(rgba, width, height, { x: 10, y: 10 });
  assert.ok(compositedColorDistance(sampled.r, sampled.g, sampled.b, red) < 1);
});

test("traceCurve follows a solid diagonal and ignores a parallel curve", () => {
  const width = 80;
  const height = 60;
  const rgba = whiteImage(width, height);
  const color = { r: 20, g: 90, b: 210 };
  for (let x = 5; x <= 74; x += 1) {
    const y = Math.round(12 + x * 0.25);
    setPixel(rgba, width, x, y, color);
    setPixel(rgba, width, x, y + 20, color);
  }
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 5, top: 0, right: 74, bottom: 59 },
    seed: { x: 40, y: 22 },
    target: color,
    threshold: 5,
    maxJump: 3,
    maxGap: 0,
  });
  assert.equal(path.length, 70);
  assert.ok(path.every((point) => Math.abs(point.y - Math.round(12 + point.x * 0.25)) <= 0.5));
});

test("centerline refinement finds the subpixel middle of a thick antialiased stroke", () => {
  const width = 64;
  const height = 46;
  const rgba = whiteImage(width, height);
  const color = { r: 18, g: 88, b: 205 };
  for (let x = 5; x <= 58; x += 1) {
    setPixel(rgba, width, x, 19, blendWithWhite(color, 0.25));
    for (let y = 20; y <= 24; y += 1) setPixel(rgba, width, x, y, color);
    setPixel(rgba, width, x, 25, blendWithWhite(color, 0.5));
  }
  const rawPath = Array.from({ length: 54 }, (_, index) => ({
    x: index + 5,
    y: 23,
    observed: true,
    confidence: 1,
    thickness: 7,
    anchor: index === 25,
  }));
  const refined = refinePathCenterline({
    rgba,
    width,
    height,
    path: rawPath,
    target: color,
    threshold: 5,
    rect: { left: 5, top: 5, right: 58, bottom: 40 },
  });
  const automaticPoints = refined.filter((point) => !point.anchor);
  const averageY = automaticPoints.reduce((sum, point) => sum + point.y, 0) / automaticPoints.length;
  assert.ok(Math.abs(averageY - 22.15) < 0.4, `unexpected refined center ${averageY}`);
  assert.equal(refined[25].y, 23);
  assert.ok(automaticPoints.every((point) => point.centerRefined));
});

test("adaptive gap fitting follows curved reliable neighborhoods without moving boundaries", () => {
  const trueY = (x) => 30 + 0.018 * (x - 50) ** 2;
  const path = Array.from({ length: 81 }, (_, index) => {
    const x = index + 10;
    const hidden = x > 40 && x < 60;
    return {
      x,
      y: hidden ? trueY(40) : trueY(x),
      observed: !hidden,
      confidence: hidden ? 0.25 : 0.95,
      thickness: hidden ? 0 : 3,
      anchor: x === 40 || x === 60,
    };
  });
  // A single bad but nominally observed neighbor should not dominate the
  // Theil-Sen slope estimate used for the hidden interval.
  path.find((point) => point.x === 34).y += 8;
  const fitted = fitInferredPathGaps(path, {
    rect: { left: 10, top: 0, right: 90, bottom: 80 },
  });
  const middle = fitted.find((point) => point.x === 50);
  assert.ok(Math.abs(middle.y - trueY(50)) < Math.abs(trueY(40) - trueY(50)) * 0.65);
  assert.equal(middle.observed, false);
  assert.equal(middle.inferenceMethod, "adaptive-local-ensemble");
  assert.ok(["linear", "hermite", "quadratic"].includes(middle.inferenceModel));
  assert.ok(Object.keys(middle.inferenceModelWeights).length >= 2);
  assert.ok(Number.isFinite(middle.modelDisagreement));
  assert.ok(Number.isFinite(middle.inferenceUncertainty) && middle.inferenceUncertainty >= 1);
  assert.equal(fitted.find((point) => point.x === 40).y, trueY(40));
  assert.equal(fitted.find((point) => point.x === 60).y, trueY(60));
});

test("adaptive gap fitting reconstructs a peak hidden entirely by a long occlusion", () => {
  const trueY = (x) => 24 - 0.03 * (x - 50) ** 2;
  const path = Array.from({ length: 81 }, (_, index) => {
    const x = index + 10;
    const hidden = x > 35 && x < 65;
    return {
      x,
      y: hidden ? trueY(35) : trueY(x),
      observed: !hidden,
      confidence: hidden ? 0.2 : 0.96,
      thickness: hidden ? 0 : 2.5,
    };
  });
  const linearError = Math.abs(path.find((point) => point.x === 50).y - trueY(50));
  const fitted = fitInferredPathGaps(path, {
    rect: { left: 10, top: 0, right: 90, bottom: 50 },
  });
  const middle = fitted.find((point) => point.x === 50);
  assert.ok(Math.abs(middle.y - trueY(50)) < linearError * 0.45);
  assert.equal(middle.inferenceMethod, "adaptive-local-ensemble");
  assert.ok((middle.inferenceModelWeights.quadratic ?? 0) > 0);
});

test("a guide inside an occlusion remains exact and splits model recovery", () => {
  const trueY = (x) => 18 + 0.006 * (x - 52) ** 2;
  const path = Array.from({ length: 91 }, (_, index) => {
    const x = index + 5;
    const hidden = x > 30 && x < 74;
    const anchor = x === 52;
    return {
      x,
      y: hidden && !anchor ? trueY(30) : trueY(x),
      observed: !hidden || anchor,
      confidence: hidden && !anchor ? 0.2 : 1,
      thickness: hidden && !anchor ? 0 : 3,
      anchor,
    };
  });
  const fitted = fitInferredPathGaps(path, {
    rect: { left: 5, top: 0, right: 95, bottom: 60 },
  });
  const anchor = fitted.find((point) => point.x === 52);
  assert.equal(anchor.y, trueY(52));
  assert.equal(anchor.anchor, true);
  assert.ok(fitted.find((point) => point.x === 45).inferenceMethod === "adaptive-local-ensemble");
  assert.ok(fitted.find((point) => point.x === 60).inferenceMethod === "adaptive-local-ensemble");
});

test("local fitting replaces a continuous low-confidence crossing fragment", () => {
  const trueY = (x) => 18 + 0.012 * (x - 45) ** 2;
  const path = Array.from({ length: 71 }, (_, index) => {
    const x = index + 10;
    const crossed = x >= 41 && x <= 49;
    return {
      x,
      y: trueY(x) + (crossed ? 3.5 : 0),
      observed: true,
      confidence: crossed ? 0.32 : 0.95,
      candidateCount: crossed ? 2 : 1,
      thickness: 3,
    };
  });
  const fitted = fitInferredPathGaps(path);
  const middle = fitted.find((point) => point.x === 45);
  assert.ok(Math.abs(middle.y - trueY(45)) < 1);
  assert.equal(middle.imageObserved, true);
  assert.equal(middle.observed, false);
  assert.equal(middle.occlusionInferred, true);
});

test("noisy-line tracing follows rapid experimental fluctuations without switching branches", () => {
  const width = 130;
  const height = 85;
  const rgba = whiteImage(width, height);
  const color = { r: 35, g: 90, b: 205 };
  const expectedY = (x) => 29 + Math.round(4 * Math.sin(x * 1.55) + 2 * Math.sin(x * 0.31));
  for (let x = 5; x <= 124; x += 1) {
    setPixel(rgba, width, x, expectedY(x), color);
    setPixel(rgba, width, x, 57, color);
  }
  const seedX = 44;
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 124, bottom: 78 },
    seed: { x: seedX, y: expectedY(seedX) },
    target: color,
    threshold: 5,
    maxJump: 6,
    maxGap: 1,
    targetStyle: "noisy",
  });
  assert.equal(path.at(0).x, 5);
  assert.equal(path.at(-1).x, 124);
  assert.ok(path.every((point) => Math.abs(point.y - expectedY(point.x)) < 0.1));
});

test("traceCurve bridges dashed gaps and labels inferred points", () => {
  const width = 90;
  const height = 50;
  const rgba = whiteImage(width, height);
  const color = { r: 210, g: 35, b: 40 };
  for (let x = 5; x <= 84; x += 1) {
    if (x % 12 < 7) setPixel(rgba, width, x, 25, color);
  }
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 84, bottom: 45 },
    seed: { x: 40, y: 25 },
    target: color,
    threshold: 5,
    maxJump: 2,
    maxGap: 7,
  });
  assert.equal(path.at(0).x, 5);
  assert.equal(path.at(-1).x, 84);
  assert.ok(path.some((point) => !point.observed));
  assert.ok(path.every((point) => point.y === 25));
});

test("automatic line-style inference distinguishes solid and dashed strokes", () => {
  const width = 150;
  const height = 40;
  const blue = { r: 20, g: 90, b: 210 };
  const rect = { left: 5, top: 3, right: 144, bottom: 36 };
  const solid = whiteImage(width, height);
  const dashed = whiteImage(width, height);
  for (let x = rect.left; x <= rect.right; x += 1) {
    setPixel(solid, width, x, 20, blue);
    if ((x - rect.left) % 14 < 8) setPixel(dashed, width, x, 20, blue);
  }
  assert.equal(inferLineStyle({
    rgba: solid, width, height, rect, seed: { x: 75, y: 20 }, target: blue, threshold: 5,
  }).style, "line");
  const inferredDash = inferLineStyle({
    rgba: dashed, width, height, rect, seed: { x: 75, y: 20 }, target: blue, threshold: 5,
  });
  assert.equal(inferredDash.style, "dashed");
  assert.ok(inferredDash.confidence >= 0.55);
});

test("traceCurve excludes a legend region and records the bridge as inferred", () => {
  const width = 70;
  const height = 40;
  const rgba = whiteImage(width, height);
  const color = { r: 180, g: 30, b: 40 };
  for (let x = 3; x <= 66; x += 1) setPixel(rgba, width, x, 20, color);
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 3, top: 3, right: 66, bottom: 36 },
    seed: { x: 15, y: 20 },
    target: color,
    threshold: 10,
    maxJump: 3,
    maxGap: 15,
    exclusions: [{ left: 30, top: 10, right: 40, bottom: 30 }],
  });
  assert.equal(path.at(0).x, 3);
  assert.equal(path.at(-1).x, 66);
  assert.ok(path.filter((point) => point.x >= 30 && point.x <= 40).every((point) => !point.observed));
});

test("pathToData preserves provenance fields", () => {
  const path = [{ x: 10, y: 90, observed: true, confidence: 0.9 }];
  const xCalibration = { scale: "linear", point1: 10, point2: 110, value1: 0, value2: 5 };
  const yCalibration = { scale: "linear", point1: 90, point2: 10, value1: 0, value2: 2 };
  assert.deepEqual(pathToData(path, xCalibration, yCalibration), [
    { x: 10, y: 90, observed: true, confidence: 0.9, dataX: 0, dataY: 0 },
  ]);
});

test("resamplePath is uniform in displayed x coordinate and honors log axes", () => {
  const path = [
    { x: 0, y: 100, observed: true, confidence: 1 },
    { x: 100, y: 50, observed: true, confidence: 0.8 },
    { x: 200, y: 0, observed: true, confidence: 1 },
  ];
  const xCalibration = { scale: "log", point1: 0, point2: 200, value1: 0.01, value2: 1 };
  const yCalibration = { scale: "linear", point1: 100, point2: 0, value1: 0, value2: 10 };
  const result = resamplePath(path, xCalibration, yCalibration, 3);
  assert.deepEqual(result.map((point) => Number(point.dataX.toPrecision(8))), [0.01, 0.1, 1]);
  assert.deepEqual(result.map((point) => point.dataY), [0, 5, 10]);
});

test("resamplePixelPath returns the requested number of display points", () => {
  const path = Array.from({ length: 51 }, (_, x) => ({
    x,
    y: 2 * x,
    observed: true,
    confidence: 1,
  }));
  const result = resamplePixelPath(path, 100);
  assert.equal(result.length, 100);
  assert.equal(result[0].x, 0);
  assert.equal(result.at(-1).x, 50);
  assert.ok(result.every((point) => Math.abs(point.y - 2 * point.x) < 1e-9));
});

test("resampling preserves occlusion model provenance and uncertainty", () => {
  const path = [
    { x: 0, y: 10, observed: true, confidence: 0.96 },
    {
      x: 10,
      y: 13,
      observed: false,
      confidence: 0.36,
      occlusionInferred: true,
      inferenceMethod: "adaptive-local-ensemble",
      inferenceModel: "quadratic",
      inferenceModelWeights: { linear: 0.2, hermite: 0.3, quadratic: 0.5 },
      inferenceModelScore: 0.8,
      modelDisagreement: 2,
      fitBlend: 0.8,
      fitSupport: 16,
      inferenceUncertainty: 3,
    },
    {
      x: 20,
      y: 13,
      observed: false,
      confidence: 0.34,
      occlusionInferred: true,
      inferenceMethod: "adaptive-local-ensemble",
      inferenceModel: "quadratic",
      inferenceModelWeights: { linear: 0.1, hermite: 0.2, quadratic: 0.7 },
      inferenceModelScore: 0.9,
      modelDisagreement: 4,
      fitBlend: 0.7,
      fitSupport: 16,
      inferenceUncertainty: 5,
    },
    { x: 30, y: 10, observed: true, confidence: 0.96 },
  ];
  const result = resamplePixelPath(path, 7);
  const middle = result.find((point) => point.x === 15);
  assert.equal(result[0].observed, true);
  assert.equal(result.at(-1).observed, true);
  assert.equal(middle.occlusionInferred, true);
  assert.equal(middle.inferenceMethod, "adaptive-local-ensemble");
  assert.equal(middle.inferenceModel, "quadratic");
  assert.ok(Math.abs(middle.inferenceModelWeights.quadratic - 0.6) < 1e-9);
  assert.equal(middle.modelDisagreement, 3);
  assert.equal(middle.inferenceUncertainty, 4);
});

test("mandatory guide points survive display resampling exactly", () => {
  const rawPath = Array.from({ length: 101 }, (_, x) => ({
    x,
    y: 30 + Math.sin(x / 10),
    observed: true,
    confidence: 1,
  }));
  const guides = [
    { x: 23, y: 41, observed: false, confidence: 0.55 },
    { x: 77, y: 19, observed: true, confidence: 1 },
  ];
  const result = includeMandatoryPoints(resamplePixelPath(rawPath, 12), guides, 12);
  assert.equal(result.length, 12);
  assert.deepEqual(
    result.filter((point) => point.anchor).map((point) => [point.x, point.y, point.origin]),
    [[23, 41, "guide"], [77, 19, "guide"]],
  );
  assert.ok(result.every((point, index) => index === 0 || point.x >= result[index - 1].x));
});

test("mandatory guides can raise an undersized requested sample count", () => {
  const sampled = resamplePixelPath([
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  ], 2);
  const guides = Array.from({ length: 4 }, (_, index) => ({
    x: 20 + index * 20,
    y: 10 + index,
  }));
  const result = includeMandatoryPoints(sampled, guides, 2);
  assert.equal(result.length, 4);
  assert.ok(result.every((point) => point.anchor));
});

test("geometry resampling adds points to a steep straight segment", () => {
  const path = Array.from({ length: 1001 }, (_, x) => ({
    x,
    y: x < 420 ? 40 : x <= 520 ? 40 + (x - 420) * 4 : 440,
    observed: true,
    confidence: 1,
  }));
  const uniform = resamplePixelPath(path, 100);
  const geometry = resamplePixelPathGeometry(path, 100);
  const steep = (point) => point.x >= 420 && point.x <= 520;
  assert.equal(geometry.length, 100);
  assert.equal(geometry[0].x, 0);
  assert.equal(geometry.at(-1).x, 1000);
  assert.ok(geometry.filter(steep).length > uniform.filter(steep).length * 2);
  assert.ok(geometry.every((point, index) => index === 0 || point.x > geometry[index - 1].x));
});

test("geometry resampling protects a sharp turn where slope passes through zero", () => {
  const path = Array.from({ length: 1001 }, (_, x) => ({
    x,
    y: Math.abs(x - 500) * 2,
    observed: true,
    confidence: 1,
  }));
  const uniform = resamplePixelPath(path, 100);
  const geometry = resamplePixelPathGeometry(path, 100);
  const nearTurn = (point) => Math.abs(point.x - 500) <= 30;
  assert.ok(geometry.filter(nearTurn).length >= uniform.filter(nearTurn).length);
});

test("adaptive pixel resampling places more points around a sharp peak", () => {
  const path = Array.from({ length: 1001 }, (_, x) => ({
    x,
    y: 200 - 120 * Math.exp(-(((x - 500) / 45) ** 2)),
    observed: true,
    confidence: 1,
  }));
  const uniform = resamplePixelPath(path, 100);
  const adaptive = resamplePixelPathAdaptive(path, 100, { peakDensity: 5, peakWidth: 8 });
  const nearPeak = (point) => Math.abs(point.x - 500) <= 70;
  assert.equal(adaptive.length, 100);
  assert.equal(adaptive[0].x, 0);
  assert.equal(adaptive.at(-1).x, 1000);
  assert.ok(adaptive.filter(nearPeak).length > uniform.filter(nearPeak).length * 1.6);
  assert.ok(adaptive.every((point, index) => index === 0 || point.x > adaptive[index - 1].x));
});

test("roughness resampling concentrates points in a locally noisy interval", () => {
  const path = Array.from({ length: 1001 }, (_, x) => ({
    x,
    y: x >= 430 && x <= 570 ? 80 + 12 * Math.sin((x - 430) * 0.55) : 80,
    observed: true,
    confidence: 1,
  }));
  const uniform = resamplePixelPath(path, 100);
  const roughness = resamplePixelPathRoughness(path, 100, { noiseDensity: 5, noiseWindow: 3 });
  const noisyInterval = (point) => point.x >= 430 && point.x <= 570;
  assert.equal(roughness.length, 100);
  assert.ok(roughness.filter(noisyInterval).length > uniform.filter(noisyInterval).length * 1.8);
  assert.ok(roughness.every((point, index) => index === 0 || point.x > roughness[index - 1].x));
});

test("assessPathQuality flags paths that follow an axis boundary", () => {
  const path = Array.from({ length: 80 }, (_, x) => ({
    x: x + 10,
    y: 5,
    observed: true,
    confidence: 1,
    candidateCount: 1,
  }));
  const quality = assessPathQuality(path, { left: 10, right: 89, top: 5, bottom: 65, width: 80, height: 61 });
  assert.equal(quality.grade, "poor");
  assert.ok(quality.warnings.some((warning) => warning.code === "boundary-following"));
});

test("assessPathQuality reports columns with many same-color candidates", () => {
  const path = Array.from({ length: 80 }, (_, x) => ({
    x: x + 10,
    y: 30,
    observed: true,
    confidence: 0.9,
    candidateCount: 3,
  }));
  const quality = assessPathQuality(path, { left: 10, right: 89, top: 5, bottom: 65, width: 80, height: 61 });
  assert.ok(quality.warnings.some((warning) => warning.code === "many-candidates"));
});

test("review regions merge nearby questionable points and rank the strongest interval first", () => {
  const path = Array.from({ length: 24 }, (_, index) => ({
    x: 10 + index * 3,
    y: 30,
    observed: true,
    confidence: 0.95,
    candidateCount: 1,
  }));
  for (const index of [4, 5, 6, 8]) {
    path[index] = {
      ...path[index],
      observed: false,
      confidence: 0.25,
      inferenceUncertainty: 4,
      candidateCount: 5,
    };
  }
  path[18] = { ...path[18], confidence: 0.42, candidateCount: 4 };
  const regions = findPathReviewRegions(path, {
    left: 10, right: 79, top: 0, bottom: 60, width: 70, height: 61,
  });

  assert.equal(regions.length, 2);
  assert.deepEqual(regions[0].pointIndices, [4, 5, 6, 8]);
  assert.equal(regions[0].severity, "poor");
  assert.ok(regions[0].reasons.some((reason) => reason.code === "inferred" && reason.count === 4));
  assert.equal(regions[1].representativeIndex, 18);
});

test("review regions ignore protected guides and user-verified data points", () => {
  const path = [
    { x: 10, y: 20, observed: false, confidence: 0.1, anchor: true },
    { x: 20, y: 20, observed: false, confidence: 0.1, userEdited: true },
    { x: 30, y: 20, observed: false, confidence: 0.1, origin: "manual" },
  ];
  assert.deepEqual(findPathReviewRegions(path, {
    left: 0, right: 40, top: 0, bottom: 40, width: 41, height: 41,
  }), []);
});

test("review regions suppress isolated ordinary interpolation gaps", () => {
  const path = Array.from({ length: 12 }, (_, index) => ({
    x: index * 5,
    y: 20,
    observed: index !== 6,
    confidence: index === 6 ? 0.25 : 0.95,
    candidateCount: 1,
  }));
  assert.deepEqual(findPathReviewRegions(path, {
    left: 0, right: 55, top: 0, bottom: 40, width: 56, height: 41,
  }), []);
});

test("review regions surface isolated high disagreement between occlusion models", () => {
  const path = Array.from({ length: 12 }, (_, index) => ({
    x: index * 5,
    y: 20,
    observed: true,
    confidence: 0.9,
    candidateCount: 1,
    modelDisagreement: index === 6 ? 3 : 0,
  }));
  const regions = findPathReviewRegions(path, {
    left: 0, right: 55, top: 0, bottom: 40, width: 56, height: 41,
  });
  assert.equal(regions.length, 1);
  assert.ok(regions[0].reasons.some((reason) => reason.code === "model-disagreement"));
});

test("guided tracing uses a later anchor to select the intended branch", () => {
  const width = 100;
  const height = 70;
  const rgba = whiteImage(width, height);
  const color = { r: 25, g: 25, b: 25 };
  for (let x = 5; x <= 94; x += 1) {
    const upper = Math.round(12 + x * 0.35);
    const lower = Math.round(58 - x * 0.35);
    setPixel(rgba, width, x, upper, color);
    setPixel(rgba, width, x, lower, color);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 94, bottom: 66 },
    anchors: [{ x: 12, y: 16 }, { x: 88, y: 43 }],
    target: color,
    threshold: 5,
    maxJump: 4,
    maxGap: 2,
  });
  assert.equal(path.at(0).x, 5);
  assert.equal(path.at(-1).x, 94);
  assert.ok(Math.abs(path.find((point) => point.x === 88).y - 43) < 0.1);
  assert.ok(path.filter((point) => point.anchor).length >= 2);
});

test("guided tracing does not switch between nearby red and orange curves", () => {
  const width = 120;
  const height = 80;
  const rgba = whiteImage(width, height);
  const red = { r: 217, g: 55, b: 69 };
  const orange = { r: 242, g: 142, b: 43 };
  for (let x = 5; x <= 114; x += 1) {
    const redY = Math.round(58 - x * 0.28);
    const orangeY = Math.round(16 + x * 0.22);
    setPixel(rgba, width, x, redY, red);
    setPixel(rgba, width, x, orangeY, orange);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 114, bottom: 76 },
    anchors: [{ x: 20, y: 52 }, { x: 100, y: 30 }],
    target: red,
    threshold: 18,
    maxJump: 4,
    maxGap: 2,
  });
  assert.ok(path.every((point) => Math.abs(point.y - Math.round(58 - point.x * 0.28)) <= 1));
});

test("guided tracing keeps a dashed branch instead of switching to a same-color solid branch", () => {
  const width = 130;
  const height = 70;
  const rgba = whiteImage(width, height);
  const red = { r: 220, g: 30, b: 40 };
  for (let x = 5; x <= 124; x += 1) {
    setPixel(rgba, width, x, 20, red);
    if (x % 14 < 7) setPixel(rgba, width, x, 48, red);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 124, bottom: 66 },
    anchors: [{ x: 5, y: 48 }, { x: 45, y: 48 }, { x: 85, y: 48 }, { x: 124, y: 48 }],
    target: red,
    threshold: 5,
    maxJump: 5,
    maxGap: 10,
    strictGuideCorridor: true,
  });
  assert.equal(path.at(0).x, 5);
  assert.equal(path.at(-1).x, 124);
  assert.ok(path.every((point) => Math.abs(point.y - 48) < 0.1));
  assert.ok(path.some((point) => !point.observed));
});

test("dash fingerprint keeps a short-dash curve separate from a nearby same-color long-dash curve", () => {
  const width = 130;
  const height = 65;
  const rgba = whiteImage(width, height);
  const blue = { r: 25, g: 55, b: 225 };
  for (let x = 5; x <= 124; x += 1) {
    if (x % 8 < 3) setPixel(rgba, width, x, 28, blue);
    if (x % 14 < 10) setPixel(rgba, width, x, 33, blue);
  }
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 124, bottom: 58 },
    seed: { x: 17, y: 28 },
    target: blue,
    threshold: 5,
    maxJump: 7,
    maxGap: 7,
    targetStyle: "dashed",
  });
  assert.ok(path.at(0).x <= 10);
  assert.ok(path.at(-1).x >= 120);
  assert.ok(path.filter((point) => point.x >= 10 && point.x <= 120)
    .every((point) => Math.abs(point.y - 28) < 0.1));
  assert.ok(path.some((point) => !point.observed));
});

test("dash-dot fingerprint rejects a phase-shifted same-color dashed branch", () => {
  const width = 150;
  const height = 70;
  const rgba = whiteImage(width, height);
  const red = { r: 220, g: 35, b: 45 };
  for (let x = 5; x <= 144; x += 1) {
    const phase = x % 16;
    if (phase < 7 || phase === 10) setPixel(rgba, width, x, 29, red);
    if ((x + 5) % 16 < 7) setPixel(rgba, width, x, 35, red);
  }
  const path = traceCurve({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 144, bottom: 64 },
    seed: { x: 18, y: 29 },
    target: red,
    threshold: 5,
    maxJump: 8,
    maxGap: 10,
    targetStyle: "dashdot",
  });
  assert.ok(path.filter((point) => point.x >= 12 && point.x <= 138)
    .every((point) => Math.abs(point.y - 29) < 0.1));
  assert.ok(path.some((point) => !point.observed));
});

test("strong anchors preserve dashed-series identity across an exact same-color overlap", () => {
  const width = 145;
  const height = 70;
  const rgba = whiteImage(width, height);
  const black = { r: 20, g: 20, b: 20 };
  for (let x = 5; x <= 139; x += 1) {
    const targetY = x <= 45 ? 20 : x < 82 ? 30 : 40;
    const otherY = x <= 45 ? 40 : x < 82 ? 30 : 20;
    if (x % 8 < 3) setPixel(rgba, width, x, targetY, black);
    if ((x + 2) % 14 < 9) setPixel(rgba, width, x, otherY, black);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 139, bottom: 64 },
    anchors: [
      { x: 18, y: 20 },
      { x: 44, y: 20 },
      { x: 50, y: 30 },
      { x: 78, y: 30 },
      { x: 86, y: 40 },
      { x: 126, y: 40 },
    ],
    target: black,
    threshold: 5,
    maxJump: 8,
    maxGap: 9,
    strictGuideCorridor: true,
    targetStyle: "dashed",
  });
  assert.ok(Math.abs(path.find((point) => point.x === 30).y - 20) < 0.1);
  assert.ok(Math.abs(path.find((point) => point.x === 64).y - 30) < 0.1);
  assert.ok(Math.abs(path.find((point) => point.x === 105).y - 40) < 0.1);
});

test("an explicit anchor bridges an occlusion longer than maxGap", () => {
  const width = 120;
  const height = 70;
  const rgba = whiteImage(width, height);
  const blue = { r: 30, g: 80, b: 220 };
  for (let x = 5; x <= 114; x += 1) {
    if (x < 38 || x > 86) setPixel(rgba, width, x, 12 + Math.round(x * 0.3), blue);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 114, bottom: 66 },
    anchors: [{ x: 30, y: 21 }, { x: 92, y: 40 }],
    target: blue,
    threshold: 5,
    maxJump: 4,
    maxGap: 8,
    strictGuideCorridor: true,
  });
  assert.equal(path.at(0).x, 5);
  assert.equal(path.at(-1).x, 114);
  assert.ok(path.find((point) => point.x === 60).observed === false);
  assert.ok(Math.abs(path.find((point) => point.x === 60).y - 30) <= 1);
});

test("flexible anchors remain authoritative across a long occlusion", () => {
  const width = 120;
  const height = 70;
  const rgba = whiteImage(width, height);
  const blue = { r: 30, g: 80, b: 220 };
  for (let x = 5; x <= 114; x += 1) {
    if (x < 38 || x > 86) setPixel(rgba, width, x, 12 + Math.round(x * 0.3), blue);
  }
  const anchors = [{ x: 30, y: 21 }, { x: 92, y: 40 }];
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 114, bottom: 66 },
    anchors,
    target: blue,
    threshold: 5,
    maxJump: 4,
    maxGap: 8,
    strictGuideCorridor: false,
  });
  assert.deepEqual(
    path.filter((point) => point.anchor).map((point) => point.x),
    anchors.map((point) => point.x),
  );
  assert.ok(Math.abs(path.find((point) => point.x === 92).y - 40) < 0.1);
  assert.equal(path.find((point) => point.x === 60).observed, false);
  assert.ok(Math.abs(path.find((point) => point.x === 60).y - 30) <= 1);
});

test("a guide placed inside an occlusion automatically constrains adjacent segments", () => {
  const width = 110;
  const height = 70;
  const rgba = whiteImage(width, height);
  const blue = { r: 30, g: 80, b: 220 };
  for (let x = 5; x <= 104; x += 1) {
    if (x <= 25 || x >= 75) setPixel(rgba, width, x, 40, blue);
    if (x >= 26 && x <= 74) {
      const coveringBranch = 40 - Math.round(15 * Math.sin(Math.PI * (x - 25) / 50));
      setPixel(rgba, width, x, coveringBranch, blue);
    }
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 4, right: 104, bottom: 64 },
    anchors: [
      { x: 15, y: 40 },
      { x: 50, y: 40, occlusionGuide: true },
      { x: 85, y: 40 },
    ],
    target: blue,
    threshold: 5,
    maxJump: 4,
    maxGap: 6,
    strictGuideCorridor: false,
  });
  const hiddenGuide = path.find((point) => point.x === 50);
  const hiddenMiddle = path.find((point) => point.x === 40);
  assert.equal(hiddenGuide.anchor, true);
  assert.equal(hiddenGuide.observed, false);
  assert.equal(hiddenGuide.y, 40);
  assert.equal(hiddenMiddle.observed, false);
  assert.ok(hiddenMiddle.y > 35, `path was stolen by the covering branch: ${hiddenMiddle.y}`);
});

test("a saved same-color path is avoided while tracing an occluded series", () => {
  const width = 100;
  const height = 65;
  const rgba = whiteImage(width, height);
  const purple = { r: 105, g: 65, b: 175 };
  const savedPath = [];
  for (let x = 5; x <= 94; x += 1) {
    setPixel(rgba, width, x, 20, purple);
    savedPath.push({ x, y: 20 });
    if (x <= 35 || x >= 74) setPixel(rgba, width, x, 43, purple);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 4, right: 94, bottom: 60 },
    anchors: [{ x: 20, y: 43 }, { x: 82, y: 43 }],
    target: purple,
    threshold: 5,
    maxJump: 4,
    maxGap: 8,
    avoidPaths: [savedPath],
  });
  assert.ok(path.filter((point) => point.x >= 40 && point.x <= 70)
    .every((point) => Math.abs(point.y - 43) < 0.1 && !point.observed));
  assert.ok(path.every((point) => Math.abs(point.y - 20) > 5));
});

test("same-color avoidance keeps a genuine crossing observable", () => {
  const width = 100;
  const height = 60;
  const rgba = whiteImage(width, height);
  const purple = { r: 105, g: 65, b: 175 };
  const savedPath = [];
  for (let x = 5; x <= 94; x += 1) {
    setPixel(rgba, width, x, 30, purple);
    savedPath.push({ x, y: 30 });
    setPixel(rgba, width, x, Math.round(10 + x * 0.4), purple);
  }
  const path = traceCurveThroughAnchors({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 94, bottom: 55 },
    anchors: [{ x: 10, y: 14 }, { x: 90, y: 46 }],
    target: purple,
    threshold: 5,
    maxJump: 4,
    maxGap: 6,
    avoidPaths: [savedPath],
  });
  const crossing = path.find((point) => point.x === 50);
  assert.ok(Math.abs(crossing.y - 30) <= 1);
  assert.equal(crossing.observed, true);
  assert.equal(crossing.sharedWithSavedCurve, true);
  assert.ok(Math.abs(path.find((point) => point.x === 80).y - 42) <= 1);
});

test("marker extraction separates compact dots from same-color dashed line segments", () => {
  const width = 110;
  const height = 70;
  const rgba = whiteImage(width, height);
  const red = { r: 220, g: 30, b: 40 };
  for (let x = 5; x <= 104; x += 1) {
    if (x % 16 < 9) setPixel(rgba, width, x, 18, red);
  }
  for (const centerX of [20, 50, 80]) {
    for (let y = 43; y <= 47; y += 1) {
      for (let x = centerX - 2; x <= centerX + 2; x += 1) setPixel(rgba, width, x, y, red);
    }
  }
  const markers = extractMarkerCenters({
    rgba,
    width,
    height,
    rect: { left: 5, top: 3, right: 104, bottom: 66 },
    target: red,
    threshold: 5,
    anchors: [
      { x: 20, y: 45, anchorId: "marker-guide-1" },
      { x: 50, y: 45, anchorId: "marker-guide-2" },
      { x: 80, y: 45, anchorId: "marker-guide-3" },
    ],
    strictGuideCorridor: true,
  });
  assert.deepEqual(markers.map((point) => Math.round(point.x)), [20, 50, 80]);
  assert.ok(markers.every((point) => Math.abs(point.y - 45) < 0.1 && point.marker));
  assert.deepEqual(
    markers.filter((point) => point.anchor).map((point) => point.anchorId),
    ["marker-guide-1", "marker-guide-2", "marker-guide-3"],
  );
});

test("marker extraction finds filled dots that are attached to a same-color solid curve", () => {
  const width = 140;
  const height = 78;
  const rgba = whiteImage(width, height);
  const black = { r: 8, g: 8, b: 8 };
  const centers = [18, 36, 54, 72, 90, 108, 126];
  for (let x = 5; x <= 134; x += 1) setPixel(rgba, width, x, 43, black);
  for (const centerX of centers) {
    for (let offsetY = -3; offsetY <= 3; offsetY += 1) {
      for (let offsetX = -3; offsetX <= 3; offsetX += 1) {
        if (offsetX ** 2 + offsetY ** 2 <= 10) {
          setPixel(rgba, width, centerX + offsetX, 43 + offsetY, black);
        }
      }
    }
  }
  const markers = extractMarkerCenters({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 134, bottom: 72 },
    target: black,
    threshold: 5,
    anchors: [{ x: 10, y: 43 }, { x: 130, y: 43 }],
    strictGuideCorridor: true,
  });
  assert.deepEqual(markers.map((point) => Math.round(point.x)), centers);
  assert.ok(markers.every((point) => Math.abs(point.y - 43) <= 0.25 && point.marker));
  assert.ok(markers.every((point) => point.attachedMarker));
});

test("marker extraction does not turn an ordinary thick solid curve into markers", () => {
  const width = 140;
  const height = 78;
  const rgba = whiteImage(width, height);
  const black = { r: 8, g: 8, b: 8 };
  for (let x = 5; x <= 134; x += 1) {
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) setPixel(rgba, width, x, 43 + offsetY, black);
  }
  const markers = extractMarkerCenters({
    rgba,
    width,
    height,
    rect: { left: 5, top: 5, right: 134, bottom: 72 },
    target: black,
    threshold: 5,
    anchors: [{ x: 10, y: 43 }, { x: 130, y: 43 }],
    strictGuideCorridor: true,
  });
  assert.deepEqual(markers, []);
});

test("detectPlotRect finds a dark rectangular frame", () => {
  const width = 160;
  const height = 110;
  const rgba = whiteImage(width, height);
  const black = { r: 10, g: 10, b: 10 };
  for (let x = 22; x <= 142; x += 1) {
    setPixel(rgba, width, x, 18, black);
    setPixel(rgba, width, x, 92, black);
  }
  for (let y = 18; y <= 92; y += 1) {
    setPixel(rgba, width, 22, y, black);
    setPixel(rgba, width, 142, y, black);
  }
  const rect = detectPlotRect(rgba, width, height);
  assert.deepEqual(
    { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    { left: 22, right: 142, top: 18, bottom: 92 },
  );
  assert.deepEqual(rect.edgeThickness, { top: 1, bottom: 1, left: 1, right: 1 });
  assert.ok(rect.confidence > 0.9);
});

test("detectPlotRect expands a thick frame to its outermost ink edges", () => {
  const width = 180;
  const height = 130;
  const rgba = whiteImage(width, height);
  const black = { r: 12, g: 12, b: 12 };
  for (let y = 16; y <= 20; y += 1) {
    for (let x = 24; x <= 154; x += 1) setPixel(rgba, width, x, y, black);
  }
  for (let y = 101; y <= 106; y += 1) {
    for (let x = 24; x <= 154; x += 1) setPixel(rgba, width, x, y, black);
  }
  for (let x = 24; x <= 28; x += 1) {
    for (let y = 16; y <= 106; y += 1) setPixel(rgba, width, x, y, black);
  }
  for (let x = 149; x <= 154; x += 1) {
    for (let y = 16; y <= 106; y += 1) setPixel(rgba, width, x, y, black);
  }
  const rect = detectPlotRect(rgba, width, height);
  assert.deepEqual(
    { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    { left: 24, right: 154, top: 16, bottom: 106 },
  );
  assert.deepEqual(rect.edgeThickness, { top: 5, bottom: 6, left: 5, right: 6 });
});

test("detectPlotRect keeps outer frame edges inside the image", () => {
  const width = 120;
  const height = 90;
  const rgba = whiteImage(width, height);
  const black = { r: 8, g: 8, b: 8 };
  for (let y = 0; y <= 2; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(rgba, width, x, y, black);
  }
  for (let y = height - 3; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(rgba, width, x, y, black);
  }
  for (let x = 0; x <= 2; x += 1) {
    for (let y = 0; y < height; y += 1) setPixel(rgba, width, x, y, black);
  }
  for (let x = width - 3; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) setPixel(rgba, width, x, y, black);
  }
  const rect = detectPlotRect(rgba, width, height);
  assert.deepEqual(
    { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
    { left: 0, right: width - 1, top: 0, bottom: height - 1 },
  );
});


test("rotation angle helpers preserve quarter turns and split fine adjustment", () => {
  assert.equal(normalizeRotationDegrees(360), 0);
  assert.equal(normalizeRotationDegrees(180), -180);
  assert.deepEqual(splitRotationDegrees(90), { quarterTurns: 1, fineDegrees: 0 });
  assert.deepEqual(splitRotationDegrees(-135), { quarterTurns: 3, fineDegrees: -45 });
  assert.equal(composeRotationDegrees({ quarterTurns: 1, fineDegrees: 2.5 }), 92.5);
});

test("rotation bounds swap dimensions for exact quarter turns and expand fine angles", () => {
  assert.deepEqual(rotatedCanvasBounds(100, 50, 0), { width: 100, height: 50 });
  assert.deepEqual(rotatedCanvasBounds(100, 50, 90), { width: 50, height: 100 });
  const diagonal = rotatedCanvasBounds(100, 50, 15);
  assert.ok(diagonal.width > 100);
  assert.ok(diagonal.height > 50);
});

test("quarter-turn RGBA rotation maps pixels clockwise and is reversible", () => {
  const rgba = new Uint8ClampedArray([
    1, 0, 0, 255, 2, 0, 0, 255,
    3, 0, 0, 255, 4, 0, 0, 255,
    5, 0, 0, 255, 6, 0, 0, 255,
  ]);
  const clockwise = rotateImageDataQuarterTurn(rgba, 2, 3, 1);
  assert.equal(clockwise.width, 3);
  assert.equal(clockwise.height, 2);
  assert.deepEqual([...clockwise.rgba.filter((_, index) => index % 4 === 0)], [5, 3, 1, 6, 4, 2]);
  const roundTrip = rotateImageDataQuarterTurn(clockwise.rgba, clockwise.width, clockwise.height, 3);
  assert.deepEqual([...roundTrip.rgba], [...rgba]);
});

test("two-point alignment returns the correction needed for horizontal or vertical reference", () => {
  assert.equal(normalizeLineAngleDegrees(180), 0);
  assert.ok(Math.abs(alignmentCorrectionDegrees({ x: 0, y: 0 }, { x: 100, y: 3.4907 }, "horizontal") + 2) < 0.01);
  assert.ok(Math.abs(alignmentCorrectionDegrees({ x: 0, y: 100 }, { x: 0, y: 0 }, "vertical")) < 1e-9);
  assert.equal(alignmentCorrectionDegrees({ x: 4, y: 4 }, { x: 4, y: 4 }, "horizontal"), null);
});

test("image fingerprints are deterministic and react to raster changes", () => {
  const first = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]),
  };
  const same = {
    ...first,
    data: new Uint8ClampedArray(first.data),
  };
  const changed = {
    ...first,
    data: new Uint8ClampedArray([10, 20, 31, 255, 40, 50, 60, 255]),
  };
  assert.equal(fingerprintImageData(first), fingerprintImageData(same));
  assert.notEqual(fingerprintImageData(first), fingerprintImageData(changed));
  assert.equal(fingerprintImageData(null), null);
});

test("edit sessions undo, redo, and restore an autosaved draft", () => {
  const stored = new Map();
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  let value = 0;
  const session = createEditSession({
    capture: () => ({ value }),
    restore: (snapshot) => {
      value = snapshot.value;
      return true;
    },
    storageKey: () => "test-draft",
    storage,
    setTimer: null,
  });

  session.reset();
  value = 1;
  assert.equal(session.commit("设为 1"), true);
  assert.equal(session.historyStatus().canUndo, true);
  assert.deepEqual(session.navigate("undo"), { direction: "undo", label: "设为 1" });
  assert.equal(value, 0);
  assert.equal(session.historyStatus().canRedo, true);
  assert.deepEqual(session.navigate("redo"), { direction: "redo", label: "设为 1" });
  assert.equal(value, 1);

  value = 7;
  assert.equal(session.saveNow(), true);
  value = 0;
  assert.equal(session.restoreDraft(), true);
  assert.equal(value, 7);
  assert.deepEqual(session.historyStatus(), {
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  });
});

test("skew estimation recovers a rotated rectangular frame", () => {
  const width = 320;
  const height = 220;
  const rgba = whiteImage(width, height);
  const angle = 3;
  const tangent = Math.tan(angle * Math.PI / 180);
  drawLine(rgba, width, height, { x: 40, y: 45 }, { x: 285, y: 45 + tangent * 245 }, undefined, 3);
  drawLine(rgba, width, height, { x: 40, y: 175 }, { x: 285, y: 175 + tangent * 245 }, undefined, 3);
  drawLine(rgba, width, height, { x: 40, y: 45 }, { x: 40 - tangent * 130, y: 175 }, undefined, 3);
  drawLine(rgba, width, height, { x: 285, y: 45 + tangent * 245 }, { x: 285 - tangent * 130, y: 175 + tangent * 245 }, undefined, 3);
  const estimated = estimateAxisSkew({ rgba, width, height });
  assert.ok(Math.abs(estimated.angleDegrees - angle) <= 0.3);
  assert.ok(estimated.confidence >= 0.6);
});

test("frame diagnosis and homography expose measurable perspective distortion", () => {
  const width = 120;
  const height = 100;
  const rgba = whiteImage(width, height);
  const corners = [
    { x: 20, y: 14 },
    { x: 101, y: 19 },
    { x: 96, y: 82 },
    { x: 24, y: 78 },
  ];
  for (let index = 0; index < 4; index += 1) {
    drawLine(rgba, width, height, corners[index], corners[(index + 1) % 4], undefined, 3);
  }
  const diagnosis = detectFrameQuadrilateral({
    rgba,
    width,
    height,
    rect: { left: 22, top: 17, right: 98, bottom: 80, width: 77, height: 64 },
    band: 10,
  });
  assert.ok(diagnosis.confidence > 0.8);
  assert.ok(diagnosis.perspectivePixels > 2);
  const globalDiagnosis = detectPerspectiveFrame({ rgba, width, height });
  assert.ok(globalDiagnosis?.confidence > 0.6);
  assert.ok(globalDiagnosis.perspectivePixels > 2);

  const destination = [
    { x: 20, y: 15 }, { x: 100, y: 15 }, { x: 100, y: 80 }, { x: 20, y: 80 },
  ];
  const homography = destinationToSourceHomography(destination, corners);
  destination.forEach((point, index) => {
    const projected = projectHomography(homography, point);
    assert.ok(Math.hypot(projected.x - corners[index].x, projected.y - corners[index].y) < 1e-6);
  });
  const identity = warpPerspectiveRgba({
    rgba,
    width,
    height,
    sourceCorners: destination,
    destinationCorners: destination,
  });
  assert.deepEqual([...identity.rgba], [...rgba]);
});
