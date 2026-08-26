import { clamp } from "./core.js";

// Image orientation and perspective correction only; coordinate calibration remains manual.

function luminanceAt(rgba, width, x, y) {
  const index = (y * width + x) * 4;
  return 0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2];
}

function isDark(rgba, width, height, x, y, threshold) {
  if (x < 0 || x >= width || y < 0 || y >= height) return false;
  const index = (y * width + x) * 4;
  return rgba[index + 3] >= 32 && luminanceAt(rgba, width, x, y) <= threshold;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function topProjectionScore(histogram, requiredLength, darkCount) {
  const peaks = Array.from(histogram).sort((left, right) => right - left).slice(0, 8);
  if (!peaks.length || !darkCount) return 0;
  const longLineEvidence = peaks.reduce((sum, peak) => sum + Math.max(0, peak - requiredLength * 0.08) ** 2, 0);
  return longLineEvidence / Math.max(1, darkCount * requiredLength);
}

/** Estimate the common angle of long horizontal and vertical chart lines. */
export function estimateAxisSkew({
  rgba,
  width,
  height,
  darkThreshold = 125,
  maximumDegrees = 10,
  stepDegrees = 0.25,
} = {}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("Skew estimation requires matching RGBA dimensions");
  }
  const sampleStep = Math.max(1, Math.ceil(Math.max(width, height) / 900));
  const points = [];
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      if (isDark(rgba, width, height, x, y, darkThreshold)) points.push({ x, y });
    }
  }
  if (points.length < 80) return { angleDegrees: 0, confidence: 0, reason: "insufficient-ink" };
  const scores = [];
  for (let angle = -maximumDegrees; angle <= maximumDegrees + 1e-8; angle += stepDegrees) {
    const tangent = Math.tan(angle * Math.PI / 180);
    const rowHistogram = new Uint32Array(height + Math.ceil(Math.abs(tangent) * width) + 6);
    const columnHistogram = new Uint32Array(width + Math.ceil(Math.abs(tangent) * height) + 6);
    const rowOffset = tangent > 0 ? Math.ceil(tangent * width) + 2 : 2;
    const columnOffset = tangent < 0 ? Math.ceil(-tangent * height) + 2 : 2;
    for (const point of points) {
      const row = Math.round(point.y - tangent * point.x) + rowOffset;
      const column = Math.round(point.x + tangent * point.y) + columnOffset;
      if (row >= 0 && row < rowHistogram.length) rowHistogram[row] += 1;
      if (column >= 0 && column < columnHistogram.length) columnHistogram[column] += 1;
    }
    const horizontalScore = topProjectionScore(rowHistogram, width / sampleStep, points.length);
    const verticalScore = topProjectionScore(columnHistogram, height / sampleStep, points.length);
    scores.push({ angleDegrees: angle, score: horizontalScore + verticalScore });
  }
  scores.sort((left, right) => right.score - left.score);
  const best = scores[0];
  const distant = scores.filter((candidate) => Math.abs(candidate.angleDegrees - best.angleDegrees) >= 1.5);
  const runnerUp = distant[0] ?? scores[1] ?? { score: 0 };
  const separation = best.score > 0 ? (best.score - runnerUp.score) / best.score : 0;
  const strength = clamp(best.score / 0.7, 0, 1);
  const confidence = clamp(separation * 1.8, 0, 1) * strength;
  return {
    angleDegrees: Number(best.angleDegrees.toFixed(3)),
    confidence,
    score: best.score,
    separation,
    sampledInk: points.length,
  };
}

function robustLine(points, dependent) {
  if (points.length < 8) return null;
  let retained = points;
  let model = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const xs = retained.map((point) => point[dependent === "y" ? "x" : "y"]);
    const ys = retained.map((point) => point[dependent]);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const denominator = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
    const slope = denominator > 0
      ? retained.reduce((sum, point, index) => sum + (xs[index] - meanX) * (ys[index] - meanY), 0) / denominator
      : 0;
    const intercept = meanY - slope * meanX;
    const residuals = retained.map((point) => Math.abs(point[dependent] - (slope * point[dependent === "y" ? "x" : "y"] + intercept)));
    const residual = median(residuals) ?? Infinity;
    model = { slope, intercept, residual, count: retained.length };
    const tolerance = Math.max(1.25, residual * 3.5);
    retained = retained.filter((point) => (
      Math.abs(point[dependent] - (slope * point[dependent === "y" ? "x" : "y"] + intercept)) <= tolerance
    ));
  }
  return model;
}

