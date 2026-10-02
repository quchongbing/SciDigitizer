import { skeletonizeMask, buildMaskGraph } from "./mask-geometry.js?v=0.20.0-preview.3.22";

export function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function normalizeRect(start, end, bounds = null) {
  let left = Math.min(start.x, end.x);
  let right = Math.max(start.x, end.x);
  let top = Math.min(start.y, end.y);
  let bottom = Math.max(start.y, end.y);

  if (bounds) {
    left = clamp(left, 0, bounds.width - 1);
    right = clamp(right, 0, bounds.width - 1);
    top = clamp(top, 0, bounds.height - 1);
    bottom = clamp(bottom, 0, bounds.height - 1);
  }

  return {
    left: Math.round(left),
    top: Math.round(top),
    right: Math.round(right),
    bottom: Math.round(bottom),
    width: Math.max(0, Math.round(right) - Math.round(left) + 1),
    height: Math.max(0, Math.round(bottom) - Math.round(top) + 1),
  };
}

function calibrationReferencePoints(calibration) {
  const listed = Array.isArray(calibration?.points) ? calibration.points : [];
  const active = listed.filter((point) => {
    const hasPixel = point?.pixel !== null && point?.pixel !== undefined && point?.pixel !== "";
    const hasValue = point?.value !== null && point?.value !== undefined && point?.value !== "";
    return hasPixel || hasValue;
  });
  if (active.length) return active.map((point, index) => ({
    ...point,
    sourceIndex: point.sourceIndex ?? index,
  }));
  return [
    {
      pixel: calibration?.point1,
      value: calibration?.value1,
      uncertaintyPx: calibration?.uncertainty1Px,
      sourceIndex: 0,
    },
    {
      pixel: calibration?.point2,
      value: calibration?.value2,
      uncertaintyPx: calibration?.uncertainty2Px,
      sourceIndex: 1,
    },
  ];
}

function numericCalibrationPoints(calibration) {
  return calibrationReferencePoints(calibration).map((point) => ({
    ...point,
    pixel: Number(point.pixel),
    value: Number(point.value),
    uncertaintyPx: Number.isFinite(Number(point.uncertaintyPx))
      ? Math.max(0.05, Number(point.uncertaintyPx))
      : 0.5,
  }));
}

function transformedCalibrationValue(value, scale) {
  return scale === "log" ? Math.log10(value) : value;
}

/**
 * Fit a robust global axis model for Linear and Log10 calibrations. With two
 * references this is the exact historical mapping; additional references use
 * a Theil-Sen slope and median intercept so one misplaced click cannot rotate
 * the whole coordinate system silently.
 */
export function fitCalibrationModel(calibration) {
  if (!calibration || calibration.scale === "piecewise") return null;
  const points = numericCalibrationPoints(calibration);
  if (points.length < 2 || points.some((point) => (
    !Number.isFinite(point.pixel)
    || !Number.isFinite(point.value)
    || (calibration.scale === "log" && point.value <= 0)
  ))) return null;
  const transformed = points.map((point) => ({
    ...point,
    transformedValue: transformedCalibrationValue(point.value, calibration.scale),
  }));
  const slopes = [];
  for (let left = 0; left < transformed.length - 1; left += 1) {
    for (let right = left + 1; right < transformed.length; right += 1) {
      const pixelSpan = transformed[right].pixel - transformed[left].pixel;
      if (Math.abs(pixelSpan) < 1e-12) continue;
      slopes.push((transformed[right].transformedValue - transformed[left].transformedValue) / pixelSpan);
    }
  }
  const slope = median(slopes);
  if (!Number.isFinite(slope) || Math.abs(slope) < 1e-15) return null;
  const intercept = median(transformed.map((point) => point.transformedValue - slope * point.pixel));
  if (!Number.isFinite(intercept)) return null;
  const residuals = transformed.map((point) => {
    const predictedPixel = (point.transformedValue - intercept) / slope;
    return {
      index: point.sourceIndex,
      key: point.key ?? null,
      pixel: point.pixel,
      value: point.value,
      pixelResidual: point.pixel - predictedPixel,
      absolutePixelResidual: Math.abs(point.pixel - predictedPixel),
    };
  });
  const residualRmsPx = Math.sqrt(residuals.reduce(
    (sum, point) => sum + point.pixelResidual ** 2,
    0,
  ) / residuals.length);
  const residualMedian = median(residuals.map((point) => point.pixelResidual)) ?? 0;
  const robustResidualPx = 1.4826 * (median(residuals.map((point) => (
    Math.abs(point.pixelResidual - residualMedian)
  ))) ?? 0);
  const outlierThresholdPx = Math.max(0.75, robustResidualPx * 3);
  const outliers = residuals.filter((point) => point.absolutePixelResidual > outlierThresholdPx);
  return {
    scale: calibration.scale ?? "linear",
    slope,
    intercept,
    points: transformed,
    residuals,
    residualRmsPx,
    robustResidualPx,
    maximumResidualPx: Math.max(0, ...residuals.map((point) => point.absolutePixelResidual)),
    outlierThresholdPx,
    outliers,
  };
}

export function calibrationError(calibration, axisName = "坐标轴") {
  if (!calibration) return `${axisName}尚未标定`;
  const references = calibrationReferencePoints(calibration);
  const minimumPoints = calibration.scale === "piecewise" ? 3 : 2;
  const positioned = references.filter((point) => (
    point?.pixel !== null
    && point?.pixel !== undefined
    && Number.isFinite(Number(point?.pixel))
  ));
  if (positioned.length < minimumPoints || positioned.length !== references.length) {
    if (calibration.scale === "piecewise") return `${axisName}分段标定需要点击至少 3 个刻度位置`;
    return `${axisName}需要点击 2 个已知刻度位置`;
  }
  if (references.some((point) => (
    point?.value === null
    || point?.value === undefined
    || !Number.isFinite(Number(point?.value))
  ))) return `${axisName}刻度值必须是有效数字`;
  const points = references.map((point) => ({
    pixel: Number(point.pixel),
    value: Number(point.value),
  }));
  if (points.some((point) => !Number.isFinite(point.value))) return `${axisName}刻度值必须是有效数字`;
  const uniquePixels = new Set(points.map((point) => point.pixel));
  const uniqueValues = new Set(points.map((point) => point.value));
  if (uniquePixels.size !== points.length) {
    return points.length === 2
      ? `${axisName}两个刻度位置至少需要相距 1 px`
      : `${axisName}的刻度位置不能重合`;
  }
  if (uniqueValues.size !== points.length) {
    return points.length === 2
      ? `${axisName}两个端点的刻度值不能相同`
      : `${axisName}的刻度值必须互不相同`;
  }
  const ordered = [...points].sort((left, right) => left.pixel - right.pixel);
  if (Math.min(...ordered.slice(1).map((point, index) => (
    Math.abs(point.pixel - ordered[index].pixel)
  ))) < 1) {
    return points.length === 2
      ? `${axisName}两个刻度位置至少需要相距 1 px`
      : `${axisName}相邻刻度位置至少需要相距 1 px`;
  }
  const directions = ordered.slice(1).map((point, index) => (
    Math.sign(point.value - ordered[index].value)
  ));
  if (directions.some((direction) => direction !== directions[0])) {
    return `${axisName}的刻度值必须随像素位置保持单调，不能在额外参考点反向`;
  }
  if (calibration.scale === "log" && points.some((point) => point.value <= 0)) {
    return points.length === 2
      ? `${axisName}为 Log10 时，两个刻度值都必须大于 0`
      : `${axisName}为 Log10 时，所有刻度值都必须大于 0`;
  }
  if (calibration.scale !== "piecewise" && !fitCalibrationModel(calibration)) {
    return `${axisName}无法从当前参考点建立稳定映射`;
  }
  return null;
}

export function validateCalibration(calibration) {
  return calibrationError(calibration) === null;
}

/**
 * Describe how strongly pixel-placement error is amplified by a valid manual calibration.
 * This never changes calibration values and warnings are advisory rather than export blockers.
 */
export function assessCalibrationQuality(calibration, axisPixelSpan) {
  if (!validateCalibration(calibration)) return null;
  const availableSpan = Math.max(1, Number(axisPixelSpan) || 1);
  const points = numericCalibrationPoints(calibration);
  points.sort((left, right) => left.pixel - right.pixel);
  const segmentPixelSpans = points.slice(1).map((point, index) => point.pixel - points[index].pixel);
  const pixelSpan = points.at(-1).pixel - points[0].pixel;
  const spanFraction = pixelSpan / availableSpan;
  const minimumSegmentFraction = Math.min(...segmentPixelSpans) / availableSpan;
  const warnings = [];
  if (spanFraction < 0.25) {
    warnings.push(`基准只覆盖坐标轴的 ${Math.round(spanFraction * 100)}%，像素误差会被明显放大`);
  } else if (spanFraction < 0.6) {
    warnings.push(`基准覆盖坐标轴的 ${Math.round(spanFraction * 100)}%；建议选择距离更远的清晰刻度`);
  }
  if (calibration.scale === "piecewise" && minimumSegmentFraction < 0.12) {
    warnings.push("分段标定中有一段过短，建议把相邻参考点拉开");
  }

  const model = fitCalibrationModel(calibration);
  const residualRmsPx = model?.residualRmsPx ?? 0;
  const maximumResidualPx = model?.maximumResidualPx ?? 0;
  const outliers = model?.outliers ?? [];
  if (points.length > 2 && residualRmsPx > 0.45) {
    warnings.push(`多点拟合残差 RMS ${formatCalibrationNumber(residualRmsPx)} px；请检查偏离最大的参考点`);
  }
  if (outliers.length) {
    const labels = outliers.map((point) => point.key ?? `#${point.index + 1}`).join("、");
    warnings.push(`疑似异常参考点 ${labels}（最大偏差 ${formatCalibrationNumber(maximumResidualPx)} px）`);
  }

  let sensitivity;
  let sensitivityKind = "absolute";
  if (calibration.scale === "log") {
    sensitivityKind = "ratio";
    sensitivity = 10 ** (
      Math.abs(Math.log10(points.at(-1).value) - Math.log10(points[0].value)) / pixelSpan
    );
  } else {
    sensitivity = Math.max(...points.slice(1).map((point, index) => (
      Math.abs(point.value - points[index].value) / segmentPixelSpans[index]
    )));
  }
  const baseGrade = spanFraction >= 0.6 && minimumSegmentFraction >= 0.12
    ? "good"
    : spanFraction >= 0.25 ? "review" : "poor";
  const grade = maximumResidualPx > 2
    ? "poor"
    : residualRmsPx > 0.45 && baseGrade === "good" ? "review" : baseGrade;
  return {
    grade,
    referenceCount: points.length,
    pixelSpan,
    spanFraction,
    minimumSegmentFraction,
    sensitivity,
    sensitivityKind,
    residualRmsPx,
    robustResidualPx: model?.robustResidualPx ?? 0,
    maximumResidualPx,
    residuals: model?.residuals ?? [],
    outliers,
    warnings,
  };
}

function formatCalibrationNumber(value) {
  return Number(value.toFixed(value >= 10 ? 2 : 3)).toString();
}

export function pixelToValue(pixel, calibration) {
  if (!validateCalibration(calibration)) return Number.NaN;
  if (calibration.scale === "piecewise") {
    const points = numericCalibrationPoints(calibration)
      .sort((a, b) => a.pixel - b.pixel);
    let left = points[0];
    let right = points[1];
    if (pixel >= points.at(-1).pixel) {
      left = points.at(-2);
      right = points.at(-1);
    } else {
      for (let index = 1; index < points.length; index += 1) {
        if (pixel <= points[index].pixel) {
          left = points[index - 1];
          right = points[index];
          break;
        }
      }
    }
    const fraction = (pixel - left.pixel) / (right.pixel - left.pixel);
    return left.value + fraction * (right.value - left.value);
  }
  const model = fitCalibrationModel(calibration);
  if (!model) return Number.NaN;
  const transformedValue = model.intercept + model.slope * pixel;
  return calibration.scale === "log" ? 10 ** transformedValue : transformedValue;
}

export function valueToPixel(value, calibration) {
  if (!validateCalibration(calibration)) return Number.NaN;
  if (calibration.scale === "piecewise") {
    const points = numericCalibrationPoints(calibration)
      .sort((a, b) => a.value - b.value);
    let left = points[0];
    let right = points[1];
    if (value >= points.at(-1).value) {
      left = points.at(-2);
      right = points.at(-1);
    } else {
      for (let index = 1; index < points.length; index += 1) {
        if (value <= points[index].value) {
          left = points[index - 1];
          right = points[index];
          break;
        }
      }
    }
    const fraction = (value - left.value) / (right.value - left.value);
    return left.pixel + fraction * (right.pixel - left.pixel);
  }
  if (calibration.scale === "log" && value <= 0) return Number.NaN;
  const model = fitCalibrationModel(calibration);
  if (!model) return Number.NaN;
  const transformedValue = transformedCalibrationValue(Number(value), calibration.scale);
  return (transformedValue - model.intercept) / model.slope;
}

export function calibrationUncertaintyAtPixel(pixel, calibration, extraPixelSigma = 0) {
  if (!validateCalibration(calibration) || !Number.isFinite(Number(pixel))) return null;
  const coordinate = Number(pixel);
  const points = numericCalibrationPoints(calibration).sort((left, right) => left.pixel - right.pixel);
  let calibrationPixelSigma;
  let residualRmsPx = 0;
  if (calibration.scale === "piecewise") {
    let left = points[0];
    let right = points[1];
    if (coordinate >= points.at(-1).pixel) {
      left = points.at(-2);
      right = points.at(-1);
    } else {
      for (let index = 1; index < points.length; index += 1) {
        if (coordinate <= points[index].pixel) {
          left = points[index - 1];
          right = points[index];
          break;
        }
      }
    }
    const fraction = (coordinate - left.pixel) / (right.pixel - left.pixel);
    calibrationPixelSigma = Math.hypot(
      (1 - fraction) * left.uncertaintyPx,
      fraction * right.uncertaintyPx,
    );
  } else {
    const model = fitCalibrationModel(calibration);
    if (!model) return null;
    const meanPixel = points.reduce((sum, point) => sum + point.pixel, 0) / points.length;
    const squaredSpan = points.reduce((sum, point) => sum + (point.pixel - meanPixel) ** 2, 0);
    const leverage = Math.sqrt(
      1 / points.length
      + (coordinate - meanPixel) ** 2 / Math.max(1, squaredSpan),
    );
    const referenceSigma = Math.sqrt(points.reduce(
      (sum, point) => sum + point.uncertaintyPx ** 2,
      0,
    ) / points.length);
    residualRmsPx = model.residualRmsPx;
    calibrationPixelSigma = Math.hypot(referenceSigma * leverage, residualRmsPx * leverage);
  }
  const pixelSigma = Math.max(0.03, Math.hypot(
    calibrationPixelSigma,
    Math.max(0, Number(extraPixelSigma) || 0),
  ));
  const centerValue = pixelToValue(coordinate, calibration);
  const lowerValue = pixelToValue(coordinate - pixelSigma, calibration);
  const upperValue = pixelToValue(coordinate + pixelSigma, calibration);
  const valueSigma = Math.max(
    Math.abs(centerValue - lowerValue),
    Math.abs(upperValue - centerValue),
  );
  return {
    pixelSigma,
    valueSigma,
    relativeSigma: centerValue === 0 ? null : Math.abs(valueSigma / centerValue),
    referenceCount: points.length,
    residualRmsPx,
  };
}

/**
 * Refine only the coordinate that controls an axis mapping. The user still
 * chooses every reference tick; this helper merely centres that click on the
 * nearby dark tick stroke and declines to move it when local evidence is weak.
 */
export function snapCalibrationPoint({
  rgba,
  width,
  height,
  point,
  axis,
  searchRadius = 6,
  sampleRadius = 8,
}) {
  if (!rgba || rgba.length !== width * height * 4 || !point || !["x", "y"].includes(axis)) {
    return { point: point ? { ...point } : null, snapped: false, confidence: 0, shift: 0, uncertaintyPx: 0.5 };
  }
  const coordinate = axis === "x" ? Number(point.x) : Number(point.y);
  const orthogonal = axis === "x" ? Number(point.y) : Number(point.x);
  if (!Number.isFinite(coordinate) || !Number.isFinite(orthogonal)) {
    return { point: { ...point }, snapped: false, confidence: 0, shift: 0, uncertaintyPx: 0.5 };
  }
  const minimum = 0;
  const maximum = (axis === "x" ? width : height) - 1;
  const scores = [];
  for (
    let candidate = Math.max(minimum, Math.floor(coordinate - searchRadius));
    candidate <= Math.min(maximum, Math.ceil(coordinate + searchRadius));
    candidate += 1
  ) {
    let score = 0;
    let weightTotal = 0;
    for (let offset = -sampleRadius; offset <= sampleRadius; offset += 1) {
      const x = axis === "x" ? candidate : Math.round(orthogonal + offset);
      const y = axis === "x" ? Math.round(orthogonal + offset) : candidate;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const index = (y * width + x) * 4;
      const alpha = rgba[index + 3] / 255;
      const luminance = rgba[index] * 0.2126 + rgba[index + 1] * 0.7152 + rgba[index + 2] * 0.0722;
      const weight = 0.55 + 0.45 * (1 - Math.abs(offset) / (sampleRadius + 1));
      score += (255 - (luminance * alpha + 255 * (1 - alpha))) * weight;
      weightTotal += weight;
    }
    scores.push({ coordinate: candidate, score: weightTotal ? score / weightTotal : 0 });
  }
  const baseline = median(scores.map((entry) => entry.score)) ?? 0;
  const adjusted = scores.map((entry) => ({
    ...entry,
    evidence: Math.max(0, entry.score - baseline),
  }));
  const best = [...adjusted].sort((left, right) => right.evidence - left.evidence)[0];
  if (!best || best.evidence < 12) {
    return { point: { ...point }, snapped: false, confidence: 0, shift: 0, uncertaintyPx: 0.5 };
  }
  const cluster = adjusted.filter((entry) => (
    Math.abs(entry.coordinate - best.coordinate) <= 2
    && entry.evidence >= best.evidence * 0.25
  ));
  const weightSum = cluster.reduce((sum, entry) => sum + entry.evidence ** 2, 0);
  const snappedCoordinate = weightSum
    ? cluster.reduce((sum, entry) => sum + entry.coordinate * entry.evidence ** 2, 0) / weightSum
    : best.coordinate;
  const shift = snappedCoordinate - coordinate;
  const confidence = clamp(
    best.evidence / Math.max(20, best.score) * (1 - Math.min(0.45, Math.abs(shift) / (searchRadius + 1) * 0.45)),
    0,
    1,
  );
  if (confidence < 0.18 || Math.abs(shift) > searchRadius + 0.25) {
    return { point: { ...point }, snapped: false, confidence, shift: 0, uncertaintyPx: 0.5 };
  }
  const snappedPoint = { ...point };
  snappedPoint[axis] = clamp(snappedCoordinate, minimum, maximum);
  return {
    point: snappedPoint,
    snapped: true,
    confidence,
    shift,
    uncertaintyPx: clamp(0.5 - confidence * 0.38, 0.12, 0.5),
  };
}

/**
 * Convert a small pixel-space nudge into the local coordinate-space step used
 * by a number input. This keeps spinner arrows equally precise on linear,
 * logarithmic, and piecewise axes instead of using an arbitrary data unit.
 */
export function valueStepForPixelNudge(pixel, calibration, pixelStep = 0.1) {
  const centerPixel = Number(pixel);
  const distance = Math.abs(Number(pixelStep));
  if (!Number.isFinite(centerPixel) || !(distance > 0) || !validateCalibration(calibration)) {
    return Number.NaN;
  }
  const centerValue = pixelToValue(centerPixel, calibration);
  if (!Number.isFinite(centerValue)) return Number.NaN;
  const candidates = [centerPixel - distance, centerPixel + distance]
    .map((candidatePixel) => Math.abs(pixelToValue(candidatePixel, calibration) - centerValue))
    .filter((candidate) => Number.isFinite(candidate) && candidate > 0);
  return candidates.length ? Math.min(...candidates) : Number.NaN;
}

export function rgbDistanceSquared(red, green, blue, target) {
  const dr = red - target.r;
  const dg = green - target.g;
  const db = blue - target.b;
  return dr * dr + dg * dg + db * db;
}

export function compositedColorDistance(red, green, blue, target) {
  const pixelInk = [255 - red, 255 - green, 255 - blue];
  const targetInk = [255 - target.r, 255 - target.g, 255 - target.b];
  const pixelNorm = Math.hypot(...pixelInk);
  const targetNorm = Math.hypot(...targetInk);
  if (pixelNorm < 7) return Infinity;
  if (targetNorm < 7) return Math.sqrt(rgbDistanceSquared(red, green, blue, target));
  const cosine = clamp(
    (pixelInk[0] * targetInk[0] + pixelInk[1] * targetInk[1] + pixelInk[2] * targetInk[2])
      / (pixelNorm * targetNorm),
    -1,
    1,
  );
  const hueDistance = Math.sqrt(Math.max(0, 2 - 2 * cosine)) * 100;
  // All greys have the same ink direction. Use a continuous luminance band
  // for neutral targets, not a black-only cutoff: otherwise a grey curve can
  // match both a pale background and a darker grid with distance zero.
  // Bright-side tolerance admits antialiasing; dark-side tolerance admits
  // small sampling/compression variations, not unrelated black strokes.
  // Scale the band with available contrast so light grey on a pale plot
  // does not inherit the much wider absolute tolerance of black on white.
  const targetLuminance = 0.2126 * target.r + 0.7152 * target.g + 0.0722 * target.b;
  const targetChroma = Math.max(target.r, target.g, target.b) - Math.min(target.r, target.g, target.b);
  const neutralWeight = clamp((36 - targetChroma) / 18, 0, 1);
  if (neutralWeight > 0) {
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const contrast = Math.max(16, 255 - targetLuminance);
    const delta = luminance - targetLuminance;
    const allowance = delta >= 0 ? Math.min(24, contrast * 0.12) : Math.min(12, contrast * 0.08);
    const luminanceDistance = Math.max(0, Math.abs(delta) - allowance) * 0.4 * Math.sqrt(255 / contrast);
    return Math.max(hueDistance, luminanceDistance * neutralWeight);
  }
  return hueDistance;
}

export function pixelAt(rgba, width, x, y) {
  const index = (y * width + x) * 4;
  return {
    r: rgba[index],
    g: rgba[index + 1],
    b: rgba[index + 2],
    a: rgba[index + 3],
  };
}

// A narrow stroke is darker than the background on both sides in at least
// one direction. A flat shaded region or a one-sided region boundary is not.
// Used only in the small colour-picking neighbourhood, never per full image.
function localStrokeContrast(rgba, width, height, x, y, luminance) {
  let contrast = 0;
  for (const distance of [2, 3, 5, 7]) {
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const x0 = x - dx * distance, y0 = y - dy * distance;
      const x1 = x + dx * distance, y1 = y + dy * distance;
      if (x0 < 0 || y0 < 0 || x1 < 0 || y1 < 0 || x0 >= width || y0 >= height || x1 >= width || y1 >= height) continue;
      const before = (y0 * width + x0) * 4;
      const after = (y1 * width + x1) * 4;
      if (rgba[before + 3] < 32 || rgba[after + 3] < 32) continue;
      const left = 0.2126 * rgba[before] + 0.7152 * rgba[before + 1] + 0.0722 * rgba[before + 2];
      const right = 0.2126 * rgba[after] + 0.7152 * rgba[after + 1] + 0.0722 * rgba[after + 2];
      contrast = Math.max(contrast, Math.min(left, right) - luminance);
    }
  }
  return contrast;
}

function nearestNeutralStrokePixels(rgba, width, height, point, radius) {
  const candidates = new Set();
  let nearest = null, nearestDistance = Infinity;
  for (let y = Math.max(0, Math.round(point.y) - radius); y <= Math.min(height - 1, Math.round(point.y) + radius); y += 1) {
    for (let x = Math.max(0, Math.round(point.x) - radius); x <= Math.min(width - 1, Math.round(point.x) + radius); x += 1) {
      const index = (y * width + x) * 4;
      const red = rgba[index], green = rgba[index + 1], blue = rgba[index + 2];
      if (rgba[index + 3] < 32 || Math.max(red, green, blue) - Math.min(red, green, blue) > 18) continue;
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (localStrokeContrast(rgba, width, height, x, y, luminance) < 6) continue;
      candidates.add(y * width + x);
      const distance = Math.hypot(x - point.x, y - point.y);
      if (distance < nearestDistance) { nearest = y * width + x; nearestDistance = distance; }
    }
  }
  if (nearest === null) return null;
  // Pick the closest stroke component first, then refine its colour. This
  // lets an antialias click reach the line core without reaching a separate
  // black grid or a second grey series a few pixels farther away.
  const component = new Set([nearest]);
  const pending = [nearest];
  while (pending.length) {
    const index = pending.pop(), x = index % width, y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
      const neighbor = (y + dy) * width + x + dx;
      if (!component.has(neighbor) && candidates.has(neighbor)) {
        component.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  const refinementRadius = Math.max(2.5, nearestDistance + 1.5);
  return new Set([...component].filter(index => Math.hypot(
    index % width - point.x, Math.floor(index / width) - point.y,
  ) <= refinementRadius));
}

export function sampleRepresentativeColor(rgba, width, height, point, radius = 6) {
  let best = null;
  let bestScore = -Infinity;
  const center = pixelAt(rgba, width, clamp(Math.round(point.x), 0, width - 1), clamp(Math.round(point.y), 0, height - 1));
  const centerLuminance = 0.2126 * center.r + 0.7152 * center.g + 0.0722 * center.b;
  const centerChroma = Math.max(center.r, center.g, center.b) - Math.min(center.r, center.g, center.b);
  let nearbyBlackCount = 0;
  let nearbyBlackMinimumX = Infinity;
  let nearbyBlackMaximumX = -Infinity;
  let nearbyBlackMinimumY = Infinity;
  let nearbyBlackMaximumY = -Infinity;
  let nearbyNeutralStroke = false;
  let nearbyColoredStroke = false;
  const neutralProbeRadius = Math.min(radius, 2);
  for (let offsetY = -neutralProbeRadius; offsetY <= neutralProbeRadius; offsetY += 1) {
    const y = clamp(Math.round(point.y) + offsetY, 0, height - 1);
    for (let offsetX = -neutralProbeRadius; offsetX <= neutralProbeRadius; offsetX += 1) {
      if (Math.hypot(offsetX, offsetY) > neutralProbeRadius + 0.01) continue;
      const x = clamp(Math.round(point.x) + offsetX, 0, width - 1);
      const color = pixelAt(rgba, width, x, y);
      if (color.a < 32) continue;
      const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
      const chroma = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      if (localStrokeContrast(rgba, width, height, x, y, luminance) >= 6) {
        if (chroma <= 18) nearbyNeutralStroke = true;
        else nearbyColoredStroke = true;
      }
      if (luminance <= 72 && chroma <= 18) {
        nearbyBlackCount += 1;
        nearbyBlackMinimumX = Math.min(nearbyBlackMinimumX, offsetX);
        nearbyBlackMaximumX = Math.max(nearbyBlackMaximumX, offsetX);
        nearbyBlackMinimumY = Math.min(nearbyBlackMinimumY, offsetY);
        nearbyBlackMaximumY = Math.max(nearbyBlackMaximumY, offsetY);
      }
    }
  }
  // A deliberate click on a black/gray stroke must stay achromatic. The normal
  // color score strongly favors chroma so that a colored curve wins over a gray
  // grid, but that same preference used to make nearby colored lines steal a
  // click from black markers (for example, black crosses over a blue curve).
  // Probe the nearest two pixels as well because display scaling and antialiasing
  // can put the pointer center on the underlying colored curve beside the glyph.
  // Require ink in both directions: a nearby black annotation/axis line must not
  // steal a deliberate click from a colored curve, while a cross marker qualifies.
  const centerIsNeutralInk = center.a >= 32 && 255 - centerLuminance >= 28 && centerChroma <= 18;
  const nearbyBlackGlyph = nearbyBlackCount >= 3
    && nearbyBlackMaximumX - nearbyBlackMinimumX >= 1
    && nearbyBlackMaximumY - nearbyBlackMinimumY >= 1;
  if (nearbyNeutralStroke && !nearbyColoredStroke && !centerIsNeutralInk && !nearbyBlackGlyph) {
    // A white-gap click on a coloured dashed curve can be closer to a black
    // annotation. Preserve the established coloured-ink preference if a real
    // coloured stroke exists in the normal picking window (not a flat tint).
    coloredProbe: for (let y = Math.max(0, Math.round(point.y) - radius); y <= Math.min(height - 1, Math.round(point.y) + radius); y += 1) {
      for (let x = Math.max(0, Math.round(point.x) - radius); x <= Math.min(width - 1, Math.round(point.x) + radius); x += 1) {
        const color = pixelAt(rgba, width, x, y);
        if (color.a < 32 || Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) <= 18) continue;
        const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        if (localStrokeContrast(rgba, width, height, x, y, luminance) >= 6) {
          nearbyColoredStroke = true;
          break coloredProbe;
        }
      }
    }
  }
  const preferNeutralInk = centerIsNeutralInk || nearbyBlackGlyph || (nearbyNeutralStroke && !nearbyColoredStroke);
  const neutralStroke = preferNeutralInk ? nearestNeutralStrokePixels(rgba, width, height, point, radius) : null;

  for (let y = Math.max(0, Math.round(point.y) - radius); y <= Math.min(height - 1, Math.round(point.y) + radius); y += 1) {
    for (let x = Math.max(0, Math.round(point.x) - radius); x <= Math.min(width - 1, Math.round(point.x) + radius); x += 1) {
      const color = pixelAt(rgba, width, x, y);
      if (color.a < 32) continue;
      const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
      const chroma = Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
      const darkness = 255 - luminance;
      const inkSaturation = chroma / Math.max(12, darkness);
      const centerDistance = Math.hypot(x - point.x, y - point.y);
      const similarityToClickedPixel = Math.sqrt(rgbDistanceSquared(color.r, color.g, color.b, center));
      let score;
      if (preferNeutralInk) {
        if (neutralStroke && !neutralStroke.has(y * width + x)) continue;
        // Proximity and local stroke contrast come before raw darkness. A
        // nearby black grid must not steal a deliberate click on a grey line;
        // a uniform grey background must not win over a slightly missed line.
        const strokeContrast = localStrokeContrast(rgba, width, height, x, y, luminance);
        score = darkness * 0.45 + Math.min(24, strokeContrast) * 1.5
          - chroma * 5
          - centerDistance * 4.5
          - similarityToClickedPixel * 0.05;
      } else {
        // High chroma is stronger evidence than raw darkness when a colored curve
        // crosses a gray grid line. Ink saturation also favors a clean antialias
        // edge over the darker but hue-corrupted center of that intersection.
        const inkScore = darkness * 0.28 + chroma * 0.9 + inkSaturation * 70;
        score = inkScore - centerDistance * 4.5 - similarityToClickedPixel * 0.05;
      }
      if (score > bestScore) {
        bestScore = score;
        best = color;
      }
    }
  }

  return best ?? center;
}

export function estimateColorThreshold(rgba, width, height, point, target, radius = 7) {
  const distances = [];
  const backgroundDistances = [];
  const neutralTarget = Math.max(target.r, target.g, target.b) - Math.min(target.r, target.g, target.b) < 36;
  let sampleCount = 0;
  const centerX = clamp(Math.round(point.x), 0, width - 1);
  const centerY = clamp(Math.round(point.y), 0, height - 1);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
      const color = pixelAt(rgba, width, x, y);
      if (color.a < 32) continue;
      sampleCount += 1;
      const distance = compositedColorDistance(color.r, color.g, color.b, target);
      if (neutralTarget) {
        const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        if (distance > 1e-6 && localStrokeContrast(rgba, width, height, x, y, luminance) <= 2) {
          backgroundDistances.push(distance);
        }
      }
      const inkStrength = Math.hypot(255 - color.r, 255 - color.g, 255 - color.b);
      if (inkStrength < 10) continue;
      if (Number.isFinite(distance) && distance <= 36) distances.push(distance);
    }
  }
  if (!distances.length) return 15;
  distances.sort((a, b) => a - b);
  // The lower part of the local cluster is normally the selected stroke. Nearby
  // grids, markers, or another curve should not be allowed to widen the match.
  const clusterEnd = Math.max(0, Math.floor((distances.length - 1) * 0.6));
  let threshold = Math.round(clamp(distances[clusterEnd] + 5, 9, 15));
  // On low-contrast plots, the many background pixels must not enlarge their
  // own acceptance threshold. Use only spatially flat samples for the cap;
  // keep white (infinite distance) so a white plot retains its usual tolerance.
  if (neutralTarget && backgroundDistances.length >= Math.max(8, sampleCount * 0.25)) {
    backgroundDistances.sort((a, b) => a - b);
    const backgroundDistance = backgroundDistances[Math.floor((backgroundDistances.length - 1) * 0.25)];
    if (Number.isFinite(backgroundDistance) && backgroundDistance > 0) {
      threshold = Math.min(threshold, Math.max(4, Math.floor(backgroundDistance * 0.75)));
    }
  }
  return threshold;
}

