import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPairedCurveRows, compositedColorDistance, estimateColorThreshold, pathToData,
  sampleRepresentativeColor, snapTargetPoint, valueToPixel,
} from "../src/core.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { prepareTraceOutput } from "../src/trace-output.js";

function imageWithBackground(width, height, backgroundAt) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    rgba.set([...backgroundAt(x, y), 255], (y * width + x) * 4);
  }
  return { rgba, width, height };
}

function setGrey(image, x, y, level) {
  image.rgba.set([level, level, level, 255], (y * image.width + x) * 4);
}

function pick(image, point, rect) {
  const target = sampleRepresentativeColor(image.rgba, image.width, image.height, point);
  const initialThreshold = estimateColorThreshold(image.rgba, image.width, image.height, point, target);
  const seed = snapTargetPoint({ ...image, point, rect, target, threshold: initialThreshold });
  const threshold = estimateColorThreshold(image.rgba, image.width, image.height, seed, target);
  return { target, seed: { ...seed, anchorId: "seed", userGuided: true }, threshold };
}

test("grey selection is not stolen by a nearby darker grid, including near-miss clicks", () => {
  for (const grid of [0, 40]) {
    const image = imageWithBackground(41, 41, () => [240, 240, 240]);
    for (let x = 2; x < 39; x += 1) {
      setGrey(image, x, 20, 128);
      setGrey(image, x, 24, grid);
    }
    for (const y of [19, 20, 21]) {
      const { target, seed } = pick(image, { x: 20, y }, { left: 2, top: 2, right: 38, bottom: 38 });
      assert.deepEqual([target.r, target.g, target.b], [128, 128, 128]);
      assert.ok(Math.abs(seed.y - 20) < 0.1, `click y=${y} snapped to the grid`);
    }
  }
});

test("auto neutral tolerance excludes the local flat background instead of learning it as ink", () => {
  for (const [ink, background] of [[128, 160], [200, 220]]) {
    for (const lineWidth of [1, 3, 5, 7, 9]) {
      const image = imageWithBackground(41, 41, () => [background, background, background]);
      for (let x = 2; x < 39; x += 1) for (let y = 20 - (lineWidth - 1) / 2; y <= 20 + (lineWidth - 1) / 2; y += 1) {
        setGrey(image, x, y, ink);
      }
      const { target, threshold, seed } = pick(image, { x: 20, y: 20 }, { left: 2, top: 2, right: 38, bottom: 38 });
      assert.equal(target.r, ink);
      assert.ok(compositedColorDistance(background, background, background, target) > threshold);
      assert.ok(compositedColorDistance(ink, ink, ink, target) <= threshold);
      assert.ok(Math.abs(seed.y - 20) < 0.1);
    }
  }
});

// Self-authored mathematical raster fixtures, not copies of user photographs.
// Check the public computation/output pipeline, with automatically picked
// colours and tolerances, rather than hard-coded ideal target parameters.
for (const { name, ink, background, lineWidth = 1.6 } of [
  { name: "mid-grey on pale grey", ink: 100, background: 220 },
  { name: "light-grey on pale grey", ink: 160, background: 220 },
  { name: "low-contrast grey", ink: 128, background: 160 },
  { name: "low-contrast light grey", ink: 200, background: 220 },
  { name: "grey below former cutoff", ink: 79, background: 220 },
  { name: "grey above former cutoff", ink: 80, background: 220 },
  { name: "thin antialiased grey", ink: 100, background: 240, lineWidth: 1.2 },
  { name: "grey across shaded backgrounds", ink: 100, background: "shaded", lineWidth: 2.4 },
]) {
  test(`one-click neutral pipeline: ${name}`, () => {
    const width = 224, height = 128;
    const rect = { left: 8, right: 215, top: 8, bottom: 119 };
    const left = 12, right = 211;
    const yAt = x => 85 - 29 * Math.exp(-(((x - 111) / 34) ** 2)) + 4 * Math.sin(x / 29);
    const image = imageWithBackground(width, height, x => background === "shaded"
      ? x < 78 ? [235, 235, 235] : x < 152 ? [192, 202, 215] : [216, 209, 201]
      : [background, background, background]);
    for (let x = left; x <= right; x += 1) {
      const center = yAt(x);
      for (let y = Math.floor(center - 3); y <= Math.ceil(center + 3); y += 1) {
        const coverage = Math.max(0, Math.min(1, lineWidth / 2 + 0.5 - Math.abs(y - center)));
        const index = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          image.rgba[index + channel] = Math.round(image.rgba[index + channel] * (1 - coverage) + ink * coverage);
        }
      }
    }
    // Dark grid and another grey series are not the selected luminance family.
    for (let x = left; x <= right; x += 1) {
      setGrey(image, x, 30, 0);
      setGrey(image, x, 104, ink <= 128 ? 185 : 60);
    }
    const clicks = (background === "shaded" ? [61, 125, 185] : [61])
      .flatMap(x => [0, -1, 1].map(offset => ({ x, y: yAt(x) + offset })));
    for (const click of clicks) {
      const { target, threshold, seed } = pick(image, click, rect);
      assert.ok(Math.abs(target.r - ink) <= 12, `selected ${target.r}, expected grey ${ink}`);
      const options = { rect, anchors: [seed], seed, target, threshold, exclusions: [] };
      const classification = runComputeOperation("classify-target", options, image);
      assert.equal(classification.markerInference.detected, false);
      const inferred = classification.lineInference;
      const traced = runComputeOperation("trace-line", {
        ...options, targetStyle: inferred.style, autoPatternedStyle: ["dashed", "dashdot", "dotted"].includes(inferred.style),
        autoStyleConfidence: inferred.confidence, orientationMode: "auto", refinementMode: "full", maxJump: 14, maxGap: 24,
      }, image);
      assert.equal(traced.orientation, "horizontal");
      for (const count of [100, 180]) {
        const path = prepareTraceOutput(traced.path, {
          count, parameters: { samplingMode: "geometry" }, orientation: traced.orientation,
          guides: [seed], width, height, rect,
        }).path;
        assert.equal(path.length, count);
        assert.ok(path.some(p => p.anchorId === seed.anchorId && p.x === seed.x && p.y === seed.y));
        assert.ok(Math.min(...path.map(p => p.x)) <= left + 2);
        assert.ok(Math.max(...path.map(p => p.x)) >= right - 2);
        assert.ok(path.every(p => Math.abs(p.y - yAt(p.x)) <= 1.5), "must stay on the selected grey curve");
        const xAxis = { point1: left, point2: right, value1: 1e-3, value2: 1e3, scale: "log" };
        const yAxis = { point1: rect.bottom, point2: rect.top, value1: 0, value2: 100, scale: "linear" };
        const rows = buildPairedCurveRows([{ label: name, data: pathToData(path, xAxis, yAxis) }]);
        assert.equal(rows.length, count + 2);
        rows.slice(2).forEach((row, index) => {
          const values = row.map(Number);
          assert.ok(values.every(Number.isFinite));
          assert.ok(Math.abs(valueToPixel(values[0], xAxis) - path[index].x) < 1e-6);
          assert.ok(Math.abs(valueToPixel(values[1], yAxis) - path[index].y) < 1e-6);
        });
      }
    }
  });
}
