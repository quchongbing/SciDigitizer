import {
  discoverColoredSeries,
  extractMarkerCenters,
  fitInferredPathGaps,
  inferLineStyle,
  inferMarkerSeries,
  preferOrdinaryTraceFallback,
  refinePathCenterline,
  traceCurveThroughAnchors,
} from "./core.js?v=0.20.0-preview.3.21";

import { traceParametricCurve } from "./parametric-trace.js?v=0.20.0-preview.3.21";

function requireImage(image) {
  if (
    !image?.rgba
    || image.rgba.length !== image.width * image.height * 4
  ) throw new Error("compute image is unavailable or incomplete");
  return image;
}

function imageOptions(image, payload) {
  return {
    ...payload,
    rgba: image.rgba,
    width: image.width,
    height: image.height,
  };
}

function horizontalSpan(path, rect) {
  if (!path?.length) return 0;
  const xs = path.map((point) => point.x);
  return (Math.max(...xs) - Math.min(...xs)) / Math.max(1, rect.width);
}

function traceLineInFrame(image, payload) {
  const {
    autoPatternedStyle = false,
    autoStyleConfidence = 1,
    refinementMode = "full",
    ...tracePayload
  } = payload;
  const options = imageOptions(image, tracePayload);
  let targetStyle = options.targetStyle;
  let path = traceCurveThroughAnchors(options);
  let autoFallback = false;
  if (
    autoPatternedStyle
    && (horizontalSpan(path, options.rect) < 0.72 || autoStyleConfidence <= 0.65)
  ) {
    const ordinaryPath = traceCurveThroughAnchors({ ...options, targetStyle: "line" });
    if (preferOrdinaryTraceFallback(path, ordinaryPath, options.rect, {
      autoConfidence: autoStyleConfidence,
    })) {
      path = ordinaryPath;
      targetStyle = "line";
      autoFallback = true;
    }
  }
  if (refinementMode !== "off") {
    path = refinePathCenterline({ ...options, path, iterations: 2 });
  }
  if (refinementMode === "full") path = fitInferredPathGaps(path, { rect: options.rect });
  // Scan columns remain integral, but user guide coordinates do not. Restore
  // only an actually retained anchor, never manufacture a missing branch.
  path = path.map((point) => {
    if (!point.anchor) return point;
    const guide = (options.anchors ?? []).find((anchor) => (
      anchor.anchorId ? anchor.anchorId === point.anchorId
        : Math.round(anchor.x) === point.x && Math.abs(anchor.y - point.y) < 1e-7
    ));
    return guide ? { ...point, x: guide.x, y: guide.y } : point;
  });
  return { path, targetStyle, autoFallback };
}

function transposePoint(point) {
  if (!point) return point;
  return { ...point, x: point.y, y: point.x };
}

function transposeRect(rect) {
  if (!rect) return rect;
  return {
    ...rect,
    left: rect.top,
    top: rect.left,
    right: rect.bottom,
    bottom: rect.right,
    width: rect.height ?? rect.bottom - rect.top + 1,
    height: rect.width ?? rect.right - rect.left + 1,
  };
}

function transposeImage(image) {
  const rgba = new Uint8ClampedArray(image.rgba.length);
  const transposedWidth = image.height;
  const transposedHeight = image.width;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const sourceIndex = (y * image.width + x) * 4;
      const destinationIndex = (x * transposedWidth + y) * 4;
      rgba[destinationIndex] = image.rgba[sourceIndex];
      rgba[destinationIndex + 1] = image.rgba[sourceIndex + 1];
      rgba[destinationIndex + 2] = image.rgba[sourceIndex + 2];
      rgba[destinationIndex + 3] = image.rgba[sourceIndex + 3];
    }
  }
  return { rgba, width: transposedWidth, height: transposedHeight };
}

function transposeInclusionMask(mask, width, height) {
  if (!mask?.data) return null;
  const data = new Uint8Array(width * height);
  const allowed = mask.allowed ? new Uint8Array(width * height) : null;
  const columns = new Uint8Array(height);
  for (let y = 0; y < height; y += 1) {
    let rowPainted = false;
    for (let x = 0; x < width; x += 1) {
      const painted = Boolean(mask.data[y * width + x]);
      data[x * height + y] = painted ? 1 : 0;
      if (allowed) allowed[x * height + y] = mask.allowed[y * width + x];
      rowPainted ||= painted;
    }
    columns[y] = rowPainted ? 1 : 0;
  }
  return { data, columns, allowed, mode: mask.mode };
}