/**
 * Snap an approximate target-selection click to the local center of the
 * sampled stroke. Browser scaling can place the natural-image coordinate a
 * few pixels beside a steep or thin line even when the pointer visibly sits
 * on it. Keeping that off-stroke coordinate as the first locked guide gives
 * the directional tracker a false initial slope and can truncate an otherwise
 * simple curve.
 *
 * This helper is intentionally local: it finds the nearest matching connected
 * component, estimates its tangent with a small PCA neighborhood, and projects
 * the click onto the component centerline. Projection preserves position along
 * near-horizontal or near-vertical curves instead of drifting along them.
 */
export function snapTargetPoint({
  rgba,
  width,
  height,
  rect,
  point,
  target,
  threshold = 15,
  exclusions = [],
  inclusionMask = null,
  searchRadius = 8,
}) {
  if (
    !rgba
    || rgba.length !== width * height * 4
    || !point
    || !target
    || !Number.isFinite(point.x)
    || !Number.isFinite(point.y)
  ) return point;
  const safeRect = normalizeRect(
    { x: rect?.left ?? 0, y: rect?.top ?? 0 },
    { x: rect?.right ?? width - 1, y: rect?.bottom ?? height - 1 },
    { width, height },
  );
  const radius = clamp(Math.round(searchRadius), 1, 16);
  const left = Math.max(safeRect.left, Math.round(point.x) - radius);
  const right = Math.min(safeRect.right, Math.round(point.x) + radius);
  const candidates = [];
  for (let x = left; x <= right; x += 1) {
    for (const candidate of clusterColumnCandidates(
      rgba,
      width,
      x,
      safeRect.top,
      safeRect.bottom,
      target,
      threshold,
      exclusions,
      inclusionMask,
    )) {
      const nearestY = clamp(point.y, candidate.start, candidate.end);
      const distance = Math.hypot(x - point.x, nearestY - point.y);
      if (distance <= radius + 0.5) candidates.push({ x, nearestY, distance, candidate });
    }
  }
  if (!candidates.length) return point;
  candidates.sort((leftCandidate, rightCandidate) => (
    leftCandidate.distance - rightCandidate.distance
    || leftCandidate.candidate.distance - rightCandidate.candidate.distance
    || Math.abs(leftCandidate.candidate.y - point.y) - Math.abs(rightCandidate.candidate.y - point.y)
  ));
  const nearest = candidates[0];
  const matchesAt = (x, y) => {
    if (x < safeRect.left || x > safeRect.right || y < safeRect.top || y > safeRect.bottom) return false;
    if ((exclusions ?? []).some((area) => (
      x >= area.left && x <= area.right && y >= area.top && y <= area.bottom
    ))) return false;
    if (!inclusionMaskAllows(inclusionMask, width, x, y)) return false;
    const index = (y * width + x) * 4;
    if (rgba[index + 3] < 32) return false;
    return compositedColorDistance(rgba[index], rgba[index + 1], rgba[index + 2], target) <= threshold;
  };
  const localTop = Math.max(safeRect.top, Math.round(point.y) - radius);
  const localBottom = Math.min(safeRect.bottom, Math.round(point.y) + radius);
  const localWidth = right - left + 1;
  const visited = new Uint8Array(localWidth * (localBottom - localTop + 1));
  const queue = [[nearest.x, clamp(Math.round(nearest.nearestY), localTop, localBottom)]];
  const component = [];
  while (queue.length) {
    const [x, y] = queue.pop();
    if (x < left || x > right || y < localTop || y > localBottom) continue;
    if (Math.hypot(x - point.x, y - point.y) > radius + 0.75) continue;
    const localIndex = (y - localTop) * localWidth + x - left;
    if (visited[localIndex]) continue;
    visited[localIndex] = 1;
    if (!matchesAt(x, y)) continue;
    component.push({ x, y });
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX || offsetY) queue.push([x + offsetX, y + offsetY]);
      }
    }
  }
  if (component.length < 3) {
    return { ...point, x: nearest.x, y: nearest.nearestY };
  }
  const center = component.reduce((sum, pixel) => ({
    x: sum.x + pixel.x / component.length,
    y: sum.y + pixel.y / component.length,
  }), { x: 0, y: 0 });
  let covarianceXX = 0;
  let covarianceXY = 0;
  let covarianceYY = 0;
  for (const pixel of component) {
    const dx = pixel.x - center.x;
    const dy = pixel.y - center.y;
    covarianceXX += dx * dx;
    covarianceXY += dx * dy;
    covarianceYY += dy * dy;
  }
  const tangentAngle = 0.5 * Math.atan2(2 * covarianceXY, covarianceXX - covarianceYY);
  const tangentX = Math.cos(tangentAngle);
  const tangentY = Math.sin(tangentAngle);
  const trace = covarianceXX + covarianceYY;
  const discriminant = Math.hypot(covarianceXX - covarianceYY, 2 * covarianceXY);
  const anisotropy = trace > 1e-9 ? discriminant / trace : 0;
  if (anisotropy < 0.18) {
    return { ...point, x: center.x, y: center.y };
  }
  const tangentOffset = (point.x - center.x) * tangentX + (point.y - center.y) * tangentY;
  return {
    ...point,
    x: clamp(center.x + tangentOffset * tangentX, safeRect.left, safeRect.right),
    y: clamp(center.y + tangentOffset * tangentY, safeRect.top, safeRect.bottom),
  };
}

function localPenGates(pixels, width, region) {
  // Infer entry/exit directions from the painted geometry, not from the trace
  // orientation or guide count. Padding also permits thinning at image edges.
  const localWidth = region.right - region.left + 3;
  const localHeight = region.bottom - region.top + 3;
  const mask = new Uint8Array(localWidth * localHeight);
  for (const index of pixels) {
    mask[(Math.floor(index / width) - region.top + 1) * localWidth + index % width - region.left + 1] = 1;
  }
  const nodes = buildMaskGraph(skeletonizeMask({
    mask, width: localWidth, height: localHeight, offsetX: region.left - 1, offsetY: region.top - 1,
  }));
  // A dab alone has no reliable direction. Keep its local exclusion rectangle
  // instead of inventing a direction that can block unrelated image regions.
  if (nodes.length < 3) return null;
  let endpoints = nodes.map((node, index) => node.neighbors.length === 1 ? index : -1).filter(index => index >= 0);
  if (endpoints.length > 2) {
    // Ignore small skeleton spurs caused by uneven brush edges. Only the two
    // most separated endpoints define how an open painted section continues.
    const farthest = (start) => {
      const distance = new Int32Array(nodes.length).fill(-1);
      const queue = [start];
      distance[start] = 0;
      for (let head = 0; head < queue.length; head += 1) {
        for (const next of nodes[queue[head]].neighbors) {
          if (distance[next] >= 0) continue;
          distance[next] = distance[queue[head]] + 1;
          queue.push(next);
        }
      }
      return endpoints.reduce((best, index) => distance[index] > distance[best] ? index : best, start);
    };
    const first = farthest(endpoints[0]);
    endpoints = [first, farthest(first)];
  }
  const support = Math.max(6, Math.min(24, pixels.length / nodes.length * 1.5));
  return endpoints.map((endpoint) => {
    let previous = -1;
    let current = endpoint;
    let distance = 0;
    while (distance < support) {
      const next = nodes[current].neighbors.filter(index => index !== previous);
      if (next.length !== 1) break;
      distance += Math.hypot(nodes[next[0]].x - nodes[current].x, nodes[next[0]].y - nodes[current].y);
      previous = current;
      current = next[0];
    }
    const dx = nodes[endpoint].x - nodes[current].x;
    const dy = nodes[endpoint].y - nodes[current].y;
    const length = Math.hypot(dx, dy);
    if (!length) return null;
    const nx = dx / length, ny = dy / length;
    // Locate the painted cap along the endpoint tangent. Extension is allowed
    // only through an entry/exit aperture, never beside the middle of a stroke.
    // A closed corridor has no exits.
    let offset = -Infinity;
    for (const index of pixels) offset = Math.max(offset, nx * (index % width) + ny * Math.floor(index / width));
    const halfWidth = Math.max(1, pixels.length / nodes.length / 2);
    // The curved edge of a round cap is not a wall across the tangent route.
    // Start its entrance a few pixels before the furthest cap projection;
    // lateral clearance below still prevents a side exit to parallel ink.
    offset = Math.max(nx * nodes[endpoint].x + ny * nodes[endpoint].y,
      offset - Math.min(4, halfWidth * 0.75));
    return {
      nx, ny, offset, x: nodes[endpoint].x, y: nodes[endpoint].y,
      halfWidth,
    };
  }).filter(Boolean);
}

/** Build one orientation-independent Pen contract for trace, sampling/export.
 * Local sections exclude unpainted pixels between their endpoint gates, not
 * just inside their bounding boxes. Only endwise extension remains available.
 * Strict mode permits only painted pixels. Manual guides remain authoritative.
 */
export function prepareInclusionMask(data, width, height, mode = "local", { erased = null } = {}) {
  if (!data || data.length !== width * height) throw new Error("Invalid Pen raster dimensions");
  if (erased && erased.length !== data.length) throw new Error("Invalid Pen erasure dimensions");
  const columns = new Uint8Array(width);
  const rows = new Uint8Array(height);
  let activePixels = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (!data[index]) continue;
    columns[index % width] = 1;
    rows[Math.floor(index / width)] = 1;
    activePixels += 1;
  }
  if (!activePixels) return null;
  const scope = mode === "strict" ? "strict" : "local";
  const regions = [];
  const gates = [];
  const allowed = scope === "strict" ? data.slice() : new Uint8Array(data.length).fill(1);
  if (scope === "local") {
    // An eraser cuts the searchable pixels, not the original local scope.
    // Otherwise a cut creates new exit gates and allows a sideways bypass.
    const unseen = data.slice();
    let scopePixels = activePixels;
    if (erased) {
      for (let index = 0; index < data.length; index += 1) {
        if (erased[index] && !unseen[index]) {
          unseen[index] = 1;
          scopePixels += 1;
        }
      }
    }
    const queue = new Int32Array(scopePixels);
    for (let seed = 0; seed < data.length; seed += 1) {
      if (!unseen[seed]) continue;
      let head = 0;
      let tail = 1;
      queue[0] = seed;
      unseen[seed] = 0;
      const region = { left: width, right: 0, top: height, bottom: 0 };
      while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = Math.floor(index / width);
        region.left = Math.min(region.left, x);
        region.right = Math.max(region.right, x);
        region.top = Math.min(region.top, y);
        region.bottom = Math.max(region.bottom, y);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const next = ny * width + nx;
            if (!unseen[next]) continue;
            unseen[next] = 0;
            queue[tail++] = next;
          }
        }
      }
      regions.push(region);
      const ends = localPenGates(queue.subarray(0, tail), width, region);
      if (ends !== null) {
        gates.push(...ends);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            if (!allowed[y * width + x] || data[y * width + x]) continue;
            if (!ends.some((gate) => {
              const projection = gate.nx * x + gate.ny * y;
              if (projection <= gate.offset + 1e-7) return false;
              const forward = projection - (gate.nx * gate.x + gate.ny * gate.y);
              // A half-plane alone admits a remote parallel branch immediately
              // beside an exit. Require a short, widening tangent entry first;
              // beyond it local assistance resumes ordinary unrestricted search.
              if (forward > Math.max(20, gate.halfWidth * 4)) return true;
              const lateral = Math.abs(-gate.ny * (x - gate.x) + gate.nx * (y - gate.y));
              return lateral <= gate.halfWidth + Math.max(0, forward) * 0.4 + 1;
            })) allowed[y * width + x] = 0;
          }
        }
      }
      // Only directionless dabs need a rectangular fallback. For an open
      // stroke, blank corners around a round cap can already be beyond an end
      // gate; clearing its entire bounding box would block legitimate entry.
      if (ends === null) for (let y = region.top; y <= region.bottom; y += 1) {
        allowed.fill(0, y * width + region.left, y * width + region.right + 1);
      }
    }
    for (let index = 0; index < data.length; index += 1) if (data[index]) allowed[index] = 1;
  }
  const effectiveErased = erased ? erased.slice() : null;
  if (effectiveErased) {
    for (let index = 0; index < data.length; index += 1) {
      // A later paint operation restores that pixel. Otherwise an explicit
      // erasure overrides the local entry/exit extensions in every direction.
      if (data[index]) effectiveErased[index] = 0;
      else if (effectiveErased[index]) allowed[index] = 0;
    }
  }
  return { data, columns, rows, allowed, erased: effectiveErased, mode: scope, regions, gates, activePixels };
}

export function inclusionMaskAllows(inclusionMask, width, x, y) {
  if (!inclusionMask?.data || !inclusionMask?.columns) return true;
  const column = Math.round(x);
  const row = Math.round(y);
  if (column < 0 || column >= width || row < 0 || row >= inclusionMask.data.length / width) return false;
  if (inclusionMask.allowed) return Boolean(inclusionMask.allowed[row * width + column]);
  if (!inclusionMask.columns[column]) return true;
  return Boolean(inclusionMask.data[row * width + column]);
}

function inclusionRunsAt(inclusionMask, width, x, top, bottom) {
  if (!inclusionMask?.data || !inclusionMask?.columns) return [];
  const column = Math.round(x);
  if (!inclusionMask.allowed && !inclusionMask.columns[column]) return [];
  const runs = [];
  let start = null;
  for (let y = top; y <= bottom; y += 1) {
    const allowed = Boolean((inclusionMask.allowed ?? inclusionMask.data)[y * width + column]);
    if (allowed && start === null) start = y;
    if (!allowed && start !== null) {
      runs.push({ start, end: y - 1, center: (start + y - 1) / 2 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: bottom, center: (start + bottom) / 2 });
  return runs;
}

function nearestInclusionRun(inclusionMask, width, x, y, top, bottom) {
  // Outside a local assistance region, do not bias the curve towards the
  // centre of the image as though the entire image were a painted stroke.
  if (inclusionMask?.allowed && inclusionMask.mode === "local"
    && !inclusionMask.data[Math.round(y) * width + Math.round(x)]
    && inclusionMaskAllows(inclusionMask, width, x, y)) return null;
  const runs = inclusionRunsAt(inclusionMask, width, x, top, bottom);
  if (!runs.length) return null;
  return runs
    .map((run) => ({
      ...run,
      distance: y < run.start ? run.start - y : y > run.end ? y - run.end : 0,
      centerDistance: Math.abs(y - run.center),
    }))
    .sort((left, right) => left.distance - right.distance || left.centerDistance - right.centerDistance)[0];
}

function inclusionRunsAtRow(inclusionMask, width, row, left, right) {
  if (!inclusionMask?.data) return [];
  const runs = [];
  let start = null;
  for (let x = left; x <= right; x += 1) {
    const allowed = Boolean((inclusionMask.allowed ?? inclusionMask.data)[row * width + x]);
    if (allowed && start === null) start = x;
    if (!allowed && start !== null) {
      runs.push({ start, end: x - 1, center: (start + x - 1) / 2 });
      start = null;
    }
  }
  if (start !== null) runs.push({ start, end: right, center: (start + right) / 2 });
  return runs;
}

function nearestInclusionRunAtRow(inclusionMask, width, y, x, left, right) {
  const runs = inclusionRunsAtRow(inclusionMask, width, y, left, right);
  if (!runs.length) return null;
  return runs
    .map((run) => ({
      ...run,
      distance: x < run.start ? run.start - x : x > run.end ? x - run.end : 0,
      centerDistance: Math.abs(x - run.center),
    }))
    .sort((leftRun, rightRun) => (
      leftRun.distance - rightRun.distance || leftRun.centerDistance - rightRun.centerDistance
    ))[0];
}

function nearestInclusionPixel(inclusionMask, width, height, x, y, rect, maximumRadius = 1.5) {
  const allowed = inclusionMask.allowed ?? inclusionMask.data;
  const column = Math.round(x);
  const row = Math.round(y);
  if (column >= 0 && column < width && row >= 0 && row < height
    && inclusionMask.erased?.[row * width + column]) return null;
  if (column >= 0 && column < width && row >= 0 && row < height
    && allowed[row * width + column]) {
    return { x, y, distance: 0 };
  }
  const radius = Math.ceil(maximumRadius);
  const left = Math.max(0, Math.round(rect.left), column - radius);
  const right = Math.min(width - 1, Math.round(rect.right), column + radius);
  const top = Math.max(0, Math.round(rect.top), row - radius);
  const bottom = Math.min(height - 1, Math.round(rect.bottom), row + radius);
  let nearest = null;
  for (let sampleY = top; sampleY <= bottom; sampleY += 1) {
    for (let sampleX = left; sampleX <= right; sampleX += 1) {
      if (!allowed[sampleY * width + sampleX]) continue;
      const distance = Math.hypot(sampleX - x, sampleY - y);
      if (distance > maximumRadius) continue;
      if (!nearest || distance < nearest.distance) nearest = { x: sampleX, y: sampleY, distance };
    }
  }
  return nearest;
}

/** Inspect every raster cell traversed by the underlying continuous path.
 * Pixel-boundary intervals, rather than output density, make even a one-pixel
 * erasure detectable. Exported point circles are not connected: callers with
 * a dense source path should validate that geometry, not sparse sampling chords.
 */
export function inclusionPathViolation(path, {
  inclusionMask = null, width, height = null, rect, maximumCorrection = 1.5,
} = {}) {
  if (!inclusionMask?.data || !rect || !Number.isFinite(width) || path?.length < 2) return null;
  const maskHeight = height ?? inclusionMask.data.length / width;
  const isGuide = point => Boolean(point.anchor || point.userGuided);
  const permitGuideExit = point => isGuide(point)
    && !inclusionMaskAllows(inclusionMask, width, point.x, point.y);
  const segmentCount = path.length - 1 + (path.some(point => point.closedPath) ? 1 : 0);
  for (let index = 0; index < segmentCount; index += 1) {
    const start = path[index], end = path[(index + 1) % path.length];
    const dx = end.x - start.x, dy = end.y - start.y;
    const boundaries = [0, 1];
    for (const [origin, delta] of [[start.x, dx], [start.y, dy]]) {
      if (!delta) continue;
      const low = Math.min(origin, origin + delta), high = Math.max(origin, origin + delta);
      for (let boundary = Math.floor(low + 0.5) + 0.5; boundary < high; boundary += 1) {
        const fraction = (boundary - origin) / delta;
        if (fraction > 0 && fraction < 1) boundaries.push(fraction);
      }
    }
    boundaries.sort((a, b) => a - b);
    const samples = [];
    for (let position = 1; position < boundaries.length; position += 1) {
      if (boundaries[position] - boundaries[position - 1] < 1e-10) continue;
      const fraction = (boundaries[position] + boundaries[position - 1]) / 2;
      const x = start.x + dx * fraction, y = start.y + dy * fraction;
      const column = Math.round(x), row = Math.round(y);
      const inside = column >= 0 && column < width && row >= 0 && row < maskHeight;
      const pixel = row * width + column;
      const erased = inside && Boolean(inclusionMask.erased?.[pixel]);
      const valid = !erased && inside && (inclusionMaskAllows(inclusionMask, width, x, y)
        || nearestInclusionPixel(inclusionMask, width, maskHeight, x, y, rect, maximumCorrection));
      samples.push({ x, y, valid: Boolean(valid), erased });
    }
    const firstAllowed = samples.findIndex(sample => sample.valid);
    const lastAllowed = samples.findLastIndex(sample => sample.valid);
    const violation = samples.find((sample, position) => {
      if (sample.valid) return false;
      if (sample.erased) return true;
      // An authoritative guide may sit outside Pen, but it cannot license a
      // forbidden hole in the middle of the automatic route.
      if (permitGuideExit(start) && (firstAllowed < 0 || position < firstAllowed)) return false;
      if (permitGuideExit(end) && (lastAllowed < 0 || position > lastAllowed)) return false;
      return true;
    });
    if (violation) return { segmentIndex: index, x: violation.x, y: violation.y, erased: violation.erased };
  }
  return null;
}

/**
 * Enforce a user-painted inclusion corridor on every non-anchor path point.
 * Candidate filtering alone is insufficient because inferred gaps, polynomial
 * recovery, and final resampling can otherwise create points outside the ROI.
 */
export function constrainPathToInclusionMask(path, {
  inclusionMask = null,
  width,
  height = null,
  rect,
  orientation = "horizontal",
  maximumCorrection = 1.5,
} = {}) {
  if (!Array.isArray(path) || !path.length) return [];
  if (!inclusionMask?.data || !inclusionMask?.columns || !Number.isFinite(width) || !rect) return path;
  const top = Math.round(rect.top);
  const bottom = Math.round(rect.bottom);
  const left = Math.round(rect.left);
  const right = Math.round(rect.right);
  return path.map((point) => {
    if (point.anchor || point.userGuided) return point;
    const clean = { ...point };
    delete clean.corridorOutside;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ...clean, corridorOutside: true };
    const corrected = (x, y) => {
      const displacement = Math.hypot(x - point.x, y - point.y);
      if (displacement > maximumCorrection) return { ...clean, corridorOutside: true };
      return {
        ...clean, x, y,
        observed: false,
        imageObserved: false,
        centerRefined: false,
        corridorConstrained: true,
        corridorCorrectionPx: Math.max(clean.corridorCorrectionPx ?? 0, displacement),
        uncertaintyPx: Math.max(clean.uncertaintyPx ?? 0, displacement),
        inferenceUncertainty: Math.max(clean.inferenceUncertainty ?? 0, displacement),
        confidence: Math.min(clean.confidence ?? 1, 0.45),
      };
    };
    if (inclusionMask.allowed || orientation === "parametric") {
      const maskHeight = Number.isFinite(height) ? height : inclusionMask.data.length / width;
      const nearest = nearestInclusionPixel(
        inclusionMask,
        width,
        maskHeight,
        point.x,
        point.y,
        rect,
        maximumCorrection,
      );
      if (!nearest) return { ...clean, corridorOutside: true };
      if (nearest.distance === 0) return clean;
      return corrected(nearest.x, nearest.y);
    }
    if (orientation === "vertical") {
      const row = Math.round(point.y);
      if (row < 0 || (Number.isFinite(height) && row >= height)) return clean;
      const rowConstrained = inclusionMask.rows
        ? Boolean(inclusionMask.rows[row])
        : inclusionRunsAtRow(inclusionMask, width, row, left, right).length > 0;
      if (!rowConstrained) return clean;
      const run = nearestInclusionRunAtRow(inclusionMask, width, row, point.x, left, right);
      if (!run || run.distance === 0) return clean;
      return corrected(clamp(point.x, run.start, run.end), point.y);
    }
    const column = Math.round(point.x);
    if (!inclusionMask.columns[column]) return clean;
    const run = nearestInclusionRun(inclusionMask, width, column, point.y, top, bottom);
    if (!run || run.distance === 0) return clean;
    const y = clamp(point.y, run.start, run.end);
    return corrected(point.x, y);
  });
}

export function clusterColumnCandidates(
  rgba,
  width,
  x,
  top,
  bottom,
  target,
  threshold,
  exclusions = [],
  inclusionMask = null,
) {
  const candidates = [];
  let run = null;

  const closeRun = () => {
    if (!run) return;
    const y = (run.start + run.end) / 2;
    // Local extension can expose a same-colour plot frame. A nearly full-height
    // band is not a thin-curve centre; do not reconnect to its midpoint unless
    // the user actually painted there. Vertical target ink is still available
    // to vertical/2D tracing, and ordinary traces without Pen are unchanged.
    if (inclusionMask?.mode === "local"
      && !inclusionMask.data[Math.round(y) * width + x]) {
      // Pen's tangent entrance can expose only a short piece of a long axis.
      // Measure the original ink column, not the already masked run length.
      const originalInk = row => {
        const offset = (row * width + x) * 4;
        return compositedColorDistance(rgba[offset], rgba[offset + 1], rgba[offset + 2], target) <= threshold;
      };
      if (originalInk(top) && originalInk(bottom)) {
        let ink = 0;
        for (let row = top; row <= bottom; row += 4) if (originalInk(row)) ink += 1;
        if (ink >= Math.ceil((bottom - top + 1) / 4) * 0.75) {
          run = null;
          return;
        }
      }
    }
    const inclusionRun = nearestInclusionRun(inclusionMask, width, x, y, top, bottom);
    candidates.push({
      y,
      start: run.start,
      end: run.end,
      thickness: run.end - run.start + 1,
      distance: run.minimumDistance,
      corridorCenterDistance: inclusionRun ? Math.abs(y - inclusionRun.center) : 0,
      corridorHalfWidth: inclusionRun ? Math.max(1, (inclusionRun.end - inclusionRun.start + 1) / 2) : null,
    });
    run = null;
  };

  for (let y = top; y <= bottom; y += 1) {
    const index = (y * width + x) * 4;
    const alpha = rgba[index + 3];
    const distance = compositedColorDistance(rgba[index], rgba[index + 1], rgba[index + 2], target);
    const excluded = exclusions.some((rect) => (
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    ));
    const matches = !excluded
      && inclusionMaskAllows(inclusionMask, width, x, y)
      && alpha >= 32
      && distance <= threshold;

    if (matches) {
      if (!run) {
        run = { start: y, end: y, minimumDistance: distance };
      } else {
        run.end = y;
        run.minimumDistance = Math.min(run.minimumDistance, distance);
      }
    } else {
      closeRun();
    }
  }
  closeRun();
  return candidates;
}

function isThinLineStyle(targetStyle) {
  return ["line", "dashed", "dashdot", "dotted", "noisy"].includes(targetStyle);
}

function isPatternedLineStyle(targetStyle) {
  return ["dashed", "dashdot", "dotted"].includes(targetStyle);
}

function candidateThicknessPenalty(candidate, targetStyle, scale = 1) {
  if (isThinLineStyle(targetStyle)) {
    return Math.max(0, candidate.thickness - 3) * 0.55 * scale;
  }
  return Math.max(0, candidate.thickness - 8) * 0.08 * scale;
}

function candidateCorridorPenalty(candidate) {
  if (!Number.isFinite(candidate.corridorHalfWidth) || candidate.corridorHalfWidth <= 0) return 0;
  return (candidate.corridorCenterDistance / candidate.corridorHalfWidth) * 0.9;
}

function exclusionCoversColumn(exclusions, x, y, padding = 2) {
  return (exclusions ?? []).some((area) => (
    x >= area.left && x <= area.right
    && y >= area.top - padding && y <= area.bottom + padding
  ));
}

function exclusionBridgeBetween(exclusions, from, to, padding = 3) {
  if (!from || !to || Math.abs(to.x - from.x) <= 1) return null;
  const leftX = Math.min(from.x, to.x) + 1;
  const rightX = Math.max(from.x, to.x) - 1;
  return (exclusions ?? []).find((area) => {
    // Candidate columns are integer-valued, while a dragged mask may retain
    // subpixel edges. Match the same integer coverage used when candidates
    // are excluded: ceil(left) through floor(right), inclusive.
    const maskedLeft = Math.ceil(area.left);
    const maskedRight = Math.floor(area.right);
    return maskedLeft <= leftX && maskedRight >= rightX
      && from.y >= area.top - padding && from.y <= area.bottom + padding
      && to.y >= area.top - padding && to.y <= area.bottom + padding;
  }) ?? null;
}

function targetPixelPresent(options, x, y, radius = 2) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (roundedX < options.rect.left || roundedX > options.rect.right) return false;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const sampleY = roundedY + offset;
    if (sampleY < options.rect.top || sampleY > options.rect.bottom) continue;
    const excluded = options.exclusions.some((area) => (
      roundedX >= area.left && roundedX <= area.right
      && sampleY >= area.top && sampleY <= area.bottom
    ));
    if (excluded) continue;
    if (!inclusionMaskAllows(options.inclusionMask, options.width, roundedX, sampleY)) continue;
    const index = (sampleY * options.width + roundedX) * 4;
    if (options.rgba[index + 3] < 32) continue;
    const distance = compositedColorDistance(
      options.rgba[index],
      options.rgba[index + 1],
      options.rgba[index + 2],
      options.target,
    );
    if (distance <= options.threshold) return true;
  }
  return false;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function measureStrokePattern(options, point, slope = 0, scanRadius = 64) {
  const safeSlope = clamp(Number.isFinite(slope) ? slope : 0, -3, 3);
  const samples = [];
  for (let offset = -scanRadius; offset <= scanRadius; offset += 1) {
    samples.push(targetPixelPresent(
      options,
      point.x + offset,
      point.y + safeSlope * offset,
      Math.max(2, Math.ceil((point.thickness ?? 1) / 2)),
    ));
  }

  let center = scanRadius;
  if (!samples[center]) {
    for (let distance = 1; distance <= 4; distance += 1) {
      if (samples[center - distance]) {
        center -= distance;
        break;
      }
      if (samples[center + distance]) {
        center += distance;
        break;
      }
    }
  }
  if (!samples[center]) return null;

  const runs = [];
  const gaps = [];
  let index = 0;
  while (index < samples.length) {
    const value = samples[index];
    const start = index;
    while (index < samples.length && samples[index] === value) index += 1;
    const length = index - start;
    if (value) runs.push({ start, end: index - 1, length });
    else if (start > 0 && index < samples.length) gaps.push(length);
  }
  const localRun = runs.find((run) => center >= run.start && center <= run.end);
  if (!localRun) return null;
  const usefulRuns = runs
    .filter((run) => run.start > 0 && run.end < samples.length - 1)
    .map((run) => run.length);
  return {
    inkLength: localRun.length,
    inkLengths: usefulRuns.length ? usefulRuns : [localRun.length],
    minimumInkLength: Math.min(...(usefulRuns.length ? usefulRuns : [localRun.length])),
    maximumInkLength: Math.max(...(usefulRuns.length ? usefulRuns : [localRun.length])),
    medianInkLength: median(usefulRuns.length ? usefulRuns : [localRun.length]),
    gapLength: median(gaps),
    gapLengths: gaps,
    coverage: samples.filter(Boolean).length / samples.length,
  };
}

