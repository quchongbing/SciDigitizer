#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  compositedColorDistance,
  detectPlotRect,
  discoverColoredSeries,
  estimateColorThreshold,
  extractMarkerCenters,
  fitInferredPathGaps,
  inferLineStyle,
  inferMarkerSeries,
  preferOrdinaryTraceFallback,
  refinePathCenterline,
  sampleRepresentativeColor,
  traceCurveThroughAnchors,
} from "../src/core.js";
import { detectPerspectiveFrame, estimateAxisSkew } from "../src/image-geometry.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { createAccuracyFixtures, createGeometryFixtures } from "./accuracy-fixtures.mjs";
import { createParametricFixtures } from "./parametric-fixtures.mjs";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_BASELINE = new URL("../benchmarks/baseline.json", import.meta.url);
const PROTOCOLS = Object.freeze({
  oneClick: { label: "one target click", seedClicks: 1, guideClicks: 0 },
  oneGuide: { label: "target click + one guide", seedClicks: 1, guideClicks: 1 },
  threeGuides: { label: "target click + three guides", seedClicks: 1, guideClicks: 3 },
});

function percentile(values, fraction) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - position) + sorted[upper] * (position - lower);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;
}

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator))
    : 0;
  return Math.hypot(
    point.x - (start.x + fraction * dx),
    point.y - (start.y + fraction * dy),
  );
}

function pointPolylineDistance(point, polyline, closed = false) {
  if (!polyline.length) return Infinity;
  if (polyline.length === 1) return Math.hypot(point.x - polyline[0].x, point.y - polyline[0].y);
  let distance = Infinity;
  for (let index = 1; index < polyline.length; index += 1) {
    distance = Math.min(distance, pointSegmentDistance(point, polyline[index - 1], polyline[index]));
  }
  if (closed) distance = Math.min(distance, pointSegmentDistance(point, polyline.at(-1), polyline[0]));
  return distance;
}

function polylineLength(polyline, closed = false) {
  if (polyline.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < polyline.length; index += 1) {
    length += Math.hypot(polyline[index].x - polyline[index - 1].x, polyline[index].y - polyline[index - 1].y);
  }
  if (closed) length += Math.hypot(polyline[0].x - polyline.at(-1).x, polyline[0].y - polyline.at(-1).y);
  return length;
}

function traceParametricFixture(fixture) {
  const seed = fixture.anchors[0];
  const target = sampleRepresentativeColor(
    fixture.image.rgba,
    fixture.image.width,
    fixture.image.height,
    seed,
  );
  const threshold = estimateColorThreshold(
    fixture.image.rgba,
    fixture.image.width,
    fixture.image.height,
    seed,
    target,
  );
  const started = performance.now();
  const result = runComputeOperation("trace-line", {
    rect: fixture.rect,
    anchors: fixture.anchors,
    target,
    threshold,
    exclusions: fixture.exclusions ?? [],
    strictGuideCorridor: false,
    avoidPaths: [],
    avoidanceRadius: 2.5,
    inclusionMask: null,
    maxJump: 8,
    maxGap: 3,
    targetStyle: fixture.targetStyle ?? "line",
    refinementMode: "full",
    orientationMode: fixture.orientationMode,
  }, fixture.image);
  return { ...result, elapsedMs: performance.now() - started };
}

function scoreParametricFixture(fixture, result) {
  const outputErrors = result.path.map((point) => pointPolylineDistance(point, fixture.truth, fixture.closed));
  const truthSamples = fixture.truth.filter((_, index) => index % 4 === 0 || index === fixture.truth.length - 1);
  const truthErrors = truthSamples.map((point) => pointPolylineDistance(point, result.path, fixture.closed));
  const outputLength = polylineLength(result.path, fixture.closed);
  const truthLength = polylineLength(fixture.truth, fixture.closed);
  const retainedGuides = fixture.anchors.filter((guide) => result.path.some((point) => (
    point.anchorId === guide.anchorId && point.x === guide.x && point.y === guide.y
  ))).length;
  const steps = result.path.slice(1).map((point, index) => (
    Math.hypot(point.x - result.path[index].x, point.y - result.path[index].y)
  ));
  const diagnostics = result.parametricDiagnostics ?? {};
  const inferred = result.path.filter((point) => point.occlusionInferred);
  const patternedInferred = result.path.filter((point) => point.patternInferred);
  const expectsInference = Boolean(fixture.exclusions?.length);
  const expectsPatternInference = Boolean(fixture.pattern);
  const expectsReview = ["self-intersecting-cycle", "guided-branched-path"].includes(fixture.expectedTopology);
  const hasReview = result.path.some((point) => point.topologyReview);
  return {
    points: result.path.length,
    orientation: result.orientation,
    topology: diagnostics.topology ?? null,
    topologyCorrect: result.orientation === "parametric"
      && diagnostics.topology === fixture.expectedTopology
      && Boolean(diagnostics.closed) === fixture.closed,
    reviewFlagCorrect: hasReview === expectsReview,
    inferenceMetadataCorrect: !expectsInference || (
      inferred.length > 0
      && inferred.every((point) => (
        !point.observed
        && point.inferenceMethod === "parametric-tangent-bridge"
        && Number.isFinite(point.inferenceUncertainty)
        && point.inferenceUncertainty >= 1
      ))
    ),
    patternMetadataCorrect: !expectsPatternInference || (
      patternedInferred.length > 0
      && (diagnostics.patternedBridges ?? 0) >= 3
      && (diagnostics.patternGapConsistency ?? 0) >= 0.7
      && patternedInferred.every((point) => (
        !point.observed
        && !point.occlusionInferred
        && point.inferenceMethod === "parametric-pattern-gap"
        && point.inferenceModel === "cubic-hermite-pattern"
        && Number.isFinite(point.inferenceUncertainty)
        && point.inferenceUncertainty >= 1
      ))
    ),
    inferredFraction: inferred.length / Math.max(1, result.path.length),
    patternInferredFraction: patternedInferred.length / Math.max(1, result.path.length),
    rmsePx: Math.sqrt(mean(outputErrors.map((error) => error ** 2))),
    p95OutputErrorPx: percentile(outputErrors, 0.95),
    p95TruthErrorPx: percentile(truthErrors, 0.95),
    coverageRate: truthErrors.filter((error) => error <= 2.5).length / Math.max(1, truthErrors.length),
    lengthRatio: outputLength / Math.max(1, truthLength),
    absoluteLengthRatioError: Math.abs(outputLength / Math.max(1, truthLength) - 1),
    guideRetentionRate: retainedGuides / Math.max(1, fixture.anchors.length),
    maximumStepPx: Math.max(0, ...steps),
    elapsedMs: result.elapsedMs,
  };
}

