#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compositedColorDistance,
  detectPlotRect,
  estimateColorThreshold,
  fitInferredPathGaps,
  refinePathCenterline,
  sampleRepresentativeColor,
  traceCurveThroughAnchors,
} from "../src/core.js";
import { decodePng } from "./png-decode.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const generated = join(here, "..", "benchmarks", "generated");
const manifest = JSON.parse(readFileSync(join(generated, "manifest.json"), "utf8"));
const thresholds = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (!thresholds.length) thresholds.push(18, 24, 30, 36, 42);

function interpolateGroundTruth(series, pixelX) {
  const xs = series.pixelX;
  const ys = series.pixelY;
  let low = 0;
  let high = xs.length - 1;
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2);
    if (xs[middle] <= pixelX) low = middle;
    else high = middle;
  }
  const fraction = (pixelX - xs[low]) / Math.max(1e-12, xs[high] - xs[low]);
  return ys[low] + fraction * (ys[high] - ys[low]);
}

function score(path, series, plotRect) {
  const squaredErrors = path.map((point) => (point.y - interpolateGroundTruth(series, point.x)) ** 2);
  const rmsePx = Math.sqrt(squaredErrors.reduce((sum, value) => sum + value, 0) / Math.max(1, squaredErrors.length));
  const expectedSpan = series.pixelX.at(-1) - series.pixelX[0];
  const actualSpan = path.length ? path.at(-1).x - path[0].x : 0;
  const spanFraction = Math.min(1, actualSpan / Math.max(1, expectedSpan));
  return {
    points: path.length,
    spanFraction,
    rmsePx,
    nrmse: rmsePx / plotRect.height + Math.max(0, 1 - spanFraction) * 0.25,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(results, key) {
  const values = results.map((result) => result[key].nrmse);
  return {
    meanNRMSE: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianNRMSE: median(values),
    fullSpanRate: results.filter((result) => result[key].spanFraction >= 0.95).length / results.length,
    belowTwoPercent: results.filter((result) => result[key].nrmse <= 0.02).length / results.length,
  };
}

function visibleSeedIndex(series, rgba, width, height) {
  const original = { r: series.color[0], g: series.color[1], b: series.color[2] };
  const start = Math.floor(series.pixelX.length * 0.05);
  const end = Math.floor(series.pixelX.length * 0.95);
  let best = { index: Math.floor(series.pixelX.length * 0.5), score: Infinity };
  for (let index = start; index <= end; index += 2) {
    const sampled = sampleRepresentativeColor(rgba, width, height, {
      x: series.pixelX[index],
      y: series.pixelY[index],
    });
    const colorError = compositedColorDistance(sampled.r, sampled.g, sampled.b, original);
    const positionPenalty = Math.abs(index / series.pixelX.length - 0.5) * 2;
    const score = colorError + positionPenalty;
    if (score < best.score) best = { index, score };
  }
  return best.index;
}

const charts = manifest.charts.map((entry) => {
  const chart = JSON.parse(readFileSync(join(generated, entry.metadata), "utf8"));
  const decoded = decodePng(join(generated, entry.image));
  if (decoded.width !== chart.width || decoded.height !== chart.height) throw new Error(`Dimension mismatch for ${chart.id}`);
  return { chart, rgba: decoded.rgba };
});

for (const threshold of thresholds) {
  const results = [];
  const plotIoUs = [];
  for (const { chart, rgba } of charts) {
    const detected = detectPlotRect(rgba, chart.width, chart.height);
    const intersectionWidth = Math.max(0, Math.min(detected.right, chart.plotRect.right) - Math.max(detected.left, chart.plotRect.left) + 1);
    const intersectionHeight = Math.max(0, Math.min(detected.bottom, chart.plotRect.bottom) - Math.max(detected.top, chart.plotRect.top) + 1);
    const intersection = intersectionWidth * intersectionHeight;
    plotIoUs.push(intersection / (detected.width * detected.height + chart.plotRect.width * chart.plotRect.height - intersection));
    for (const series of chart.series) {
      const colorIndex = visibleSeedIndex(series, rgba, chart.width, chart.height);
      const target = sampleRepresentativeColor(rgba, chart.width, chart.height, {
        x: series.pixelX[colorIndex],
        y: series.pixelY[colorIndex],
      });
      const seedAnchor = { x: series.pixelX[colorIndex], y: series.pixelY[colorIndex] };
      const seedFraction = colorIndex / series.pixelX.length;
      const seriesThreshold = threshold === 0
        ? estimateColorThreshold(rgba, chart.width, chart.height, seedAnchor, target)
        : threshold;
      const traceAt = (fractions) => {
        const anchors = [seedAnchor, ...fractions.map((fraction) => {
          const index = Math.floor(series.pixelX.length * fraction);
          return { x: series.pixelX[index], y: series.pixelY[index] };
        })];
        let path = traceCurveThroughAnchors({
          rgba,
          width: chart.width,
          height: chart.height,
          rect: chart.plotRect,
          anchors,
          target,
          threshold: seriesThreshold,
          maxJump: 16,
          maxGap: 30,
        });
        path = refinePathCenterline({
          rgba,
          width: chart.width,
          height: chart.height,
          rect: chart.plotRect,
          path,
          target,
          threshold: seriesThreshold,
        });
        return fitInferredPathGaps(path, { rect: chart.plotRect });
      };
      results.push({
        chart: chart.id,
        label: series.label,
        originalColor: series.color,
        sampledColor: [target.r, target.g, target.b],
        seedFraction,
        seriesThreshold,
        oneAnchor: score(traceAt([]), series, chart.plotRect),
        twoAnchors: score(traceAt([seedFraction < 0.5 ? 0.9 : 0.1]), series, chart.plotRect),
        fourAnchors: score(traceAt([0.05, 0.5, 0.95]), series, chart.plotRect),
      });
    }
  }
  console.log(JSON.stringify({
    threshold,
    meanPlotIoU: plotIoUs.reduce((sum, value) => sum + value, 0) / plotIoUs.length,
    oneAnchor: summarize(results, "oneAnchor"),
    twoAnchors: summarize(results, "twoAnchors"),
    fourAnchors: summarize(results, "fourAnchors"),
    worstFourAnchors: [...results]
      .sort((a, b) => b.fourAnchors.nrmse - a.fourAnchors.nrmse)
      .slice(0, 5)
      .map((result) => ({
        chart: result.chart,
        label: result.label,
        originalColor: result.originalColor,
        sampledColor: result.sampledColor,
        seedFraction: result.seedFraction,
        seriesThreshold: result.seriesThreshold,
        ...result.fourAnchors,
      })),
  }));
}