/**
 * Infer a continuous/dashed/dotted/dash-dot fingerprint around a user click.
 * This is intentionally conservative: ambiguous or steep local evidence stays
 * a continuous line so automatic mode does not manufacture gaps.
 */
export function inferLineStyle({
  rgba,
  width,
  height,
  rect,
  seed,
  target,
  threshold = 15,
  exclusions = [],
  scanRadius = 64,
}) {
  if (!rgba || rgba.length !== width * height * 4 || !rect || !seed || !target) {
    return { style: "line", confidence: 0, reason: "insufficient-input" };
  }
  const options = { rgba, width, height, rect, target, threshold, exclusions };
  const support = [{ x: seed.x, y: seed.y }];
  for (const offset of [-18, -12, -6, 6, 12, 18]) {
    const x = clamp(Math.round(seed.x + offset), rect.left, rect.right);
    const candidates = clusterColumnCandidates(
      rgba, width, x, rect.top, rect.bottom, target, threshold, exclusions,
    );
    const nearest = candidates
      .filter((candidate) => Math.abs(candidate.y - seed.y) <= 28)
      .sort((left, right) => Math.abs(left.y - seed.y) - Math.abs(right.y - seed.y))[0];
    if (nearest) support.push({ x, y: nearest.y });
  }
  const slopeModel = robustLineSlope(support);
  const slope = slopeModel?.slope ?? 0;
  if (Math.abs(slope) > 0.95) {
    return { style: "line", confidence: 0.55, slope, reason: "steep-local-segment" };
  }

  const samples = [];
  for (let offset = -scanRadius; offset <= scanRadius; offset += 1) {
    samples.push(targetPixelPresent(options, seed.x + offset, seed.y + slope * offset, 1));
  }
  const inkRuns = [];
  const gapRuns = [];
  let index = 0;
  while (index < samples.length) {
    const ink = samples[index];
    const start = index;
    while (index < samples.length && samples[index] === ink) index += 1;
    const length = index - start;
    if (start === 0 || index === samples.length) continue;
    (ink ? inkRuns : gapRuns).push(length);
  }
  const coverage = samples.filter(Boolean).length / samples.length;
  const medianInk = median(inkRuns) ?? samples.length;
  const medianGap = median(gapRuns) ?? 0;
  const minimumInk = inkRuns.length ? Math.min(...inkRuns) : medianInk;
  const maximumInk = inkRuns.length ? Math.max(...inkRuns) : medianInk;
  const pattern = { inkRuns, gapRuns, coverage, medianInk, medianGap, minimumInk, maximumInk };
  const dominantContinuousRun = maximumInk >= scanRadius * 0.7
    && maximumInk >= Math.max(12, medianInk * 5);
  if (dominantContinuousRun) {
    return { style: "line", confidence: 0.68, slope, pattern, reason: "dominant-continuous-run" };
  }
  if (inkRuns.length < 3 || gapRuns.length < 2 || medianGap < 1.25 || coverage > 0.82) {
    return { style: "line", confidence: clamp(coverage, 0.55, 0.98), slope, pattern };
  }
  const periodicConfidence = clamp((gapRuns.length / 5) * (1 - coverage) * 2.2, 0.55, 0.97);
  if (medianInk <= 5.5 && maximumInk <= 12) {
    return { style: "dotted", confidence: periodicConfidence, slope, pattern };
  }
  const lengthContrast = maximumInk / Math.max(1, minimumInk);
  const shortRuns = inkRuns.filter((length) => length <= minimumInk * 1.6).length;
  const longRuns = inkRuns.filter((length) => length >= maximumInk * 0.72).length;
  if (lengthContrast >= 2.4 && shortRuns >= 2 && longRuns >= 2) {
    return { style: "dashdot", confidence: periodicConfidence, slope, pattern };
  }
  return { style: "dashed", confidence: periodicConfidence, slope, pattern };
}

function ratioDistance(value, target) {
  if (!Number.isFinite(value) || !Number.isFinite(target) || value <= 0 || target <= 0) return 0;
  return Math.abs(Math.log2(value / target));
}

function patternedLinePenalty(options, candidate, x, slope = 0) {
  if (!isPatternedLineStyle(options.targetStyle) || !options.styleReference) return 0;
  // A horizontal raster scan is not a reliable dash ruler for very steep
  // segments. Geometry and explicit anchors remain the safer evidence there.
  if (Math.abs(slope) > 0.9) return 0;
  const slopeBucket = Math.round(clamp(slope, -3, 3) * 4);
  const key = `${x}:${Math.round(candidate.y)}:${candidate.thickness}:${slopeBucket}`;
  let pattern = options.strokePatternCache?.get(key);
  if (pattern === undefined) {
    pattern = measureStrokePattern(options, { ...candidate, x }, slope);
    options.strokePatternCache?.set(key, pattern);
  }
  if (!pattern) return 18;

  const reference = options.styleReference;
  let inkCost;
  let structureCost = 0;
  if (options.targetStyle === "dashdot") {
    const referenceLengths = reference.inkLengths.length
      ? [Math.min(...reference.inkLengths), Math.max(...reference.inkLengths)]
      : [reference.inkLength];
    inkCost = Math.min(...referenceLengths.map((length) => ratioDistance(pattern.inkLength, length)));
    const referenceContrast = reference.maximumInkLength / Math.max(1, reference.minimumInkLength);
    const candidateContrast = pattern.maximumInkLength / Math.max(1, pattern.minimumInkLength);
    structureCost = ratioDistance(candidateContrast, referenceContrast);
  } else {
    inkCost = ratioDistance(pattern.inkLength, reference.inkLength);
  }
  const gapCost = ratioDistance(pattern.gapLength, reference.gapLength);
  const coverageExcess = Math.max(0, pattern.coverage - (reference.coverage ?? pattern.coverage));
  const severeMismatch = inkCost > 1.25
    || gapCost > 1.5
    || structureCost > 1
    || pattern.coverage > Math.max(0.84, (reference.coverage ?? 0) + 0.42);
  if (severeMismatch) return Infinity;
  return inkCost * 5 + gapCost * 2.4 + structureCost * 5 + coverageExcess * 12;
}

function buildStyleReference(options, point, slope = 0) {
  if (!isPatternedLineStyle(options.targetStyle)) return null;
  if (Math.abs(slope) > 0.9) return null;
  return measureStrokePattern(options, point, slope);
}

function buildAvoidanceByX(paths, rect) {
  const byX = new Map();
  const add = (x, y) => {
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const values = byX.get(x) ?? [];
    if (!values.some((value) => Math.abs(value - y) < 0.5)) values.push(y);
    byX.set(x, values);
  };

  for (const path of paths ?? []) {
    const sorted = (path ?? [])
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      .sort((left, right) => left.x - right.x);
    if (!sorted.length) continue;
    add(Math.round(sorted[0].x), sorted[0].y);
    for (let index = 1; index < sorted.length; index += 1) {
      const left = sorted[index - 1];
      const right = sorted[index];
      const startX = Math.round(left.x);
      const endX = Math.round(right.x);
      if (endX === startX) {
        add(startX, right.y);
        continue;
      }
      for (let x = startX; x <= endX; x += 1) {
        const fraction = (x - left.x) / (right.x - left.x);
        add(x, left.y + clamp(fraction, 0, 1) * (right.y - left.y));
      }
    }
  }
  return byX;
}

function candidateAvoidance(options, candidate, x) {
  const avoidedYs = options.avoidanceByX?.get(x);
  if (!avoidedYs?.length) return { overlaps: false, distance: Infinity, penalty: 0 };
  const radius = options.avoidanceRadius ?? 3;
  const candidateRadius = Math.min(2.5, Math.max(0.5, candidate.thickness / 2));
  const distance = Math.min(...avoidedYs.map((y) => Math.abs(candidate.y - y)));
  const overlapRadius = radius + candidateRadius;
  if (distance > overlapRadius) return { overlaps: false, distance, penalty: 0 };
  // Saved same-colour paths are soft occupancy, not forbidden pixels. A real
  // crossing may legitimately share the same raster pixels for a few columns;
  // continuity decides whether that overlap agrees with the requested path.
  return {
    overlaps: true,
    distance,
    penalty: 2.4 + (1 - distance / Math.max(1, overlapRadius)) * 3.6,
  };
}

function inclusionBridgeAllowed(inclusionMask, width, start, end) {
  if (!inclusionMask?.data) return true;
  const steps = Math.ceil(Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y)));
  const height = inclusionMask.data.length / width;
  const rect = { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  for (let step = 1; step < steps; step += 1) {
    const fraction = step / steps;
    const x = start.x + (end.x - start.x) * fraction;
    const y = start.y + (end.y - start.y) * fraction;
    if (inclusionMaskAllows(inclusionMask, width, x, y)) continue;
    // Scan candidates have not yet undergone stroke-centre/gap refinement.
    // Allow a small preliminary margin at rounded caps, while the final
    // validator still enforces its stricter 1.5 px raster-edge correction.
    // Explicit erasures remain forbidden even within this search margin.
    if (!nearestInclusionPixel(inclusionMask, width, height, x, y, rect, 4)) return false;
  }
  return true;
}

function traceDirection({
  rgba,
  width,
  rect,
  seed,
  target,
  threshold,
  maxJump,
  maxGap,
  direction,
  limit = null,
  exclusions = [],
  targetStyle = "auto",
  styleReference = null,
  strokePatternCache = null,
  initialSlope = null,
  avoidanceByX = null,
  avoidanceRadius = 3,
  inclusionMask = null,
}) {
  const points = [];
  let lastObserved = { x: Math.round(seed.x), y: seed.y };
  let previousObserved = Number.isFinite(initialSlope)
    ? {
        x: lastObserved.x - direction,
        y: lastObserved.y - initialSlope * direction,
      }
    : null;
  let gap = 0;
  const xLimit = limit ?? (direction > 0 ? rect.right : rect.left);
  // Pen supplies an independent spatial constraint. Only in that assisted
  // mode use a short observed tangent to stabilise the dash ruler; leave the
  // ordinary tracer unchanged, especially its curved-pattern behaviour.
  const stabilizePattern = isPatternedLineStyle(targetStyle) && Boolean(inclusionMask?.data);
  const tangentSupport = previousObserved ? [previousObserved, lastObserved] : [lastObserved];

  for (let x = lastObserved.x + direction; direction > 0 ? x <= xLimit : x >= xLimit; x += direction) {
    const columnCandidates = clusterColumnCandidates(
      rgba,
      width,
      x,
      rect.top,
      rect.bottom,
      target,
      threshold,
      exclusions,
      inclusionMask,
    );
    const dx = Math.abs(x - lastObserved.x);
    const velocity = previousObserved
      ? (lastObserved.y - previousObserved.y) / Math.max(1, Math.abs(lastObserved.x - previousObserved.x))
      : 0;
    let patternSlope = velocity;
    if (stabilizePattern && tangentSupport.length >= 3) {
      const meanX = tangentSupport.reduce((sum, p) => sum + p.x, 0) / tangentSupport.length;
      const meanY = tangentSupport.reduce((sum, p) => sum + p.y, 0) / tangentSupport.length;
      const variance = tangentSupport.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
      const slope = variance > 0 ? tangentSupport.reduce((sum, p) => (
        sum + (p.x - meanX) * (p.y - meanY)
      ), 0) / variance : 0;
      const residual = Math.sqrt(tangentSupport.reduce((sum, p) => (
        sum + (p.y - meanY - slope * (p.x - meanX)) ** 2
      ), 0) / tangentSupport.length);
      // Thin, almost horizontal ink (also vertical ink after transposition)
      // alternates flat raster steps with one-pixel jumps. Stabilise only a
      // locally straight ruler, not curved segments or the motion prediction.
      if (Math.abs(slope) <= 0.25 && residual <= 0.55) patternSlope = slope;
    }
    const noisyMode = targetStyle === "noisy";
    const predictedY = lastObserved.y + velocity * dx * (noisyMode ? 0.22 : 1);
    const allowedJump = maxJump * (noisyMode ? 1.6 : 1) * Math.max(1, dx);
    const candidates = columnCandidates.flatMap((candidate) => {
      const avoidance = candidateAvoidance({ avoidanceByX, avoidanceRadius }, candidate, x);
      const jump = Math.abs(candidate.y - predictedY);
      // Reject a remote saved branch, but retain short overlaps that agree with
      // the current trajectory so genuine intersections remain observable.
      if (avoidance.overlaps && jump > Math.max(3, maxJump * 0.42 * Math.max(1, dx))) return [];
      return [{ ...candidate, avoidance }];
    });

    let best = null;
    let bestCost = Infinity;
    let secondBestCost = Infinity;
    for (const candidate of candidates) {
      const jump = Math.abs(candidate.y - predictedY);
      if (jump > allowedJump) continue;
      // Valid endpoints do not make the intervening gap valid. In local Pen
      // mode a remote same-colour axis can be outside an exit gate, yet its
      // straight bridge crosses the protected section. Reject it before it
      // changes the trace velocity or creates inferred pixels outside Pen.
      if (!inclusionBridgeAllowed(inclusionMask, width, lastObserved, { x, y: candidate.y })) continue;
      const thicknessPenalty = candidateThicknessPenalty(candidate, targetStyle);
      const stylePenalty = patternedLinePenalty({
        rgba,
        width,
        rect,
        target,
        threshold,
        exclusions,
        targetStyle,
        styleReference,
        strokePatternCache,
      }, candidate, x, patternSlope);
      if (!Number.isFinite(stylePenalty)) continue;
      const colorPenalty = threshold > 0 ? candidate.distance / threshold : 0;
      const cost = jump * (noisyMode ? 0.58 : 1)
        + colorPenalty * 2
        + thicknessPenalty
        + stylePenalty
        + candidateCorridorPenalty(candidate)
        + candidate.avoidance.penalty;
      if (cost < bestCost) {
        secondBestCost = bestCost;
        bestCost = cost;
        best = candidate;
      } else if (cost < secondBestCost) {
        secondBestCost = cost;
      }
    }

    if (!best) {
      // A user mask is explicit evidence that missing target pixels are caused
      // by an occluder. Do not spend the ordinary dash-gap budget while the
      // predicted trajectory remains inside that mask; resume searching on
      // its far side instead of terminating the whole tail.
      if (!exclusionCoversColumn(exclusions, x, predictedY)) gap += 1;
      if (gap > maxGap) break;
      continue;
    }

    const span = Math.abs(x - lastObserved.x);
    const occlusionBridge = exclusionBridgeBetween(exclusions, lastObserved, { x, y: best.y });
    if (span > 1) {
      for (let offset = 1; offset < span; offset += 1) {
        const fraction = offset / span;
        points.push({
          x: lastObserved.x + direction * offset,
          y: lastObserved.y + (best.y - lastObserved.y) * fraction,
          observed: false,
          confidence: 0.35,
          occlusionMasked: Boolean(occlusionBridge),
        });
      }
    }

    const colorConfidence = clamp(1 - best.distance / Math.max(1, threshold), 0.45, 1);
    const ambiguityMargin = Number.isFinite(secondBestCost) ? secondBestCost - bestCost : maxJump;
    const ambiguityConfidence = clamp(ambiguityMargin / Math.max(2, maxJump * 0.45), 0.42, 1);
    const expectedThickness = isThinLineStyle(targetStyle) ? 4 : 9;
    const thicknessConfidence = clamp(expectedThickness / Math.max(expectedThickness, best.thickness), 0.45, 1);
    const sharedConfidence = best.avoidance.overlaps ? 0.72 : 1;
    const confidence = colorConfidence * ambiguityConfidence * thicknessConfidence * sharedConfidence;
    const point = {
      x,
      y: best.y,
      observed: true,
      confidence,
      candidateCount: candidates.length,
      thickness: best.thickness,
      sharedWithSavedCurve: best.avoidance.overlaps,
      reconnectedAfterOcclusion: Boolean(occlusionBridge),
      occlusionBridgeSpan: occlusionBridge ? span - 1 : 0,
    };
    points.push(point);
    previousObserved = lastObserved;
    lastObserved = point;
    if (stabilizePattern) {
      tangentSupport.push(point);
      while (tangentSupport.length > 3 && (tangentSupport.length > 8
        || Math.abs(point.x - tangentSupport[0].x) > 12)) tangentSupport.shift();
    }
    gap = 0;
  }

  return points;
}

export function traceCurve({
  rgba,
  width,
  height,
  rect,
  seed,
  target,
  threshold = 42,
  maxJump = 14,
  maxGap = 24,
  exclusions = [],
  targetStyle = "auto",
  avoidPaths = [],
  avoidanceRadius = 3,
  inclusionMask = null,
}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  const safeRect = normalizeRect(
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { width, height },
  );
  const safeSeed = {
    ...seed,
    x: clamp(Math.round(seed.x), safeRect.left, safeRect.right),
    y: clamp(seed.y, safeRect.top, safeRect.bottom),
    observed: true,
    confidence: 1,
    anchor: true,
    userGuided: true,
  };

  const options = {
    rgba,
    width,
    rect: safeRect,
    seed: safeSeed,
    target,
    threshold,
    maxJump,
    maxGap,
    exclusions,
    targetStyle,
    avoidanceByX: buildAvoidanceByX(avoidPaths, safeRect),
    avoidanceRadius,
    inclusionMask,
  };
  options.strokePatternCache = new Map();
  options.styleReference = buildStyleReference(options, safeSeed, 0);
  if (Number.isFinite(options.styleReference?.gapLength)) {
    options.maxGap = Math.max(options.maxGap, Math.ceil(options.styleReference.gapLength) + 2);
  }
  // Patterned styles already use a measured dash fingerprint and deliberate
  // gaps; their specialised directional tracker is more selective. Continuous
  // and auto modes benefit from keeping whole-tail branch hypotheses.
  const traceTail = isPatternedLineStyle(options.targetStyle) ? traceDirection : multiHypothesisTraceDirection;
  const left = traceTail({ ...options, direction: -1 }).reverse();
  const right = traceTail({ ...options, direction: 1 });
  return [...left, safeSeed, ...right];
}

function fillPathGaps(points) {
  if (points.length < 2) return points;
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const result = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = result.at(-1);
    const current = sorted[index];
    if (current.x === previous.x) {
      if (current.confidence > previous.confidence) result[result.length - 1] = current;
      continue;
    }
    const span = current.x - previous.x;
    const occlusionBridge = Boolean(
      current.reconnectedAfterOcclusion || previous.reconnectedAfterOcclusion,
    ) && Math.max(current.occlusionBridgeSpan ?? 0, previous.occlusionBridgeSpan ?? 0) >= span - 1;
    for (let offset = 1; offset < span; offset += 1) {
      const fraction = offset / span;
      result.push({
        x: previous.x + offset,
        y: previous.y + (current.y - previous.y) * fraction,
        observed: false,
        confidence: 0.25,
        candidateCount: 0,
        thickness: 0,
        occlusionMasked: occlusionBridge,
      });
    }
    result.push(current);
  }
  return result;
}

function greedyGuidedSegment(options, start, end) {
  if (start.x === end.x) return [{ ...start, anchor: true }];
  const leftAnchor = start.x < end.x ? start : end;
  const rightAnchor = start.x < end.x ? end : start;
  const segmentSlope = (rightAnchor.y - leftAnchor.y) / Math.max(1, rightAnchor.x - leftAnchor.x);
  const forward = [
    { ...leftAnchor, anchor: true },
    ...traceDirection({
      ...options,
      seed: leftAnchor,
      direction: 1,
      limit: Math.round(rightAnchor.x),
      initialSlope: isPatternedLineStyle(options.targetStyle) ? segmentSlope : null,
    }),
  ];
  const backward = [
    ...traceDirection({
      ...options,
      seed: rightAnchor,
      direction: -1,
      limit: Math.round(leftAnchor.x),
      initialSlope: isPatternedLineStyle(options.targetStyle) ? segmentSlope : null,
    }).reverse(),
    { ...rightAnchor, anchor: true },
  ];
  const backwardByX = new Map(backward.map((point) => [point.x, point]));
  let join = null;
  let joinCost = Infinity;
  const midpoint = (leftAnchor.x + rightAnchor.x) / 2;

  for (const point of forward) {
    const other = backwardByX.get(point.x);
    if (!other) continue;
    const topologyCost = Math.abs(point.y - other.y);
    const centerBias = Math.abs(point.x - midpoint) / Math.max(1, rightAnchor.x - leftAnchor.x);
    const confidencePenalty = 1 - Math.min(point.confidence ?? 0, other.confidence ?? 0);
    const cost = topologyCost + centerBias * 0.08 + confidencePenalty * 0.2;
    if (cost < joinCost) {
      joinCost = cost;
      join = point.x;
    }
  }

  if (join === null) {
    return fillPathGaps([...forward, ...backward]);
  }
  return fillPathGaps([
    ...forward.filter((point) => point.x <= join),
    ...backward.filter((point) => point.x > join),
  ]);
}

function candidateToPoint(candidate, x, threshold, candidateCount, targetStyle = "auto") {
  const colorConfidence = clamp(1 - candidate.distance / Math.max(1, threshold), 0.45, 1);
  const expectedThickness = isThinLineStyle(targetStyle) ? 4 : 9;
  const thicknessConfidence = clamp(expectedThickness / Math.max(expectedThickness, candidate.thickness), 0.45, 1);
  return {
    x,
    y: candidate.y,
    observed: true,
    confidence: colorConfidence * thicknessConfidence,
    candidateCount,
    thickness: candidate.thickness,
  };
}

function attachCandidateAmbiguity(point, candidates, selectedCandidate, maximumSeparation = Infinity) {
  if (!point || !Array.isArray(candidates) || candidates.length < 2) return point;
  const selectedY = Number(selectedCandidate?.y ?? point.y);
  const selectedThickness = Math.max(1, Number(selectedCandidate?.thickness ?? point.thickness ?? 1));
  const alternatives = candidates
    .filter((candidate) => candidate !== selectedCandidate && Number.isFinite(candidate?.y))
    .map((candidate) => ({
      y: Number(candidate.y),
      separation: Math.abs(Number(candidate.y) - selectedY),
      thickness: Math.max(1, Number(candidate.thickness ?? 1)),
    }))
    .filter((candidate) => (
      candidate.separation > Math.max(2, (selectedThickness + candidate.thickness) * 0.3)
      && candidate.separation <= maximumSeparation
    ))
    .sort((left, right) => left.separation - right.separation)
    .slice(0, 4);
  if (!alternatives.length) return point;
  point.ambiguityAlternatives = alternatives.map((candidate) => candidate.y);
  point.ambiguitySeparation = alternatives[0].separation;
  point.ambiguitySpread = Math.max(
    ...alternatives.map((candidate) => candidate.separation),
  );
  return point;
}

/**
 * Trace an unconstrained tail with a small Viterbi-style beam. Keeping several
 * slope histories for the same raster candidate is important at crossings:
 * the pixels may merge for a few columns, but evidence after the crossing can
 * still resolve which incoming trajectory should be continued.
 */