function benchmarkParametricCurves() {
  const results = createParametricFixtures().map((fixture) => ({
    fixture: fixture.id,
    category: fixture.category,
    score: scoreParametricFixture(fixture, traceParametricFixture(fixture)),
  }));
  const degraded = results.filter((entry) => entry.category === "parametric-degraded");
  const patterned = results.filter((entry) => entry.category === "parametric-patterned");
  return {
    fixtures: results.length,
    automaticFixtures: results.filter((entry) => entry.fixture.endsWith("-auto")).length,
    inferredFixtures: results.filter((entry) => entry.category === "parametric-occlusion").length,
    degradedFixtures: degraded.length,
    patternedFixtures: patterned.length,
    meanRmsePx: mean(results.map((entry) => entry.score.rmsePx)),
    p95SeriesRmsePx: percentile(results.map((entry) => entry.score.rmsePx), 0.95),
    meanCoverageRate: mean(results.map((entry) => entry.score.coverageRate)),
    minimumCoverageRate: Math.min(...results.map((entry) => entry.score.coverageRate)),
    meanAbsoluteLengthRatioError: mean(results.map((entry) => entry.score.absoluteLengthRatioError)),
    topologyAccuracy: results.filter((entry) => entry.score.topologyCorrect).length / results.length,
    reviewFlagAccuracy: results.filter((entry) => entry.score.reviewFlagCorrect).length / results.length,
    inferenceMetadataRate: results.filter((entry) => entry.score.inferenceMetadataCorrect).length / results.length,
    degradedTopologyAccuracy: degraded.filter((entry) => entry.score.topologyCorrect).length / Math.max(1, degraded.length),
    degradedMeanCoverageRate: mean(degraded.map((entry) => entry.score.coverageRate)),
    degradedP95SeriesRmsePx: percentile(degraded.map((entry) => entry.score.rmsePx), 0.95),
    patternedTopologyAccuracy: patterned.filter((entry) => entry.score.topologyCorrect).length
      / Math.max(1, patterned.length),
    patternedMeanCoverageRate: mean(patterned.map((entry) => entry.score.coverageRate)),
    patternedP95SeriesRmsePx: percentile(patterned.map((entry) => entry.score.rmsePx), 0.95),
    patternMetadataRate: patterned.filter((entry) => entry.score.patternMetadataCorrect).length
      / Math.max(1, patterned.length),
    guideRetentionRate: mean(results.map((entry) => entry.score.guideRetentionRate)),
    maximumStepPx: Math.max(...results.map((entry) => entry.score.maximumStepPx)),
    medianElapsedMs: percentile(results.map((entry) => entry.score.elapsedMs), 0.5),
    results,
  };
}

function interpolateTruth(points, x) {
  if (!points?.length) return Number.NaN;
  if (x <= points[0].x) return points[0].y;
  if (x >= points.at(-1).x) return points.at(-1).y;
  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].x <= x) low = middle;
    else high = middle;
  }
  const fraction = (x - points[low].x) / Math.max(1e-12, points[high].x - points[low].x);
  return points[low].y + fraction * (points[high].y - points[low].y);
}

function pointAtFraction(points, fraction) {
  return points[Math.round(Math.max(0, Math.min(1, fraction)) * (points.length - 1))];
}

function uniqueAnchors(points) {
  return points.filter((point, index) => (
    index === 0 || Math.round(point.x) !== Math.round(points[index - 1].x)
  ));
}

function seedForFixture(fixture) {
  const truth = fixture.target.kind === "markers" ? fixture.target.markerTruth : fixture.target.truth;
  const preferred = pointAtFraction(truth, fixture.target.seedFraction);
  if (fixture.target.kind === "markers") return { ...preferred };

  const expectedColor = {
    r: fixture.target.color[0],
    g: fixture.target.color[1],
    b: fixture.target.color[2],
  };
  let best = { point: preferred, score: Infinity };
  for (let index = 4; index < truth.length - 4; index += 2) {
    const point = truth[index];
    const sampled = sampleRepresentativeColor(fixture.rgba, fixture.width, fixture.height, point);
    const colorError = compositedColorDistance(sampled.r, sampled.g, sampled.b, expectedColor);
    const fraction = index / Math.max(1, truth.length - 1);
    const preferencePenalty = Math.abs(fraction - fixture.target.seedFraction) * 10;
    const nearestDistractor = Math.min(
      Infinity,
      ...fixture.distractors.map((distractor) => (
        Math.abs(point.y - interpolateTruth(distractor, point.x))
      )),
    );
    const crossingPenalty = Math.max(0, 10 - nearestDistractor) * 1.5;
    const score = colorError + preferencePenalty + crossingPenalty;
    if (score < best.score) best = { point, score };
  }
  return { ...best.point };
}

