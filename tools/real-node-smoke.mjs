#!/usr/bin/env node

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  assessPathQuality,
  detectPlotRect,
  estimateColorThreshold,
  extractMarkerCenters,
  fitInferredPathGaps,
  refinePathCenterline,
  sampleRepresentativeColor,
  traceCurveThroughAnchors,
} from "../src/core.js";
import { decodePng } from "./png-decode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const images = join(here, "..", "images");
const cases = [
  { image: "fig1.png", name: "fig1 green peak", anchors: [[276, 85]], maxJump: 16, maxGap: 18 },
  { image: "fig1.png", name: "fig1 orange solid", anchors: [[280, 173]], maxJump: 14, maxGap: 18 },
  { image: "fig1.png", name: "fig1 blue solid", anchors: [[134, 132]], maxJump: 14, maxGap: 20 },
  {
    image: "fig1.png",
    name: "fig1 red solid through occlusion",
    anchors: [[100, 203], [250, 197], [370, 238], [500, 296], [540, 312]],
    exclusions: [{ left: 388, top: 42, right: 545, bottom: 220 }],
    expected: [[430, 265], [540, 312]],
    strictGuideCorridor: true,
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

const cache = new Map();
const results = [];
for (const config of cases) {
  if (!cache.has(config.image)) cache.set(config.image, decodePng(join(images, config.image)));
  const image = cache.get(config.image);
  const rect = detectPlotRect(image.rgba, image.width, image.height);
  const anchors = config.anchors.map(([x, y]) => ({ x, y }));
  const target = sampleRepresentativeColor(image.rgba, image.width, image.height, anchors[0]);
  const threshold = estimateColorThreshold(image.rgba, image.width, image.height, anchors[0], target);
  const started = performance.now();
  let path;
  if (config.markerRange) {
    path = extractMarkerCenters({
      rgba: image.rgba,
      width: image.width,
      height: image.height,
      rect,
      anchors,
      target,
      threshold,
      exclusions: config.exclusions ?? [],
      strictGuideCorridor: false,
    });
  } else {
    path = traceCurveThroughAnchors({
      rgba: image.rgba,
      width: image.width,
      height: image.height,
      rect,
      anchors,
      target,
      threshold,
      maxJump: config.maxJump,
      maxGap: config.maxGap,
      exclusions: config.exclusions ?? [],
      strictGuideCorridor: config.strictGuideCorridor ?? false,
      targetStyle: config.targetStyle ?? "auto",
    });
    path = refinePathCenterline({
      rgba: image.rgba,
      width: image.width,
      height: image.height,
      rect,
      path,
      target,
      threshold,
      exclusions: config.exclusions ?? [],
    });
    path = fitInferredPathGaps(path, { rect });
  }
  if (config.markerRange) {
    assert.ok(
      path.length >= config.markerRange[0] && path.length <= config.markerRange[1],
      `${config.name}: expected ${config.markerRange[0]}–${config.markerRange[1]} markers, received ${path.length}`,
    );
  }
  for (const [expectedX, expectedY] of config.expected ?? []) {
    const point = path.reduce((nearest, candidate) => (
      Math.abs(candidate.x - expectedX) < Math.abs(nearest.x - expectedX) ? candidate : nearest
    ));
    assert.ok(
      Math.abs(point.y - expectedY) <= 3,
      `${config.name}: expected y≈${expectedY} at x=${expectedX}, received ${point.y}`,
    );
  }
  const elapsedMs = performance.now() - started;
  const observed = path.filter((point) => point.observed).length;
  results.push({
    name: config.name,
    target,
    threshold,
    plotRect: rect,
    points: path.length,
    xRange: path.length ? [path[0].x, path.at(-1).x] : null,
    observedFraction: observed / path.length,
    quality: assessPathQuality(path, rect),
    elapsedMs,
  });
}

console.log(JSON.stringify(results, null, 2));