function globalTraceDirection({
  rgba,
  width,
  rect,
  seed,
  target,
  threshold,
  maxJump,
  maxGap,
  direction,
  limit = null,
  exclusions = [],
  targetStyle = "auto",
  styleReference = null,
  strokePatternCache = null,
  initialSlope = null,
  avoidanceByX = null,
  avoidanceRadius = 3,
  inclusionMask = null,
}) {
  const options = {
    rgba,
    width,
    rect,
    target,
    threshold,
    maxJump,
    maxGap,
    exclusions,
    targetStyle,
    styleReference,
    strokePatternCache,
    avoidanceByX,
    avoidanceRadius,
    inclusionMask,
  };
  const startX = Math.round(seed.x);
  const xLimit = limit ?? (direction > 0 ? rect.right : rect.left);
  const noisyMode = targetStyle === "noisy";
  let states = [{
    x: startX,
    y: seed.y,
    slope: Number.isFinite(initialSlope) ? initialSlope : null,
    trendSlope: Number.isFinite(initialSlope) ? initialSlope : null,
    cost: 0,
    previous: null,
    point: { ...seed, x: startX, anchor: true },
  }];

  for (let x = startX + direction; direction > 0 ? x <= xLimit : x >= xLimit; x += direction) {
    const candidates = clusterColumnCandidates(
      rgba,
      width,
      x,
      rect.top,
      rect.bottom,
      target,
      threshold,
      exclusions,
      inclusionMask,
    );
    if (!candidates.length) continue;

    const nextStates = [];
    for (const candidate of candidates) {
      const candidateStates = [];
      for (const previous of states) {
        const dx = Math.abs(x - previous.x);
        const occlusionBridge = exclusionBridgeBetween(exclusions, previous, { x, y: candidate.y });
        if (dx > maxGap + 1 && !occlusionBridge) continue;
        if (!inclusionBridgeAllowed(inclusionMask, width, previous, { x, y: candidate.y })) continue;
        const slope = (candidate.y - previous.y) / Math.max(1, x - previous.x);
        const recentSlope = previous.slope ?? slope;
        const trendSlope = previous.trendSlope ?? recentSlope;
        const predictionSlope = recentSlope * (noisyMode ? 0.24 : 0.68)
          + trendSlope * (noisyMode ? 0.08 : 0.32);
        const predictedY = previous.y + predictionSlope * (x - previous.x);
        const jump = Math.abs(candidate.y - predictedY);
        const allowedJump = maxJump * (noisyMode ? 1.6 : 1) * Math.max(1, dx);
        if (jump > allowedJump) continue;

        const avoidance = candidateAvoidance(options, candidate, x);
        if (avoidance.overlaps && jump > Math.max(3, maxJump * 0.42 * Math.max(1, dx))) continue;
        const styleCost = patternedLinePenalty(options, candidate, x, predictionSlope);
        if (!Number.isFinite(styleCost)) continue;
        const colorCost = threshold > 0 ? candidate.distance / threshold : 0;
        const curvature = Math.abs(slope - recentSlope);
        const trendDeparture = Math.abs(slope - trendSlope);
        const cost = previous.cost
          + colorCost * 2.8
          + candidateThicknessPenalty(candidate, targetStyle, 0.8)
          + styleCost
          + candidateCorridorPenalty(candidate)
          + avoidance.penalty
          + jump * (noisyMode ? 0.035 : 0.11)
          + Math.min(20, curvature) * (noisyMode ? 0.1 : 0.64)
          + Math.min(20, trendDeparture) * (noisyMode ? 0.025 : 0.09)
          + Math.max(0, dx - 1) * (isPatternedLineStyle(targetStyle) ? 0.1 : 0.22);
        const point = candidateToPoint(candidate, x, threshold, candidates.length, targetStyle);
        point.confidence *= candidates.length > 1 ? 0.86 : 1;
        point.sharedWithSavedCurve = avoidance.overlaps;
        point.globalHypothesis = true;
        point.reconnectedAfterOcclusion = Boolean(occlusionBridge);
        point.occlusionBridgeSpan = occlusionBridge ? dx - 1 : 0;
        candidateStates.push({
          x,
          y: candidate.y,
          slope,
          trendSlope: trendSlope * (noisyMode ? 0.7 : 0.94) + slope * (noisyMode ? 0.3 : 0.06),
          cost,
          previous,
          point,
        });
      }
      // Preserve several arrival histories at a merged candidate rather than
      // collapsing immediately to the locally cheapest branch.
      candidateStates.sort((left, right) => left.cost - right.cost);
      nextStates.push(...candidateStates.slice(0, 6));
    }
    if (nextStates.length) {
      const viableCandidates = [...new Map(nextStates.map((state) => [
        state.y,
        { y: state.y, thickness: state.point.thickness },
      ])).values()];
      for (const state of nextStates) {
        attachCandidateAmbiguity(
          state.point,
          viableCandidates,
          viableCandidates.find((candidate) => candidate.y === state.y),
          Math.max(8, maxJump * 2.5),
        );
      }
      nextStates.sort((left, right) => left.cost - right.cost);
      states = nextStates.slice(0, 180);
    }
  }

  if (!states.length) return traceDirection({ ...options, seed, direction, limit, initialSlope });
  let cursor = states.sort((left, right) => left.cost - right.cost)[0];
  const points = [];
  while (cursor?.previous) {
    points.push(cursor.point);
    cursor = cursor.previous;
  }
  if (!points.length) return traceDirection({ ...options, seed, direction, limit, initialSlope });
  return fillPathGaps(points.reverse());
}

function multiHypothesisTraceDirection(options) {
  const globalPath = globalTraceDirection(options);
  const limit = options.limit
    ?? (options.direction > 0 ? options.rect.right : options.rect.left);
  const globalEnd = globalPath.at(-1)?.x ?? Math.round(options.seed.x);
  if (Math.abs(limit - globalEnd) <= 1) return globalPath;

  // Highly discontinuous/noisy evidence can exhaust every beam. Preserve the
  // established local behaviour when it reaches materially farther, rather
  // than turning a global optimisation failure into a truncated curve.
  const localPath = traceDirection(options);
  const localEnd = localPath.at(-1)?.x ?? Math.round(options.seed.x);
  return Math.abs(limit - localEnd) < Math.abs(limit - globalEnd) ? localPath : globalPath;
}

function hermiteGuideY(start, end, entrySlope, exitSlope, x) {
  const span = Math.max(1, end.x - start.x);
  const t = clamp((x - start.x) / span, 0, 1);
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * start.y
    + h10 * span * entrySlope
    + h01 * end.y
    + h11 * span * exitSlope;
}

function globalGuidedSegment(options, start, end, {
  entrySlope = null,
  exitSlope = null,
} = {}) {
  if (start.x === end.x) return [{ ...start, anchor: true }];
  const leftAnchor = start.x < end.x ? start : end;
  const rightAnchor = start.x < end.x ? end : start;
  const leftX = Math.round(leftAnchor.x);
  const rightX = Math.round(rightAnchor.x);
  const horizontalSpan = Math.max(1, rightX - leftX);
  const guideTolerance = clamp(horizontalSpan * 0.045, 4, 14);
  const noisyMode = options.targetStyle === "noisy";
  const preserveTrajectoryHistory = !isPatternedLineStyle(options.targetStyle);
  const chordSlope = (rightAnchor.y - leftAnchor.y) / horizontalSpan;
  const safeEntrySlope = Number.isFinite(entrySlope) ? entrySlope : chordSlope;
  const safeExitSlope = Number.isFinite(exitSlope) ? exitSlope : chordSlope;
  let states = [{
    x: leftX,
    y: leftAnchor.y,
    slope: preserveTrajectoryHistory ? safeEntrySlope : null,
    trendSlope: preserveTrajectoryHistory ? safeEntrySlope : null,
    cost: 0,
    previous: null,
    point: { ...leftAnchor, x: leftX, anchor: true },
  }];

  for (let x = leftX + 1; x <= rightX; x += 1) {
    const isEnd = x === rightX;
    const candidates = isEnd
      ? [{ y: rightAnchor.y, thickness: 1, distance: 0, anchor: true }]
      : clusterColumnCandidates(
        options.rgba,
        options.width,
        x,
        options.rect.top,
        options.rect.bottom,
        options.target,
        options.threshold,
        options.exclusions,
        options.inclusionMask,
      );
    if (!candidates.length) continue;

    const nextStates = [];
    for (const candidate of candidates) {
      const candidateStates = [];
      for (const previous of states) {
        const dx = x - previous.x;
        const occlusionBridge = exclusionBridgeBetween(
          options.exclusions,
          previous,
          { x, y: candidate.y },
        );
        // Strict mode lets an explicit anchor bridge a gap longer than the
        // ordinary pixel evidence allows. Flexible mode falls back to the
        // bidirectional guided segment, which still retains both anchors.
        if (
          dx > options.maxGap + 1
          && !(candidate.anchor && options.strictGuideCorridor)
          && !occlusionBridge
        ) continue;
        if (!inclusionBridgeAllowed(options.inclusionMask, options.width, previous, { x, y: candidate.y })) continue;
        const slope = (candidate.y - previous.y) / dx;
        const recentSlope = previous.slope ?? slope;
        const trendSlope = previous.trendSlope ?? recentSlope;
        const predictionSlope = preserveTrajectoryHistory
          ? recentSlope * (noisyMode ? 0.24 : 0.68) + trendSlope * (noisyMode ? 0.08 : 0.32)
          : recentSlope;
        const predictedY = previous.slope === null
          ? previous.y
          : previous.y + predictionSlope * dx;
        const avoidance = candidateAvoidance(options, candidate, x);
        if (
          avoidance.overlaps
          && !candidate.anchor
          && Math.abs(candidate.y - predictedY) > Math.max(3, options.maxJump * 0.42 * Math.max(1, dx))
        ) continue;
        if (
          Math.abs(candidate.y - predictedY) > options.maxJump * (noisyMode ? 1.6 : 1) * Math.max(1, dx)
          && !(candidate.anchor && options.strictGuideCorridor)
        ) continue;
        const curvature = Math.abs(slope - recentSlope);
        const trendDeparture = Math.abs(slope - trendSlope);
        const colorCost = options.threshold > 0 ? candidate.distance / options.threshold : 0;
        const thicknessCost = candidateThicknessPenalty(candidate, options.targetStyle, 0.75);
        const styleCost = candidate.anchor ? 0 : patternedLinePenalty(options, candidate, x, slope);
        if (!Number.isFinite(styleCost)) continue;
        const guideFraction = (x - leftX) / horizontalSpan;
        const guideY = options.strictGuideCorridor || preserveTrajectoryHistory
          ? hermiteGuideY(
              { ...leftAnchor, x: leftX },
              { ...rightAnchor, x: rightX },
              safeEntrySlope,
              safeExitSlope,
              x,
            )
          : leftAnchor.y + guideFraction * (rightAnchor.y - leftAnchor.y);
        const guideDeviation = Math.abs(candidate.y - guideY);
        // A same-color neighboring branch should be treated as "no target
        // pixels here", not as evidence that the requested curve jumped. The
        // missing section will be marked inferred and interpolated between the
        // two anchors. Add more anchors for strongly curved intervals.
        if (options.strictGuideCorridor && !candidate.anchor && guideDeviation > guideTolerance) continue;
        const cost = previous.cost
          + colorCost * 1.4
          + thicknessCost
          + styleCost
          + candidateCorridorPenalty(candidate)
          + avoidance.penalty
          + Math.abs(slope) * (noisyMode ? 0.012 : 0.035)
          + Math.min(20, curvature) * (noisyMode ? 0.12 : 0.72)
          + (preserveTrajectoryHistory ? Math.min(20, trendDeparture) * (noisyMode ? 0.025 : 0.09) : 0)
          + Math.max(0, dx - 1) * 0.11
          // Strict mode rejects remote same-color branches and favors the
          // anchor corridor. Flexible mode still passes through every anchor,
          // but does not linearize naturally curved intervals between them.
          + (options.strictGuideCorridor
            ? guideDeviation * 0.28
            : guideDeviation * (preserveTrajectoryHistory && candidates.length > 1 ? 0.045 : 0))
          + (candidate.anchor && preserveTrajectoryHistory ? Math.abs(slope - safeExitSlope) * 0.32 : 0);
        const point = candidate.anchor
          ? { ...rightAnchor, x, anchor: true }
          : candidateToPoint(candidate, x, options.threshold, candidates.length, options.targetStyle);
        if (!candidate.anchor) {
          point.confidence *= avoidance.overlaps ? 0.72 : 1;
          point.sharedWithSavedCurve = avoidance.overlaps;
        }
        point.reconnectedAfterOcclusion = Boolean(occlusionBridge);
        point.occlusionBridgeSpan = occlusionBridge ? dx - 1 : 0;
        candidateStates.push({
          x,
          y: candidate.y,
          slope,
          trendSlope: preserveTrajectoryHistory
            ? trendSlope * (noisyMode ? 0.7 : 0.94) + slope * (noisyMode ? 0.3 : 0.06)
            : null,
          cost,
          previous,
          point,
        });
      }
      candidateStates.sort((a, b) => a.cost - b.cost);
      nextStates.push(...candidateStates.slice(0, preserveTrajectoryHistory ? 6 : 3));
    }
    if (nextStates.length) {
      const viableCandidates = [...new Map(nextStates.map((state) => [
        state.y,
        { y: state.y, thickness: state.point.thickness },
      ])).values()];
      for (const state of nextStates) {
        if (state.point.anchor) continue;
        attachCandidateAmbiguity(
          state.point,
          viableCandidates,
          viableCandidates.find((candidate) => candidate.y === state.y),
          Math.max(8, options.maxJump * 2.5),
        );
      }
      nextStates.sort((a, b) => a.cost - b.cost);
      states = nextStates.slice(0, preserveTrajectoryHistory ? 180 : 120);
    }
  }

  const completed = states.filter((state) => state.x === rightX);
  if (!completed.length) return null;
  let cursor = completed.sort((a, b) => a.cost - b.cost)[0];
  const points = [];
  while (cursor) {
    points.push(cursor.point);
    cursor = cursor.previous;
  }
  return fillPathGaps(points.reverse());
}

function guidedSegment(options, start, end, context = {}) {
  // A manually placed guide with no matching target-colored pixel is an
  // explicit statement about a hidden curve. Automatically constrain only the
  // adjacent segment, so the user does not also have to find the advanced
  // strict-guidance switch. Visible guides keep the ordinary flexible model.
  const localOptions = start.occlusionGuide || end.occlusionGuide
    ? { ...options, strictGuideCorridor: true }
    : options;
  return globalGuidedSegment(localOptions, start, end, context)
    ?? greedyGuidedSegment(localOptions, start, end);
}

function hasPersistentGuideCompetition({
  rgba,
  width,
  rect,
  anchors,
  target,
  threshold,
  exclusions,
  inclusionMask,
}) {
  const left = Math.max(rect.left, Math.round(Math.min(...anchors.map((anchor) => anchor.x))));
  const right = Math.min(rect.right, Math.round(Math.max(...anchors.map((anchor) => anchor.x))));
  const step = Math.max(1, Math.floor((right - left + 1) / 96));
  let sampledColumns = 0;
  let competingColumns = 0;
  for (let x = left; x <= right; x += step) {
    const candidates = clusterColumnCandidates(
      rgba,
      width,
      x,
      rect.top,
      rect.bottom,
      target,
      threshold,
      exclusions,
      inclusionMask,
    );
    sampledColumns += 1;
    if (candidates.some((candidate, index) => candidates.slice(index + 1).some((other) => (
      Math.abs(candidate.y - other.y) >= Math.max(3, (candidate.thickness + other.thickness) / 2)
    )))) competingColumns += 1;
  }
  return competingColumns >= Math.max(3, Math.ceil(sampledColumns * 0.08));
}

export function traceCurveThroughAnchors({
  rgba,
  width,
  height,
  rect,
  anchors,
  target,
  threshold = 42,
  maxJump = 14,
  maxGap = 24,
  exclusions = [],
  strictGuideCorridor = false,
  targetStyle = "auto",
  avoidPaths = [],
  avoidanceRadius = 3,
  inclusionMask = null,
}) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new Error("At least one curve anchor is required");
  }
  if (anchors.length === 1) {
    return traceCurve({
      rgba,
      width,
      height,
      rect,
      seed: anchors[0],
      target,
      threshold,
      maxJump,
      maxGap,
      exclusions,
      targetStyle,
      avoidPaths,
      avoidanceRadius,
      inclusionMask,
    });
  }

  const safeRect = normalizeRect(
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { width, height },
  );
  const sortedAnchors = anchors
    .map((anchor) => {
      const x = clamp(Math.round(anchor.x), safeRect.left, safeRect.right);
      const y = clamp(anchor.y, safeRect.top, safeRect.bottom);
      const nearbyCandidate = clusterColumnCandidates(
        rgba,
        width,
        x,
        safeRect.top,
        safeRect.bottom,
        target,
        threshold,
        exclusions,
        inclusionMask,
      ).find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, candidate.thickness / 2 + 1));
      return {
        ...anchor,
        x,
        y,
        observed: Boolean(nearbyCandidate),
        confidence: nearbyCandidate ? 1 : 0.55,
        anchor: true,
        userGuided: true,
      };
    })
    .sort((a, b) => a.x - b.x);
  const uniqueAnchors = sortedAnchors.filter((anchor, index) => index === 0 || anchor.x !== sortedAnchors[index - 1].x);
  if (uniqueAnchors.length === 1) {
    return traceCurve({
      rgba,
      width,
      height,
      rect: safeRect,
      seed: uniqueAnchors[0],
      target,
      threshold,
      maxJump,
      maxGap,
      exclusions,
      targetStyle,
      avoidPaths,
      avoidanceRadius,
      inclusionMask,
    });
  }

  const automaticStrictGuidance = isPatternedLineStyle(targetStyle)
    && uniqueAnchors.length >= 3
    && hasPersistentGuideCompetition({
      rgba,
      width,
      rect: safeRect,
      anchors: uniqueAnchors,
      target,
      threshold,
      exclusions,
      inclusionMask,
    });

  const options = {
    rgba,
    width,
    rect: safeRect,
    target,
    threshold,
    maxJump,
    maxGap,
    exclusions,
    targetStyle,
    strictGuideCorridor: Boolean(
      strictGuideCorridor
      || automaticStrictGuidance
    ),
    avoidanceByX: buildAvoidanceByX(avoidPaths, safeRect),
    avoidanceRadius,
    inclusionMask,
  };
  const originalReference = {
    x: clamp(Math.round(anchors[0].x), safeRect.left, safeRect.right),
    y: clamp(anchors[0].y, safeRect.top, safeRect.bottom),
  };
  const referenceNeighbor = anchors
    .slice(1)
    .sort((a, b) => Math.abs(a.x - originalReference.x) - Math.abs(b.x - originalReference.x))[0];
  const referenceSlope = referenceNeighbor && Math.abs(referenceNeighbor.x - originalReference.x) >= 2
    ? (referenceNeighbor.y - originalReference.y) / (referenceNeighbor.x - originalReference.x)
    : 0;
  options.strokePatternCache = new Map();
  options.styleReference = buildStyleReference(options, originalReference, referenceSlope);
  if (Number.isFinite(options.styleReference?.gapLength)) {
    options.maxGap = Math.max(options.maxGap, Math.ceil(options.styleReference.gapLength) + 2);
  }
  const first = uniqueAnchors[0];
  const last = uniqueAnchors.at(-1);
  const leftSlope = (uniqueAnchors[1].y - first.y) / Math.max(1, uniqueAnchors[1].x - first.x);
  const previousAnchor = uniqueAnchors.at(-2);
  const rightSlope = (last.y - previousAnchor.y) / Math.max(1, last.x - previousAnchor.x);
  const leftTail = traceDirection({
    ...options,
    seed: first,
    direction: -1,
    initialSlope: isPatternedLineStyle(options.targetStyle) ? leftSlope : null,
  }).reverse();
  const rightTail = traceDirection({
    ...options,
    seed: last,
    direction: 1,
    initialSlope: isPatternedLineStyle(options.targetStyle) ? rightSlope : null,
  });
  let result = [...leftTail];

  for (let index = 1; index < uniqueAnchors.length; index += 1) {
    const start = uniqueAnchors[index - 1];
    const end = uniqueAnchors[index];
    const before = uniqueAnchors[index - 2];
    const after = uniqueAnchors[index + 1];
    const chordSlope = (end.y - start.y) / Math.max(1, end.x - start.x);
    const entrySlope = before
      ? (end.y - before.y) / Math.max(1, end.x - before.x)
      : chordSlope;
    const exitSlope = after
      ? (after.y - start.y) / Math.max(1, after.x - start.x)
      : chordSlope;
    const segment = guidedSegment(options, start, end, { entrySlope, exitSlope });
    if (result.length && segment.length && result.at(-1).x === segment[0].x) segment.shift();
    result.push(...segment);
  }
  if (result.length && rightTail.length && result.at(-1).x === rightTail[0].x) rightTail.shift();
  result.push(...rightTail);
  return fillPathGaps(result);
}

function bilinearColorAt(rgba, width, height, x, y) {
  const safeX = clamp(x, 0, width - 1);
  const safeY = clamp(y, 0, height - 1);
  const left = Math.floor(safeX);
  const right = Math.min(width - 1, left + 1);
  const top = Math.floor(safeY);
  const bottom = Math.min(height - 1, top + 1);
  const fractionX = safeX - left;
  const fractionY = safeY - top;
  const sample = (channel) => {
    const topLeft = rgba[(top * width + left) * 4 + channel];
    const topRight = rgba[(top * width + right) * 4 + channel];
    const bottomLeft = rgba[(bottom * width + left) * 4 + channel];
    const bottomRight = rgba[(bottom * width + right) * 4 + channel];
    const topValue = topLeft + (topRight - topLeft) * fractionX;
    const bottomValue = bottomLeft + (bottomRight - bottomLeft) * fractionX;
    return topValue + (bottomValue - topValue) * fractionY;
  };
  return {
    r: sample(0),
    g: sample(1),
    b: sample(2),
    a: sample(3),
  };
}

function targetInkAffinity({
  rgba,
  width,
  height,
  rect,
  target,
  threshold,
  exclusions,
  inclusionMask,
}, x, y) {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return 0;
  if ((exclusions ?? []).some((area) => (
    x >= area.left && x <= area.right && y >= area.top && y <= area.bottom
  ))) return 0;
  if (!inclusionMaskAllows(inclusionMask, width, x, y)) return 0;
  const color = bilinearColorAt(rgba, width, height, x, y);
  if (color.a < 32) return 0;
  const distance = compositedColorDistance(color.r, color.g, color.b, target);
  if (!Number.isFinite(distance) || distance > threshold + 4) return 0;
  const targetInk = Math.hypot(255 - target.r, 255 - target.g, 255 - target.b);
  const pixelInk = Math.hypot(255 - color.r, 255 - color.g, 255 - color.b);
  const coverage = targetInk > 7 ? clamp(pixelInk / targetInk, 0, 1.25) : 1;
  const colorAgreement = clamp(1 - distance / Math.max(5, threshold + 4), 0, 1);
  return coverage * colorAgreement ** 2 * clamp(color.a / 255, 0, 1);
}

function localPathSlope(path, index, radius = 4) {
  const slopes = [];
  const start = Math.max(0, index - radius);
  const end = Math.min(path.length - 1, index + radius);
  for (let cursor = start + 1; cursor <= end; cursor += 1) {
    const left = path[cursor - 1];
    const right = path[cursor];
    const dx = right.x - left.x;
    if (Math.abs(dx) < 1e-9) continue;
    slopes.push((right.y - left.y) / dx);
  }
  return median(slopes) ?? 0;
}

/**
 * Move observed trace points to the weighted center of the target-colored
 * stroke. Sampling is performed along the local curve normal rather than only
 * within a vertical image column, which avoids the systematic bias of thick,
 * slanted, or asymmetrically antialiased lines.
 */
export function refinePathCenterline({
  rgba,
  width,
  height,
  path,
  target,
  threshold = 15,
  rect = { left: 0, top: 0, right: width - 1, bottom: height - 1 },
  exclusions = [],
  iterations = 2,
  inclusionMask = null,
}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  if (!Array.isArray(path) || !path.length) return [];
  const safeRect = normalizeRect(
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { width, height },
  );
  const observedThicknesses = path
    .filter((point) => point.observed && !point.anchor && Number.isFinite(point.thickness) && point.thickness > 0)
    .map((point) => point.thickness);
  const typicalVerticalThickness = median(observedThicknesses) ?? 2;
  const passCount = clamp(Math.round(iterations), 1, 3);
  let refined = path.map((point) => ({ ...point }));

  for (let pass = 0; pass < passCount; pass += 1) {
    refined = refined.map((point, index) => {
      // A guide point is a user-owned constraint. It must never be silently
      // moved, even when its click position is not the image-mask centroid.
      if (point.anchor || !point.observed) return point;
      const slope = clamp(localPathSlope(refined, index), -8, 8);
      const normalScale = Math.hypot(1, slope);
      const normalX = -slope / normalScale;
      const normalY = 1 / normalScale;
      const trustedVerticalThickness = Math.min(
        point.thickness ?? typicalVerticalThickness,
        Math.max(typicalVerticalThickness * 1.8, typicalVerticalThickness + 2),
      );
      const normalThickness = trustedVerticalThickness / normalScale;
      const scanRadius = clamp(normalThickness / 2 + 2, 2.5, 8);
      const samples = [];
      for (let offset = -scanRadius; offset <= scanRadius + 1e-9; offset += 0.5) {
        samples.push({
          offset,
          affinity: targetInkAffinity({
            rgba,
            width,
            height,
            rect: safeRect,
            target,
            threshold,
            exclusions,
            inclusionMask,
          }, point.x + normalX * offset, point.y + normalY * offset),
        });
      }

      const centerIndex = samples.reduce((best, sample, sampleIndex) => (
        Math.abs(sample.offset) < Math.abs(samples[best].offset) ? sampleIndex : best
      ), 0);
      let seedIndex = centerIndex;
      if (samples[seedIndex].affinity < 0.025) {
        let bestDistance = Infinity;
        for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
          if (samples[sampleIndex].affinity < 0.025) continue;
          const distance = Math.abs(samples[sampleIndex].offset);
          if (distance < bestDistance) {
            bestDistance = distance;
            seedIndex = sampleIndex;
          }
        }
        if (!Number.isFinite(bestDistance) || bestDistance > 1.5) return point;
      }

      let componentStart = seedIndex;
      let componentEnd = seedIndex;
      while (componentStart > 0 && samples[componentStart - 1].affinity >= 0.025) componentStart -= 1;
      while (componentEnd + 1 < samples.length && samples[componentEnd + 1].affinity >= 0.025) componentEnd += 1;
      let totalAffinity = 0;
      let weightedOffset = 0;
      for (let sampleIndex = componentStart; sampleIndex <= componentEnd; sampleIndex += 1) {
        const sample = samples[sampleIndex];
        totalAffinity += sample.affinity;
        weightedOffset += sample.offset * sample.affinity;
      }
      if (totalAffinity < 0.15) return point;
      const normalOffset = clamp(weightedOffset / totalAffinity, -scanRadius / 2, scanRadius / 2);
      const y = clamp(point.y + normalOffset * normalY, safeRect.top, safeRect.bottom);
      return {
        ...point,
        y,
        centerRefined: true,
        centerShift: (point.centerShift ?? 0) + (y - point.y),
      };
    });
  }
  return refined;
}

function robustLineSlope(points) {
  const slopes = [];
  for (let leftIndex = 0; leftIndex < points.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < points.length; rightIndex += 1) {
      const dx = points[rightIndex].x - points[leftIndex].x;
      if (Math.abs(dx) < 2) continue;
      slopes.push((points[rightIndex].y - points[leftIndex].y) / dx);
    }
  }
  const slope = median(slopes);
  if (!Number.isFinite(slope)) return null;
  const intercept = median(points.map((point) => point.y - slope * point.x));
  const absoluteResiduals = points.map((point) => Math.abs(point.y - (slope * point.x + intercept)));
  return {
    slope,
    residual: (median(absoluteResiduals) ?? 0) * 1.4826,
  };
}

function collectGapSupport(path, boundaryIndex, direction, gapSpan, typicalThickness) {
  const support = [];
  const boundaryX = path[boundaryIndex].x;
  const maximumSpan = clamp(gapSpan * 1.75, 14, 52);
  const maximumSupportPoints = clamp(Math.ceil(gapSpan * 0.75), 14, 28);
  for (
    let index = boundaryIndex;
    index >= 0 && index < path.length && support.length < maximumSupportPoints;
    index += direction
  ) {
    const point = path[index];
    if (Math.abs(point.x - boundaryX) > maximumSpan) break;
    const reliableThickness = !Number.isFinite(point.thickness)
      || point.thickness <= Math.max(typicalThickness * 1.8, typicalThickness + 3);
    const reliable = point.anchor
      || (point.observed && (point.confidence ?? 0) >= 0.52 && reliableThickness);
    if (reliable || index === boundaryIndex) support.push(point);
  }
  return support.sort((left, right) => left.x - right.x);
}

function solveSmallLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    if (Math.abs(augmented[best][pivot]) < 1e-10) return null;
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = pivot; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivot][column];
      }
    }
  }
  return augmented.map((row) => row[size]);
}

function robustQuadraticTrend(points, center, scale) {
  if (points.length < 5 || !(scale > 0)) return null;
  let weights = points.map((point) => clamp(point.confidence ?? 1, 0.35, 1));
  let coefficients = null;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const matrix = Array.from({ length: 3 }, () => Array(3).fill(0));
    const vector = Array(3).fill(0);
    for (let index = 0; index < points.length; index += 1) {
      const z = (points[index].x - center) / scale;
      const powers = [1, z, z ** 2, z ** 3, z ** 4];
      const weight = weights[index];
      for (let row = 0; row < 3; row += 1) {
        vector[row] += weight * points[index].y * powers[row];
        for (let column = 0; column < 3; column += 1) {
          matrix[row][column] += weight * powers[row + column];
        }
      }
    }
    coefficients = solveSmallLinearSystem(matrix, vector);
    if (!coefficients) return null;
    const residuals = points.map((point) => {
      const z = (point.x - center) / scale;
      return point.y - (coefficients[0] + coefficients[1] * z + coefficients[2] * z ** 2);
    });
    const robustScale = Math.max(0.35, (median(residuals.map(Math.abs)) ?? 0) * 1.4826);
    weights = residuals.map((residual, index) => {
      const normalized = Math.abs(residual) / (robustScale * 2.5);
      return clamp(points[index].confidence ?? 1, 0.35, 1) / (1 + normalized ** 2);
    });
  }
  return {
    predict(x) {
      const z = (x - center) / scale;
      return coefficients[0] + coefficients[1] * z + coefficients[2] * z ** 2;
    },
    slope(x) {
      const z = (x - center) / scale;
      return (coefficients[1] + 2 * coefficients[2] * z) / scale;
    },
  };
}

function createGapModels({
  leftBoundary,
  rightBoundary,
  leftModel,
  rightModel,
  support,
}) {
  const gapSpan = rightBoundary.x - leftBoundary.x;
  const chordSlope = (rightBoundary.y - leftBoundary.y) / gapSpan;
  const fractionAt = (x) => (x - leftBoundary.x) / gapSpan;
  const linear = {
    name: "linear",
    prior: 1.15,
    predict(x) {
      return leftBoundary.y + fractionAt(x) * (rightBoundary.y - leftBoundary.y);
    },
    slope() {
      return chordSlope;
    },
  };
  const hermite = {
    name: "hermite",
    prior: 1,
    predict(x) {
      const fraction = fractionAt(x);
      const fractionSquared = fraction ** 2;
      const fractionCubed = fraction ** 3;
      return (2 * fractionCubed - 3 * fractionSquared + 1) * leftBoundary.y
        + (fractionCubed - 2 * fractionSquared + fraction) * gapSpan * leftModel.slope
        + (-2 * fractionCubed + 3 * fractionSquared) * rightBoundary.y
        + (fractionCubed - fractionSquared) * gapSpan * rightModel.slope;
    },
    slope(x) {
      const fraction = fractionAt(x);
      return ((6 * fraction ** 2 - 6 * fraction) * leftBoundary.y
        + (3 * fraction ** 2 - 4 * fraction + 1) * gapSpan * leftModel.slope
        + (-6 * fraction ** 2 + 6 * fraction) * rightBoundary.y
        + (3 * fraction ** 2 - 2 * fraction) * gapSpan * rightModel.slope) / gapSpan;
    },
  };
  const supportSpan = Math.max(1, Math.min(
    leftBoundary.x - support[0].x,
    support.at(-1).x - rightBoundary.x,
  ));
  const supportReliability = clamp(supportSpan / Math.max(4, gapSpan * 0.7), 0, 1)
    * clamp(1 - Math.max(leftModel.residual, rightModel.residual) / 4, 0.2, 1);
  const tangentWeight = clamp(0.3 + supportReliability * 0.62, 0.3, 0.92);
  // Shrink only the slope departure from the endpoint chord. This preserves
  // the exact boundary values and the broad trend while preventing noisy
  // one-sided slopes from creating a large cubic overshoot in a long gap.
  const maximumSlopeDeparture = Math.max(0.35, Math.abs(chordSlope) * 1.5, 30 / gapSpan);
  const regularizedLeftSlope = chordSlope + clamp(
    (leftModel.slope - chordSlope) * tangentWeight,
    -maximumSlopeDeparture,
    maximumSlopeDeparture,
  );
  const regularizedRightSlope = chordSlope + clamp(
    (rightModel.slope - chordSlope) * tangentWeight,
    -maximumSlopeDeparture,
    maximumSlopeDeparture,
  );
  const regularizedSmooth = {
    name: "regularized-smooth",
    // Prefer the regularized bridge when endpoint evidence is short or noisy;
    // on long, clean support it remains a conservative alternative without
    // diluting a clearly superior Hermite/quadratic continuation.
    prior: supportReliability < 0.72 ? 1.12 : 0.2,
    predict(x) {
      return hermiteGuideY(
        leftBoundary,
        rightBoundary,
        regularizedLeftSlope,
        regularizedRightSlope,
        x,
      );
    },
    slope(x) {
      const fraction = fractionAt(x);
      return ((6 * fraction ** 2 - 6 * fraction) * leftBoundary.y
        + (3 * fraction ** 2 - 4 * fraction + 1) * gapSpan * regularizedLeftSlope
        + (-6 * fraction ** 2 + 6 * fraction) * rightBoundary.y
        + (3 * fraction ** 2 - 2 * fraction) * gapSpan * regularizedRightSlope) / gapSpan;
    },
  };
  // Short missing runs are normally antialiasing or dash gaps; the extra
  // regularization is intended for genuinely unsupported occlusion spans.
  const models = gapSpan >= 16
    ? [linear, regularizedSmooth, hermite]
    : [linear, hermite];
  const center = (leftBoundary.x + rightBoundary.x) / 2;
  const scale = Math.max(gapSpan / 2, 1);
  const quadraticTrend = robustQuadraticTrend(support, center, scale);
  if (quadraticTrend) {
    const leftCorrection = leftBoundary.y - quadraticTrend.predict(leftBoundary.x);
    const rightCorrection = rightBoundary.y - quadraticTrend.predict(rightBoundary.x);
    models.push({
      name: "quadratic",
      prior: 1,
      predict(x) {
        const fraction = fractionAt(x);
        return quadraticTrend.predict(x)
          + (1 - fraction) * leftCorrection
          + fraction * rightCorrection;
      },
      slope(x) {
        return quadraticTrend.slope(x) + (rightCorrection - leftCorrection) / gapSpan;
      },
    });
  }
  return models;
}

function scoreGapModel(model, support, {
  leftBoundary,
  rightBoundary,
  leftSlope,
  rightSlope,
  gapSpan,
  typicalThickness,
}) {
  const evaluationSpan = Math.max(8, gapSpan * 0.8);
  const evaluationPoints = support.filter((point) => (
    point.x >= leftBoundary.x - evaluationSpan
    && point.x <= rightBoundary.x + evaluationSpan
  ));
  const residuals = evaluationPoints.map((point) => Math.abs(model.predict(point.x) - point.y));
  const robustResidual = median(residuals) ?? Infinity;
  const clippedMean = residuals.length
    ? residuals.reduce((sum, residual) => sum + Math.min(residual, typicalThickness * 4 + 6), 0) / residuals.length
    : Infinity;
  const slopeScale = Math.min(12, Math.max(3, gapSpan * 0.3));
  const slopeMismatch = (
    Math.abs(model.slope(leftBoundary.x) - leftSlope)
    + Math.abs(model.slope(rightBoundary.x) - rightSlope)
  ) * slopeScale * 0.22;
  return robustResidual + clippedMean * 0.35 + slopeMismatch;
}

/**
 * Replace only pixel-unobserved gaps with an evidence-weighted local model
 * ensemble. A conservative line, regularized smooth bridge, unconstrained
 * Hermite curve, and robust quadratic trend compete against reliable pixels
 * on both sides. Disagreement and distance from observed evidence are
 * propagated into uncertainty instead of being hidden behind one fit.
 */
export function fitInferredPathGaps(path, {
  rect = null,
  minimumSupport = 4,
} = {}) {
  if (!Array.isArray(path) || path.length < 3) return (path ?? []).map((point) => ({ ...point }));
  const refined = path.map((point) => ({ ...point }));
  const typicalThickness = median(refined
    .filter((point) => point.observed && Number.isFinite(point.thickness) && point.thickness > 0)
    .map((point) => point.thickness)) ?? 2;
  const needsInference = (point) => {
    if (point.anchor) return false;
    if (!point.observed) return true;
    const multipleFragments = (point.candidateCount ?? 1) > 1;
    const unusuallyThick = Number.isFinite(point.thickness)
      && point.thickness > Math.max(typicalThickness * 1.8, typicalThickness + 3);
    // A crossing often leaves two target-colored edge fragments, or merges
    // same-color strokes into an abnormally thick blob. Only replace these
    // image pixels when the path scorer also judged them ambiguous.
    return (point.confidence ?? 1) < 0.48 && (multipleFragments || unusuallyThick);
  };
  let index = 0;

  while (index < refined.length) {
    if (!needsInference(refined[index])) {
      index += 1;
      continue;
    }
    const gapStart = index;
    while (index + 1 < refined.length && needsInference(refined[index + 1])) {
      index += 1;
    }
    const gapEnd = index;
    const leftIndex = gapStart - 1;
    const rightIndex = gapEnd + 1;
    index += 1;
    if (leftIndex < 0 || rightIndex >= refined.length) continue;

    const leftBoundary = refined[leftIndex];
    const rightBoundary = refined[rightIndex];
    const gapSpan = rightBoundary.x - leftBoundary.x;
    if (!(gapSpan > 1)) continue;
    const leftSupport = collectGapSupport(refined, leftIndex, -1, gapSpan, typicalThickness);
    const rightSupport = collectGapSupport(refined, rightIndex, 1, gapSpan, typicalThickness);
    if (leftSupport.length < minimumSupport || rightSupport.length < minimumSupport) continue;
    const leftModel = robustLineSlope(leftSupport);
    const rightModel = robustLineSlope(rightSupport);
    if (!leftModel || !rightModel) continue;
    const supportSpan = Math.min(
      leftBoundary.x - leftSupport[0].x,
      rightSupport.at(-1).x - rightBoundary.x,
    );
    if (supportSpan < 3) continue;
    const residualTolerance = Math.max(1.25, typicalThickness * 0.7);
    const residualReliability = clamp(
      1 - Math.max(leftModel.residual, rightModel.residual) / residualTolerance,
      0,
      1,
    );
    const spanReliability = clamp(supportSpan / Math.max(4, gapSpan * 0.7), 0, 1);
    let blend = residualReliability * spanReliability;

    const support = [...leftSupport, ...rightSupport];
    const models = createGapModels({
      leftBoundary,
      rightBoundary,
      leftModel,
      rightModel,
      support,
    });
    const scoredModels = models.map((model) => ({
      ...model,
      score: scoreGapModel(model, support, {
        leftBoundary,
        rightBoundary,
        leftSlope: leftModel.slope,
        rightSlope: rightModel.slope,
        gapSpan,
        typicalThickness,
      }),
    }));
    const bestScore = Math.min(...scoredModels.map((model) => model.score));
    const modelTemperature = Math.max(
      0.75,
      typicalThickness * 0.4,
      Math.max(leftModel.residual, rightModel.residual),
    );
    const viableModels = scoredModels.filter((model) => model.score <= bestScore + modelTemperature * 4);
    const totalModelWeight = viableModels.reduce((sum, model) => {
      model.rawWeight = model.prior * Math.exp(-(model.score - bestScore) / modelTemperature);
      return sum + model.rawWeight;
    }, 0);
    for (const model of viableModels) model.weight = model.rawWeight / totalModelWeight;
    const dominantModel = [...viableModels].sort((left, right) => right.weight - left.weight)[0];
    const modelFitReliability = clamp(1 - bestScore / Math.max(3, residualTolerance * 4), 0, 1);
    // Curved but clean support can make a local straight-line residual look
    // poor even when the robust quadratic explains both sides very well.
    // Let cross-model support evidence recover confidence independently.
    blend = Math.max(blend, modelFitReliability * spanReliability * 0.9);
    const predictions = [];
    let maximumCurveDeviation = 0;
    for (let cursor = gapStart; cursor <= gapEnd; cursor += 1) {
      const point = refined[cursor];
      const fraction = (point.x - leftBoundary.x) / gapSpan;
      const linearY = leftBoundary.y + fraction * (rightBoundary.y - leftBoundary.y);
      const modelPredictions = viableModels.map((model) => ({
        name: model.name,
        weight: model.weight,
        y: model.predict(point.x),
      }));
      const ensembleY = modelPredictions.reduce((sum, model) => sum + model.y * model.weight, 0);
      const modelDisagreement = Math.sqrt(modelPredictions.reduce((sum, model) => (
        sum + model.weight * (model.y - ensembleY) ** 2
      ), 0));
      maximumCurveDeviation = Math.max(maximumCurveDeviation, Math.abs(ensembleY - linearY));
      predictions.push({ cursor, ensembleY, linearY, fraction, modelDisagreement });
    }
    const allowedDeviation = clamp(gapSpan * 0.2, 2.5, 18);
    if (maximumCurveDeviation * blend > allowedDeviation) {
      blend *= allowedDeviation / (maximumCurveDeviation * blend);
    }
    if (blend < 0.12) continue;

    for (const prediction of predictions) {
      const point = refined[prediction.cursor];
      const fittedY = prediction.linearY + (prediction.ensembleY - prediction.linearY) * blend;
      const centerWeight = 4 * prediction.fraction * (1 - prediction.fraction);
      const modelResidual = Math.max(leftModel.residual, rightModel.residual);
      const unsupportedDistance = Math.min(
        point.x - leftBoundary.x,
        rightBoundary.x - point.x,
      );
      const distanceUncertainty = Math.sqrt(Math.max(0, unsupportedDistance)) * 0.22
        + unsupportedDistance * (0.012 + modelResidual * 0.008);
      const inferenceUncertainty = clamp(
        typicalThickness * 0.5
          + modelResidual
          + distanceUncertainty
          + centerWeight * (
            prediction.modelDisagreement * Math.max(0.6, blend)
            + (1 - blend) * allowedDeviation * 0.45
            + gapSpan * 0.012
          ),
        1,
        24,
      );
      refined[prediction.cursor] = {
        ...point,
        y: rect ? clamp(fittedY, rect.top, rect.bottom) : fittedY,
        imageObserved: Boolean(point.observed || point.imageObserved),
        observed: false,
        confidence: clamp(
          0.5 + blend * 0.08 - inferenceUncertainty * 0.035,
          0.16,
          0.45,
        ),
        occlusionInferred: true,
        inferenceMethod: "adaptive-local-ensemble",
        inferenceModel: dominantModel.name,
        inferenceModelWeights: Object.fromEntries(viableModels.map((model) => [
          model.name,
          Number(model.weight.toFixed(6)),
        ])),
        inferenceModelScore: bestScore,
        modelDisagreement: prediction.modelDisagreement,
        fitBlend: blend,
        fitSupport: leftSupport.length + rightSupport.length,
        unsupportedDistance,
        boundedByGuide: Boolean(leftBoundary.anchor || rightBoundary.anchor),
        inferenceUncertainty,
      };
    }
  }
  return refined;
}

function guideYAtX(anchors, x) {
  if (!anchors?.length) return null;
  if (anchors.length === 1) return anchors[0].y;
  const sorted = [...anchors].sort((a, b) => a.x - b.x);
  let left = sorted[0];
  let right = sorted[1];
  if (x >= sorted.at(-1).x) {
    left = sorted.at(-2);
    right = sorted.at(-1);
  } else if (x > sorted[0].x) {
    for (let index = 1; index < sorted.length; index += 1) {
      if (x <= sorted[index].x) {
        left = sorted[index - 1];
        right = sorted[index];
        break;
      }
    }
  }
  const fraction = right.x === left.x ? 0 : (x - left.x) / (right.x - left.x);
  return left.y + fraction * (right.y - left.y);
}

function markerDistanceTransform(mask, width, height) {
  const distances = new Float32Array(mask.length);
  const diagonal = Math.SQRT2;
  const infinity = width + height + 1;
  for (let index = 0; index < mask.length; index += 1) {
    distances[index] = mask[index] ? infinity : 0;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      let distance = Math.min(x + 1, y + 1);
      if (x > 0) distance = Math.min(distance, distances[index - 1] + 1);
      if (y > 0) distance = Math.min(distance, distances[index - width] + 1);
      if (x > 0 && y > 0) distance = Math.min(distance, distances[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) distance = Math.min(distance, distances[index - width + 1] + diagonal);
      distances[index] = distance;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      let distance = Math.min(distances[index], width - x, height - y);
      if (x + 1 < width) distance = Math.min(distance, distances[index + 1] + 1);
      if (y + 1 < height) distance = Math.min(distance, distances[index + width] + 1);
      if (x + 1 < width && y + 1 < height) distance = Math.min(distance, distances[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) distance = Math.min(distance, distances[index + width - 1] + diagonal);
      distances[index] = distance;
    }
  }
  return distances;
}

function markerDiskFill(mask, width, height, centerX, centerY, radius) {
  let filled = 0;
  let total = 0;
  const radiusSquared = radius ** 2;
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    const y = centerY + offsetY;
    if (y < 0 || y >= height) continue;
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if (offsetX ** 2 + offsetY ** 2 > radiusSquared) continue;
      const x = centerX + offsetX;
      if (x < 0 || x >= width) continue;
      total += 1;
      if (mask[y * width + x]) filled += 1;
    }
  }
  return total ? filled / total : 0;
}

function consolidateRegularMarkerGrid(knownMarkers, candidates, estimatedDiameter) {
  if (knownMarkers.length < 5) return null;
  const known = [...knownMarkers].sort((left, right) => left.x - right.x);
  const gaps = known.slice(1)
    .map((point, index) => point.x - known[index].x)
    .filter((gap) => gap >= Math.max(2, estimatedDiameter * 0.45) && gap <= estimatedDiameter * 2.2);
  if (gaps.length < 4) return null;
  const initialSpacing = median(gaps);
  const inlierTolerance = Math.max(1.25, initialSpacing * 0.24);
  const inlierGaps = gaps.filter((gap) => Math.abs(gap - initialSpacing) <= inlierTolerance);
  if (inlierGaps.length / gaps.length < 0.72) return null;
  const spacing = median(inlierGaps);
  if (!(spacing > 0)) return null;

  const referenceX = known[0].x;
  const maximumPhaseError = Math.max(2.2, spacing * 0.44);
  const buckets = new Map();
  const knownSet = new Set(knownMarkers);
  for (const candidate of [...knownMarkers, ...candidates]) {
    const gridIndex = Math.round((candidate.x - referenceX) / spacing);
    const expectedX = referenceX + gridIndex * spacing;
    const phaseError = Math.abs(candidate.x - expectedX);
    if (phaseError > maximumPhaseError) continue;
    if (!buckets.has(gridIndex)) buckets.set(gridIndex, []);
    buckets.get(gridIndex).push({ candidate, phaseError, known: knownSet.has(candidate) });
  }

  const selectedByIndex = new Map();
  for (const [gridIndex, options] of buckets) {
    const trusted = options.filter((option) => option.known);
    if (!trusted.length) continue;
    trusted.sort((left, right) => (
      (right.candidate.confidence ?? 0) - (left.candidate.confidence ?? 0)
      || left.phaseError - right.phaseError
    ));
    selectedByIndex.set(gridIndex, trusted[0].candidate);
  }
  const trustedIndices = [...selectedByIndex.keys()].sort((left, right) => left - right);
  if (!trustedIndices.length) return null;

  const chooseCandidate = (gridIndex, direction) => {
    const options = buckets.get(gridIndex);
    if (!options?.length) return;
    const previousIndices = [...selectedByIndex.keys()]
      .filter((index) => direction > 0 ? index < gridIndex : index > gridIndex)
      .sort((left, right) => direction > 0 ? right - left : left - right);
    let predictedY = null;
    if (previousIndices.length >= 2) {
      const nearIndex = previousIndices[0];
      const farIndex = previousIndices[1];
      const near = selectedByIndex.get(nearIndex);
      const far = selectedByIndex.get(farIndex);
      const indexSpan = nearIndex - farIndex;
      const slope = indexSpan ? (near.y - far.y) / indexSpan : 0;
      predictedY = near.y + slope * (gridIndex - nearIndex);
    } else if (previousIndices.length === 1) {
      predictedY = selectedByIndex.get(previousIndices[0]).y;
    }
    options.sort((left, right) => {
      const score = (option) => {
        const shapeScore = option.candidate.markerScore
          ?? ((option.candidate.thickness ?? estimatedDiameter) + (option.candidate.confidence ?? 0));
        const continuityPenalty = predictedY === null ? 0 : Math.abs(option.candidate.y - predictedY) * 0.72;
        return shapeScore - continuityPenalty - option.phaseError * 0.18;
      };
      return score(right) - score(left);
    });
    selectedByIndex.set(gridIndex, options[0].candidate);
  };

  const allIndices = [...buckets.keys()].sort((left, right) => left - right);
  const minimumTrustedIndex = trustedIndices[0];
  const maximumTrustedIndex = trustedIndices.at(-1);
  for (const gridIndex of allIndices) {
    if (gridIndex > maximumTrustedIndex) chooseCandidate(gridIndex, 1);
  }
  for (let index = allIndices.length - 1; index >= 0; index -= 1) {
    const gridIndex = allIndices[index];
    if (gridIndex < minimumTrustedIndex) chooseCandidate(gridIndex, -1);
  }
  for (const gridIndex of allIndices) {
    if (!selectedByIndex.has(gridIndex)) chooseCandidate(gridIndex, 1);
  }
  return [...selectedByIndex.values()].sort((left, right) => left.x - right.x);
}

function attachedMarkerCenters({
  mask,
  width,
  height,
  safeRect,
  anchors,
  strictGuideCorridor,
  knownMarkers,
  estimatedDiameter,
}) {
  const distances = markerDistanceTransform(mask, width, height);
  // Ordinary antialiased plot strokes are commonly 1–4 px thick. Requiring a
  // core radius above a two-pixel stroke prevents a plain solid curve from
  // turning into a row of synthetic markers, while filled marker disks retain
  // a substantially thicker local core even when attached to that stroke.
  const coreThreshold = Math.max(2.25, estimatedDiameter * 0.36);
  const supportRadius = clamp(Math.round(estimatedDiameter * 0.48), 2, 14);
  const refineRadius = clamp(Math.round(estimatedDiameter * 0.28), 1, 6);
  const candidates = [];

  for (let localY = 1; localY < height - 1; localY += 1) {
    const y = safeRect.top + localY;
    for (let localX = 1; localX < width - 1; localX += 1) {
      const index = localY * width + localX;
      const coreDistance = distances[index];
      if (coreDistance < coreThreshold) continue;

      let localMaximum = true;
      for (let offsetY = -2; offsetY <= 2 && localMaximum; offsetY += 1) {
        const neighborY = localY + offsetY;
        if (neighborY < 0 || neighborY >= height) continue;
        for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
          const neighborX = localX + offsetX;
          if (neighborX < 0 || neighborX >= width) continue;
          if (distances[neighborY * width + neighborX] > coreDistance + 0.05) {
            localMaximum = false;
            break;
          }
        }
      }
      if (!localMaximum) continue;

      let weightedX = 0;
      let weightedY = 0;
      let totalWeight = 0;
      for (let offsetY = -refineRadius; offsetY <= refineRadius; offsetY += 1) {
        const neighborY = localY + offsetY;
        if (neighborY < 0 || neighborY >= height) continue;
        for (let offsetX = -refineRadius; offsetX <= refineRadius; offsetX += 1) {
          const neighborX = localX + offsetX;
          if (neighborX < 0 || neighborX >= width) continue;
          const distance = distances[neighborY * width + neighborX];
          if (distance < coreThreshold) continue;
          const weight = distance ** 2;
          weightedX += neighborX * weight;
          weightedY += neighborY * weight;
          totalWeight += weight;
        }
      }
      const refinedX = totalWeight ? weightedX / totalWeight : localX;
      const refinedY = totalWeight ? weightedY / totalWeight : localY;
      const x = safeRect.left + refinedX;
      const refinedGlobalY = safeRect.top + refinedY;

      if (anchors.length >= 2) {
        const guideY = guideYAtX(anchors, x);
        const tolerance = strictGuideCorridor
          ? clamp(safeRect.width * 0.018, 5, 16)
          : clamp(safeRect.height * 0.12, 14, 42);
        if (Math.abs(refinedGlobalY - guideY) > tolerance) continue;
      }

      const fillFraction = markerDiskFill(
        mask,
        width,
        height,
        Math.round(refinedX),
        Math.round(refinedY),
        supportRadius,
      );
      if (fillFraction < 0.46) continue;
      candidates.push({
        x,
        y: refinedGlobalY,
        observed: true,
        confidence: clamp(0.48 + coreDistance / Math.max(4, estimatedDiameter) * 0.35 + fillFraction * 0.24, 0.55, 0.94),
        candidateCount: 1,
        thickness: estimatedDiameter,
        componentArea: null,
        componentWidth: null,
        componentHeight: null,
        marker: true,
        attachedMarker: true,
        markerScore: coreDistance + fillFraction * estimatedDiameter * 0.35 + estimatedDiameter * 0.65,
      });
    }
  }

  // A filled marker attached to a thin curve also appears as a localized peak
  // in the vertical ink thickness. This second response is essential when the
  // marker disks are so closely spaced that connected-component analysis joins
  // several neighboring disks and the curve into one long component.
  const columnRuns = [];
  const columnRunOptions = [];
  for (let localX = 1; localX < width - 1; localX += 1) {
    const x = safeRect.left + localX;
    const guideY = anchors.length >= 2 ? guideYAtX(anchors, x) : null;
    const guideTolerance = strictGuideCorridor
      ? clamp(safeRect.width * 0.018, 5, 16)
      : clamp(safeRect.height * 0.12, 14, 42);
    let runStart = null;
    let bestRun = null;
    const eligibleRuns = [];
    const considerRun = (runEnd) => {
      if (runStart === null) return;
      const middle = (runStart + runEnd) / 2;
      const globalMiddle = safeRect.top + middle;
      if (guideY === null || Math.abs(globalMiddle - guideY) <= guideTolerance) {
        const run = {
          localX,
          start: runStart,
          end: runEnd,
          middle,
          thickness: runEnd - runStart + 1,
          guideDeviation: guideY === null ? 0 : Math.abs(globalMiddle - guideY),
        };
        eligibleRuns.push(run);
        if (
          !bestRun
          || run.guideDeviation < bestRun.guideDeviation - 0.25
          || (Math.abs(run.guideDeviation - bestRun.guideDeviation) <= 0.25 && run.thickness > bestRun.thickness)
        ) bestRun = run;
      }
      runStart = null;
    };
    for (let localY = 0; localY < height; localY += 1) {
      if (mask[localY * width + localX]) {
        if (runStart === null) runStart = localY;
      } else if (runStart !== null) considerRun(localY - 1);
    }
    if (runStart !== null) considerRun(height - 1);
    columnRuns.push(bestRun);
    columnRunOptions.push(eligibleRuns);
  }

  const positiveThicknesses = columnRunOptions
    .flat()
    .map((run) => run.thickness)
    .sort((left, right) => left - right);
  const baselineSampleCount = Math.max(1, Math.ceil(positiveThicknesses.length * 0.4));
  const baselineThickness = median(positiveThicknesses.slice(0, baselineSampleCount));
  const minimumMarkerThickness = Math.max(3, baselineThickness + Math.max(0.9, estimatedDiameter * 0.16));
  const thicknessPeakRadius = clamp(Math.round(estimatedDiameter * 0.42), 1, 7);

  for (let index = 0; index < columnRunOptions.length; index += 1) {
    for (const run of columnRunOptions[index]) {
      if (run.thickness < minimumMarkerThickness) continue;
      let localMaximum = true;
      for (let offset = -thicknessPeakRadius; offset <= thicknessPeakRadius && localMaximum; offset += 1) {
        for (const neighbor of columnRunOptions[index + offset] ?? []) {
          if (
            Math.abs(neighbor.middle - run.middle) <= estimatedDiameter * 0.9
            && neighbor.thickness > run.thickness
          ) {
            localMaximum = false;
            break;
          }
        }
      }
      if (!localMaximum) continue;
      let plateauXSum = 0;
      let plateauCount = 0;
      for (let offset = -thicknessPeakRadius; offset <= thicknessPeakRadius; offset += 1) {
        for (const neighbor of columnRunOptions[index + offset] ?? []) {
          if (
            neighbor.thickness === run.thickness
            && Math.abs(neighbor.middle - run.middle) <= Math.max(1, estimatedDiameter * 0.35)
          ) {
            plateauXSum += neighbor.localX;
            plateauCount += 1;
          }
        }
      }
      const refinedLocalX = plateauCount ? plateauXSum / plateauCount : run.localX;
      const fillFraction = markerDiskFill(
        mask,
        width,
        height,
        Math.round(refinedLocalX),
        Math.round(run.middle),
        supportRadius,
      );
      if (fillFraction < 0.4) continue;
      candidates.push({
        x: safeRect.left + refinedLocalX,
        y: safeRect.top + run.middle,
        observed: true,
        confidence: clamp(0.52 + (run.thickness - baselineThickness) / Math.max(3, estimatedDiameter) * 0.22 + fillFraction * 0.2, 0.55, 0.92),
        candidateCount: 1,
        thickness: run.thickness,
        componentArea: null,
        componentWidth: null,
        componentHeight: null,
        marker: true,
        attachedMarker: true,
        alternateMarkerBranch: run !== columnRuns[index],
        markerScore: run.thickness + fillFraction * estimatedDiameter * 0.4,
      });
    }
  }

  const consolidated = consolidateRegularMarkerGrid(knownMarkers, candidates, estimatedDiameter);
  if (consolidated) return consolidated;

  const selected = [...knownMarkers];
  const minimumSeparation = Math.max(3, estimatedDiameter * 0.68);
  const preferredCandidates = candidates.filter((candidate) => !candidate.alternateMarkerBranch);
  preferredCandidates.sort((left, right) => right.markerScore - left.markerScore);
  for (const candidate of preferredCandidates) {
    if (selected.some((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) < minimumSeparation)) continue;
    selected.push(candidate);
  }
  return selected;
}