function anchorsFor(fixture, protocolName, seed = seedForFixture(fixture)) {
  const truth = fixture.target.kind === "markers" ? fixture.target.markerTruth : fixture.target.truth;
  if (protocolName === "oneClick") return [{ ...seed }];
  if (protocolName === "oneGuide") {
    const farFraction = fixture.target.seedFraction < 0.5 ? 0.92 : 0.08;
    return uniqueAnchors([{ ...seed }, { ...pointAtFraction(truth, farFraction) }].sort((a, b) => a.x - b.x));
  }
  return uniqueAnchors([
    { ...seed },
    ...fixture.target.guideFractions.map((fraction) => ({ ...pointAtFraction(truth, fraction) })),
  ].sort((a, b) => a.x - b.x));
}

function spanFraction(path, truth) {
  if (!path.length || !truth.length) return 0;
  const actual = Math.max(...path.map((point) => point.x)) - Math.min(...path.map((point) => point.x));
  const expected = truth.at(-1).x - truth[0].x;
  return Math.min(1, actual / Math.max(1, expected));
}

function traceLineFixture(fixture, protocolName, { exclusions = [] } = {}) {
  const seed = seedForFixture(fixture);
  const anchors = anchorsFor(fixture, protocolName, seed);
  const target = sampleRepresentativeColor(
    fixture.rgba,
    fixture.width,
    fixture.height,
    seed,
  );
  const threshold = estimateColorThreshold(
    fixture.rgba,
    fixture.width,
    fixture.height,
    seed,
    target,
  );
  const diagnosis = inferLineStyle({
    rgba: fixture.rgba,
    width: fixture.width,
    height: fixture.height,
    rect: fixture.plotRect,
    seed,
    target,
    threshold,
  });
  let targetStyle = diagnosis.style;
  if (fixture.target.expectedStyle === "noisy") targetStyle = "noisy";
  const options = {
    rgba: fixture.rgba,
    width: fixture.width,
    height: fixture.height,
    rect: fixture.plotRect,
    anchors,
    target,
    threshold,
    maxJump: 16,
    maxGap: 30,
    targetStyle,
    exclusions,
  };
  const started = performance.now();
  let path = traceCurveThroughAnchors(options);
  const horizontalSpan = spanFraction(path, fixture.target.truth);
  if (["dashed", "dashdot", "dotted"].includes(targetStyle)
    && (horizontalSpan < 0.72 || diagnosis.confidence <= 0.65)) {
    const ordinary = traceCurveThroughAnchors({ ...options, targetStyle: "line" });
    if (preferOrdinaryTraceFallback(path, ordinary, fixture.plotRect, {
      autoConfidence: diagnosis.confidence,
    })) {
      path = ordinary;
      targetStyle = "line";
    }
  }
  path = refinePathCenterline({ ...options, path, iterations: 2 });
  path = fitInferredPathGaps(path, { rect: fixture.plotRect });
  const elapsedMs = performance.now() - started;
  return { path, target, threshold, inferredStyle: targetStyle, styleConfidence: diagnosis.confidence, elapsedMs };
}

function scoreLine(fixture, trace) {
  const errors = trace.path.map((point) => Math.abs(point.y - interpolateTruth(fixture.target.truth, point.x)));
  const squaredErrors = errors.map((error) => error ** 2);
  const rmsePx = Math.sqrt(mean(squaredErrors));
  const coverage = spanFraction(trace.path, fixture.target.truth);
  let wrongBranchPoints = 0;
  for (const point of trace.path) {
    const targetError = Math.abs(point.y - interpolateTruth(fixture.target.truth, point.x));
    const closestDistractor = Math.min(
      Infinity,
      ...fixture.distractors.map((truth) => Math.abs(point.y - interpolateTruth(truth, point.x))),
    );
    if (targetError > 3 && closestDistractor + 1 < targetError) wrongBranchPoints += 1;
  }
  const wrongBranchFraction = wrongBranchPoints / Math.max(1, trace.path.length);
  const nrmse = rmsePx / fixture.plotRect.height + Math.max(0, 1 - coverage) * 0.25;
  return {
    points: trace.path.length,
    rmsePx,
    medianAbsErrorPx: percentile(errors, 0.5),
    p95AbsErrorPx: percentile(errors, 0.95),
    maximumAbsErrorPx: Math.max(0, ...errors),
    nrmse,
    spanFraction: coverage,
    observedFraction: trace.path.filter((point) => point.observed).length / Math.max(1, trace.path.length),
    wrongBranchFraction,
    wrongBranch: wrongBranchFraction > 0.08,
    elapsedMs: trace.elapsedMs,
    inferredStyle: trace.inferredStyle,
    expectedStyle: fixture.target.expectedStyle,
    styleCorrect: trace.inferredStyle === fixture.target.expectedStyle
      || (fixture.target.expectedStyle === "noisy" && trace.inferredStyle === "noisy"),
    sampledColorError: compositedColorDistance(
      trace.target.r,
      trace.target.g,
      trace.target.b,
      { r: fixture.target.color[0], g: fixture.target.color[1], b: fixture.target.color[2] },
    ),
    threshold: trace.threshold,
  };
}

function ordinaryComputePayload(fixture) {
  const seed = seedForFixture(fixture);
  const target = sampleRepresentativeColor(fixture.rgba, fixture.width, fixture.height, seed);
  const threshold = estimateColorThreshold(fixture.rgba, fixture.width, fixture.height, seed, target);
  return {
    image: { rgba: fixture.rgba, width: fixture.width, height: fixture.height },
    payload: {
      rect: fixture.plotRect,
      anchors: [{ ...seed, anchorId: "benchmark-seed" }],
      target,
      threshold,
      exclusions: [],
      strictGuideCorridor: false,
      avoidPaths: [],
      avoidanceRadius: 2.5,
      inclusionMask: null,
      maxJump: 16,
      maxGap: 30,
      targetStyle: "line",
      refinementMode: "full",
    },
  };
}