function borderSamples(rgba, width, height, rect, edge, darkThreshold, band) {
  const horizontal = edge === "top" || edge === "bottom";
  const approximate = rect[edge] + (edge === "top" || edge === "left" ? -1 : 1);
  const start = horizontal ? rect.left : rect.top;
  const end = horizontal ? rect.right : rect.bottom;
  const trim = Math.round((end - start) * 0.035);
  const samples = [];
  for (let along = start + trim; along <= end - trim; along += 2) {
    let best = null;
    for (let offset = -band; offset <= band; offset += 1) {
      const x = horizontal ? along : Math.round(approximate + offset);
      const y = horizontal ? Math.round(approximate + offset) : along;
      if (!isDark(rgba, width, height, x, y, darkThreshold)) continue;
      const darkness = 255 - luminanceAt(rgba, width, x, y);
      if (!best || darkness > best.darkness) best = { x, y, darkness };
    }
    if (best) samples.push(best);
  }
  return samples;
}

function lineIntersection(horizontal, vertical) {
  const denominator = 1 - horizontal.slope * vertical.slope;
  if (Math.abs(denominator) < 1e-6) return null;
  const x = (vertical.slope * horizontal.intercept + vertical.intercept) / denominator;
  return { x, y: horizontal.slope * x + horizontal.intercept };
}

/** Diagnose a four-sided plot frame that is no longer rectangular. */
export function detectFrameQuadrilateral({ rgba, width, height, rect, darkThreshold = 145, band = 8 } = {}) {
  if (!rgba || rgba.length !== width * height * 4 || !rect) return null;
  const topSamples = borderSamples(rgba, width, height, rect, "top", darkThreshold, band);
  const bottomSamples = borderSamples(rgba, width, height, rect, "bottom", darkThreshold, band);
  const leftSamples = borderSamples(rgba, width, height, rect, "left", darkThreshold, band);
  const rightSamples = borderSamples(rgba, width, height, rect, "right", darkThreshold, band);
  const top = robustLine(topSamples, "y");
  const bottom = robustLine(bottomSamples, "y");
  const left = robustLine(leftSamples, "x");
  const right = robustLine(rightSamples, "x");
  if (!top || !bottom || !left || !right) return null;
  const corners = {
    topLeft: lineIntersection(top, left),
    topRight: lineIntersection(top, right),
    bottomRight: lineIntersection(bottom, right),
    bottomLeft: lineIntersection(bottom, left),
  };
  if (Object.values(corners).some((corner) => !corner || !Number.isFinite(corner.x) || !Number.isFinite(corner.y))) return null;
  const expectedCounts = [rect.width / 2, rect.width / 2, rect.height / 2, rect.height / 2];
  const models = [top, bottom, left, right];
  const coverage = models.reduce((sum, model, index) => sum + clamp(model.count / expectedCounts[index], 0, 1), 0) / 4;
  const residual = models.reduce((sum, model) => sum + model.residual, 0) / 4;
  const perspectivePixels = Math.max(
    Math.abs((corners.topRight.y - corners.topLeft.y) - (corners.bottomRight.y - corners.bottomLeft.y)),
    Math.abs((corners.bottomLeft.x - corners.topLeft.x) - (corners.bottomRight.x - corners.topRight.x)),
  );
  const severity = perspectivePixels / Math.max(1, Math.min(rect.width, rect.height));
  const confidence = clamp(coverage * 0.75 + (1 - clamp(residual / 3, 0, 1)) * 0.25, 0, 1);
  return { corners, lines: { top, bottom, left, right }, coverage, residual, perspectivePixels, severity, confidence };
}