export function extractMarkerCenters({
  rgba,
  width,
  height,
  rect,
  target,
  threshold = 42,
  exclusions = [],
  anchors = [],
  strictGuideCorridor = false,
  inclusionMask = null,
}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  const safeRect = normalizeRect(
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { width, height },
  );
  const localWidth = safeRect.right - safeRect.left + 1;
  const localHeight = safeRect.bottom - safeRect.top + 1;
  const localSize = localWidth * localHeight;
  const mask = new Uint8Array(localSize);
  const queue = new Int32Array(localSize);

  for (let localY = 0; localY < localHeight; localY += 1) {
    const y = safeRect.top + localY;
    for (let localX = 0; localX < localWidth; localX += 1) {
      const x = safeRect.left + localX;
      const excluded = exclusions.some((area) => (
        x >= area.left && x <= area.right && y >= area.top && y <= area.bottom
      ));
      if (excluded) continue;
      if (!inclusionMaskAllows(inclusionMask, width, x, y)) continue;
      const sourceIndex = (y * width + x) * 4;
      if (rgba[sourceIndex + 3] < 32) continue;
      const distance = compositedColorDistance(
        rgba[sourceIndex],
        rgba[sourceIndex + 1],
        rgba[sourceIndex + 2],
        target,
      );
      if (distance <= threshold) mask[localY * localWidth + localX] = 1;
    }
  }
  const sourceMask = mask.slice();

  const maximumDiameter = clamp(Math.round(Math.min(safeRect.width, safeRect.height) * 0.1), 8, 48);
  const components = [];
  for (let start = 0; start < localSize; start += 1) {
    if (!mask[start]) continue;
    let queueStart = 0;
    let queueEnd = 1;
    queue[0] = start;
    mask[start] = 0;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minimumX = localWidth;
    let maximumX = 0;
    let minimumY = localHeight;
    let maximumY = 0;

    while (queueStart < queueEnd) {
      const localIndex = queue[queueStart];
      queueStart += 1;
      const localY = Math.floor(localIndex / localWidth);
      const localX = localIndex - localY * localWidth;
      area += 1;
      sumX += localX;
      sumY += localY;
      minimumX = Math.min(minimumX, localX);
      maximumX = Math.max(maximumX, localX);
      minimumY = Math.min(minimumY, localY);
      maximumY = Math.max(maximumY, localY);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const neighborY = localY + offsetY;
        if (neighborY < 0 || neighborY >= localHeight) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighborX = localX + offsetX;
          if (neighborX < 0 || neighborX >= localWidth) continue;
          const neighborIndex = neighborY * localWidth + neighborX;
          if (!mask[neighborIndex]) continue;
          mask[neighborIndex] = 0;
          queue[queueEnd] = neighborIndex;
          queueEnd += 1;
        }
      }
    }

    const componentWidth = maximumX - minimumX + 1;
    const componentHeight = maximumY - minimumY + 1;
    const smallerDimension = Math.min(componentWidth, componentHeight);
    const largerDimension = Math.max(componentWidth, componentHeight);
    const roundness = smallerDimension / Math.max(1, largerDimension);
    const fillFraction = area / Math.max(1, componentWidth * componentHeight);
    if (
      area < 4
      || smallerDimension < 2
      || largerDimension > maximumDiameter
      || roundness < 0.42
      || fillFraction < 0.18
    ) continue;

    const x = safeRect.left + sumX / area;
    const y = safeRect.top + sumY / area;
    if (anchors.length >= 2) {
      const guideY = guideYAtX(anchors, x);
      const tolerance = strictGuideCorridor
        ? clamp(safeRect.width * 0.018, 5, 16)
        : clamp(safeRect.height * 0.12, 14, 42);
      if (Math.abs(y - guideY) > tolerance) continue;
    }
    components.push({
      x,
      y,
      observed: true,
      confidence: clamp(0.55 + roundness * 0.25 + Math.min(1, fillFraction) * 0.2, 0.55, 1),
      candidateCount: 1,
      thickness: largerDimension,
      componentArea: area,
      componentWidth,
      componentHeight,
      marker: true,
    });
  }
  const componentDiameters = components
    .map((point) => Math.min(point.componentWidth, point.componentHeight))
    .filter((diameter) => Number.isFinite(diameter) && diameter >= 3);
  const fallbackDiameter = clamp(Math.min(safeRect.width, safeRect.height) * 0.018, 5, 14);
  const estimatedDiameter = clamp(
    componentDiameters.length ? median(componentDiameters) : fallbackDiameter,
    4,
    maximumDiameter,
  );
  const trustedComponents = components.filter((point) => (
    point.componentWidth <= estimatedDiameter * 1.45
    && point.componentHeight <= estimatedDiameter * 1.45
  ));
  const markerCenters = attachedMarkerCenters({
    mask: sourceMask,
    width: localWidth,
    height: localHeight,
    safeRect,
    anchors,
    strictGuideCorridor,
    knownMarkers: trustedComponents,
    estimatedDiameter,
  })
    .map(({ markerScore: _markerScore, alternateMarkerBranch: _alternateMarkerBranch, ...point }) => point)
    .sort((a, b) => a.x - b.x);
  const claimedCenters = new Set();
  for (const anchor of anchors) {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    markerCenters.forEach((point, index) => {
      if (claimedCenters.has(index)) return;
      const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    });
    if (nearestIndex < 0 || nearestDistance > Math.max(3, estimatedDiameter * 1.25)) continue;
    claimedCenters.add(nearestIndex);
    markerCenters[nearestIndex] = {
      ...markerCenters[nearestIndex],
      anchor: true,
      userGuided: true,
      anchorId: anchor.anchorId,
    };
  }
  return markerCenters;
}

function consolidateMarkerSeriesCandidates(candidates, seed, seedThickness) {
  const mergeRadiusX = Math.max(2.5, seedThickness * 0.58);
  const mergeRadiusY = Math.max(3, seedThickness * 0.9);
  const ranked = [...candidates].sort((left, right) => {
    const score = (point) => {
      const thicknessAgreement = Math.exp(-Math.abs(Math.log(
        Math.max(0.25, (point.thickness ?? seedThickness) / seedThickness),
      )) * 1.7);
      const seedDistance = Math.hypot(point.x - seed.x, point.y - seed.y);
      const seedBonus = seedDistance <= Math.max(3, seedThickness * 0.8) ? 0.45 : 0;
      return (point.confidence ?? 0.5) * 0.75 + thicknessAgreement * 0.4 + seedBonus;
    };
    return score(right) - score(left) || left.x - right.x;
  });
  const selected = [];
  for (const candidate of ranked) {
    if (selected.some((point) => (
      Math.abs(point.x - candidate.x) <= mergeRadiusX
      && Math.abs(point.y - candidate.y) <= mergeRadiusY
    ))) continue;
    selected.push(candidate);
  }
  return selected.sort((left, right) => left.x - right.x);
}

/**
 * Conservatively decide whether one target click belongs to a repeated marker
 * series. The clicked marker supplies a local size fingerprint; repeated
 * candidates must also form a smooth, well-spaced path across the plot. This
 * keeps ordinary lines on the established line tracer when evidence is weak.
 */
export function inferMarkerSeries({
  rgba,
  width,
  height,
  rect,
  seed,
  target,
  threshold = 42,
  exclusions = [],
  inclusionMask = null,
} = {}) {
  if (!rgba || rgba.length !== width * height * 4 || !rect || !seed || !target) {
    return { detected: false, confidence: 0, markers: [], reason: "insufficient-input" };
  }
  const rawMarkers = extractMarkerCenters({
    rgba,
    width,
    height,
    rect,
    target,
    threshold,
    exclusions,
    anchors: [seed],
    strictGuideCorridor: false,
    inclusionMask,
  });
  if (rawMarkers.length < 5) {
    return {
      detected: false,
      confidence: 0,
      markers: [],
      reason: "too-few-marker-candidates",
      evidence: { rawCandidates: rawMarkers.length },
    };
  }
  const seedCandidate = [...rawMarkers].sort((left, right) => (
    Math.hypot(left.x - seed.x, left.y - seed.y) - Math.hypot(right.x - seed.x, right.y - seed.y)
  ))[0];
  const seedThickness = Number(seedCandidate?.thickness);
  const seedDistance = seedCandidate
    ? Math.hypot(seedCandidate.x - seed.x, seedCandidate.y - seed.y)
    : Infinity;
  const strokeDiagnosis = inferLineStyle({
    rgba,
    width,
    height,
    rect,
    seed,
    target,
    threshold,
    exclusions,
  });
  if (
    !Number.isFinite(seedThickness)
    || seedThickness < 7
    || seedDistance > Math.max(4, seedThickness * 1.05)
    || strokeDiagnosis.style === "line"
  ) {
    return {
      detected: false,
      confidence: 0.15,
      markers: [],
      reason: "clicked-object-is-not-a-marker-core",
      evidence: {
        rawCandidates: rawMarkers.length,
        seedDistance,
        seedThickness,
        strokeFingerprint: strokeDiagnosis.style,
      },
    };
  }

  const boundaryMargin = Math.max(3, seedThickness * 0.42);
  const shapeFiltered = rawMarkers.filter((point) => (
    (point.confidence ?? 0) >= 0.76
    && (point.thickness ?? 0) >= Math.max(3, seedThickness * 0.72)
    && (point.thickness ?? Infinity) <= seedThickness * 2.05
    && point.x > rect.left + boundaryMargin
    && point.x < rect.right - boundaryMargin
    && point.y > rect.top + boundaryMargin
    && point.y < rect.bottom - boundaryMargin
  ));
  const markers = consolidateMarkerSeriesCandidates(shapeFiltered, seed, seedThickness);
  if (markers.length < 5) {
    return {
      detected: false,
      confidence: 0.3,
      markers: [],
      reason: "too-few-shape-matched-candidates",
      evidence: { rawCandidates: rawMarkers.length, shapeCandidates: markers.length, seedThickness },
    };
  }

  const gaps = markers.slice(1).map((point, index) => point.x - markers[index].x);
  const medianGap = median(gaps);
  const regularGapFraction = gaps.filter((gap) => (
    gap >= medianGap * 0.52 && gap <= medianGap * 1.72
  )).length / Math.max(1, gaps.length);
  const slopes = markers.slice(1).map((point, index) => (
    (point.y - markers[index].y) / Math.max(1, point.x - markers[index].x)
  ));
  const slopeChanges = slopes.slice(1).map((slope, index) => Math.abs(slope - slopes[index]));
  const medianSlopeChange = median(slopeChanges) ?? 0;
  const smoothness = 1 - clamp(medianSlopeChange / 1.35, 0, 1);
  const horizontalSpan = (markers.at(-1).x - markers[0].x) / Math.max(1, rect.width);
  const shapeAgreement = markers.reduce((sum, point) => (
    sum + Math.exp(-Math.abs(Math.log(
      Math.max(0.25, (point.thickness ?? seedThickness) / seedThickness),
    )) * 1.5)
  ), 0) / markers.length;
  const countScore = clamp((markers.length - 4) / 7, 0, 1);
  const spanScore = clamp(horizontalSpan / 0.55, 0, 1);
  const seedSupport = markers.some((point) => (
    Math.hypot(point.x - seed.x, point.y - seed.y) <= Math.max(4, seedThickness * 1.05)
  ));
  const confidence = clamp(
    0.12
      + countScore * 0.18
      + spanScore * 0.14
      + regularGapFraction * 0.2
      + smoothness * 0.15
      + shapeAgreement * 0.16
      + (seedSupport ? 0.08 : 0),
    0,
    0.98,
  );
  const detected = confidence >= 0.78
    && seedSupport
    && horizontalSpan >= 0.22
    && regularGapFraction >= 0.68
    && smoothness >= 0.7;
  return {
    detected,
    confidence,
    markers: detected ? markers : [],
    reason: detected ? "repeated-marker-geometry" : "marker-series-evidence-too-weak",
    evidence: {
      rawCandidates: rawMarkers.length,
      shapeCandidates: markers.length,
      seedThickness,
      seedDistance,
      strokeFingerprint: strokeDiagnosis.style,
      horizontalSpan,
      medianGap,
      regularGapFraction,
      smoothness,
      shapeAgreement,
    },
  };
}

function rgbHue(red, green, blue) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (delta < 1e-8) return 0;
  let hue;
  if (maximum === red) hue = ((green - blue) / delta) % 6;
  else if (maximum === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function circularHueDistance(left, right) {
  const difference = Math.abs(left - right) % 360;
  return Math.min(difference, 360 - difference);
}

function coloredSeriesPixel(red, green, blue, alpha) {
  if (alpha < 64) return false;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return chroma >= 30
    && chroma / Math.max(1, maximum) >= 0.18
    && luminance <= 242;
}

function insideAnyRectangle(rectangles, x, y, padding = 0) {
  return (rectangles ?? []).some((rectangle) => (
    x >= rectangle.left - padding
    && x <= rectangle.right + padding
    && y >= rectangle.top - padding
    && y <= rectangle.bottom + padding
  ));
}

function mergeColoredSeriesBins(bins, plotWidth) {
  const groups = [];
  const claimed = new Set();
  for (let start = 0; start < bins.length; start += 1) {
    if (claimed.has(start)) continue;
    const indices = [start];
    claimed.add(start);
    for (let cursor = 0; cursor < indices.length; cursor += 1) {
      const sourceIndex = indices[cursor];
      const source = bins[sourceIndex];
      for (let candidateIndex = 0; candidateIndex < bins.length; candidateIndex += 1) {
        if (claimed.has(candidateIndex)) continue;
        const candidate = bins[candidateIndex];
        const neighboringHue = circularHueDistance(source.hue, candidate.hue) <= 18;
        const colorDistance = compositedColorDistance(
          source.color.r,
          source.color.g,
          source.color.b,
          candidate.color,
        );
        if (!neighboringHue || colorDistance > 58) continue;
        claimed.add(candidateIndex);
        indices.push(candidateIndex);
      }
    }
    const members = indices.map((index) => bins[index]);
    const weight = members.reduce((sum, member) => sum + member.weight, 0);
    const columns = new Uint8Array(plotWidth);
    for (const member of members) {
      member.columns.forEach((present, index) => {
        if (present) columns[index] = 1;
      });
    }
    groups.push({
      count: members.reduce((sum, member) => sum + member.count, 0),
      weight,
      color: {
        r: Math.round(members.reduce((sum, member) => sum + member.color.r * member.weight, 0) / weight),
        g: Math.round(members.reduce((sum, member) => sum + member.color.g * member.weight, 0) / weight),
        b: Math.round(members.reduce((sum, member) => sum + member.color.b * member.weight, 0) / weight),
        a: 255,
      },
      hue: members.reduce((sum, member) => sum + member.hue * member.weight, 0) / weight,
      minX: Math.min(...members.map((member) => member.minX)),
      maxX: Math.max(...members.map((member) => member.maxX)),
      columns,
    });
  }
  return groups;
}

function reliableColoredSeriesSeed({
  rgba,
  width,
  plotRect,
  color,
  exclusions,
}) {
  const left = Math.max(0, Math.ceil(plotRect.left + Math.max(3, plotRect.width * 0.025)));
  const right = Math.min(width - 1, Math.floor(plotRect.right - Math.max(3, plotRect.width * 0.025)));
  const top = Math.ceil(plotRect.top + Math.max(3, plotRect.height * 0.025));
  const bottom = Math.floor(plotRect.bottom - Math.max(3, plotRect.height * 0.025));
  const targetHue = rgbHue(color.r, color.g, color.b);
  const columnStep = Math.max(1, Math.floor(plotRect.width / 700));
  let best = null;
  for (let x = left; x <= right; x += columnStep) {
    const runs = [];
    let run = null;
    const closeRun = () => {
      if (!run) return;
      runs.push(run);
      run = null;
    };
    for (let y = top; y <= bottom; y += 1) {
      const index = (y * width + x) * 4;
      const red = rgba[index];
      const green = rgba[index + 1];
      const blue = rgba[index + 2];
      const alpha = rgba[index + 3];
      const matches = !insideAnyRectangle(exclusions, x, y, 2)
        && coloredSeriesPixel(red, green, blue, alpha)
        && circularHueDistance(rgbHue(red, green, blue), targetHue) <= 13
        && compositedColorDistance(red, green, blue, color) <= 70;
      if (!matches) {
        closeRun();
        continue;
      }
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const darkness = 255 - (0.2126 * red + 0.7152 * green + 0.0722 * blue);
      const pixelScore = chroma * 0.78 + darkness * 0.22;
      if (!run) run = { start: y, end: y, bestY: y, pixelScore };
      else {
        run.end = y;
        if (pixelScore > run.pixelScore) {
          run.bestY = y;
          run.pixelScore = pixelScore;
        }
      }
    }
    closeRun();
    const plausibleRuns = runs.filter((candidate) => (
      candidate.end - candidate.start + 1 <= Math.max(12, plotRect.height * 0.08)
    ));
    for (const candidate of plausibleRuns) {
      const normalizedCenterDistance = Math.abs(
        x - (plotRect.left + plotRect.right) / 2,
      ) / Math.max(1, plotRect.width / 2);
      const thickness = candidate.end - candidate.start + 1;
      const ambiguityPenalty = Math.max(0, plausibleRuns.length - 1) * 18;
      const thicknessPenalty = Math.max(0, thickness - 6) * 2.5;
      const score = candidate.pixelScore
        + (1 - normalizedCenterDistance) * 34
        - ambiguityPenalty
        - thicknessPenalty;
      if (!best || score > best.score) {
        best = { x, y: candidate.bestY, score, localRuns: plausibleRuns.length, thickness };
      }
    }
  }
  return best;
}

/**
 * Find only high-confidence, horizontally persistent coloured curve families.
 * The result is review-only: each candidate contains a representative colour
 * and a reliable on-curve seed, but this function never changes masks, axes,
 * calibration, or extracted data.
 */
export function discoverColoredSeries({
  rgba,
  width,
  height,
  plotRect,
  exclusions = [],
  maxResults = 8,
} = {}) {
  if (!rgba || rgba.length !== width * height * 4 || !plotRect) return [];
  const left = clamp(Math.ceil(plotRect.left + 2), 0, width - 1);
  const right = clamp(Math.floor(plotRect.right - 2), 0, width - 1);
  const top = clamp(Math.ceil(plotRect.top + 2), 0, height - 1);
  const bottom = clamp(Math.floor(plotRect.bottom - 2), 0, height - 1);
  const plotWidth = right - left + 1;
  if (plotWidth < 12 || bottom - top < 8) return [];
  const hueBinSize = 15;
  const bins = new Map();
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (insideAnyRectangle(exclusions, x, y)) continue;
      const index = (y * width + x) * 4;
      const red = rgba[index];
      const green = rgba[index + 1];
      const blue = rgba[index + 2];
      const alpha = rgba[index + 3];
      if (!coloredSeriesPixel(red, green, blue, alpha)) continue;
      const hue = rgbHue(red, green, blue);
      const key = Math.round(hue / hueBinSize) % Math.round(360 / hueBinSize);
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const darkness = 255 - (0.2126 * red + 0.7152 * green + 0.0722 * blue);
      const weight = chroma * (0.65 + darkness / 510);
      let bin = bins.get(key);
      if (!bin) {
        bin = {
          count: 0,
          weight: 0,
          weightedRed: 0,
          weightedGreen: 0,
          weightedBlue: 0,
          weightedHue: 0,
          minX: x,
          maxX: x,
          columns: new Uint8Array(plotWidth),
        };
        bins.set(key, bin);
      }
      bin.count += 1;
      bin.weight += weight;
      bin.weightedRed += red * weight;
      bin.weightedGreen += green * weight;
      bin.weightedBlue += blue * weight;
      bin.weightedHue += hue * weight;
      bin.minX = Math.min(bin.minX, x);
      bin.maxX = Math.max(bin.maxX, x);
      bin.columns[x - left] = 1;
    }
  }
  const normalizedBins = [...bins.values()]
    .filter((bin) => bin.count >= Math.max(8, plotWidth * 0.08))
    .map((bin) => ({
      ...bin,
      color: {
        r: Math.round(bin.weightedRed / bin.weight),
        g: Math.round(bin.weightedGreen / bin.weight),
        b: Math.round(bin.weightedBlue / bin.weight),
        a: 255,
      },
      hue: bin.weightedHue / bin.weight,
    }));
  const groups = mergeColoredSeriesBins(normalizedBins, plotWidth);
  const candidates = [];
  const persistentGroups = groups.map((group) => {
    const coveredColumns = group.columns.reduce((sum, present) => sum + present, 0);
    const horizontalSpan = (group.maxX - group.minX + 1) / plotWidth;
    const columnCoverage = coveredColumns / plotWidth;
    return { ...group, coveredColumns, horizontalSpan, columnCoverage };
  }).filter((group) => (
    group.count >= Math.max(18, plotWidth * 0.16)
      && group.horizontalSpan >= 0.32
      && group.columnCoverage >= 0.18
  )).sort((leftGroup, rightGroup) => (
    rightGroup.horizontalSpan * rightGroup.columnCoverage
      - leftGroup.horizontalSpan * leftGroup.columnCoverage
  )).slice(0, clamp(Math.round(maxResults) * 2, 2, 16));
  for (const group of persistentGroups) {
    const seed = reliableColoredSeriesSeed({
      rgba,
      width,
      plotRect,
      color: group.color,
      exclusions,
    });
    if (!seed) continue;
    const spanScore = clamp((group.horizontalSpan - 0.32) / 0.5, 0, 1);
    const coverageScore = clamp((group.columnCoverage - 0.18) / 0.55, 0, 1);
    const ambiguityScore = seed.localRuns <= 1 ? 1 : seed.localRuns === 2 ? 0.72 : 0.45;
    const confidence = clamp(
      0.57 + spanScore * 0.16 + coverageScore * 0.17 + ambiguityScore * 0.08,
      0,
      0.98,
    );
    if (confidence < 0.72) continue;
    candidates.push({
      color: group.color,
      seed: { x: seed.x, y: seed.y },
      confidence,
      horizontalSpan: group.horizontalSpan,
      columnCoverage: group.columnCoverage,
      pixelCount: group.count,
    });
  }
  return candidates
    .sort((leftCandidate, rightCandidate) => (
      rightCandidate.confidence - leftCandidate.confidence
      || rightCandidate.horizontalSpan - leftCandidate.horizontalSpan
      || rightCandidate.columnCoverage - leftCandidate.columnCoverage
    ))
    .slice(0, clamp(Math.round(maxResults), 1, 12));
}

function darkestBandPresence(rgba, width, height, axis, coordinate, threshold, tolerance = 2) {
  const length = axis === "row" ? width : height;
  const crossLength = axis === "row" ? height : width;
  const prefix = new Int32Array(length + 1);
  for (let along = 0; along < length; along += 1) {
    let present = 0;
    for (let offset = -tolerance; offset <= tolerance && !present; offset += 1) {
      const cross = coordinate + offset;
      if (cross < 0 || cross >= crossLength) continue;
      const x = axis === "row" ? along : cross;
      const y = axis === "row" ? cross : along;
      const index = (y * width + x) * 4;
      const luminance = 0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2];
      present = rgba[index + 3] >= 32 && luminance <= threshold ? 1 : 0;
    }
    prefix[along + 1] = prefix[along] + present;
  }
  return prefix;
}

function strongestSeparatedPeaks(scores, count = 22, separation = 4) {
  const ranked = Array.from(scores, (score, index) => ({ score, index }))
    .sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of ranked) {
    if (selected.every((item) => Math.abs(item.index - candidate.index) >= separation)) {
      selected.push(candidate);
      if (selected.length >= count) break;
    }
  }
  return selected.map((item) => item.index).sort((a, b) => a - b);
}

function frameSegmentCoverage(rgba, width, height, axis, coordinate, start, end, threshold) {
  const maximumCoordinate = axis === "row" ? height - 1 : width - 1;
  if (coordinate < 0 || coordinate > maximumCoordinate) return 0;
  let darkPixels = 0;
  const minimum = clamp(Math.round(start), 0, axis === "row" ? width - 1 : height - 1);
  const maximum = clamp(Math.round(end), minimum, axis === "row" ? width - 1 : height - 1);
  for (let along = minimum; along <= maximum; along += 1) {
    const x = axis === "row" ? along : coordinate;
    const y = axis === "row" ? coordinate : along;
    const index = (y * width + x) * 4;
    const luminance = 0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2];
    if (rgba[index + 3] >= 32 && luminance <= threshold) darkPixels += 1;
  }
  return darkPixels / Math.max(1, maximum - minimum + 1);
}

/**
 * Locate the complete antialiased frame stroke around a detected edge. The
 * detector's peak may land anywhere inside a multi-pixel border, so returning
 * that peak (or an inset from it) does not consistently describe the visible
 * plot boundary. A local high-coverage component gives us both stroke edges.
 */
function frameStrokeExtent(rgba, width, height, {
  axis,
  coordinate,
  start,
  end,
  darkThreshold,
}) {
  const crossLength = axis === "row" ? height : width;
  const radius = clamp(Math.round(crossLength * 0.012), 4, 12);
  const minimum = Math.max(0, coordinate - radius);
  const maximum = Math.min(crossLength - 1, coordinate + radius);
  // Include light antialiasing at the outside of an otherwise dark frame.
  const strokeThreshold = Math.max(darkThreshold, 210);
  const samples = [];
  for (let current = minimum; current <= maximum; current += 1) {
    samples.push({
      coordinate: current,
      coverage: frameSegmentCoverage(
        rgba,
        width,
        height,
        axis,
        current,
        start,
        end,
        strokeThreshold,
      ),
    });
  }
  const strongest = samples.reduce((best, sample) => (
    sample.coverage > best.coverage ? sample : best
  ), samples[0]);
  if (!strongest || strongest.coverage < 0.18) {
    return { minimum: coordinate, maximum: coordinate, thickness: 1 };
  }
  const componentThreshold = Math.max(0.16, strongest.coverage * 0.42);
  let seedIndex = samples.indexOf(strongest);
  let componentStart = seedIndex;
  let componentEnd = seedIndex;
  while (componentStart > 0 && samples[componentStart - 1].coverage >= componentThreshold) {
    componentStart -= 1;
  }
  while (componentEnd + 1 < samples.length && samples[componentEnd + 1].coverage >= componentThreshold) {
    componentEnd += 1;
  }
  const outerMinimum = samples[componentStart].coordinate;
  const outerMaximum = samples[componentEnd].coordinate;
  return {
    minimum: outerMinimum,
    maximum: outerMaximum,
    thickness: outerMaximum - outerMinimum + 1,
  };
}

function rectangleIoU(a, b) {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right < left || bottom < top) return 0;
  const intersection = (right - left + 1) * (bottom - top + 1);
  const areaA = (a.right - a.left + 1) * (a.bottom - a.top + 1);
  const areaB = (b.right - b.left + 1) * (b.bottom - b.top + 1);
  return intersection / (areaA + areaB - intersection);
}