function equivalentOrdinaryPath(automatic, horizontal) {
  if (automatic.orientation !== "horizontal" || horizontal.orientation !== "horizontal") return false;
  if (automatic.path.length !== horizontal.path.length || automatic.targetStyle !== horizontal.targetStyle) return false;
  return automatic.path.every((point, index) => {
    const expected = horizontal.path[index];
    return Math.abs(point.x - expected.x) < 1e-9
      && Math.abs(point.y - expected.y) < 1e-9
      && point.observed === expected.observed
      && point.confidence === expected.confidence;
  });
}

function benchmarkOrdinaryFastPath(fixtures) {
  const ordinary = fixtures.filter((fixture) => (
    fixture.target.kind === "line" && fixture.difficulty === "ordinary"
  ));
  const results = ordinary.map((fixture, fixtureIndex) => {
    const { image, payload } = ordinaryComputePayload(fixture);
    const run = (orientationMode) => {
      const started = performance.now();
      const result = runComputeOperation("trace-line", { ...payload, orientationMode }, image);
      return { result, elapsedMs: performance.now() - started };
    };
    // Warm both branches before measurement so parsing, allocation pools and
    // JIT compilation do not masquerade as an automatic-selection slowdown.
    for (let warmup = 0; warmup < 2; warmup += 1) {
      run("horizontal");
      run("auto");
    }
    const automaticTimes = [];
    const horizontalTimes = [];
    let automaticResult;
    let horizontalResult;
    for (let iteration = 0; iteration < 9; iteration += 1) {
      const autoFirst = (fixtureIndex + iteration) % 2 === 0;
      if (autoFirst) {
        const automatic = run("auto");
        const horizontal = run("horizontal");
        automaticTimes.push(automatic.elapsedMs);
        horizontalTimes.push(horizontal.elapsedMs);
        automaticResult = automatic.result;
        horizontalResult = horizontal.result;
      } else {
        const horizontal = run("horizontal");
        const automatic = run("auto");
        horizontalTimes.push(horizontal.elapsedMs);
        automaticTimes.push(automatic.elapsedMs);
        horizontalResult = horizontal.result;
        automaticResult = automatic.result;
      }
    }
    const medianAutoElapsedMs = percentile(automaticTimes, 0.5);
    const medianHorizontalElapsedMs = percentile(horizontalTimes, 0.5);
    return {
      fixture: fixture.id,
      equivalent: equivalentOrdinaryPath(automaticResult, horizontalResult),
      medianAutoElapsedMs,
      medianHorizontalElapsedMs,
      slowdownRatio: medianAutoElapsedMs / Math.max(0.01, medianHorizontalElapsedMs),
    };
  });
  return {
    fixtures: results.length,
    warmupRunsPerMode: 2,
    measuredRunsPerMode: 9,
    equivalentRate: results.filter((result) => result.equivalent).length / Math.max(1, results.length),
    medianAutoElapsedMs: percentile(results.map((result) => result.medianAutoElapsedMs), 0.5),
    medianHorizontalElapsedMs: percentile(results.map((result) => result.medianHorizontalElapsedMs), 0.5),
    medianSlowdownRatio: percentile(results.map((result) => result.slowdownRatio), 0.5),
    p95SlowdownRatio: percentile(results.map((result) => result.slowdownRatio), 0.95),
    results,
  };
}