function transposeTracePayload(payload, width, height) {
  return {
    ...payload,
    rect: transposeRect(payload.rect),
    anchors: (payload.anchors ?? []).map(transposePoint),
    exclusions: (payload.exclusions ?? []).map(transposeRect),
    avoidPaths: (payload.avoidPaths ?? []).map((path) => path.map(transposePoint)),
    inclusionMask: transposeInclusionMask(payload.inclusionMask, width, height),
  };
}

function directionSpan(path, rect, orientation) {
  if (!path?.length || !rect) return 0;
  const values = path.map((point) => orientation === "vertical" ? point.y : point.x);
  const dimension = orientation === "vertical" ? rect.height : rect.width;
  return (Math.max(...values) - Math.min(...values) + 1) / Math.max(1, dimension);
}

function traceEvidence(result, rect, orientation) {
  const path = result.path ?? [];
  if (!path.length) return 0;
  const observedFraction = path.filter((point) => point.observed).length / path.length;
  const meanConfidence = path.reduce((sum, point) => sum + Number(point.confidence ?? 0), 0) / path.length;
  return directionSpan(path, rect, orientation) * 0.64
    + observedFraction * 0.23
    + meanConfidence * 0.13;
}

function pathArcLength(path, closed = false) {
  if (!path?.length || path.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < path.length; index += 1) {
    length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
  }
  if (closed) length += Math.hypot(path[0].x - path.at(-1).x, path[0].y - path.at(-1).y);
  return length;
}

function maximumPathStep(path) {
  let maximum = 0;
  for (let index = 1; index < (path?.length ?? 0); index += 1) {
    maximum = Math.max(maximum, Math.hypot(
      path[index].x - path[index - 1].x,
      path[index].y - path[index - 1].y,
    ));
  }
  return maximum;
}

function retainsEveryGuide(path, anchors) {
  return (anchors ?? []).every((anchor) => path.some((point) => (
    anchor.anchorId
      ? point.anchorId === anchor.anchorId
      : Math.hypot(point.x - anchor.x, point.y - anchor.y) <= 1e-6
  )));
}

function guideMinimumTreeLength(anchors) {
  if ((anchors?.length ?? 0) < 2) return 0;
  const included = new Uint8Array(anchors.length);
  const distances = new Float64Array(anchors.length);
  distances.fill(Number.POSITIVE_INFINITY);
  distances[0] = 0;
  let length = 0;
  for (let count = 0; count < anchors.length; count += 1) {
    let current = -1;
    for (let index = 0; index < anchors.length; index += 1) {
      if (!included[index] && (current < 0 || distances[index] < distances[current])) current = index;
    }
    included[current] = 1;
    length += distances[current];
    for (let index = 0; index < anchors.length; index += 1) {
      if (included[index]) continue;
      distances[index] = Math.min(distances[index], Math.hypot(
        anchors[index].x - anchors[current].x,
        anchors[index].y - anchors[current].y,
      ));
    }
  }
  return length;
}

function guidesRequireMixedDirectionPath(anchors, rect) {
  if ((anchors?.length ?? 0) < 3 || !rect) return false;
  const xValues = anchors.map((anchor) => anchor.x);
  const horizontalSpan = Math.max(...xValues) - Math.min(...xValues);
  if (horizontalSpan < Math.max(20, rect.width * 0.15)) return false;
  const nearVerticalPair = anchors.some((left, leftIndex) => anchors.some((right, rightIndex) => (
    rightIndex > leftIndex
    && Math.abs(right.x - left.x) <= Math.max(6, rect.width * 0.03)
    && Math.abs(right.y - left.y) >= Math.max(20, rect.height * 0.12)
  )));
  return nearVerticalPair;
}

function ambiguityFraction(path) {
  if (!path?.length) return 0;
  return path.filter((point) => (
    (point.candidateCount ?? 0) > 1 || point.ambiguityAlternatives?.length
  )).length / path.length;
}

function markOrientation(path, orientation) {
  return path.map((point, index) => ({
    ...point,
    traceOrientation: orientation,
    parametricOrder: index,
  }));
}

