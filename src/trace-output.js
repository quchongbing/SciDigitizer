import {
  constrainPathToInclusionMask,
  includeMandatoryParametricPoints,
  includeMandatoryPoints,
  resamplePixelPath,
  resamplePixelPathArcLength,
  resamplePixelPathAdaptive,
  resamplePixelPathGeometry,
  resamplePixelPathRoughness,
} from "./core.js?v=0.20.0-preview.3.21";

function outputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function isDuplicateGuidePoint(anchors, point) {
  return anchors.some((anchor) => Math.hypot(anchor.x - point.x, anchor.y - point.y) < 0.5);
}

function transpose(point) {
  return { ...point, x: point.y, y: point.x };
}

export function sampleTracePath(path, count, parameters = {}, orientation = "horizontal") {
  if (orientation === "parametric") {
    return resamplePixelPathArcLength(path, count, { closed: path.some((point) => point.closedPath) });
  }
  const source = orientation === "vertical" ? path.map(transpose) : path;
  let sampled;
  if (parameters.samplingMode === "peak") sampled = resamplePixelPathAdaptive(source, count, parameters);
  else if (parameters.samplingMode === "noise") sampled = resamplePixelPathRoughness(source, count, parameters);
  else if (parameters.samplingMode === "geometry") sampled = resamplePixelPathGeometry(source, count);
  else sampled = resamplePixelPath(source, count);
  return orientation === "vertical" ? sampled.map(transpose) : sampled;
}

export function retainTraceGuides(sampled, mandatory, count, orientation = "horizontal") {
  if (orientation === "parametric") return includeMandatoryParametricPoints(sampled, mandatory, count);
  if (orientation === "vertical") {
    return includeMandatoryPoints(sampled.map(transpose), mandatory.map(transpose), count).map(transpose);
  }
  return includeMandatoryPoints(sampled, mandatory, count);
}

/** Shared by tracing, density edits, restore and export. No DOM or state writes.
 * Only one-pixel raster-edge corrections are allowed; large errors fail closed.
 * A failure never partially installs a new raw path in the application state.
 */
export function prepareTraceOutput(path, {
  count = null,
  parameters = {},
  orientation = "horizontal",
  guides = [],
  markerData = false,
  ...corridor
} = {}) {
  if (!path?.length) throw outputError("EMPTY_PATH", "未找到可用路径；请补充引导点或调整 Pen 后重新追踪");
  if (path.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    throw outputError("INVALID_PATH", "路径包含无效坐标；未替换上一次结果");
  }
  for (const guide of guides) {
    if (!path.some((point) => (
      (!guide.anchorId || point.anchorId === guide.anchorId)
      && Math.hypot(point.x - guide.x, point.y - guide.y) < 1e-7
    ))) throw outputError("MISSING_GUIDE", "路径未经过全部引导点；请调整走廊或切换二维追踪");
  }
  const constrain = (points) => {
    const result = constrainPathToInclusionMask(points, { ...corridor, orientation });
    if (result.some((point) => point.corridorOutside && !point.anchor && !point.userGuided)) {
      throw outputError("PEN_OUTSIDE", "路径超出 Pen 约束范围；请补涂走廊或调整引导点后重试");
    }
    return result;
  };
  // Reindex before sampling, so guide positions and interpolated positions use
  // the same parameter domain even after editing or loading a saved project.
  const rawPath = constrain(path.map((point, index) => ({ ...point, parametricOrder: index })));
  const mandatory = rawPath.filter((point) => point.anchor || point.userGuided);
  let sampled = rawPath;
  if (count !== null && !markerData) {
    sampled = retainTraceGuides(
      sampleTracePath(rawPath, count, parameters, orientation), mandatory, count, orientation,
    );
    // Mandatory insertion is a sampling constraint, not a promotion of a
    // manually edited regular point to a permanent guide anchor.
    sampled = sampled.map((point) => {
      const original = mandatory.find((guide) => (
        point.anchor && point.x === guide.x && point.y === guide.y
        && (!guide.anchorId || point.anchorId === guide.anchorId)
      ));
      return original ? { ...point, ...original } : point;
    });
    sampled = constrain(sampled);
  }
  for (const guide of mandatory) {
    if (!sampled.some((point) => (
      point.x === guide.x && point.y === guide.y
      && (!guide.anchorId || point.anchorId === guide.anchorId)
    ))) throw outputError("MISSING_GUIDE", "路径未经过全部引导点；请调整走廊或切换二维追踪");
  }
  const marked = sampled.map((point, index) => ({
    ...point, traceOrientation: orientation, parametricOrder: index,
  }));
  return { rawPath, path: marked, orientation };
}

/** Migrate old projects/drafts without losing their data on validation errors. */
export function prepareRestoredTrace(curve, options = {}) {
  if (curve.traceStale || !curve.path?.length) return { ...curve };
  try {
    const rawPath = curve.rawPath?.length
      ? prepareTraceOutput(curve.rawPath, { ...options, count: null }).path : (curve.rawPath ?? []);
    const path = prepareTraceOutput(curve.path, options).path;
    return { ...curve, path, rawPath, traceStale: false, traceError: null };
  } catch (error) {
    return { ...curve, traceStale: true, traceError: error.message };
  }
}