function scoreMarkers(detected, truth, plotRect, elapsedMs) {
  const claimed = new Set();
  const distances = [];
  for (const expected of truth) {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    detected.forEach((candidate, index) => {
      if (claimed.has(index)) return;
      const distance = Math.hypot(candidate.x - expected.x, candidate.y - expected.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });
    if (nearestIndex >= 0 && nearestDistance <= 8) {
      claimed.add(nearestIndex);
      distances.push(nearestDistance);
    }
  }
  const precision = claimed.size / Math.max(1, detected.length);
  const recall = claimed.size / truth.length;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return {
    points: detected.length,
    expectedPoints: truth.length,
    matchedPoints: claimed.size,
    precision,
    recall,
    f1,
    rmsePx: distances.length ? Math.sqrt(mean(distances.map((distance) => distance ** 2))) : plotRect.height,
    elapsedMs,
  };
}

function traceMarkerFixture(fixture, protocolName) {
  const seed = seedForFixture(fixture);
  const anchors = anchorsFor(fixture, protocolName, seed);
  const target = sampleRepresentativeColor(fixture.rgba, fixture.width, fixture.height, seed);
  const threshold = estimateColorThreshold(fixture.rgba, fixture.width, fixture.height, seed, target);
  const started = performance.now();
  const detected = protocolName === "oneClick"
    ? inferMarkerSeries({
      rgba: fixture.rgba,
      width: fixture.width,
      height: fixture.height,
      rect: fixture.plotRect,
      seed,
      target,
      threshold,
    }).markers
    : extractMarkerCenters({
      rgba: fixture.rgba,
      width: fixture.width,
      height: fixture.height,
      rect: fixture.plotRect,
      anchors,
      target,
      threshold,
      strictGuideCorridor: anchors.length >= 4,
    });
  return scoreMarkers(detected, fixture.target.markerTruth, fixture.plotRect, performance.now() - started);
}

function classifyMarkerFixture(fixture) {
  const seed = seedForFixture(fixture);
  const target = sampleRepresentativeColor(fixture.rgba, fixture.width, fixture.height, seed);
  const threshold = estimateColorThreshold(fixture.rgba, fixture.width, fixture.height, seed, target);
  const started = performance.now();
  const inference = inferMarkerSeries({
    rgba: fixture.rgba,
    width: fixture.width,
    height: fixture.height,
    rect: fixture.plotRect,
    seed,
    target,
    threshold,
  });
  return {
    detected: inference.detected,
    confidence: inference.confidence,
    reason: inference.reason,
    evidence: inference.evidence ?? null,
    elapsedMs: performance.now() - started,
    markerScore: fixture.target.kind === "markers"
      ? scoreMarkers(inference.markers, fixture.target.markerTruth, fixture.plotRect, 0)
      : null,
  };
}

function discoverFixtureColors(fixture) {
  const started = performance.now();
  const suggestions = discoverColoredSeries({
    rgba: fixture.rgba,
    width: fixture.width,
    height: fixture.height,
    plotRect: fixture.plotRect,
  });
  const elapsedMs = performance.now() - started;
  const target = {
    r: fixture.target.color[0],
    g: fixture.target.color[1],
    b: fixture.target.color[2],
  };
  const ranked = suggestions.map((suggestion) => ({
    ...suggestion,
    targetColorError: compositedColorDistance(
      suggestion.color.r,
      suggestion.color.g,
      suggestion.color.b,
      target,
    ),
  })).sort((left, right) => left.targetColorError - right.targetColorError);
  const matched = fixture.target.kind === "line" && ranked[0]?.targetColorError <= 65;
  return {
    suggestions: suggestions.length,
    matched,
    targetColorError: matched ? ranked[0].targetColorError : null,
    bestConfidence: suggestions[0]?.confidence ?? 0,
    elapsedMs,
  };
}

function summarizeLineResults(results) {
  const nrmse = results.map((result) => result.score.nrmse);
  const rmse = results.map((result) => result.score.rmsePx);
  const p95Errors = results.map((result) => result.score.p95AbsErrorPx);
  const elapsed = results.map((result) => result.score.elapsedMs);
  return {
    series: results.length,
    meanNRMSE: mean(nrmse),
    medianNRMSE: percentile(nrmse, 0.5),
    p95NRMSE: percentile(nrmse, 0.95),
    meanRmsePx: mean(rmse),
    p95SeriesRmsePx: percentile(rmse, 0.95),
    p95AbsErrorPx: percentile(p95Errors, 0.95),
    fullSpanRate: results.filter((result) => result.score.spanFraction >= 0.95).length / results.length,
    belowTwoPercent: results.filter((result) => result.score.nrmse <= 0.02).length / results.length,
    wrongBranchRate: results.filter((result) => result.score.wrongBranch).length / results.length,
    meanObservedFraction: mean(results.map((result) => result.score.observedFraction)),
    styleAccuracy: results.filter((result) => result.score.styleCorrect).length / results.length,
    medianElapsedMs: percentile(elapsed, 0.5),
    p95ElapsedMs: percentile(elapsed, 0.95),
  };
}

function summarizeMarkerResults(results) {
  return {
    series: results.length,
    meanPrecision: mean(results.map((result) => result.score.precision)),
    meanRecall: mean(results.map((result) => result.score.recall)),
    meanF1: mean(results.map((result) => result.score.f1)),
    p95RmsePx: percentile(results.map((result) => result.score.rmsePx), 0.95),
    medianElapsedMs: percentile(results.map((result) => result.score.elapsedMs), 0.5),
  };
}

function rectangleIoU(left, right) {
  if (!left || !right) return 0;
  const intersectionWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left) + 1);
  const intersectionHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) + 1);
  const intersection = intersectionWidth * intersectionHeight;
  return intersection / Math.max(1, left.width * left.height + right.width * right.height - intersection);
}

function polygonMatchError(actual, expected) {
  if (!actual?.length || actual.length !== expected.length) return Infinity;
  const candidates = [];
  for (const reversed of [false, true]) {
    const ordered = reversed ? [...actual].reverse() : [...actual];
    for (let offset = 0; offset < ordered.length; offset += 1) {
      candidates.push(mean(expected.map((point, index) => {
        const candidate = ordered[(index + offset) % ordered.length];
        return Math.hypot(point.x - candidate.x, point.y - candidate.y);
      })));
    }
  }
  return Math.min(...candidates);
}

function benchmarkGeometry() {
  const fixtures = createGeometryFixtures();
  const skew = fixtures.skew.map((fixture) => {
    const result = estimateAxisSkew(fixture);
    return {
      id: fixture.id,
      expectedDegrees: fixture.angleDegrees,
      estimatedDegrees: result.angleDegrees,
      absoluteErrorDegrees: Math.abs(result.angleDegrees - fixture.angleDegrees),
      confidence: result.confidence,
    };
  });
  const perspective = fixtures.perspective.map((fixture) => {
    const result = detectPerspectiveFrame(fixture);
    const detectedCorners = result ? [
      result.corners.topLeft,
      result.corners.topRight,
      result.corners.bottomRight,
      result.corners.bottomLeft,
    ] : null;
    return {
      id: fixture.id,
      detected: Boolean(result),
      meanCornerErrorPx: result ? polygonMatchError(detectedCorners, fixture.corners) : Infinity,
      confidence: result?.confidence ?? 0,
      perspectivePixels: result?.perspectivePixels ?? 0,
    };
  });
  return {
    skew: {
      cases: skew.length,
      meanAbsoluteErrorDegrees: mean(skew.map((result) => result.absoluteErrorDegrees)),
      maximumAbsoluteErrorDegrees: Math.max(...skew.map((result) => result.absoluteErrorDegrees)),
      minimumConfidence: Math.min(...skew.map((result) => result.confidence)),
      results: skew,
    },
    perspective: {
      cases: perspective.length,
      detectionRate: perspective.filter((result) => result.detected).length / perspective.length,
      meanCornerErrorPx: mean(perspective.map((result) => result.meanCornerErrorPx)),
      minimumConfidence: Math.min(...perspective.map((result) => result.confidence)),
      results: perspective,
    },
  };
}