export function detectPlotRects(rgba, width, height, { darkThreshold = 135, maxResults = 12 } = {}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  const rowScores = new Float64Array(height);
  const columnScores = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const luminance = 0.2126 * rgba[index] + 0.7152 * rgba[index + 1] + 0.0722 * rgba[index + 2];
      if (rgba[index + 3] >= 32 && luminance <= darkThreshold) {
        rowScores[y] += 1;
        columnScores[x] += 1;
      }
    }
  }

  const rowCandidates = strongestSeparatedPeaks(rowScores, 24, Math.max(3, Math.round(height * 0.004)));
  const columnCandidates = strongestSeparatedPeaks(columnScores, 24, Math.max(3, Math.round(width * 0.004)));
  const rowPrefixes = new Map(rowCandidates.map((y) => [
    y,
    darkestBandPresence(rgba, width, height, "row", y, darkThreshold),
  ]));
  const columnPrefixes = new Map(columnCandidates.map((x) => [
    x,
    darkestBandPresence(rgba, width, height, "column", x, darkThreshold),
  ]));

  const proposals = [];
  const minimumWidth = Math.max(40, width * 0.15);
  const minimumHeight = Math.max(40, height * 0.12);

  for (let topIndex = 0; topIndex < rowCandidates.length; topIndex += 1) {
    const top = rowCandidates[topIndex];
    for (let bottomIndex = topIndex + 1; bottomIndex < rowCandidates.length; bottomIndex += 1) {
      const bottom = rowCandidates[bottomIndex];
      if (bottom - top < minimumHeight) continue;
      for (let leftIndex = 0; leftIndex < columnCandidates.length; leftIndex += 1) {
        const left = columnCandidates[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < columnCandidates.length; rightIndex += 1) {
          const right = columnCandidates[rightIndex];
          if (right - left < minimumWidth) continue;
          const horizontalLength = right - left + 1;
          const verticalLength = bottom - top + 1;
          const topPrefix = rowPrefixes.get(top);
          const bottomPrefix = rowPrefixes.get(bottom);
          const leftPrefix = columnPrefixes.get(left);
          const rightPrefix = columnPrefixes.get(right);
          const topCoverage = (topPrefix[right + 1] - topPrefix[left]) / horizontalLength;
          const bottomCoverage = (bottomPrefix[right + 1] - bottomPrefix[left]) / horizontalLength;
          const leftCoverage = (leftPrefix[bottom + 1] - leftPrefix[top]) / verticalLength;
          const rightCoverage = (rightPrefix[bottom + 1] - rightPrefix[top]) / verticalLength;
          const weakestEdge = Math.min(topCoverage, bottomCoverage, leftCoverage, rightCoverage);
          const meanCoverage = (topCoverage + bottomCoverage + leftCoverage + rightCoverage) / 4;
          const areaFraction = (horizontalLength * verticalLength) / (width * height);
          let internalDividers = 0;
          for (const internalY of rowCandidates) {
            if (internalY <= top + 4 || internalY >= bottom - 4) continue;
            const prefix = rowPrefixes.get(internalY);
            const coverage = (prefix[right + 1] - prefix[left]) / horizontalLength;
            if (coverage >= 0.92) internalDividers += 1;
          }
          for (const internalX of columnCandidates) {
            if (internalX <= left + 4 || internalX >= right - 4) continue;
            const prefix = columnPrefixes.get(internalX);
            const coverage = (prefix[bottom + 1] - prefix[top]) / verticalLength;
            if (coverage >= 0.92) internalDividers += 1;
          }
          const structurePenalty = Math.min(0.14, internalDividers * 0.032);
          // Screenshots and exported figures sometimes carry a one-pixel
          // border around the entire bitmap in addition to the real axes
          // frame. Without a small prior against that exact image boundary,
          // its perfect coverage always outranks the inset plot rectangle and
          // sends titles, tick labels, and page furniture into curve tracing.
          // Keep it as a valid fallback when no inset frame exists.
          const fullImageBorder = left <= 1
            && top <= 1
            && right >= width - 2
            && bottom >= height - 2;
          const imageBorderPenalty = fullImageBorder ? 0.075 : 0;
          const score = meanCoverage * 0.68
            + weakestEdge * 0.28
            + Math.sqrt(areaFraction) * 0.04
            - structurePenalty
            - imageBorderPenalty;
          if (weakestEdge < 0.28 || meanCoverage < 0.42) continue;
          const topStroke = frameStrokeExtent(rgba, width, height, {
            axis: "row", coordinate: top, start: left, end: right, darkThreshold,
          });
          const bottomStroke = frameStrokeExtent(rgba, width, height, {
            axis: "row", coordinate: bottom, start: left, end: right, darkThreshold,
          });
          const leftStroke = frameStrokeExtent(rgba, width, height, {
            axis: "column", coordinate: left, start: top, end: bottom, darkThreshold,
          });
          const rightStroke = frameStrokeExtent(rgba, width, height, {
            axis: "column", coordinate: right, start: top, end: bottom, darkThreshold,
          });
          const outerLeft = leftStroke.minimum;
          const outerTop = topStroke.minimum;
          const outerRight = rightStroke.maximum;
          const outerBottom = bottomStroke.maximum;
          proposals.push({
            left: outerLeft,
            top: outerTop,
            right: outerRight,
            bottom: outerBottom,
            width: outerRight - outerLeft + 1,
            height: outerBottom - outerTop + 1,
            confidence: clamp(score, 0, 1),
            score,
            internalDividers,
            edgeCoverage: { top: topCoverage, bottom: bottomCoverage, left: leftCoverage, right: rightCoverage },
            edgeThickness: {
              top: topStroke.thickness,
              bottom: bottomStroke.thickness,
              left: leftStroke.thickness,
              right: rightStroke.thickness,
            },
          });
        }
      }
    }
  }
  proposals.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const proposal of proposals) {
    if (selected.some((existing) => rectangleIoU(existing, proposal) > 0.72)) continue;
    selected.push(proposal);
    if (selected.length >= maxResults) break;
  }
  return selected;
}

export function detectPlotRect(rgba, width, height, options = {}) {
  return detectPlotRects(rgba, width, height, { ...options, maxResults: 1 })[0] ?? null;
}

function annotationInkPixel(rgba, index) {
  if (rgba[index + 3] < 32) return false;
  const red = rgba[index];
  const green = rgba[index + 1];
  const blue = rgba[index + 2];
  const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const distanceFromWhite = Math.hypot(255 - red, 255 - green, 255 - blue);
  return luminance <= 178 || (chroma >= 24 && distanceFromWhite >= 88);
}

function boundedExpandedRect(rect, plotRect, padding = 4) {
  const left = Math.max(plotRect.left + 2, Math.floor(rect.left - padding));
  const top = Math.max(plotRect.top + 2, Math.floor(rect.top - padding));
  const right = Math.min(plotRect.right - 2, Math.ceil(rect.right + padding));
  const bottom = Math.min(plotRect.bottom - 2, Math.ceil(rect.bottom + padding));
  return {
    left,
    top,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

function horizontalOverlapFraction(left, right) {
  const overlap = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left) + 1);
  return overlap / Math.max(1, Math.min(left.width, right.width));
}

function annotationLineBands(rgba, width, height, plotRect) {
  const marginX = Math.max(4, Math.round(plotRect.width * 0.012));
  const marginY = Math.max(4, Math.round(plotRect.height * 0.012));
  const left = clamp(plotRect.left + marginX, 0, width - 1);
  const right = clamp(plotRect.right - marginX, 0, width - 1);
  const top = clamp(plotRect.top + marginY, 0, height - 1);
  const bottom = clamp(plotRect.bottom - marginY, 0, height - 1);
  const minimumRuns = Math.max(5, Math.round(plotRect.width / 115));
  const activeRows = [];
  for (let y = top; y <= bottom; y += 1) {
    let runs = 0;
    let ink = 0;
    let insideRun = false;
    for (let x = left; x <= right; x += 1) {
      const active = annotationInkPixel(rgba, (y * width + x) * 4);
      if (active) {
        ink += 1;
        if (!insideRun) runs += 1;
      }
      insideRun = active;
    }
    activeRows.push({
      y,
      active: runs >= minimumRuns
        && ink >= Math.max(8, plotRect.width * 0.014)
        && ink <= plotRect.width * 0.58,
    });
  }

  const bands = [];
  let start = null;
  let lastActive = null;
  for (const row of activeRows) {
    if (row.active) {
      start ??= row.y;
      lastActive = row.y;
    } else if (start !== null && row.y - lastActive > 1) {
      bands.push({ top: start, bottom: lastActive });
      start = null;
      lastActive = null;
    }
  }
  if (start !== null) bands.push({ top: start, bottom: lastActive });

  const maximumBandHeight = Math.max(24, plotRect.height * 0.08);
  const joinGap = Math.max(5, Math.round(plotRect.width * 0.012));
  const minimumLineWidth = Math.max(14, plotRect.width * 0.055);
  const lines = [];
  for (const band of bands) {
    if (band.bottom - band.top + 1 > maximumBandHeight) continue;
    const occupied = [];
    for (let x = left; x <= right; x += 1) {
      let count = 0;
      for (let y = band.top; y <= band.bottom; y += 1) {
        if (annotationInkPixel(rgba, (y * width + x) * 4)) count += 1;
      }
      occupied.push(count > 0);
    }
    let segmentStart = null;
    let lastInk = null;
    for (let offset = 0; offset < occupied.length; offset += 1) {
      if (occupied[offset]) {
        segmentStart ??= offset;
        lastInk = offset;
      }
      const gapExceeded = segmentStart !== null && lastInk !== null && offset - lastInk > joinGap;
      const atEnd = offset === occupied.length - 1;
      if (!gapExceeded && !atEnd) continue;
      const end = atEnd && occupied[offset] ? offset : lastInk;
      const segmentWidth = end - segmentStart + 1;
      if (segmentWidth >= minimumLineWidth) {
        lines.push({
          left: left + segmentStart,
          right: left + end,
          top: band.top,
          bottom: band.bottom,
          width: segmentWidth,
          height: band.bottom - band.top + 1,
        });
      }
      segmentStart = null;
      lastInk = null;
    }
  }
  return lines;
}

function annotationInkDensity(rgba, width, rect) {
  let ink = 0;
  for (let y = rect.top; y <= rect.bottom; y += 1) {
    for (let x = rect.left; x <= rect.right; x += 1) {
      if (annotationInkPixel(rgba, (y * width + x) * 4)) ink += 1;
    }
  }
  return ink / Math.max(1, rect.width * rect.height);
}

/**
 * Suggest likely in-plot legends or annotation blocks without applying them.
 * The detector deliberately favours boxed regions and repeated text-like rows;
 * ordinary one-pixel curves do not create enough horizontal ink transitions.
 */
export function suggestInterferenceMasks({
  rgba,
  width,
  height,
  plotRect,
  exclusions = [],
  maxResults = 5,
} = {}) {
  if (!rgba || rgba.length !== width * height * 4 || !plotRect) return [];
  const plotArea = Math.max(1, plotRect.width * plotRect.height);
  const proposals = [];

  for (const framed of detectPlotRects(rgba, width, height, { darkThreshold: 178, maxResults: 32 })) {
    const safelyInside = framed.left > plotRect.left + 3
      && framed.right < plotRect.right - 3
      && framed.top > plotRect.top + 3
      && framed.bottom < plotRect.bottom - 3;
    const areaFraction = (framed.width * framed.height) / plotArea;
    if (!safelyInside || areaFraction < 0.006 || areaFraction > 0.28) continue;
    if (framed.width < plotRect.width * 0.08 || framed.width > plotRect.width * 0.56) continue;
    if (framed.height < plotRect.height * 0.055 || framed.height > plotRect.height * 0.46) continue;
    proposals.push({
      ...boundedExpandedRect(framed, plotRect, 3),
      kind: "legend",
      confidence: clamp(0.7 + framed.confidence * 0.25, 0, 0.97),
      evidence: { framed: true, textLines: 0, inkDensity: null },
    });
  }

  const lineGroups = [];
  const maximumLineGap = Math.max(12, plotRect.height * 0.045);
  for (const line of annotationLineBands(rgba, width, height, plotRect).sort((a, b) => a.top - b.top)) {
    const group = lineGroups.find((candidate) => (
      line.top - candidate.bottom <= maximumLineGap
      && horizontalOverlapFraction(candidate, line) >= 0.22
    ));
    if (group) {
      group.left = Math.min(group.left, line.left);
      group.right = Math.max(group.right, line.right);
      group.top = Math.min(group.top, line.top);
      group.bottom = Math.max(group.bottom, line.bottom);
      group.width = group.right - group.left + 1;
      group.height = group.bottom - group.top + 1;
      group.lines += 1;
    } else {
      lineGroups.push({ ...line, lines: 1 });
    }
  }

  for (const group of lineGroups) {
    const padded = boundedExpandedRect(group, plotRect, 5);
    const areaFraction = (padded.width * padded.height) / plotArea;
    if (areaFraction < 0.003 || areaFraction > 0.24) continue;
    if (padded.width > plotRect.width * 0.56 || padded.height > plotRect.height * 0.44) continue;
    const centerX = (padded.left + padded.right) / 2;
    const centerY = (padded.top + padded.bottom) / 2;
    const horizontalEdge = 1 - Math.min(
      centerX - plotRect.left,
      plotRect.right - centerX,
    ) / Math.max(1, plotRect.width / 2);
    const verticalEdge = 1 - Math.min(
      centerY - plotRect.top,
      plotRect.bottom - centerY,
    ) / Math.max(1, plotRect.height / 2);
    const cornerScore = clamp((horizontalEdge + verticalEdge) / 2, 0, 1);
    if (group.lines < 2 && cornerScore < 0.72) continue;
    const inkDensity = annotationInkDensity(rgba, width, padded);
    if (inkDensity < 0.018 || inkDensity > 0.48) continue;
    const confidence = clamp(
      0.35 + Math.min(4, group.lines) * 0.09 + cornerScore * 0.2 + Math.min(0.12, inkDensity * 0.7),
      0,
      0.92,
    );
    if (confidence < 0.62) continue;
    proposals.push({
      ...padded,
      kind: group.lines >= 2 ? "legend-or-annotation" : "annotation",
      confidence,
      evidence: { framed: false, textLines: group.lines, inkDensity },
    });
  }

  proposals.sort((left, right) => right.confidence - left.confidence);
  const selected = [];
  for (const proposal of proposals) {
    if ((exclusions ?? []).some((area) => rectangleIoU(area, proposal) > 0.2)) continue;
    const duplicateIndex = selected.findIndex((candidate) => rectangleIoU(candidate, proposal) > 0.24);
    if (duplicateIndex >= 0) {
      if (proposal.confidence > selected[duplicateIndex].confidence) selected[duplicateIndex] = proposal;
      continue;
    }
    selected.push(proposal);
    if (selected.length >= maxResults) break;
  }
  return selected;
}

export function pathToData(path, xCalibration, yCalibration) {
  if (!validateCalibration(xCalibration) || !validateCalibration(yCalibration)) return [];
  return path.map((point) => {
    const xUncertainty = calibrationUncertaintyAtPixel(point.x, xCalibration);
    const yUncertainty = calibrationUncertaintyAtPixel(
      point.y,
      yCalibration,
      point.inferenceUncertainty ?? 0,
    );
    return {
      ...point,
      dataX: pixelToValue(point.x, xCalibration),
      dataY: pixelToValue(point.y, yCalibration),
      dataXUncertainty: xUncertainty?.valueSigma ?? null,
      dataYUncertainty: yUncertainty?.valueSigma ?? null,
      calibrationXPixelUncertainty: xUncertainty?.pixelSigma ?? null,
      calibrationYPixelUncertainty: yUncertainty?.pixelSigma ?? null,
    };
  });
}

export function resamplePixelPath(path, count) {
  if (!Array.isArray(path) || path.length === 0) return [];
  const numericCount = Number(count);
  const sampleCount = Math.max(2, Number.isFinite(numericCount) ? Math.round(numericCount) : 100);
  const sorted = [...path].sort((a, b) => a.x - b.x);
  const minimumX = sorted[0].x;
  const maximumX = sorted.at(-1).x;
  if (maximumX === minimumX) return [{ ...sorted[0] }];
  const sampleXs = [];

  for (let index = 0; index < sampleCount; index += 1) {
    sampleXs.push(minimumX + (index / (sampleCount - 1)) * (maximumX - minimumX));
  }
  return interpolatePixelPath(sorted, sampleXs);
}

function interpolateOrderedPathPoint(left, right, fraction, parametricOrder) {
  if (fraction <= 1e-9) return { ...left, parametricOrder };
  if (fraction >= 1 - 1e-9) return { ...right, parametricOrder };
  const nearest = fraction <= 0.5 ? left : right;
  const point = {
    ...nearest,
    x: left.x + (right.x - left.x) * fraction,
    y: left.y + (right.y - left.y) * fraction,
    observed: Boolean(left.observed && right.observed),
    confidence: (left.confidence ?? 0) + ((right.confidence ?? 0) - (left.confidence ?? 0)) * fraction,
    candidateCount: Math.max(left.candidateCount ?? 0, right.candidateCount ?? 0),
    thickness: (left.thickness ?? 0) + ((right.thickness ?? 0) - (left.thickness ?? 0)) * fraction,
    parametricOrder,
  };
  delete point.pointId;
  delete point.anchorId;
  point.anchor = false;
  point.userGuided = false;
  const occlusionInferred = Boolean(left.occlusionInferred || right.occlusionInferred);
  const patternInferred = Boolean(left.patternInferred || right.patternInferred);
  if (occlusionInferred || patternInferred) {
    point.occlusionInferred = occlusionInferred;
    point.patternInferred = patternInferred;
    point.imageObserved = Boolean(left.imageObserved ?? left.observed)
      && Boolean(right.imageObserved ?? right.observed);
    point.inferenceMethod = left.inferenceMethod ?? right.inferenceMethod;
    point.inferenceModel = fraction <= 0.5
      ? (left.inferenceModel ?? right.inferenceModel)
      : (right.inferenceModel ?? left.inferenceModel);
    point.inferenceUncertainty = (left.inferenceUncertainty ?? 0)
      + ((right.inferenceUncertainty ?? 0) - (left.inferenceUncertainty ?? 0)) * fraction;
    for (const field of ["inferenceModelScore", "modelDisagreement", "unsupportedDistance"]) {
      const leftValue = Number(left[field]);
      const rightValue = Number(right[field]);
      if (Number.isFinite(leftValue) && Number.isFinite(rightValue)) {
        point[field] = leftValue + (rightValue - leftValue) * fraction;
      } else if (Number.isFinite(leftValue)) point[field] = leftValue;
      else if (Number.isFinite(rightValue)) point[field] = rightValue;
    }
  }
  return point;
}

/**
 * Resample an already ordered 2D path by screen-space arc length. A closed
 * path includes the last-to-first segment but never duplicates its first point,
 * so CSV rows retain one unambiguous traversal of the loop.
 */
export function resamplePixelPathArcLength(path, count, { closed = false } = {}) {
  const ordered = (path ?? []).filter((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.y)
  ));
  if (!ordered.length) return [];
  if (ordered.length === 1) return [{ ...ordered[0], parametricOrder: 0 }];
  const numericCount = Number(count);
  const sampleCount = Math.max(2, Number.isFinite(numericCount) ? Math.round(numericCount) : 100);
  const segmentCount = closed ? ordered.length : ordered.length - 1;
  const cumulative = [0];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const left = ordered[segment];
    const right = ordered[(segment + 1) % ordered.length];
    cumulative.push(cumulative.at(-1) + Math.hypot(right.x - left.x, right.y - left.y));
  }
  const total = cumulative.at(-1);
  if (!(total > 0)) return [{ ...ordered[0], parametricOrder: 0 }];
  const result = [];
  let segment = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const fraction = closed ? sample / sampleCount : sample / (sampleCount - 1);
    const target = fraction * total;
    while (segment < segmentCount - 1 && cumulative[segment + 1] < target) segment += 1;
    const leftDistance = cumulative[segment];
    const rightDistance = cumulative[segment + 1];
    const localFraction = rightDistance === leftDistance
      ? 0
      : (target - leftDistance) / (rightDistance - leftDistance);
    result.push(interpolateOrderedPathPoint(
      ordered[segment],
      ordered[(segment + 1) % ordered.length],
      localFraction,
      segment + localFraction,
    ));
  }
  return result;
}

export function includeMandatoryParametricPoints(
  sampledPath,
  mandatoryPoints,
  count = sampledPath?.length,
) {
  const sampled = (sampledPath ?? []).map((point) => ({ point: { ...point }, mandatory: false }));
  const mandatory = (mandatoryPoints ?? []).filter((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.y)
  )).map((point) => ({
    ...point,
    anchor: true,
    userGuided: true,
    origin: "guide",
  }));
  if (!mandatory.length) return sampled.map((entry) => entry.point);
  const requested = Number.isFinite(Number(count)) ? Math.max(2, Math.round(Number(count))) : sampled.length;
  const targetCount = Math.max(requested, mandatory.length);
  for (const guide of mandatory) {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    sampled.forEach((entry, index) => {
      if (entry.mandatory) return;
      const orderDistance = Number.isFinite(guide.parametricOrder) && Number.isFinite(entry.point.parametricOrder)
        ? Math.abs(guide.parametricOrder - entry.point.parametricOrder)
        : Math.hypot(guide.x - entry.point.x, guide.y - entry.point.y);
      if (orderDistance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = orderDistance;
      }
    });
    if (nearestIndex >= 0) sampled.splice(nearestIndex, 1);
    sampled.push({ point: guide, mandatory: true });
  }
  while (sampled.length > targetCount) {
    sampled.sort((left, right) => (
      (left.point.parametricOrder ?? Infinity) - (right.point.parametricOrder ?? Infinity)
    ));
    let removalIndex = -1;
    let smallestSpacing = Infinity;
    for (let index = 0; index < sampled.length; index += 1) {
      if (sampled[index].mandatory) continue;
      const previous = sampled[(index - 1 + sampled.length) % sampled.length].point;
      const next = sampled[(index + 1) % sampled.length].point;
      const spacing = Math.min(
        Math.hypot(sampled[index].point.x - previous.x, sampled[index].point.y - previous.y),
        Math.hypot(next.x - sampled[index].point.x, next.y - sampled[index].point.y),
      );
      if (spacing < smallestSpacing) {
        smallestSpacing = spacing;
        removalIndex = index;
      }
    }
    if (removalIndex < 0) break;
    sampled.splice(removalIndex, 1);
  }
  return sampled
    .map((entry) => entry.point)
    .sort((left, right) => (
      (left.parametricOrder ?? Infinity) - (right.parametricOrder ?? Infinity)
    ))
    .map((point, index) => ({ ...point, parametricOrder: index }));
}

export function includeMandatoryPoints(sampledPath, mandatoryPoints, count = sampledPath?.length) {
  const sampled = (sampledPath ?? [])
    .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    .map((point) => ({ ...point, anchor: Boolean(point.anchor) }));
  const mandatoryByX = new Map();
  for (const point of mandatoryPoints ?? []) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
    mandatoryByX.set(point.x, {
      ...point,
      anchor: true,
      userGuided: true,
      origin: "guide",
    });
  }
  const mandatory = [...mandatoryByX.values()].sort((left, right) => left.x - right.x);
  if (!mandatory.length) return sampled;

  const numericCount = Number(count);
  const requestedCount = Number.isFinite(numericCount) ? Math.max(2, Math.round(numericCount)) : sampled.length;
  const targetCount = Math.max(requestedCount, mandatory.length);
  const selected = sampled.map((point) => ({ point, mandatory: false }));

  // Replace the nearest automatically sampled point with each guide. This
  // preserves the requested density and its adaptive distribution while
  // guaranteeing that every carefully placed guide is represented exactly.
  for (const guide of mandatory) {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    selected.forEach((entry, index) => {
      if (entry.mandatory) return;
      const distance = Math.abs(entry.point.x - guide.x);
      if (distance < nearestDistance) {
        nearestIndex = index;
        nearestDistance = distance;
      }
    });
    if (nearestIndex >= 0) selected.splice(nearestIndex, 1);
    selected.push({ point: guide, mandatory: true });
  }

  while (selected.length > targetCount) {
    selected.sort((left, right) => left.point.x - right.point.x);
    let removalIndex = -1;
    let smallestSpacing = Infinity;
    for (let index = 0; index < selected.length; index += 1) {
      if (selected[index].mandatory) continue;
      const previousDistance = index > 0
        ? Math.abs(selected[index].point.x - selected[index - 1].point.x)
        : Infinity;
      const nextDistance = index < selected.length - 1
        ? Math.abs(selected[index + 1].point.x - selected[index].point.x)
        : Infinity;
      const spacing = Math.min(previousDistance, nextDistance);
      if (spacing < smallestSpacing) {
        removalIndex = index;
        smallestSpacing = spacing;
      }
    }
    if (removalIndex < 0) break;
    selected.splice(removalIndex, 1);
  }

  return selected
    .map((entry) => entry.point)
    .sort((left, right) => left.x - right.x);
}

function interpolatePixelPath(sortedPath, sampleXs) {
  const result = [];
  let cursor = 0;

  const interpolateOptionalNumber = (leftValue, rightValue, fraction) => {
    const hasLeft = Number.isFinite(leftValue);
    const hasRight = Number.isFinite(rightValue);
    if (hasLeft && hasRight) return leftValue + fraction * (rightValue - leftValue);
    if (hasLeft) return leftValue;
    if (hasRight) return rightValue;
    return null;
  };

  const interpolateModelWeights = (leftWeights, rightWeights, fraction) => {
    const leftValid = leftWeights && typeof leftWeights === "object";
    const rightValid = rightWeights && typeof rightWeights === "object";
    if (!leftValid && !rightValid) return null;
    if (!leftValid) return { ...rightWeights };
    if (!rightValid) return { ...leftWeights };
    const keys = new Set([...Object.keys(leftWeights), ...Object.keys(rightWeights)]);
    const weights = Object.fromEntries([...keys].map((key) => [
      key,
      (Number(leftWeights[key]) || 0) * (1 - fraction)
        + (Number(rightWeights[key]) || 0) * fraction,
    ]));
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
    if (!(total > 0)) return null;
    return Object.fromEntries(Object.entries(weights).map(([key, weight]) => [
      key,
      Number((weight / total).toFixed(6)),
    ]));
  };

  for (const pixelX of sampleXs) {
    while (cursor < sortedPath.length - 2 && sortedPath[cursor + 1].x < pixelX) cursor += 1;
    const left = sortedPath[cursor];
    const right = sortedPath[Math.min(cursor + 1, sortedPath.length - 1)];
    if (Math.abs(pixelX - left.x) < 1e-9 || Math.abs(pixelX - right.x) < 1e-9) {
      const exact = Math.abs(pixelX - left.x) < 1e-9 ? left : right;
      result.push({ ...exact });
      continue;
    }
    const localFraction = right.x === left.x ? 0 : (pixelX - left.x) / (right.x - left.x);
    const pixelY = left.y + localFraction * (right.y - left.y);
    const sampledPoint = {
      x: pixelX,
      y: pixelY,
      observed: left.observed && right.observed,
      confidence: (left.confidence ?? 0) + localFraction * ((right.confidence ?? 0) - (left.confidence ?? 0)),
      candidateCount: Math.max(left.candidateCount ?? 0, right.candidateCount ?? 0),
      thickness: (left.thickness ?? 0) + localFraction * ((right.thickness ?? 0) - (left.thickness ?? 0)),
    };
    const ambiguitySource = localFraction <= 0.5 ? left : right;
    if (Array.isArray(ambiguitySource.ambiguityAlternatives)) {
      sampledPoint.ambiguityAlternatives = [...ambiguitySource.ambiguityAlternatives];
      sampledPoint.ambiguitySeparation = ambiguitySource.ambiguitySeparation;
      sampledPoint.ambiguitySpread = ambiguitySource.ambiguitySpread;
    }
    const occlusionInferred = Boolean(left.occlusionInferred || right.occlusionInferred);
    const patternInferred = Boolean(left.patternInferred || right.patternInferred);
    if (occlusionInferred || patternInferred) {
      sampledPoint.occlusionInferred = occlusionInferred;
      sampledPoint.patternInferred = patternInferred;
      sampledPoint.imageObserved = Boolean(left.imageObserved ?? left.observed)
        && Boolean(right.imageObserved ?? right.observed);
      sampledPoint.inferenceMethod = left.inferenceMethod ?? right.inferenceMethod;
      sampledPoint.inferenceModel = localFraction <= 0.5
        ? (left.inferenceModel ?? right.inferenceModel)
        : (right.inferenceModel ?? left.inferenceModel);
      sampledPoint.inferenceModelWeights = interpolateModelWeights(
        left.inferenceModelWeights,
        right.inferenceModelWeights,
        localFraction,
      );
      for (const field of [
        "inferenceModelScore",
        "modelDisagreement",
        "fitBlend",
        "fitSupport",
        "unsupportedDistance",
        "inferenceUncertainty",
      ]) {
        const value = interpolateOptionalNumber(left[field], right[field], localFraction);
        if (value !== null) sampledPoint[field] = value;
      }
      sampledPoint.boundedByGuide = Boolean(left.boundedByGuide || right.boundedByGuide);
      sampledPoint.occlusionMasked = Boolean(left.occlusionMasked || right.occlusionMasked);
    }
    if (left.centerRefined || right.centerRefined) {
      sampledPoint.centerRefined = true;
      const centerShift = interpolateOptionalNumber(left.centerShift, right.centerShift, localFraction);
      if (centerShift !== null) sampledPoint.centerShift = centerShift;
    }
    result.push(sampledPoint);
  }
  return result;
}