function houghFrameLines(rgba, width, height, orientation, darkThreshold = 135) {
  const sampleStep = Math.max(1, Math.ceil(Math.max(width, height) / 900));
  const points = [];
  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      if (isDark(rgba, width, height, x, y, darkThreshold)) points.push({ x, y });
    }
  }
  const expectedLength = (orientation === "horizontal" ? width : height) / sampleStep;
  const candidates = [];
  for (let angle = -12; angle <= 12.001; angle += 0.5) {
    const tangent = Math.tan(angle * Math.PI / 180);
    const histogram = new Map();
    for (const point of points) {
      const intercept = orientation === "horizontal"
        ? Math.round(point.y - tangent * point.x)
        : Math.round(point.x + tangent * point.y);
      histogram.set(intercept, (histogram.get(intercept) ?? 0) + 1);
    }
    for (const [intercept, count] of histogram) {
      const coverage = count / Math.max(1, expectedLength);
      if (coverage < 0.24) continue;
      candidates.push({
        orientation,
        angle,
        slope: orientation === "horizontal" ? tangent : -tangent,
        intercept,
        coverage,
        count,
      });
    }
  }
  candidates.sort((left, right) => right.coverage - left.coverage);
  const selected = [];
  for (const candidate of candidates) {
    const center = orientation === "horizontal"
      ? candidate.slope * width / 2 + candidate.intercept
      : candidate.slope * height / 2 + candidate.intercept;
    if (selected.some((existing) => {
      const existingCenter = orientation === "horizontal"
        ? existing.slope * width / 2 + existing.intercept
        : existing.slope * height / 2 + existing.intercept;
      return Math.abs(existingCenter - center) < 5 && Math.abs(existing.angle - candidate.angle) < 1.5;
    })) continue;
    selected.push(candidate);
    if (selected.length >= 18) break;
  }
  return selected;
}

/** Find a strongly outlined trapezoidal plot even when rectangular projection detection fails. */
export function detectPerspectiveFrame({ rgba, width, height, darkThreshold = 135 } = {}) {
  if (!rgba || rgba.length !== width * height * 4) return null;
  const horizontal = houghFrameLines(rgba, width, height, "horizontal", darkThreshold)
    .sort((left, right) => (
      left.slope * width / 2 + left.intercept - (right.slope * width / 2 + right.intercept)
    ));
  const vertical = houghFrameLines(rgba, width, height, "vertical", darkThreshold)
    .sort((left, right) => (
      left.slope * height / 2 + left.intercept - (right.slope * height / 2 + right.intercept)
    ));
  let best = null;
  for (let topIndex = 0; topIndex < horizontal.length - 1; topIndex += 1) {
    for (let bottomIndex = topIndex + 1; bottomIndex < horizontal.length; bottomIndex += 1) {
      const top = horizontal[topIndex];
      const bottom = horizontal[bottomIndex];
      const verticalSpan = (bottom.slope * width / 2 + bottom.intercept)
        - (top.slope * width / 2 + top.intercept);
      if (verticalSpan < height * 0.12) continue;
      for (let leftIndex = 0; leftIndex < vertical.length - 1; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < vertical.length; rightIndex += 1) {
          const left = vertical[leftIndex];
          const right = vertical[rightIndex];
          const horizontalSpan = (right.slope * height / 2 + right.intercept)
            - (left.slope * height / 2 + left.intercept);
          if (horizontalSpan < width * 0.15) continue;
          const corners = {
            topLeft: lineIntersection(top, left),
            topRight: lineIntersection(top, right),
            bottomRight: lineIntersection(bottom, right),
            bottomLeft: lineIntersection(bottom, left),
          };
          if (Object.values(corners).some((corner) => (
            !corner
            || corner.x < -width * 0.05
            || corner.x > width * 1.05
            || corner.y < -height * 0.05
            || corner.y > height * 1.05
          ))) continue;
          const cornerList = Object.values(corners);
          const minimumX = Math.min(...cornerList.map((corner) => corner.x));
          const maximumX = Math.max(...cornerList.map((corner) => corner.x));
          const minimumY = Math.min(...cornerList.map((corner) => corner.y));
          const maximumY = Math.max(...cornerList.map((corner) => corner.y));
          const areaFraction = ((maximumX - minimumX) * (maximumY - minimumY)) / (width * height);
          if (areaFraction < 0.025 || areaFraction > 0.92) continue;
          const edgeCoverage = [top.coverage, bottom.coverage, left.coverage, right.coverage];
          const weakestCoverage = Math.min(...edgeCoverage);
          const meanCoverage = edgeCoverage.reduce((sum, value) => sum + value, 0) / 4;
          const score = weakestCoverage * 0.48 + meanCoverage * 0.42 + Math.sqrt(areaFraction) * 0.1;
          if (!best || score > best.score) {
            const perspectivePixels = Math.max(
              Math.abs((corners.topRight.y - corners.topLeft.y) - (corners.bottomRight.y - corners.bottomLeft.y)),
              Math.abs((corners.bottomLeft.x - corners.topLeft.x) - (corners.bottomRight.x - corners.topRight.x)),
            );
            best = {
              corners,
              lines: { top, bottom, left, right },
              coverage: meanCoverage,
              residual: 0,
              perspectivePixels,
              severity: perspectivePixels / Math.max(1, Math.min(maximumX - minimumX, maximumY - minimumY)),
              confidence: clamp(score, 0, 1),
              score,
              rect: {
                left: Math.round(minimumX) + 1,
                top: Math.round(minimumY) + 1,
                right: Math.round(maximumX) - 1,
                bottom: Math.round(maximumY) - 1,
                width: Math.max(0, Math.round(maximumX) - Math.round(minimumX) - 1),
                height: Math.max(0, Math.round(maximumY) - Math.round(minimumY) - 1),
              },
            };
          }
        }
      }
    }
  }
  return best;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = column; entry <= size; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry <= size; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