export function runAccuracyBenchmark() {
  const fixtures = createAccuracyFixtures();
  const plotResults = fixtures.map((fixture) => {
    const detected = detectPlotRect(fixture.rgba, fixture.width, fixture.height);
    return { id: fixture.id, iou: rectangleIoU(detected, fixture.plotRect) };
  });
  const protocolResults = {};
  for (const protocolName of Object.keys(PROTOCOLS)) {
    const lineResults = [];
    const markerResults = [];
    for (const fixture of fixtures) {
      if (fixture.target.kind === "markers") {
        markerResults.push({ fixture: fixture.id, category: fixture.category, score: traceMarkerFixture(fixture, protocolName) });
      } else {
        const trace = traceLineFixture(fixture, protocolName);
        lineResults.push({ fixture: fixture.id, category: fixture.category, difficulty: fixture.difficulty, score: scoreLine(fixture, trace) });
      }
    }
    const byCategory = Object.fromEntries([...new Set(lineResults.map((result) => result.category))]
      .sort()
      .map((category) => [category, summarizeLineResults(lineResults.filter((result) => result.category === category))]));
    const ordinary = lineResults.filter((result) => result.difficulty === "ordinary");
    protocolResults[protocolName] = {
      ...PROTOCOLS[protocolName],
      manualActions: PROTOCOLS[protocolName].seedClicks + PROTOCOLS[protocolName].guideClicks,
      lines: summarizeLineResults(lineResults),
      ordinaryLines: summarizeLineResults(ordinary),
      markers: summarizeMarkerResults(markerResults),
      byCategory,
      worstLines: [...lineResults]
        .sort((left, right) => right.score.nrmse - left.score.nrmse)
        .slice(0, 8),
    };
  }
  const maskedOcclusionResults = fixtures
    .filter((fixture) => fixture.target.kind === "line" && fixture.assistedExclusions.length)
    .map((fixture) => {
      const trace = traceLineFixture(fixture, "oneClick", {
        exclusions: fixture.assistedExclusions,
      });
      return {
        fixture: fixture.id,
        category: fixture.category,
        score: scoreLine(fixture, trace),
      };
    });
  const markerClassificationResults = fixtures.map((fixture) => ({
    fixture: fixture.id,
    kind: fixture.target.kind,
    result: classifyMarkerFixture(fixture),
  }));
  const markerClassificationTargets = markerClassificationResults.filter((entry) => entry.kind === "markers");
  const markerClassificationLines = markerClassificationResults.filter((entry) => entry.kind === "line");
  const colorDiscoveryResults = fixtures.map((fixture) => ({
    fixture: fixture.id,
    kind: fixture.target.kind,
    result: discoverFixtureColors(fixture),
  }));
  const coloredLineDiscovery = colorDiscoveryResults.filter((entry) => entry.kind === "line");
  return {
    schemaVersion: 4,
    extractorVersion: packageMetadata.version,
    suite: "deterministic-raster-stress-v1",
    fixtures: {
      total: fixtures.length,
      lineSeries: fixtures.filter((fixture) => fixture.target.kind === "line").length,
      markerSeries: fixtures.filter((fixture) => fixture.target.kind === "markers").length,
      categories: [...new Set(fixtures.map((fixture) => fixture.category))].sort(),
      thirdPartyImages: 0,
    },
    plotDetection: {
      cases: plotResults.length,
      meanIoU: mean(plotResults.map((result) => result.iou)),
      minimumIoU: Math.min(...plotResults.map((result) => result.iou)),
      results: plotResults,
    },
    protocols: protocolResults,
    automaticMarkerDetection: {
      markerSeries: markerClassificationTargets.length,
      lineSeries: markerClassificationLines.length,
      detectionRate: markerClassificationTargets.filter((entry) => entry.result.detected).length
        / Math.max(1, markerClassificationTargets.length),
      lineFalsePositiveRate: markerClassificationLines.filter((entry) => entry.result.detected).length
        / Math.max(1, markerClassificationLines.length),
      meanMarkerF1: mean(markerClassificationTargets.map((entry) => entry.result.markerScore.f1)),
      medianElapsedMs: percentile(markerClassificationResults.map((entry) => entry.result.elapsedMs), 0.5),
      results: markerClassificationResults,
    },
    automaticColorDiscovery: {
      coloredLineSeries: coloredLineDiscovery.length,
      targetDiscoveryRate: coloredLineDiscovery.filter((entry) => entry.result.matched).length
        / Math.max(1, coloredLineDiscovery.length),
      meanTargetColorError: mean(coloredLineDiscovery
        .filter((entry) => entry.result.matched)
        .map((entry) => entry.result.targetColorError)),
      meanSuggestions: mean(colorDiscoveryResults.map((entry) => entry.result.suggestions)),
      medianElapsedMs: percentile(colorDiscoveryResults.map((entry) => entry.result.elapsedMs), 0.5),
      results: colorDiscoveryResults,
    },
    occlusionAssistance: {
      label: "target click + one occlusion-mask drag",
      manualActions: 2,
      lines: summarizeLineResults(maskedOcclusionResults),
      results: maskedOcclusionResults,
    },
    parametricCurves: benchmarkParametricCurves(),
    ordinaryFastPath: benchmarkOrdinaryFastPath(fixtures),
    geometry: benchmarkGeometry(),
  };
}

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