function movingAverage(values, radius) {
  const prefix = [0];
  for (const value of values) prefix.push(prefix.at(-1) + value);
  return values.map((_, index) => {
    const left = Math.max(0, index - radius);
    const right = Math.min(values.length - 1, index + radius);
    return (prefix[right + 1] - prefix[left]) / (right - left + 1);
  });
}

function geometrySamplingWeights(sortedPath) {
  if (sortedPath.length < 3) return sortedPath.map(() => 1);
  const rawYs = sortedPath.map((point) => point.y);
  // Measure geometry on a lightly smoothed path so antialiasing and one-pixel
  // trace jitter do not consume the point budget. The returned points are still
  // interpolated from the unsmoothed, center-refined path.
  const smoothingRadius = clamp(Math.round(sortedPath.length * 0.003), 1, 8);
  const smoothedYs = movingAverage(rawYs, smoothingRadius);
  const directionRadius = clamp(Math.round(sortedPath.length * 0.006), 2, 12);

  return sortedPath.map((point, index) => {
    const leftIndex = Math.max(0, index - directionRadius);
    const rightIndex = Math.min(sortedPath.length - 1, index + directionRadius);
    const leftDx = point.x - sortedPath[leftIndex].x;
    const rightDx = sortedPath[rightIndex].x - point.x;
    const totalDx = sortedPath[rightIndex].x - sortedPath[leftIndex].x;
    if (!(totalDx > 1e-9)) return 1;

    const localSlope = (smoothedYs[rightIndex] - smoothedYs[leftIndex]) / totalDx;
    // Arc length per unit x is sqrt(1 + slope²). Blend it with a uniform-x
    // floor and cap it so a near-vertical fragment cannot starve flat regions.
    const arcRatio = clamp(Math.hypot(1, localSlope), 1, 6);
    const slopeDensity = 0.25 + arcRatio * 0.75;

    let turnScore = 0;
    if (leftDx > 1e-9 && rightDx > 1e-9) {
      const leftAngle = Math.atan2(smoothedYs[index] - smoothedYs[leftIndex], leftDx);
      const rightAngle = Math.atan2(smoothedYs[rightIndex] - smoothedYs[index], rightDx);
      const turnAngle = Math.abs(Math.atan2(
        Math.sin(rightAngle - leftAngle),
        Math.cos(rightAngle - leftAngle),
      ));
      turnScore = clamp(turnAngle / (Math.PI / 6), 0, 1);
    }
    return clamp(slopeDensity + turnScore * 1.5, 1, 6);
  });
}

function resamplePixelPathByWeights(sortedPath, sampleCount, weights) {
  const cumulative = [0];
  for (let index = 1; index < sortedPath.length; index += 1) {
    const deltaX = Math.max(0, sortedPath[index].x - sortedPath[index - 1].x);
    cumulative.push(cumulative.at(-1) + deltaX * (weights[index - 1] + weights[index]) / 2);
  }
  const totalWeight = cumulative.at(-1);
  if (!(totalWeight > 0)) return resamplePixelPath(sortedPath, sampleCount);

  const sampleXs = [];
  let cursor = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const target = (index / (sampleCount - 1)) * totalWeight;
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor += 1;
    const leftWeight = cumulative[cursor];
    const rightWeight = cumulative[Math.min(cursor + 1, cumulative.length - 1)];
    const fraction = rightWeight === leftWeight ? 0 : (target - leftWeight) / (rightWeight - leftWeight);
    sampleXs.push(sortedPath[cursor].x + fraction * (
      sortedPath[Math.min(cursor + 1, sortedPath.length - 1)].x - sortedPath[cursor].x
    ));
  }
  return interpolatePixelPath(sortedPath, sampleXs);
}

/**
 * Allocate a fixed point budget by displayed curve geometry. Steep segments
 * receive points according to their screen-space arc length, while a turn
 * bonus protects sharp corners whose instantaneous slope passes through zero.
 * Smooth peak neighborhoods are handled by the dedicated peak mode. A
 * uniform-x floor and density cap keep the distribution balanced.
 */
export function resamplePixelPathGeometry(path, count) {
  if (!Array.isArray(path) || path.length < 3) return resamplePixelPath(path, count);
  const numericCount = Number(count);
  const sampleCount = Math.max(2, Number.isFinite(numericCount) ? Math.round(numericCount) : 100);
  const sorted = [...path].sort((a, b) => a.x - b.x);
  return resamplePixelPathByWeights(sorted, sampleCount, geometrySamplingWeights(sorted));
}

export function resamplePixelPathAdaptive(path, count, options = {}) {
  if (!Array.isArray(path) || path.length < 5) return resamplePixelPath(path, count);
  const numericCount = Number(count);
  const sampleCount = Math.max(2, Number.isFinite(numericCount) ? Math.round(numericCount) : 100);
  const peakDensity = clamp(Number(options.peakDensity) || 4, 1, 12);
  const peakWidth = clamp(Number(options.peakWidth) || 8, 1, 30) / 100;
  const sorted = [...path].sort((a, b) => a.x - b.x);
  const minimumX = sorted[0].x;
  const maximumX = sorted.at(-1).x;
  const xSpan = maximumX - minimumX;
  if (xSpan <= 0) return resamplePixelPath(sorted, sampleCount);
  const geometryWeights = geometrySamplingWeights(sorted);
  if (peakDensity <= 1) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);

  const rawYs = sorted.map((point) => point.y);
  const ySpan = Math.max(...rawYs) - Math.min(...rawYs);
  if (ySpan < 1e-9) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);
  const smoothingRadius = Math.max(1, Math.round(sorted.length * 0.005));
  const smoothedYs = movingAverage(rawYs, smoothingRadius);
  const comparisonRadius = Math.max(smoothingRadius + 1, Math.round(sorted.length * peakWidth * 0.55));
  const candidates = [];

  for (let index = 1; index < sorted.length - 1; index += 1) {
    const leftSlope = smoothedYs[index] - smoothedYs[index - 1];
    const rightSlope = smoothedYs[index + 1] - smoothedYs[index];
    if (leftSlope * rightSlope > 0 || (leftSlope === 0 && rightSlope === 0)) continue;
    const leftIndex = Math.max(0, index - comparisonRadius);
    const rightIndex = Math.min(sorted.length - 1, index + comparisonRadius);
    const prominence = Math.min(
      Math.abs(smoothedYs[index] - smoothedYs[leftIndex]),
      Math.abs(smoothedYs[index] - smoothedYs[rightIndex]),
    );
    if (prominence < ySpan * 0.015) continue;
    candidates.push({ x: sorted[index].x, prominence });
  }

  if (!candidates.length) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);
  candidates.sort((a, b) => b.prominence - a.prominence);
  const minimumSeparation = xSpan * peakWidth * 0.45;
  const peaks = [];
  for (const candidate of candidates) {
    if (peaks.every((peak) => Math.abs(peak.x - candidate.x) >= minimumSeparation)) peaks.push(candidate);
  }
  const maximumProminence = peaks[0].prominence;
  const sigma = Math.max(1e-9, xSpan * peakWidth * 0.5);
  const peakWeights = sorted.map((point) => {
    let peakScore = 0;
    for (const peak of peaks) {
      const distance = (point.x - peak.x) / sigma;
      const prominence = peak.prominence / maximumProminence;
      peakScore = Math.max(peakScore, prominence * Math.exp(-0.5 * distance * distance));
    }
    return 1 + (peakDensity - 1) * peakScore;
  });
  const weights = geometryWeights.map((weight, index) => clamp(weight * peakWeights[index], 1, 12));
  return resamplePixelPathByWeights(sorted, sampleCount, weights);
}

export function resamplePixelPathRoughness(path, count, options = {}) {
  if (!Array.isArray(path) || path.length < 5) return resamplePixelPath(path, count);
  const numericCount = Number(count);
  const sampleCount = Math.max(2, Number.isFinite(numericCount) ? Math.round(numericCount) : 100);
  const noiseDensity = clamp(Number(options.noiseDensity) || 4, 1, 12);
  const noiseWindow = clamp(Number(options.noiseWindow) || 3, 1, 15) / 100;
  const sorted = [...path].sort((a, b) => a.x - b.x);
  const minimumX = sorted[0].x;
  const maximumX = sorted.at(-1).x;
  const xSpan = maximumX - minimumX;
  if (xSpan <= 0) return resamplePixelPath(sorted, sampleCount);
  const geometryWeights = geometrySamplingWeights(sorted);
  if (noiseDensity <= 1) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);

  const rawYs = sorted.map((point) => point.y);
  const baselineRadius = Math.max(2, Math.round(sorted.length * noiseWindow * 0.5));
  const baseline = movingAverage(rawYs, baselineRadius);
  const roughness = rawYs.map((value, index) => {
    const previous = rawYs[Math.max(0, index - 1)];
    const next = rawYs[Math.min(rawYs.length - 1, index + 1)];
    const localTurn = Math.abs((value - previous) - (next - value));
    return Math.abs(value - baseline[index]) + localTurn * 0.65;
  });
  const positive = roughness.filter((value) => value > 1e-9).sort((a, b) => a - b);
  if (!positive.length) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);
  const scale = positive[Math.min(positive.length - 1, Math.floor(positive.length * 0.9))];
  if (!(scale > 0)) return resamplePixelPathByWeights(sorted, sampleCount, geometryWeights);
  const roughnessWeights = roughness.map((value) => 1 + (noiseDensity - 1) * clamp(value / scale, 0, 1));
  const weights = geometryWeights.map((weight, index) => clamp(weight * roughnessWeights[index], 1, 12));
  return resamplePixelPathByWeights(sorted, sampleCount, weights);
}

export function resamplePath(path, xCalibration, yCalibration, count) {
  if (!validateCalibration(xCalibration) || !validateCalibration(yCalibration)) return [];
  return pathToData(resamplePixelPath(path, count), xCalibration, yCalibration);
}

function longestConsecutiveRun(path, predicate) {
  let longest = 0;
  let current = 0;
  for (const point of path) {
    if (predicate(point)) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

const reviewReasonLabels = {
  inferred: "遮挡推断",
  "low-confidence": "低置信度",
  ambiguous: "同色候选歧义",
  uncertain: "拟合不确定度较高",
  "model-disagreement": "遮挡恢复模型分歧",
  boundary: "疑似贴近坐标轴边界",
};

function pathPointReviewRisk(point, rect, markerSeries) {
  if (!point || point.anchor || point.userEdited || point.origin === "manual") {
    return { score: 0, reasons: [] };
  }
  let score = 0;
  const reasons = [];
  const inferred = point.observed === false || point.occlusionInferred;
  const confidence = clamp(Number(point.confidence ?? 1), 0, 1);
  if (inferred) {
    score += 0.9;
    reasons.push("inferred");
  }
  if (confidence < 0.5) {
    score += 0.45 + (0.5 - confidence) * 1.1;
    reasons.push("low-confidence");
  }
  const uncertainty = Number(point.inferenceUncertainty);
  if (Number.isFinite(uncertainty) && uncertainty > 2) {
    score += Math.min(0.75, (uncertainty - 2) * 0.16 + 0.2);
    reasons.push("uncertain");
  }
  const modelDisagreement = Number(point.modelDisagreement);
  if (Number.isFinite(modelDisagreement) && modelDisagreement > 1.25) {
    score += Math.min(0.7, (modelDisagreement - 1.25) * 0.18 + 0.2);
    reasons.push("model-disagreement");
  }
  const explicitAlternatives = Array.isArray(point.ambiguityAlternatives)
    ? point.ambiguityAlternatives.filter(Number.isFinite).length
    : 0;
  if (explicitAlternatives > 0) {
    score += Math.min(0.8, 0.5 + explicitAlternatives * 0.1);
    reasons.push("ambiguous");
  } else if ((point.candidateCount ?? 0) >= 3 && confidence < 0.7) {
    score += Math.min(0.45, ((point.candidateCount ?? 0) - 2) * 0.09 + 0.12);
    reasons.push("ambiguous");
  }
  const verticalTrace = point.traceOrientation === "vertical";
  const parametricTrace = point.traceOrientation === "parametric";
  const followsBoundary = parametricTrace
    ? Math.abs(point.x - rect.left) <= 2
      || Math.abs(point.x - rect.right) <= 2
      || Math.abs(point.y - rect.top) <= 2
      || Math.abs(point.y - rect.bottom) <= 2
    : verticalTrace
      ? Math.abs(point.x - rect.left) <= 2 || Math.abs(point.x - rect.right) <= 2
      : Math.abs(point.y - rect.top) <= 2 || Math.abs(point.y - rect.bottom) <= 2;
  if (!markerSeries && rect && followsBoundary) {
    score += 0.8;
    reasons.push("boundary");
  }
  return { score, reasons };
}

/**
 * Select the single click that should reduce branch uncertainty the most.
 * A useful click is placed after competing same-colour paths have separated
 * enough to distinguish visually, but before they become unreachable from the
 * current trajectory. Existing guides suppress nearby suggestions because the
 * user has already supplied authoritative information there.
 */
export function findMostInformativeAmbiguity(path, rect, anchors = []) {
  if (!Array.isArray(path) || !path.length || !rect) return null;
  const width = Math.max(1, Number(rect.width ?? rect.right - rect.left));
  const height = Math.max(1, Number(rect.height ?? rect.bottom - rect.top));
  const anchorSpacing = Math.max(5, width * 0.015);
  const supportRadius = Math.max(6, width * 0.02);
  const idealSeparation = clamp(height * 0.035, 5, 13);
  const maximumUsefulSeparation = clamp(height * 0.22, 14, 22);
  const validAnchors = (anchors ?? []).filter((anchor) => Number.isFinite(anchor?.x));

  const entries = path.flatMap((point, index) => {
    if (!point || point.anchor || point.userEdited || point.origin === "manual") return [];
    if (validAnchors.some((anchor) => Math.abs(anchor.x - point.x) < anchorSpacing)) return [];
    const alternatives = [...new Set((point.ambiguityAlternatives ?? [])
      .filter(Number.isFinite)
      .map(Number))]
      .filter((y) => (
        y >= rect.top && y <= rect.bottom
        && Math.abs(y - point.y) > 2
        && Math.abs(y - point.y) <= maximumUsefulSeparation
      ))
      .sort((left, right) => Math.abs(left - point.y) - Math.abs(right - point.y));
    if (!alternatives.length) return [];
    const separation = Math.abs(alternatives[0] - point.y);
    const clarity = clamp(separation / idealSeparation, 0, 1);
    const reachability = clamp(
      (maximumUsefulSeparation - separation) / Math.max(1, maximumUsefulSeparation - idealSeparation),
      0,
      1,
    );
    const localSupport = path.filter((candidate) => (
      Math.abs(candidate.x - point.x) <= supportRadius
      && Array.isArray(candidate.ambiguityAlternatives)
      && candidate.ambiguityAlternatives.length
    )).length;
    const edgeDistance = Math.min(point.x - rect.left, rect.right - point.x);
    const edgeFactor = clamp(edgeDistance / Math.max(8, width * 0.04), 0.35, 1);
    const confidence = clamp(Number(point.confidence ?? 1), 0, 1);
    const informationScore = (
      2.2
      + clarity * 1.4
      + reachability * 0.7
      + Math.min(1.2, localSupport * 0.12)
      + Math.min(0.6, (alternatives.length - 1) * 0.2)
      + (1 - confidence) * 0.45
    ) * edgeFactor;
    return [{
      pointIndex: index,
      x: point.x,
      y: point.y,
      alternatives,
      candidateYs: [point.y, ...alternatives].sort((left, right) => left - right),
      separation,
      localSupport,
      informationScore,
      kind: "branch",
    }];
  });

  return entries.sort((left, right) => (
    right.informationScore - left.informationScore
    || right.separation - left.separation
    || left.pointIndex - right.pointIndex
  ))[0] ?? null;
}

/**
 * Collapse individual questionable trace samples into a short, ranked review queue.
 * Manual edits and protected guide points are treated as already verified.
 */
export function findPathReviewRegions(path, rect) {
  if (!Array.isArray(path) || !path.length || !rect) return [];
  const markerSeries = path.every((point) => point.marker);
  const risks = path.map((point, index) => ({
    index,
    ...pathPointReviewRisk(point, rect, markerSeries),
  })).filter((entry) => entry.score >= 0.45);
  if (!risks.length) return [];

  const stepDistances = path.slice(1).map((point, index) => (
    Math.hypot(point.x - path[index].x, point.y - path[index].y)
  )).filter(Number.isFinite);
  const typicalStepDistance = median(stepDistances) ?? 0;
  const maximumMergeDistance = Math.max(
    6,
    Number(rect.width ?? 0) * 0.025,
    Math.min(Number(rect.width ?? 0) * 0.06, typicalStepDistance * 2.5),
  );
  const groups = [];
  for (const entry of risks) {
    const previousGroup = groups.at(-1);
    const previousEntry = previousGroup?.entries.at(-1);
    const pixelDistance = previousEntry
      ? Math.hypot(
        path[entry.index].x - path[previousEntry.index].x,
        path[entry.index].y - path[previousEntry.index].y,
      )
      : Infinity;
    if (
      previousGroup
      && entry.index - previousEntry.index <= 3
      && pixelDistance <= maximumMergeDistance
    ) {
      previousGroup.entries.push(entry);
    } else {
      groups.push({ entries: [entry] });
    }
  }

  return groups.map(({ entries }) => {
    const startIndex = entries[0].index;
    const endIndex = entries.at(-1).index;
    const regionPath = path.slice(startIndex, endIndex + 1);
    const reasonCounts = new Map();
    for (const entry of entries) {
      for (const reason of entry.reasons) {
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
    }
    const maximumRisk = Math.max(...entries.map((entry) => entry.score));
    const averageRisk = entries.reduce((sum, entry) => sum + entry.score, 0) / entries.length;
    const midpoint = (startIndex + endIndex) / 2;
    const representative = [...entries].sort((left, right) => (
      right.score - left.score || Math.abs(left.index - midpoint) - Math.abs(right.index - midpoint)
    ))[0];
    const reasons = [...reasonCounts.entries()]
      .map(([code, count]) => ({ code, count, label: reviewReasonLabels[code] }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "zh-CN"));
    const xMin = Math.min(...regionPath.map((point) => point.x));
    const xMax = Math.max(...regionPath.map((point) => point.x));
    const yMin = Math.min(...regionPath.map((point) => point.y));
    const yMax = Math.max(...regionPath.map((point) => point.y));
    const severeReason = reasons.some((reason) => (
      reason.code === "boundary" || (reason.code === "inferred" && reason.count >= 3)
    ));
    return {
      startIndex,
      endIndex,
      pointIndices: entries.map((entry) => entry.index),
      representativeIndex: representative.index,
      suspiciousPointCount: entries.length,
      xMin,
      xMax,
      yMin,
      yMax,
      severity: severeReason || maximumRisk >= 1.35 ? "poor" : "review",
      priority: maximumRisk * 60 + averageRisk * 25 + Math.min(15, Math.sqrt(entries.length) * 4),
      reasons,
    };
  }).filter((region) => (
    region.suspiciousPointCount > 1
    || region.reasons.some((reason) => !["inferred", "low-confidence"].includes(reason.code))
  )).sort((left, right) => (
    right.priority - left.priority || left.startIndex - right.startIndex
  ));
}

export function assessPathQuality(path, rect) {
  if (!Array.isArray(path) || path.length === 0 || !rect) {
    return {
      score: 0,
      grade: "empty",
      metrics: {},
      warnings: [{ code: "empty", severity: "error", message: "还没有可评估的曲线路径" }],
    };
  }
  const observedFraction = path.filter((point) => point.observed).length / path.length;
  const lowConfidenceFraction = path.filter((point) => (point.confidence ?? 0) < 0.5).length / path.length;
  const ambiguousFraction = path.filter((point) => (point.candidateCount ?? 0) > 1).length / path.length;
  const markerSeries = path.every((point) => point.marker);
  const topologyReviewRequired = path.some((point) => point.topologyReview);
  const parametricTrace = !markerSeries
    && path.filter((point) => point.traceOrientation === "parametric").length > path.length / 2;
  const closedParametricTrace = parametricTrace
    && path.filter((point) => point.closedPath).length > path.length / 2;
  const verticalTrace = !markerSeries
    && !parametricTrace
    && path.filter((point) => point.traceOrientation === "vertical").length > path.length / 2;
  const boundaryFraction = path.filter((point) => (
    parametricTrace
      ? Math.abs(point.x - rect.left) <= 2
        || Math.abs(point.x - rect.right) <= 2
        || Math.abs(point.y - rect.top) <= 2
        || Math.abs(point.y - rect.bottom) <= 2
      : verticalTrace
      ? Math.abs(point.x - rect.left) <= 2 || Math.abs(point.x - rect.right) <= 2
      : Math.abs(point.y - rect.top) <= 2 || Math.abs(point.y - rect.bottom) <= 2
  )).length / path.length;
  const scanValues = path.map((point) => verticalTrace ? point.y : point.x);
  const minimumScanCoordinate = Math.min(...scanValues);
  const maximumScanCoordinate = Math.max(...scanValues);
  const scanDimension = parametricTrace
    ? Math.hypot(rect.width, rect.height)
    : verticalTrace ? rect.height : rect.width;
  // Closed paths have no privileged scan axis. Their topology establishes a
  // complete traversal, while their bounding-box extent remains available as
  // a diagnostic instead of incorrectly penalising a legitimate small loop.
  const parametricXSpan = parametricTrace
    ? (Math.max(...path.map((point) => point.x)) - Math.min(...path.map((point) => point.x)) + 1)
      / Math.max(1, rect.width)
    : null;
  const parametricYSpan = parametricTrace
    ? (Math.max(...path.map((point) => point.y)) - Math.min(...path.map((point) => point.y)) + 1)
      / Math.max(1, rect.height)
    : null;
  const parametricArcLength = parametricTrace
    ? path.slice(1).reduce((length, point, index) => (
        length + Math.hypot(point.x - path[index].x, point.y - path[index].y)
      ), 0)
    : null;
  const spanFraction = parametricTrace
    ? closedParametricTrace ? 1 : clamp(parametricArcLength / Math.max(1, scanDimension), 0, 1)
    : clamp(
        (maximumScanCoordinate - minimumScanCoordinate + 1) / Math.max(1, scanDimension),
        0,
        1,
      );
  const longestInferredGap = longestConsecutiveRun(path, (point) => !point.observed);
  const warnings = [];

  if (topologyReviewRequired) warnings.push({
    code: "topology-review",
    severity: "warning",
    message: "路径经过自交节点；已优先保持切向连续，请复核交叉前后的连接顺序",
  });

  if ((!parametricTrace || !closedParametricTrace) && spanFraction < 0.8) warnings.push({
    code: "short-span",
    severity: "warning",
    message: parametricTrace
      ? `开放二维路径弧长只达到绘图区对角线的 ${(spanFraction * 100).toFixed(0)}%；可能只识别了局部片段`
      : `路径只覆盖绘图区${verticalTrace ? "高度" : "宽度"}的 ${(spanFraction * 100).toFixed(0)}%；可增加虚线间隔或添加引导点`,
  });
  if (observedFraction < 0.75) warnings.push({
    code: "low-observation",
    severity: "warning",
    message: `只有 ${(observedFraction * 100).toFixed(0)}% 的点直接来自图像，插值比例偏高`,
  });
  if (lowConfidenceFraction > 0.2) warnings.push({
    code: "low-confidence",
    severity: "warning",
    message: `${(lowConfidenceFraction * 100).toFixed(0)}% 的路径处于低置信度；重点核对圆点与原曲线的贴合`,
  });
  if (ambiguousFraction > 0.65) warnings.push({
    code: "many-candidates",
    severity: "warning",
    message: `${(ambiguousFraction * 100).toFixed(0)}% 的扫描线存在多个同色候选；黑白图或曲线族应重点核对引导点`,
  });
  const boundaryWarningThreshold = markerSeries ? 0.3 : 0.12;
  if (boundaryFraction > boundaryWarningThreshold) warnings.push({
    code: "boundary-following",
    severity: markerSeries ? "warning" : "error",
    message: markerSeries
      ? `${(boundaryFraction * 100).toFixed(0)}% 的 marker 贴近绘图区边界；请确认这些实验点确实位于坐标轴上`
      : `路径有 ${(boundaryFraction * 100).toFixed(0)}% 贴近${parametricTrace ? "绘图区" : verticalTrace ? "左右" : "上下"}边框，可能误追了坐标轴`,
  });
  if (longestInferredGap > Math.max(12, scanDimension * 0.08)) warnings.push({
    code: "long-gap",
    severity: "warning",
    message: `最长连续插值 ${longestInferredGap} px；该区间的信息可能已被图例或遮挡破坏`,
  });

  const score = Math.round(clamp(
    100
      - (1 - observedFraction) * 32
      - lowConfidenceFraction * 28
      - ambiguousFraction * 8
      - (topologyReviewRequired ? 10 : 0)
      - (1 - spanFraction) * 30
      - boundaryFraction * (markerSeries ? 8 : 35)
      - Math.min(0.12, longestInferredGap / Math.max(1, scanDimension)) * 80,
    0,
    100,
  ));
  const grade = score >= 85
    && !topologyReviewRequired
    && !warnings.some((warning) => warning.severity === "error")
    ? "good"
    : score >= 65 && !warnings.some((warning) => warning.severity === "error") ? "review" : "poor";
  return {
    score,
    grade,
    metrics: {
      observedFraction,
      lowConfidenceFraction,
      ambiguousFraction,
      boundaryFraction,
      spanFraction,
      parametricXSpan,
      parametricYSpan,
      parametricArcLength,
      topologyReviewRequired,
      longestInferredGap,
      traceOrientation: parametricTrace ? "parametric" : verticalTrace ? "vertical" : "horizontal",
    },
    warnings,
  };
}

export function preferOrdinaryTraceFallback(patternedPath, ordinaryPath, rect, {
  autoConfidence = 1,
} = {}) {
  if (!Array.isArray(patternedPath) || !patternedPath.length
    || !Array.isArray(ordinaryPath) || !ordinaryPath.length || !rect) return false;
  const patterned = assessPathQuality(patternedPath, rect);
  const ordinary = assessPathQuality(ordinaryPath, rect);
  if (ordinary.metrics.spanFraction >= patterned.metrics.spanFraction + 0.15) return true;
  if (!Number.isFinite(autoConfidence) || autoConfidence > 0.65) return false;
  const observedGain = ordinary.metrics.observedFraction - patterned.metrics.observedFraction;
  const confidenceGain = patterned.metrics.lowConfidenceFraction - ordinary.metrics.lowConfidenceFraction;
  return ordinary.score >= patterned.score + 12
    && (observedGain >= 0.18 || confidenceGain >= 0.18);
}

export function formatNumber(value, precision = 8) {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || magnitude < 1e-4) return value.toExponential(Math.max(2, precision - 2));
  return Number(value.toPrecision(precision)).toString();
}

export function buildPairedCurveRows(series, xLabel = "x", yLabel = "y") {
  const curves = (Array.isArray(series) ? series : []).map((curve, index) => ({
    label: String(curve?.label ?? "").trim() || `Curve ${index + 1}`,
    data: Array.isArray(curve?.data) ? curve.data : [],
    xLabel: String(curve?.xLabel ?? "").trim() || String(xLabel ?? "").trim() || "x",
    yLabel: String(curve?.yLabel ?? "").trim() || String(yLabel ?? "").trim() || "y",
  }));
  const rows = [
    curves.flatMap((curve) => [curve.label, ""]),
    curves.flatMap((curve) => [curve.xLabel, curve.yLabel]),
  ];
  const maximumPointCount = Math.max(0, ...curves.map((curve) => curve.data.length));
  for (let pointIndex = 0; pointIndex < maximumPointCount; pointIndex += 1) {
    rows.push(curves.flatMap((curve) => {
      const point = curve.data[pointIndex];
      if (!point) return ["", ""];
      return [formatNumber(Number(point.dataX), 12), formatNumber(Number(point.dataY), 12)];
    }));
  }
  return rows;
}

export function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