/** Return a homography mapping destination coordinates to source coordinates. */
export function destinationToSourceHomography(destinationCorners, sourceCorners) {
  if (destinationCorners.length !== 4 || sourceCorners.length !== 4) return null;
  const matrix = [];
  const vector = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = destinationCorners[index];
    const source = sourceCorners[index];
    matrix.push([x, y, 1, 0, 0, 0, -source.x * x, -source.x * y]);
    vector.push(source.x);
    matrix.push([0, 0, 0, x, y, 1, -source.y * x, -source.y * y]);
    vector.push(source.y);
  }
  const solution = solveLinearSystem(matrix, vector);
  return solution ? [...solution, 1] : null;
}

export function projectHomography(homography, point) {
  const denominator = homography[6] * point.x + homography[7] * point.y + homography[8];
  if (Math.abs(denominator) < 1e-10) return null;
  return {
    x: (homography[0] * point.x + homography[1] * point.y + homography[2]) / denominator,
    y: (homography[3] * point.x + homography[4] * point.y + homography[5]) / denominator,
  };
}

export function warpPerspectiveRgba({
  rgba,
  width,
  height,
  sourceCorners,
  destinationCorners,
  background = [255, 255, 255, 255],
} = {}) {
  if (!rgba || rgba.length !== width * height * 4) throw new Error("Perspective warp requires matching RGBA dimensions");
  const homography = destinationToSourceHomography(destinationCorners, sourceCorners);
  if (!homography) throw new Error("Perspective quadrilateral is degenerate");
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = projectHomography(homography, { x, y });
      const outputIndex = (y * width + x) * 4;
      if (!source || source.x < 0 || source.y < 0 || source.x > width - 1 || source.y > height - 1) {
        output.set(background, outputIndex);
        continue;
      }
      const x0 = Math.floor(source.x);
      const y0 = Math.floor(source.y);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = source.x - x0;
      const fy = source.y - y0;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = rgba[(y0 * width + x0) * 4 + channel] * (1 - fx)
          + rgba[(y0 * width + x1) * 4 + channel] * fx;
        const bottom = rgba[(y1 * width + x0) * 4 + channel] * (1 - fx)
          + rgba[(y1 * width + x1) * 4 + channel] * fx;
        output[outputIndex + channel] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
  return { rgba: output, width, height, homography };
}