function traceLineVertical(image, payload) {
  const transposedImage = transposeImage(image);
  const transposedPayload = transposeTracePayload(payload, image.width, image.height);
  const result = traceLineInFrame(transposedImage, transposedPayload);
  return {
    ...result,
    path: markOrientation(result.path.map((point) => {
      const restored = transposePoint(point);
      // Column alternatives in the transposed frame represent alternative X
      // positions. Keep them for diagnostics without exposing them to the
      // horizontal branch-click assistant as candidate Y coordinates.
      if (Array.isArray(restored.ambiguityAlternatives)) {
        restored.verticalAmbiguityAlternatives = [...restored.ambiguityAlternatives];
        delete restored.ambiguityAlternatives;
      }
      return restored;
    }), "vertical"),
    orientation: "vertical",
  };
}

function traceLineParametric(image, payload, fallbackStyle = "line") {
  const options = imageOptions(image, payload);
  const parametric = traceParametricCurve(options);
  if (!parametric.path.length) {
    return {
      path: [],
      targetStyle: fallbackStyle,
      autoFallback: false,
      orientation: "parametric",
      parametricDiagnostics: parametric,
    };
  }
  return {
    path: parametric.path,
    targetStyle: fallbackStyle === "auto" ? "line" : fallbackStyle,
    autoFallback: false,
    orientation: "parametric",
    parametricDiagnostics: parametric,
  };
}