const REGRESSION_GATES = Object.freeze([
  { path: "plotDetection.meanIoU", direction: "minimum", relative: 0.995, absolute: 0.002 },
  { path: "protocols.oneClick.ordinaryLines.meanNRMSE", direction: "maximum", relative: 1.08, absolute: 0.0015 },
  { path: "protocols.oneClick.lines.meanNRMSE", direction: "maximum", relative: 1.08, absolute: 0.002 },
  { path: "protocols.oneClick.lines.p95NRMSE", direction: "maximum", relative: 1.1, absolute: 0.003 },
  { path: "protocols.oneClick.lines.fullSpanRate", direction: "minimum", relative: 0.98, absolute: 0.025 },
  { path: "protocols.oneClick.lines.wrongBranchRate", direction: "maximum", relative: 1.12, absolute: 0.025 },
  { path: "protocols.threeGuides.lines.meanNRMSE", direction: "maximum", relative: 1.08, absolute: 0.0015 },
  { path: "protocols.threeGuides.lines.p95NRMSE", direction: "maximum", relative: 1.1, absolute: 0.0025 },
  { path: "protocols.threeGuides.lines.fullSpanRate", direction: "minimum", relative: 0.99, absolute: 0.015 },
  { path: "protocols.threeGuides.lines.wrongBranchRate", direction: "maximum", relative: 1.1, absolute: 0.015 },
  {
    path: "protocols.threeGuides.byCategory.patterned-line.meanNRMSE",
    direction: "maximum",
    relative: 1.08,
    absolute: 0.0015,
    hardMaximum: 0.04,
  },
  {
    path: "protocols.threeGuides.byCategory.patterned-line.p95NRMSE",
    direction: "maximum",
    relative: 1.08,
    absolute: 0.002,
    hardMaximum: 0.065,
  },
  {
    path: "protocols.threeGuides.byCategory.patterned-line.fullSpanRate",
    direction: "minimum",
    relative: 0.99,
    absolute: 0.015,
    hardMinimum: 0.98,
  },
  {
    path: "protocols.threeGuides.byCategory.patterned-line.wrongBranchRate",
    direction: "maximum",
    relative: 1,
    absolute: 0,
    hardMaximum: 0,
  },
  { path: "protocols.threeGuides.markers.meanF1", direction: "minimum", relative: 0.97, absolute: 0.03 },
  { path: "automaticMarkerDetection.detectionRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "automaticMarkerDetection.lineFalsePositiveRate", direction: "maximum", relative: 1, absolute: 0 },
  { path: "automaticMarkerDetection.meanMarkerF1", direction: "minimum", relative: 0.98, absolute: 0.02 },
  { path: "automaticColorDiscovery.targetDiscoveryRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "automaticColorDiscovery.meanTargetColorError", direction: "maximum", relative: 1.08, absolute: 1 },
  { path: "occlusionAssistance.lines.meanNRMSE", direction: "maximum", relative: 1.1, absolute: 0.001 },
  { path: "occlusionAssistance.lines.fullSpanRate", direction: "minimum", relative: 0.99, absolute: 0.015 },
  { path: "occlusionAssistance.lines.wrongBranchRate", direction: "maximum", relative: 1.1, absolute: 0.015 },
  { path: "parametricCurves.meanRmsePx", direction: "maximum", relative: 1.08, absolute: 0.12 },
  { path: "parametricCurves.p95SeriesRmsePx", direction: "maximum", relative: 1.1, absolute: 0.18 },
  { path: "parametricCurves.minimumCoverageRate", direction: "minimum", relative: 0.99, absolute: 0.02 },
  { path: "parametricCurves.meanAbsoluteLengthRatioError", direction: "maximum", relative: 1.1, absolute: 0.025 },
  { path: "parametricCurves.topologyAccuracy", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.reviewFlagAccuracy", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.inferenceMetadataRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.degradedTopologyAccuracy", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.degradedMeanCoverageRate", direction: "minimum", relative: 0.99, absolute: 0.02 },
  { path: "parametricCurves.degradedP95SeriesRmsePx", direction: "maximum", relative: 1.1, absolute: 0.2 },
  { path: "parametricCurves.patternedTopologyAccuracy", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.patternedMeanCoverageRate", direction: "minimum", relative: 0.99, absolute: 0.02 },
  { path: "parametricCurves.patternedP95SeriesRmsePx", direction: "maximum", relative: 1.1, absolute: 0.2 },
  { path: "parametricCurves.patternMetadataRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.guideRetentionRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "parametricCurves.maximumStepPx", direction: "maximum", relative: 1.1, absolute: 0.5 },
  { path: "ordinaryFastPath.equivalentRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
  { path: "ordinaryFastPath.medianSlowdownRatio", direction: "maximum", relative: 1.12, absolute: 0.25 },
  { path: "geometry.skew.maximumAbsoluteErrorDegrees", direction: "maximum", relative: 1.1, absolute: 0.15 },
  { path: "geometry.perspective.detectionRate", direction: "minimum", relative: 0.99, absolute: 0.01 },
]);

function checkRegression(current, baseline) {
  const failures = [];
  const comparisons = REGRESSION_GATES.map((gate) => {
    const currentValue = Number(valueAt(current, gate.path));
    const baselineValue = Number(valueAt(baseline, gate.path));
    let limit;
    let passed;
    if (gate.direction === "maximum") {
      limit = Math.max(baselineValue * gate.relative, baselineValue + gate.absolute);
      if (Number.isFinite(gate.hardMaximum)) limit = Math.min(limit, gate.hardMaximum);
      passed = currentValue <= limit;
    } else {
      limit = Math.min(baselineValue * gate.relative, baselineValue - gate.absolute);
      if (Number.isFinite(gate.hardMinimum)) limit = Math.max(limit, gate.hardMinimum);
      passed = currentValue >= limit;
    }
    const comparison = { ...gate, baseline: baselineValue, current: currentValue, limit, passed };
    if (!passed) failures.push(comparison);
    return comparison;
  });
  return { passed: failures.length === 0, failures, comparisons };
}

function conciseSummary(result) {
  return {
    extractorVersion: result.extractorVersion,
    suite: result.suite,
    fixtures: result.fixtures,
    plotDetection: {
      meanIoU: result.plotDetection.meanIoU,
      minimumIoU: result.plotDetection.minimumIoU,
    },
    protocols: Object.fromEntries(Object.entries(result.protocols).map(([name, protocol]) => [name, {
      manualActions: protocol.manualActions,
      lines: protocol.lines,
      ordinaryLines: protocol.ordinaryLines,
      markers: protocol.markers,
    }])),
    occlusionAssistance: {
      manualActions: result.occlusionAssistance.manualActions,
      lines: result.occlusionAssistance.lines,
    },
    parametricCurves: {
      fixtures: result.parametricCurves.fixtures,
      automaticFixtures: result.parametricCurves.automaticFixtures,
      inferredFixtures: result.parametricCurves.inferredFixtures,
      degradedFixtures: result.parametricCurves.degradedFixtures,
      patternedFixtures: result.parametricCurves.patternedFixtures,
      meanRmsePx: result.parametricCurves.meanRmsePx,
      p95SeriesRmsePx: result.parametricCurves.p95SeriesRmsePx,
      meanCoverageRate: result.parametricCurves.meanCoverageRate,
      minimumCoverageRate: result.parametricCurves.minimumCoverageRate,
      meanAbsoluteLengthRatioError: result.parametricCurves.meanAbsoluteLengthRatioError,
      topologyAccuracy: result.parametricCurves.topologyAccuracy,
      reviewFlagAccuracy: result.parametricCurves.reviewFlagAccuracy,
      inferenceMetadataRate: result.parametricCurves.inferenceMetadataRate,
      degradedTopologyAccuracy: result.parametricCurves.degradedTopologyAccuracy,
      degradedMeanCoverageRate: result.parametricCurves.degradedMeanCoverageRate,
      degradedP95SeriesRmsePx: result.parametricCurves.degradedP95SeriesRmsePx,
      patternedTopologyAccuracy: result.parametricCurves.patternedTopologyAccuracy,
      patternedMeanCoverageRate: result.parametricCurves.patternedMeanCoverageRate,
      patternedP95SeriesRmsePx: result.parametricCurves.patternedP95SeriesRmsePx,
      patternMetadataRate: result.parametricCurves.patternMetadataRate,
      guideRetentionRate: result.parametricCurves.guideRetentionRate,
      maximumStepPx: result.parametricCurves.maximumStepPx,
      medianElapsedMs: result.parametricCurves.medianElapsedMs,
    },
    ordinaryFastPath: {
      fixtures: result.ordinaryFastPath.fixtures,
      warmupRunsPerMode: result.ordinaryFastPath.warmupRunsPerMode,
      measuredRunsPerMode: result.ordinaryFastPath.measuredRunsPerMode,
      equivalentRate: result.ordinaryFastPath.equivalentRate,
      medianAutoElapsedMs: result.ordinaryFastPath.medianAutoElapsedMs,
      medianHorizontalElapsedMs: result.ordinaryFastPath.medianHorizontalElapsedMs,
      medianSlowdownRatio: result.ordinaryFastPath.medianSlowdownRatio,
      p95SlowdownRatio: result.ordinaryFastPath.p95SlowdownRatio,
    },
    automaticColorDiscovery: {
      coloredLineSeries: result.automaticColorDiscovery.coloredLineSeries,
      targetDiscoveryRate: result.automaticColorDiscovery.targetDiscoveryRate,
      meanTargetColorError: result.automaticColorDiscovery.meanTargetColorError,
      meanSuggestions: result.automaticColorDiscovery.meanSuggestions,
      medianElapsedMs: result.automaticColorDiscovery.medianElapsedMs,
    },
    geometry: {
      skew: {
        meanAbsoluteErrorDegrees: result.geometry.skew.meanAbsoluteErrorDegrees,
        maximumAbsoluteErrorDegrees: result.geometry.skew.maximumAbsoluteErrorDegrees,
        minimumConfidence: result.geometry.skew.minimumConfidence,
      },
      perspective: {
        detectionRate: result.geometry.perspective.detectionRate,
        meanCornerErrorPx: result.geometry.perspective.meanCornerErrorPx,
        minimumConfidence: result.geometry.perspective.minimumConfidence,
      },
    },
  };
}

function parseArguments(arguments_) {
  const options = { json: false, write: null, check: null };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = arguments_[index += 1];
    else if (argument === "--check") options.check = arguments_[index += 1] ?? DEFAULT_BASELINE;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const result = runAccuracyBenchmark();
if (options.write) {
  writeFileSync(options.write, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Updated accuracy baseline: ${options.write}`);
}
if (options.check) {
  const baseline = JSON.parse(readFileSync(options.check, "utf8"));
  const regression = checkRegression(result, baseline);
  if (!regression.passed) {
    console.error(JSON.stringify({ status: "regression", failures: regression.failures }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(`Accuracy regression gates passed (${regression.comparisons.length} metrics).`);
  }
}
if (!options.write || options.json) console.log(JSON.stringify(options.json ? result : conciseSummary(result), null, 2));