function traceLine(image, payload) {
  const orientationMode = ["horizontal", "vertical", "parametric"].includes(payload.orientationMode)
    ? payload.orientationMode
    : "auto";
  const tracePayload = { ...payload };
  delete tracePayload.orientationMode;
  if (orientationMode === "parametric") {
    const forced = traceLineParametric(image, tracePayload, tracePayload.targetStyle);
    if (!forced.path.length) {
      throw new Error("未找到可信的二维目标路径；请增加引导点、画 Pen 走廊，或改回自动判断");
    }
    return forced;
  }
  if (orientationMode === "vertical") return traceLineVertical(image, tracePayload);

  const horizontal = traceLineInFrame(image, tracePayload);
  const horizontalResult = {
    ...horizontal,
    path: markOrientation(horizontal.path, "horizontal"),
    orientation: "horizontal",
  };
  if (orientationMode === "horizontal") return horizontalResult;

  const horizontalCoverage = directionSpan(horizontalResult.path, tracePayload.rect, "horizontal");
  const horizontalObserved = horizontalResult.path.length
    ? horizontalResult.path.filter((point) => point.observed).length / horizontalResult.path.length
    : 0;
  const horizontalAmbiguity = ambiguityFraction(horizontalResult.path);
  const requireGuided2d = guidesRequireMixedDirectionPath(tracePayload.anchors, tracePayload.rect);
  const guideAssisted2d = requireGuided2d || (Boolean(tracePayload.inclusionMask?.data)
    && (tracePayload.anchors?.length ?? 0) >= 3);
  // A healthy ordinary curve returns immediately. The transposed fallback is
  // only evaluated when the x-column model fails to cover the plot, keeping
  // the established one-click path fast and byte-for-byte equivalent.
  if (
    horizontalCoverage >= 0.78
    && horizontalObserved >= 0.68
    && horizontalAmbiguity < 0.42
    && !guideAssisted2d
    && retainsEveryGuide(horizontalResult.path, tracePayload.anchors)
  ) return horizontalResult;

  let selected = horizontalResult;
  if (horizontalCoverage < 0.78 || horizontalObserved < 0.68
    || !retainsEveryGuide(horizontalResult.path, tracePayload.anchors)) {
    const verticalResult = traceLineVertical(image, tracePayload);
    const horizontalScore = traceEvidence(horizontalResult, tracePayload.rect, "horizontal");
    const verticalScore = traceEvidence(verticalResult, tracePayload.rect, "vertical");
    const verticalCoverage = directionSpan(verticalResult.path, tracePayload.rect, "vertical");
    const chooseVertical = retainsEveryGuide(verticalResult.path, tracePayload.anchors)
      && (!retainsEveryGuide(horizontalResult.path, tracePayload.anchors)
        || (verticalCoverage >= horizontalCoverage + 0.12 && verticalScore >= horizontalScore + 0.07));
    if (chooseVertical) selected = verticalResult;
  }

  const selectedAmbiguity = ambiguityFraction(selected.path);
  const shouldInspectParametric = horizontalAmbiguity >= 0.42
    || !retainsEveryGuide(selected.path, tracePayload.anchors)
    || selectedAmbiguity >= 0.42
    || directionSpan(selected.path, tracePayload.rect, selected.orientation) < 0.62
    || guideAssisted2d
    // A deliberate occlusion mask may split a loop into scan-line fragments
    // even when one visible branch still spans the X range. Inspect the 2D
    // graph after this explicit user signal; ordinary unmasked curves retain
    // the established early return and incur no extra work.
    || (tracePayload.exclusions?.length ?? 0) > 0;
  if (!shouldInspectParametric || ![
    "auto", "line", "noisy", "dashed", "dotted", "dashdot",
  ].includes(tracePayload.targetStyle)) {
    return selected;
  }
  const parametric = traceLineParametric(image, tracePayload, selected.targetStyle);
  const diagnostics = parametric.parametricDiagnostics;
  const selectedLength = pathArcLength(selected.path);
  const parametricLength = diagnostics?.arcLength ?? pathArcLength(parametric.path, true);
  const guideLength = guideMinimumTreeLength(tracePayload.anchors);
  const chooseSimpleParametric = parametric.path.length >= 24
    && (diagnostics?.simpleCycle || diagnostics?.simplePath)
    && diagnostics.topologyConfidence >= 0.9
    && retainsEveryGuide(parametric.path, tracePayload.anchors)
    && (parametricLength >= selectedLength * 1.35 || (requireGuided2d
      && maximumPathStep(parametric.path) <= Math.max(8, Number(tracePayload.maxJump ?? 8))
      && parametricLength >= guideLength * 0.9));
  // Three or more guides inside a painted Pen corridor are explicit
  // evidence for a mixed-orientation route. This covers curves that are
  // horizontal, turn vertical, and cross same-colour ink: neither a global
  // X nor Y scan can represent the full path. Keep the result review-required
  // and accept it only when the graph route retains every guide, is continuous,
  // and is not merely a short local shortcut.
  const chooseGuidedParametric = parametric.path.length >= 24
    && guideAssisted2d
    && diagnostics?.guidedBranchedPath
    && diagnostics.topologyConfidence >= 0.55
    && retainsEveryGuide(parametric.path, tracePayload.anchors)
    && maximumPathStep(parametric.path) <= Math.max(8, Number(tracePayload.maxJump ?? 8))
    // Use an order-independent lower bound. Guides may be added while panning
    // around the plot rather than in exact curve order; the Pen graph resolves
    // their geometric order. A wrong scan-line result can contain a giant jump
    // between unrelated black objects and has no useful length comparison.
    && parametricLength >= guideLength * 0.9
    && parametricLength <= guideLength * 4;
  if (chooseSimpleParametric || chooseGuidedParametric) return parametric;
  // When the guides themselves clearly show both a broad horizontal span and
  // a near-vertical section, returning a scan-line fallback is demonstrably
  // wrong. Fail closed so the UI never leaves plausible-looking points on an
  // unrelated same-colour line outside an incomplete Pen stroke.
  if (requireGuided2d) {
    throw new Error("二维 Pen 路径不连续；请沿目标曲线补涂完整走廊，并在转弯或交叉两侧保留引导点");
  }
  return selected;
}

/**
 * Execute one deterministic, DOM-free image operation. Both the Web Worker
 * and the synchronous fallback call this exact function so responsiveness can
 * improve without creating a second extraction algorithm.
 */
export function runComputeOperation(type, payload = {}, suppliedImage = null) {
  const image = requireImage(suppliedImage);
  if (type === "discover-colors") {
    return discoverColoredSeries({
      ...payload,
      rgba: image.rgba,
      width: image.width,
      height: image.height,
    });
  }
  if (type === "classify-target") {
    const options = imageOptions(image, payload);
    const markerInference = inferMarkerSeries(options);
    const lineInference = markerInference.detected ? null : inferLineStyle(options);
    return { markerInference, lineInference };
  }
  if (type === "trace-marker") {
    const { automatic = false, seed = null, ...markerPayload } = payload;
    const options = imageOptions(image, markerPayload);
    if (automatic) {
      const inference = inferMarkerSeries({ ...options, seed });
      return { path: inference.markers, inference };
    }
    return { path: extractMarkerCenters(options), inference: null };
  }
  if (type === "trace-line") return traceLine(image, payload);
  throw new Error(`unsupported compute operation: ${type}`);
}
