import {
  assessCalibrationQuality,
  assessPathQuality,
  buildPairedCurveRows,
  calibrationUncertaintyAtPixel,
  calibrationError,
  clamp,
  compositedColorDistance,
  csvEscape,
  detectPlotRects,
  estimateColorThreshold,
  findMostInformativeAmbiguity,
  findPathReviewRegions,
  formatNumber,
  inclusionMaskAllows,
  normalizeRect,
  prepareInclusionMask,
  pathToData,
  pixelToValue,
  sampleRepresentativeColor,
  snapCalibrationPoint,
  snapTargetPoint,
  suggestInterferenceMasks,
  validateCalibration,
  valueStepForPixelNudge,
  valueToPixel,
} from "./core.js?v=0.20.0-preview.3.21";

import {
  isDuplicateGuidePoint,
  prepareRestoredTrace,
  prepareTraceOutput,
} from "./trace-output.js?v=0.20.0-preview.3.21";

import { runComputeOperation } from "./compute-engine.js?v=0.20.0-preview.3.21";
import { createComputeClient } from "./compute-client.js?v=0.20.0-preview.3.21";

import {
  pickRasterImageFile,
  rasterImageDisplayName,
  validateRasterImageFile,
} from "./image-import.js?v=0.20.0-preview.3.21";

import {
  alignmentCorrectionDegrees,
  composeRotationDegrees,
  normalizeRotationDegrees,
  renderRotatedImage,
  splitRotationDegrees,
} from "./image-transform.js?v=0.20.0-preview.3.21";

import {
  cloneSerializable,
  createEditSession,
  fingerprintImageData,
} from "./edit-session.js?v=0.20.0-preview.3.21";

import {
  detectFrameQuadrilateral,
  detectPerspectiveFrame,
  estimateAxisSkew,
  warpPerspectiveRgba,
} from "./image-geometry.js?v=0.20.0-preview.3.21";

import {
  initializeI18n,
  refreshTranslations,
  setLanguage,
  translateMessage,
} from "./i18n.js?v=0.20.0-preview.3.21";

initializeI18n();

const minimumCalibrationReferences = 2;
const maximumCalibrationReferences = 5;

function emptyCalibrationPoints() {
  return Object.fromEntries(
    ["x", "y"].flatMap((axis) => Array.from(
      { length: maximumCalibrationReferences },
      (_, index) => [`${axis}${index + 1}`, null],
    )),
  );
}

const $ = (selector) => document.querySelector(selector);
const canvas = $("#plot-canvas");
const context = canvas.getContext("2d");
const imageCanvas = $("#plot-image-canvas");
const imageContext = imageCanvas.getContext("2d", { willReadFrequently: true });
const plotSurface = $("#plot-surface");
const scroller = $("#canvas-scroller");
const magnifierCanvas = $("#magnifier-canvas");
const magnifierContext = magnifierCanvas.getContext("2d");

const state = {
  image: null,
  imageData: null,
  source: { name: "", samplePath: null, width: 0, height: 0 },
  plotRect: null,
  draftRect: null,
  exclusions: [],
  exclusionSuggestions: [],
  exclusionSuggestionIndex: 0,
  colorSuggestions: [],
  draftExclusion: null,
  traceCorridorOperations: [],
  draftTraceCorridor: null,
  calibrationPoints: emptyCalibrationPoints(),
  calibrationReferenceCounts: { x: 2, y: 2 },
  seed: null,
  seedColor: null,
  automaticMarkerSeries: false,
  automaticMarkerConfidence: 0,
  anchors: [],
  rawPath: [],
  path: [],
  traceOrientation: "horizontal",
  series: [],
  editingSeriesId: null,
  mode: null,
  dragStart: null,
  cursor: null,
  magnifierPoint: null,
  hoveredPointId: null,
  pointHoverSource: null,
  selectedPointId: null,
  draggedPointId: null,
  pointDragMoved: false,
  hoveredAnchorIndex: null,
  selectedAnchorIndex: null,
  draggedAnchorIndex: null,
  anchorDragMoved: false,
  zoom: 1,
  plotSuggestions: [],
  plotSuggestionIndex: -1,
  selectedCalibrationKey: null,
  draggedCalibrationKey: null,
  calibrationDragMoved: false,
  calibrationBeforeSeriesEdit: null,
  reviewRegionIndex: 0,
  preprocessingDiagnostics: null,
  perspectiveCommitted: null,
  originalImage: null,
  rotationCommitted: { degrees: 0 },
  rotationDraft: null,
  rotationPreviewImage: null,
  rotationPreviewActive: false,
  rotationAlignmentPoints: [],
  rotationPendingCommit: null,
  rotationPreviewFrame: null,
  ambiguityResolutionTarget: null,
  computeBusy: null,
  traceStale: false,
  traceError: null,
};

const seriesPalette = ["#087f8c", "#d1495b", "#6a4c93", "#e07a1f", "#3a7d44", "#2069c3", "#b34b9b", "#66717e"];
const builtInSamplePath = "images/fig1.png";
const supportedProjectSchemaVersions = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
const defaultTracePointCount = 100;
const maximumTracePointCount = 2000;
const draftStoragePrefix = "scidigitizer:draft:v1:";
let pointIdSequence = 0;
let guideIdSequence = 0;
let editSession = null;
let draftRecoveryAvailable = false;
let plotDetectionSequence = 0;
let traceCorridorRevision = 0;
let traceCorridorCache = null;
let interferenceScanSequence = 0;
let colorDiscoverySequence = 0;
let targetSelectionSequence = 0;
let traceTaskSequence = 0;

const computeClient = createComputeClient({
  workerUrl: new URL("src/trace-worker.js?v=0.20.0-preview.3.21", document.baseURI).href,
});

function currentComputeImage() {
  if (!state.imageData) return null;
  return {
    rgba: state.imageData.data,
    width: state.imageData.width,
    height: state.imageData.height,
  };
}

function runBackgroundOperation(operation, payload) {
  const image = currentComputeImage();
  if (!image) return Promise.reject(new Error("工作图像尚未准备完成"));
  // Display canvases are not structured-cloneable. Only send the numerical
  // Pen contract to the Worker (file:// uses the exact same payload).
  const mask = payload.inclusionMask;
  const numericalPayload = { ...payload, inclusionMask: mask ? {
    data: mask.data, columns: mask.columns, rows: mask.rows,
    allowed: mask.allowed, mode: mask.mode,
  } : null };
  return computeClient.run(
    operation,
    numericalPayload,
    () => runComputeOperation(operation, numericalPayload, image),
  );
}

const editableControlSelectors = [
  "#x-scale", "#y-scale", "#x-value-1", "#x-value-2", "#x-value-3", "#x-value-4", "#x-value-5",
  "#y-value-1", "#y-value-2", "#y-value-3", "#y-value-4", "#y-value-5", "#x-label", "#y-label",
  "#series-label", "#color-threshold", "#max-jump", "#max-gap", "#sampling-mode",
  "#peak-density", "#peak-width", "#noise-density", "#noise-window", "#strict-guide",
  "#target-style", "#trace-orientation", "#path-refinement", "#trace-point-count", "#export-density",
  "#trace-corridor-width", "#trace-corridor-mode", "#calibration-snap",
];

let imageLoadSequence = 0;
function colorToCss(color, fallback = "#111111") {
  if (!color || ![color.r, color.g, color.b].every(Number.isFinite)) return fallback;
  return `rgb(${Math.round(color.r)} ${Math.round(color.g)} ${Math.round(color.b)})`;
}

function formatAngleDegrees(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  const rounded = Number(numeric.toFixed(2));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function seriesTargetColor(series, index = 0) {
  return colorToCss(series?.seedColor, seriesPalette[index % seriesPalette.length]);
}

function colorDistance(left, right) {
  if (!left || !right) return Infinity;
  return Math.hypot(left.r - right.r, left.g - right.g, left.b - right.b);
}

function targetInkNearGuide(point) {
  if (!state.imageData || !state.seedColor || !point) return false;
  const radius = 3;
  const threshold = Number($("#color-threshold")?.value ?? 15) + 4;
  const centerX = Math.round(point.x);
  const centerY = Math.round(point.y);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(canvas.height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(canvas.width - 1, centerX + radius); x += 1) {
      if (Math.hypot(x - point.x, y - point.y) > radius + 0.5) continue;
      const index = (y * canvas.width + x) * 4;
      if (state.imageData.data[index + 3] < 32) continue;
      const distance = compositedColorDistance(
        state.imageData.data[index],
        state.imageData.data[index + 1],
        state.imageData.data[index + 2],
        state.seedColor,
      );
      if (distance <= threshold) return true;
    }
  }
  return false;
}

function sameColorAvoidancePaths() {
  if (!state.seedColor) return [];
  const matchingDistance = Math.max(16, Number($("#color-threshold")?.value ?? 15) * 1.5);
  return state.series
    .filter((series) => (
      series.id !== state.editingSeriesId
      && colorDistance(series.seedColor, state.seedColor) <= matchingDistance
    ))
    .map((series) => series.rawPath?.length ? series.rawPath : series.path)
    .filter((path) => path?.length);
}

function createGuideAnchor(point) {
  guideIdSequence += 1;
  return {
    ...point,
    anchorId: point?.anchorId ?? `guide-${Date.now().toString(36)}-${guideIdSequence.toString(36)}`,
    userGuided: true,
  };
}

const pickButtonByMode = {
  x1: $("#pick-x-1"),
  x2: $("#pick-x-2"),
  x3: $("#pick-x-3"),
  x4: $("#pick-x-4"),
  x5: $("#pick-x-5"),
  y1: $("#pick-y-1"),
  y2: $("#pick-y-2"),
  y3: $("#pick-y-3"),
  y4: $("#pick-y-4"),
  y5: $("#pick-y-5"),
};
const calibrationPointKeys = Object.keys(pickButtonByMode);

function calibrationPointLabel(key) {
  const suffix = { 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅" }[key?.at(-1)] ?? "";
  return `${key?.startsWith("x") ? "x" : "y"}${suffix}`;
}

function calibrationCoordinate(key) {
  return key?.startsWith("x") ? "x" : "y";
}

function calibrationPointVisible(key) {
  const axis = calibrationCoordinate(key);
  return Number(key?.at(-1)) <= activeCalibrationReferenceCount(axis);
}

function activeCalibrationReferenceCount(axis) {
  const scaleMinimum = $(`#${axis}-scale`)?.value === "piecewise" ? 3 : minimumCalibrationReferences;
  return clamp(
    Math.max(scaleMinimum, Number(state.calibrationReferenceCounts?.[axis]) || minimumCalibrationReferences),
    scaleMinimum,
    maximumCalibrationReferences,
  );
}

function setCalibrationReferenceCount(axis, count, { clearRemoved = true } = {}) {
  const minimum = $(`#${axis}-scale`)?.value === "piecewise" ? 3 : minimumCalibrationReferences;
  const next = clamp(Math.round(Number(count) || minimum), minimum, maximumCalibrationReferences);
  const previous = activeCalibrationReferenceCount(axis);
  state.calibrationReferenceCounts[axis] = next;
  if (clearRemoved && next < previous) {
    for (let index = next + 1; index <= maximumCalibrationReferences; index += 1) {
      state.calibrationPoints[`${axis}${index}`] = null;
      const input = $(`#${axis}-value-${index}`);
      if (input) input.value = "";
    }
  }
  if (state.selectedCalibrationKey && !calibrationPointVisible(state.selectedCalibrationKey)) {
    state.selectedCalibrationKey = null;
  }
  return next;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  refreshTranslations(toast);
  toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

const panelSummarySources = {
  image: "#source-meta",
  plot: "#plot-status",
  calibration: "#calibration-status",
  trace: "#seed-status",
  export: "#export-status",
};

function setPanelSectionExpanded(section, expanded) {
  section.classList.toggle("is-expanded", expanded);
  section.classList.toggle("is-collapsed", !expanded);
  const heading = section.querySelector(":scope > .section-heading");
  heading?.setAttribute("aria-expanded", String(expanded));
  heading?.querySelector(".section-compact-status")?.setAttribute("aria-hidden", String(expanded));
}

function togglePanelSection(section) {
  const expand = !section.classList.contains("is-expanded");
  for (const candidate of document.querySelectorAll(".panel-collapsible")) {
    setPanelSectionExpanded(candidate, expand && candidate === section);
  }
}

function updatePanelSectionSummaries() {
  for (const section of document.querySelectorAll(".panel-collapsible")) {
    const summary = section.querySelector(".section-compact-status");
    const source = $(panelSummarySources[section.dataset.panelStep]);
    if (!summary || !source) continue;
    const savedCurveSummary = section.dataset.panelStep === "trace" && !state.path.length && state.series.length
      ? `已保存 ${state.series.length} 条曲线`
      : null;
    summary.textContent = savedCurveSummary ?? source.textContent.trim();
  }
}

function initializePanelAccordion() {
  const sections = [...document.querySelectorAll(".panel-collapsible")];
  sections.forEach((section, index) => {
    const heading = section.querySelector(":scope > .section-heading");
    const headingCopy = heading?.querySelector(":scope > div");
    if (!heading || !headingCopy) return;
    heading.setAttribute("role", "button");
    heading.tabIndex = 0;
    const summary = document.createElement("span");
    summary.className = "section-compact-status";
    headingCopy.append(summary);
    setPanelSectionExpanded(section, index === 0);
    heading.addEventListener("click", () => togglePanelSection(section));
    heading.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      togglePanelSection(section);
    });
  });
  updatePanelSectionSummaries();
}

for (const button of document.querySelectorAll("[data-language]")) {
  button.addEventListener("click", () => setLanguage(button.dataset.language));
}

window.addEventListener("languagechange", () => {
  updateUi();
  syncHistoryControls();
  syncModeControls();
  refreshTranslations(document);
  draw();
});

function sourceImageFingerprint(source) {
  const raster = renderRotatedImage(source, { degrees: 0, background: "#ffffff" });
  const rasterContext = raster.getContext("2d", { willReadFrequently: true });
  return fingerprintImageData(rasterContext.getImageData(0, 0, raster.width, raster.height));
}

function canvasFromRgba(rgba, width, height) {
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outputContext = output.getContext("2d", { willReadFrequently: true });
  const imageData = outputContext.createImageData(width, height);
  imageData.data.set(rgba);
  outputContext.putImageData(imageData, 0, 0);
  return output;
}

function applyPerspectiveRecord(image, perspective) {
  if (!perspective?.sourceCorners?.length || !perspective?.destinationCorners?.length) return image;
  const imageContext = image.getContext("2d", { willReadFrequently: true });
  const imageData = imageContext.getImageData(0, 0, image.width, image.height);
  const warped = warpPerspectiveRgba({
    rgba: imageData.data,
    width: image.width,
    height: image.height,
    sourceCorners: perspective.sourceCorners,
    destinationCorners: perspective.destinationCorners,
  });
  return canvasFromRgba(warped.rgba, warped.width, warped.height);
}

function renderCommittedImage(degrees = state.rotationCommitted.degrees, perspective = state.perspectiveCommitted) {
  if (!state.originalImage) return null;
  const rotated = renderRotatedImage(state.originalImage, { degrees, background: "#ffffff" });
  return applyPerspectiveRecord(rotated, perspective);
}

function captureEditableSnapshot() {
  if (!state.image || !state.source.imageFingerprint) return null;
  const controls = {};
  for (const selector of editableControlSelectors) {
    const element = $(selector);
    if (!element) continue;
    controls[selector] = element.type === "checkbox" ? Boolean(element.checked) : element.value;
  }
  const targetStyle = $("#target-style");
  return {
    version: 2,
    sourceFingerprint: state.source.imageFingerprint,
    rotationDegrees: state.rotationCommitted.degrees,
    perspectiveCommitted: cloneSerializable(state.perspectiveCommitted),
    targetStyleDataset: {
      autoDetected: targetStyle.dataset.autoDetected ?? null,
      autoConfidence: targetStyle.dataset.autoConfidence ?? null,
      autoFallback: targetStyle.dataset.autoFallback ?? null,
    },
    geometry: cloneSerializable({
      plotRect: state.plotRect,
      exclusions: state.exclusions,
      exclusionSuggestions: state.exclusionSuggestions,
      exclusionSuggestionIndex: state.exclusionSuggestionIndex,
      traceCorridorOperations: state.traceCorridorOperations,
      calibrationPoints: state.calibrationPoints,
      calibrationReferenceCounts: state.calibrationReferenceCounts,
      seed: state.seed,
      seedColor: state.seedColor,
      automaticMarkerSeries: state.automaticMarkerSeries,
      automaticMarkerConfidence: state.automaticMarkerConfidence,
      anchors: state.anchors,
      rawPath: state.rawPath,
      path: state.path,
      traceOrientation: state.traceOrientation,
      traceStale: state.traceStale,
      traceError: state.traceError,
      series: state.series,
      editingSeriesId: state.editingSeriesId,
      calibrationBeforeSeriesEdit: state.calibrationBeforeSeriesEdit,
      plotSuggestions: state.plotSuggestions,
      plotSuggestionIndex: state.plotSuggestionIndex,
    }),
    controls,
  };
}

function syncHistoryControls(history = editSession?.historyStatus() ?? {}) {
  const undo = $("#undo-action");
  const redo = $("#redo-action");
  if (!undo || !redo) return;
  undo.disabled = !history.canUndo || state.rotationPreviewActive;
  redo.disabled = !history.canRedo || state.rotationPreviewActive;
  undo.title = history.canUndo
    ? `撤销：${history.undoLabel}（Ctrl+Z）`
    : "没有可撤销的操作";
  redo.title = history.canRedo
    ? `重做：${history.redoLabel}（Ctrl+Shift+Z）`
    : "没有可重做的操作";
}

function draftStorageKey() {
  return state.source.imageFingerprint ? `${draftStoragePrefix}${state.source.imageFingerprint}` : null;
}

function scheduleDraftSave() {
  return editSession?.scheduleSave() ?? false;
}

function resetHistorySession() {
  editSession?.reset();
}

function syncDraftRecovery() {
  const button = $("#restore-draft");
  button.hidden = !draftRecoveryAvailable;
  button.disabled = !draftRecoveryAvailable || Boolean(state.computeBusy) || state.rotationPreviewActive;
}

function commitHistory(label, options = {}) {
  return editSession?.commit(label, options) ?? false;
}

function restoreEditableSnapshot(snapshot) {
  plotDetectionSequence += 1;
  interferenceScanSequence += 1;
  colorDiscoverySequence += 1;
  targetSelectionSequence += 1;
  traceTaskSequence += 1;
  state.computeBusy = null;
  delete $("#suggest-exclusions").dataset.scanning;
  if (
    !snapshot
    || !snapshot.geometry
    || typeof snapshot.geometry !== "object"
    || snapshot.sourceFingerprint !== state.source.imageFingerprint
    || (snapshot.controls !== null && snapshot.controls !== undefined && !isPlainRecord(snapshot.controls))
  ) return false;
  if (!validateEditableGeometry(snapshot.geometry)) return false;
  if (
    snapshot.version >= 2
    && (!isPlainRecord(snapshot.targetStyleDataset)
      || !["autoDetected", "autoConfidence", "autoFallback"].every((key) => (
        snapshot.targetStyleDataset[key] === null
        || snapshot.targetStyleDataset[key] === undefined
        || typeof snapshot.targetStyleDataset[key] === "string"
      )))
  ) return false;
  const degrees = normalizeRotationDegrees(snapshot.rotationDegrees ?? 0);
  const perspectiveChanged = JSON.stringify(snapshot.perspectiveCommitted ?? null) !== JSON.stringify(state.perspectiveCommitted ?? null);
  if ((Math.abs(degrees - state.rotationCommitted.degrees) > 1e-8 || perspectiveChanged) && state.originalImage) {
    state.perspectiveCommitted = cloneSerializable(snapshot.perspectiveCommitted ?? null);
    state.image = renderCommittedImage(degrees, state.perspectiveCommitted);
    state.rotationCommitted = { degrees };
    state.source.rotationDegrees = degrees;
    state.source.perspectiveCorrected = Boolean(state.perspectiveCommitted);
    updateWorkingCanvas(state.image);
    state.source.workingWidth = state.image.width;
    state.source.workingHeight = state.image.height;
  }
  const geometry = cloneSerializable(snapshot.geometry);
  for (const key of [
    "plotRect", "exclusions", "exclusionSuggestions", "exclusionSuggestionIndex",
    "traceCorridorOperations", "calibrationPoints", "calibrationReferenceCounts",
    "seed", "seedColor", "automaticMarkerSeries", "automaticMarkerConfidence",
    "anchors", "rawPath", "path", "series", "editingSeriesId",
    "calibrationBeforeSeriesEdit", "plotSuggestions", "plotSuggestionIndex",
  ]) {
    if (Object.hasOwn(geometry, key)) state[key] = geometry[key];
  }
  state.traceOrientation = ["horizontal", "vertical", "parametric"].includes(geometry.traceOrientation)
    ? geometry.traceOrientation
    : resolvedTraceOrientation(null, geometry.rawPath?.length ? geometry.rawPath : geometry.path);
  state.traceStale = Boolean(geometry.traceStale);
  state.traceError = typeof geometry.traceError === "string" ? geometry.traceError : null;
  Object.assign(state, {
    mode: null,
    draftRect: null,
    draftExclusion: null,
    draftTraceCorridor: null,
    dragStart: null,
    cursor: null,
    hoveredPointId: null,
    pointHoverSource: null,
    selectedPointId: null,
    draggedPointId: null,
    selectedCalibrationKey: null,
    draggedCalibrationKey: null,
    calibrationDragMoved: false,
    reviewRegionIndex: 0,
    ambiguityResolutionTarget: null,
    hoveredAnchorIndex: null,
    selectedAnchorIndex: geometry.anchors?.length ? 0 : null,
    draggedAnchorIndex: null,
  });
  state.traceCorridorOperations ??= [];
  state.automaticMarkerSeries = Boolean(state.automaticMarkerSeries);
  state.automaticMarkerConfidence = Number(state.automaticMarkerConfidence) || 0;
  state.exclusionSuggestions ??= [];
  state.exclusionSuggestionIndex = clamp(
    Number(state.exclusionSuggestionIndex) || 0,
    0,
    Math.max(0, state.exclusionSuggestions.length - 1),
  );
  state.calibrationPoints = { ...emptyCalibrationPoints(), ...(state.calibrationPoints ?? {}) };
  state.calibrationReferenceCounts = {
    x: Math.max(2, Number(state.calibrationReferenceCounts?.x) || 2),
    y: Math.max(2, Number(state.calibrationReferenceCounts?.y) || 2),
  };
  invalidateTraceCorridor();
  $("#trace-corridor-mode").value = snapshot.controls?.["#trace-corridor-mode"]
    ?? (state.traceOrientation === "parametric" ? "strict" : "local");
  for (const [selector, value] of Object.entries(snapshot.controls ?? {})) {
    const element = $(selector);
    if (!element) continue;
    if (element.type === "checkbox") element.checked = Boolean(value);
    else element.value = value;
  }
  const targetStyle = $("#target-style");
  delete targetStyle.dataset.autoDetected;
  delete targetStyle.dataset.autoConfidence;
  delete targetStyle.dataset.autoFallback;
  if (snapshot.version >= 2) {
    for (const key of ["autoDetected", "autoConfidence", "autoFallback"]) {
      const value = snapshot.targetStyleDataset[key];
      if (typeof value === "string") targetStyle.dataset[key] = value;
    }
  } else if (state.automaticMarkerSeries && targetStyle.value === "markers") {
    targetStyle.dataset.autoDetected = "markers";
    targetStyle.dataset.autoConfidence = String(state.automaticMarkerConfidence);
  }
  if (!Object.hasOwn(geometry, "traceStale")) {
    // Old autosaved drafts bypass project-file import. Validate them once as
    // well, instead of displaying/exporting their old out-of-Pen results as current.
    const restored = prepareRestoredTrace(state, {
      orientation: state.traceOrientation, inclusionMask: traceCorridorMask(),
      width: canvas.width, height: canvas.height, rect: state.plotRect,
    });
    for (const key of ["path", "rawPath", "traceStale", "traceError"]) state[key] = restored[key];
    state.series = state.series.map((series) => {
      const orientation = resolvedTraceOrientation(series.parameters, series.path);
      const corridorMode = series.parameters?.corridorMode ?? (orientation === "parametric" ? "strict" : "local");
      return prepareRestoredTrace({ ...series, parameters: { ...series.parameters, corridorMode } }, {
        orientation, inclusionMask: buildTraceCorridorMask(series.traceCorridorOperations, corridorMode),
        width: canvas.width, height: canvas.height, rect: state.plotRect,
      });
    });
  }
  syncRangeOutputs();
  updateUi();
  draw();
  return true;
}

function restorePreviousDraft() {
  if (!draftRecoveryAvailable) return false;
  const restored = editSession?.restoreDraft() ?? false;
  showToast(restored
    ? "已恢复这张图片的上次草稿"
    : "无法恢复这张图片的草稿；草稿未删除，可尝试载入已保存的项目文件");
  return restored;
}

function navigateHistory(direction) {
  const result = editSession?.navigate(direction);
  if (result) showToast(`${direction === "undo" ? "已撤销" : "已重做"}：${result.label}`);
}

editSession = createEditSession({
  capture: captureEditableSnapshot,
  restore: restoreEditableSnapshot,
  storageKey: draftStorageKey,
  maximumEntries: 60,
  onHistoryChange: syncHistoryControls,
  onSaveStatus(status) {
    // Recovery is offered before the first new edit. From then on autosave
    // belongs to the new session, not the previous one.
    if (["saving", "saved", "restored", "cleared"].includes(status)) {
      draftRecoveryAvailable = false;
      syncDraftRecovery();
    }
    const element = $("#autosave-status");
    if (!element) return;
    element.textContent = {
      saving: "正在保存…",
      saved: "草稿已保存",
      error: "存储空间不足",
      restored: "已恢复草稿",
      cleared: "草稿已清除",
    }[status] ?? element.textContent;
  },
});

// Persist actual pending edits before a refresh, never an untouched new view.
window.addEventListener("pagehide", () => editSession?.flushPendingSave());

function syncModeControls() {
  for (const [key, button] of Object.entries(pickButtonByMode)) {
    button.classList.toggle("active", state.mode === key);
  }
  $("#select-plot").classList.toggle("button-primary", state.mode !== "plot");
  $("#select-plot").classList.toggle("button-accent", state.mode === "plot");
  $("#pick-seed").classList.toggle("button-primary", state.mode !== "seed");
  $("#pick-seed").classList.toggle("button-accent", state.mode === "seed");
  $("#add-guide").classList.toggle("button-secondary", state.mode !== "guide");
  $("#add-guide").classList.toggle("button-accent", state.mode === "guide");
  $("#add-exclusion").classList.toggle("button-ghost", state.mode !== "exclude");
  $("#add-exclusion").classList.toggle("button-accent", state.mode === "exclude");
  $("#exclude-trace").classList.toggle("button-ghost", state.mode !== "exclude");
  $("#exclude-trace").classList.toggle("button-accent", state.mode === "exclude");
  $("#draw-trace-corridor").classList.toggle("active", state.mode === "corridor-pen");
  $("#erase-trace-corridor").classList.toggle("active", state.mode === "corridor-erase");
  for (const axis of ["horizontal", "vertical"]) {
    const button = $(`#rotation-align-${axis}`);
    const active = state.mode === `align-${axis}`;
    button?.classList.toggle("button-ghost", !active);
    button?.classList.toggle("button-accent", active);
    button?.setAttribute("aria-pressed", String(active));
  }
  canvas.classList.toggle("mode-active", Boolean(state.mode));
  canvas.classList.toggle("corridor-mode", state.mode === "corridor-pen" || state.mode === "corridor-erase");

  const magnifierHint = $("#magnifier-hint");
  if (magnifierHint) {
    const aligning = state.mode === "align-horizontal" || state.mode === "align-vertical";
    const calibrating = calibrationPointKeys.includes(state.mode);
    magnifierHint.textContent = aligning
      ? (state.rotationAlignmentPoints.length
        ? "十字中心为当前鼠标像素 · R1 已选，请点击较远的 R2"
        : "十字与中心点即将选取的像素 · 请点击 R1")
      : calibrating
        ? `十字中心即 ${calibrationPointLabel(state.mode)} · 点击后可拖动或按方向键微调`
        : state.selectedCalibrationKey
          ? `${calibrationPointLabel(state.selectedCalibrationKey)} 已选 · 方向键 1 px，Shift+方向键 0.1 px`
      : "引导菱形与数据圆圈同步显示 · 可回到图中拖动";
  }
}

function setMode(mode) {
  if (state.rotationPreviewActive && mode && !mode.startsWith("align-")) return;
  state.mode = state.mode === mode ? null : mode;
  if (state.mode !== "guide") state.ambiguityResolutionTarget = null;
  if (state.mode && !calibrationPointKeys.includes(state.mode)) {
    state.selectedCalibrationKey = null;
  }
  syncModeControls();

  const hints = {
    plot: "在图上从一个角拖到对角，框选单个 panel 的绘图区",
    x1: "点击 X 轴的第一个已知刻度位置",
    x2: "点击 X 轴的第二个已知刻度位置",
    x3: "点击 X 轴分段映射的第三个已知刻度位置",
    y1: "点击 Y 轴的第一个已知刻度位置",
    y2: "点击 Y 轴的第二个已知刻度位置",
    y3: "点击 Y 轴分段映射的第三个已知刻度位置",
    seed: "点击目标曲线的清晰位置以采样颜色；这会开始一条新的追踪路径",
    guide: "点击目标曲线应经过的位置；遮挡处也可按趋势放置，右键菱形可删除",
    exclude: "拖拽框住遮挡、图例、文字或其他不应参与追踪的区域；程序会在远端自动重连，并用两侧趋势恢复框内路径",
    "corridor-pen": "按住左键沿目标曲线涂画；折返或横竖混合曲线需要涂完整路径，引导点添加顺序不限",
    "corridor-erase": "按住左键擦除 Pen 走廊；范围遵循上方 Pen 设置，与追踪方向无关",
    "align-horizontal": "校水平：把十字中心对准同一条水平参考线，依次点击相距较远的 R1、R2",
    "align-vertical": "校垂直：把十字中心对准同一条垂直参考线，依次点击相距较远的 R1、R2",
  };
  $("#mode-hint").textContent = hints[state.mode]
    ?? (state.seedColor
      ? "左键空白处新增 · 拖动圆圈/菱形 · 右键删除附近最近的普通点"
      : "可继续标定或调整追踪参数");
  draw();
}

function resetExtraction({ keepCalibrationValues = true } = {}) {
  plotDetectionSequence += 1;
  state.traceStale = false;
  state.traceError = null;
  $("#trace-corridor-mode").value = "strict";
  interferenceScanSequence += 1;
  colorDiscoverySequence += 1;
  targetSelectionSequence += 1;
  traceTaskSequence += 1;
  state.computeBusy = null;
  delete $("#suggest-exclusions").dataset.scanning;
  state.plotRect = null;
  state.draftRect = null;
  state.exclusions = [];
  state.exclusionSuggestions = [];
  state.exclusionSuggestionIndex = 0;
  state.colorSuggestions = [];
  state.draftExclusion = null;
  state.traceCorridorOperations = [];
  state.draftTraceCorridor = null;
  invalidateTraceCorridor();
  state.calibrationPoints = emptyCalibrationPoints();
  state.seed = null;
  state.seedColor = null;
  state.automaticMarkerSeries = false;
  state.automaticMarkerConfidence = 0;
  state.anchors = [];
  $("#strict-guide").checked = false;
  $("#target-style").value = "auto";
  $("#trace-orientation").value = "auto";
  delete $("#target-style").dataset.autoDetected;
  delete $("#target-style").dataset.autoConfidence;
  delete $("#target-style").dataset.autoFallback;
  $("#trace-assist-tools").open = false;
  $("#path-refinement").value = "full";
  state.rawPath = [];
  state.path = [];
  state.traceOrientation = "horizontal";
  state.series = [];
  state.editingSeriesId = null;
  state.mode = null;
  state.dragStart = null;
  state.cursor = null;
  state.magnifierPoint = null;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.selectedPointId = null;
  state.draggedPointId = null;
  state.pointDragMoved = false;
  state.hoveredAnchorIndex = null;
  state.selectedAnchorIndex = null;
  state.draggedAnchorIndex = null;
  state.anchorDragMoved = false;
  state.plotSuggestions = [];
  state.plotSuggestionIndex = -1;
  state.selectedCalibrationKey = null;
  state.draggedCalibrationKey = null;
  state.calibrationDragMoved = false;
  state.calibrationBeforeSeriesEdit = null;
  state.reviewRegionIndex = 0;
  state.ambiguityResolutionTarget = null;
  if (!keepCalibrationValues) {
    for (const selector of editableControlSelectors) {
      const element = $(selector);
      if (element.type === "checkbox") element.checked = element.defaultChecked;
      else if (element.tagName === "SELECT") {
        element.value = [...element.options].find((option) => option.defaultSelected)?.value ?? element.options[0].value;
      } else element.value = element.defaultValue;
    }
    state.calibrationReferenceCounts = { x: 2, y: 2 };
    syncRangeOutputs();
  }
  updateUi();
}

function imageCoordinates(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - bounds.left) * (canvas.width / bounds.width), 0, canvas.width - 1),
    y: clamp((event.clientY - bounds.top) * (canvas.height / bounds.height), 0, canvas.height - 1),
  };
}

function traceCorridorWidth() {
  const value = Number($("#trace-corridor-width")?.value ?? 24);
  return Number.isFinite(value) ? clamp(value, 4, 80) : 24;
}

function invalidateTraceCorridor() {
  traceCorridorRevision += 1;
  traceCorridorCache = null;
}

function normalizeTraceCorridorOperations(operations) {
  if (!Array.isArray(operations)) return [];
  return operations.flatMap((operation) => {
    const points = Array.isArray(operation?.points)
      ? operation.points
        .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
        .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
      : [];
    if (!points.length) return [];
    return [{
      mode: operation.mode === "erase" ? "erase" : "paint",
      width: clamp(Number(operation.width) || 24, 4, 80),
      points,
    }];
  });
}

function renderTraceCorridorOperations(drawingContext, operations) {
  drawingContext.clearRect(0, 0, drawingContext.canvas.width, drawingContext.canvas.height);
  for (const operation of operations) {
    const points = operation.points ?? [];
    if (!points.length) continue;
    drawingContext.save();
    drawingContext.globalCompositeOperation = operation.mode === "erase" ? "destination-out" : "source-over";
    drawingContext.strokeStyle = "#ffffff";
    drawingContext.fillStyle = "#ffffff";
    drawingContext.lineWidth = operation.width;
    drawingContext.lineCap = "round";
    drawingContext.lineJoin = "round";
    if (points.length === 1) {
      drawingContext.beginPath();
      drawingContext.arc(points[0].x, points[0].y, operation.width / 2, 0, Math.PI * 2);
      drawingContext.fill();
    } else {
      drawingContext.beginPath();
      drawingContext.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) drawingContext.lineTo(point.x, point.y);
      drawingContext.stroke();
    }
    drawingContext.restore();
  }
}

function traceCorridorMask() {
  if (!canvas.width || !canvas.height || !state.traceCorridorOperations.length) return null;
  if (
    traceCorridorCache
    && traceCorridorCache.revision === traceCorridorRevision
    && traceCorridorCache.width === canvas.width
    && traceCorridorCache.height === canvas.height
    && traceCorridorCache.mode === $("#trace-corridor-mode").value
  ) return traceCorridorCache.activePixels ? traceCorridorCache : null;

  traceCorridorCache = buildTraceCorridorMask(state.traceCorridorOperations, $("#trace-corridor-mode").value);
  if (traceCorridorCache) traceCorridorCache.revision = traceCorridorRevision;
  return traceCorridorCache;
}

function buildTraceCorridorMask(operations, mode = "local") {
  if (!operations?.length) return null;
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = canvas.width;
  maskCanvas.height = canvas.height;
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  renderTraceCorridorOperations(maskContext, operations);
  const rgba = maskContext.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < data.length; index += 1) {
    if (rgba[index * 4 + 3] < 32) continue;
    data[index] = 1;
  }
  const mask = prepareInclusionMask(data, canvas.width, canvas.height, mode);
  if (!mask) return null;

  const displayCanvas = document.createElement("canvas");
  displayCanvas.width = canvas.width;
  displayCanvas.height = canvas.height;
  const displayContext = displayCanvas.getContext("2d");
  displayContext.drawImage(maskCanvas, 0, 0);
  displayContext.globalCompositeOperation = "source-in";
  displayContext.fillStyle = "rgba(0, 169, 165, 0.24)";
  displayContext.fillRect(0, 0, canvas.width, canvas.height);
  displayContext.globalCompositeOperation = "source-over";

  return {
    ...mask,
    width: canvas.width,
    height: canvas.height,
    displayCanvas,
  };
}

function traceCorridorColumnCount(mask = traceCorridorMask()) {
  if (!mask) return 0;
  let count = 0;
  for (const covered of mask.columns) count += covered ? 1 : 0;
  return count;
}

function boundedPlotPoint(point) {
  if (!state.plotRect) return point;
  return {
    x: clamp(point.x, state.plotRect.left, state.plotRect.right),
    y: clamp(point.y, state.plotRect.top, state.plotRect.bottom),
  };
}

function appendTraceCorridorPoint(point) {
  const stroke = state.draftTraceCorridor;
  if (!stroke) return false;
  const bounded = boundedPlotPoint(point);
  const previous = stroke.points.at(-1);
  if (previous && Math.hypot(previous.x - bounded.x, previous.y - bounded.y) < 0.45) return false;
  stroke.points.push(bounded);
  return true;
}

function drawDraftTraceCorridor() {
  const operation = state.draftTraceCorridor;
  if (!operation?.points?.length) return;
  context.save();
  context.strokeStyle = operation.mode === "erase" ? "rgba(209, 73, 91, 0.48)" : "rgba(0, 169, 165, 0.34)";
  context.fillStyle = context.strokeStyle;
  context.lineWidth = operation.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (operation.points.length === 1) {
    context.beginPath();
    context.arc(operation.points[0].x, operation.points[0].y, operation.width / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.beginPath();
    context.moveTo(operation.points[0].x, operation.points[0].y);
    for (const point of operation.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.restore();
}

function drawTraceCorridor(drawingContext = context, focus = null) {
  const mask = traceCorridorMask();
  if (!mask) return;
  drawingContext.save();
  if (focus) {
    const sourceSize = 24;
    drawingContext.imageSmoothingEnabled = false;
    drawingContext.drawImage(
      mask.displayCanvas,
      focus.x - sourceSize / 2,
      focus.y - sourceSize / 2,
      sourceSize,
      sourceSize,
      0,
      0,
      drawingContext.canvas.width,
      drawingContext.canvas.height,
    );
  } else {
    drawingContext.drawImage(mask.displayCanvas, 0, 0);
    drawingContext.strokeStyle = "rgba(0, 130, 130, 0.55)";
    drawingContext.lineWidth = 1 / state.zoom;
    drawingContext.setLineDash([4 / state.zoom, 4 / state.zoom]);
    // Show actual entry/exit planes rather than bounding boxes: unpainted
    // pixels beside a local stroke are no longer unrestricted outside a box.
    const bounds = state.plotRect ?? { left: 0, top: 0, width: canvas.width, height: canvas.height };
    drawingContext.beginPath();
    drawingContext.rect(bounds.left, bounds.top, bounds.width, bounds.height);
    drawingContext.clip();
    const extent = Math.hypot(canvas.width, canvas.height) * 2;
    for (const { nx, ny, offset } of mask.gates ?? []) {
      const x = nx * offset, y = ny * offset;
      drawingContext.beginPath();
      drawingContext.moveTo(x - ny * extent, y + nx * extent);
      drawingContext.lineTo(x + ny * extent, y - nx * extent);
      drawingContext.stroke();
    }
  }
  drawingContext.restore();
}

function drawCross(point, color, label = "", {
  drawingContext = context,
  transform = null,
  selected = false,
} = {}) {
  if (!point) return;
  const position = transform ? transform(point) : point;
  const unit = transform ? 1 : 1 / state.zoom;
  const radius = transform ? (selected ? 12 : 9) : Math.max(6, (selected ? 11 : 8) * unit);
  drawingContext.save();
  drawingContext.strokeStyle = selected ? "#d7264f" : color;
  drawingContext.fillStyle = selected ? "#d7264f" : color;
  drawingContext.lineWidth = transform ? (selected ? 3 : 2) : Math.max(1.5, (selected ? 3 : 2) * unit);
  if (selected) {
    drawingContext.beginPath();
    drawingContext.arc(position.x, position.y, radius + (transform ? 4 : 3 * unit), 0, Math.PI * 2);
    drawingContext.strokeStyle = "rgba(255, 255, 255, 0.96)";
    drawingContext.lineWidth = transform ? 5 : Math.max(3, 5 * unit);
    drawingContext.stroke();
    drawingContext.strokeStyle = "#d7264f";
    drawingContext.lineWidth = transform ? 3 : Math.max(2, 3 * unit);
    drawingContext.stroke();
  }
  drawingContext.beginPath();
  drawingContext.moveTo(position.x - radius, position.y);
  drawingContext.lineTo(position.x + radius, position.y);
  drawingContext.moveTo(position.x, position.y - radius);
  drawingContext.lineTo(position.x, position.y + radius);
  drawingContext.stroke();
  if (label) {
    drawingContext.font = `700 ${transform ? 12 : Math.max(11, 12 * unit)}px ui-sans-serif`;
    drawingContext.fillText(label, position.x + radius + (transform ? 3 : 2 * unit), position.y - radius - unit);
  }
  drawingContext.restore();
}

function drawCalibrationPoints(drawingContext = context, transform = null) {
  for (const key of calibrationPointKeys) {
    if (!calibrationPointVisible(key)) continue;
    drawCross(
      state.calibrationPoints[key],
      key.startsWith("x") ? "#1769d1" : "#7b48c8",
      calibrationPointLabel(key),
      { drawingContext, transform, selected: key === state.selectedCalibrationKey },
    );
  }
}

function calibrationPointAt(position) {
  const radius = Math.max(8, 11 / state.zoom);
  const candidates = calibrationPointKeys
    .filter((key) => calibrationPointVisible(key) && state.calibrationPoints[key])
    .map((key) => ({
      key,
      distance: Math.hypot(
        state.calibrationPoints[key].x - position.x,
        state.calibrationPoints[key].y - position.y,
      ),
    }))
    .filter((candidate) => candidate.distance <= radius)
    .sort((left, right) => {
      if (left.key === state.selectedCalibrationKey) return -1;
      if (right.key === state.selectedCalibrationKey) return 1;
      return left.distance - right.distance;
    });
  return candidates[0]?.key ?? null;
}

function drawDataPointCircle(point, drawingContext = context, transform = null, {
  active = false,
  color = "#111111",
} = {}) {
  if (!point) return;
  const position = transform ? transform(point) : point;
  const radius = transform ? 4.5 : Math.max(3, 4 / state.zoom);
  const highlighted = active && (
    point.pointId === state.selectedPointId
    || point.pointId === state.hoveredPointId
  );
  const dragged = active && point.pointId === state.draggedPointId;
  const inferred = point.observed === false || point.occlusionInferred;
  drawingContext.save();
  if (highlighted || dragged) {
    drawingContext.fillStyle = "#ff3154";
    drawingContext.strokeStyle = "#ffffff";
    drawingContext.lineWidth = transform ? 2.4 : Math.max(2, 2.8 / state.zoom);
    drawingContext.beginPath();
    drawingContext.arc(position.x, position.y, radius + (transform ? 1.8 : 1.5 / state.zoom), 0, Math.PI * 2);
    drawingContext.fill();
    drawingContext.stroke();
    drawingContext.strokeStyle = "#64101f";
    drawingContext.lineWidth = transform ? 1.2 : Math.max(0.9, 1.2 / state.zoom);
    drawingContext.stroke();
    drawingContext.restore();
    return;
  }
  if (inferred && Number.isFinite(point.inferenceUncertainty)) {
    const upper = transform
      ? transform({ x: point.x, y: point.y - point.inferenceUncertainty })
      : { x: position.x, y: position.y - point.inferenceUncertainty };
    const lower = transform
      ? transform({ x: point.x, y: point.y + point.inferenceUncertainty })
      : { x: position.x, y: position.y + point.inferenceUncertainty };
    const cap = transform ? 3 : Math.max(2, 3 / state.zoom);
    drawingContext.strokeStyle = "rgb(154 93 10 / 68%)";
    drawingContext.lineWidth = transform ? 1.4 : Math.max(1, 1.3 / state.zoom);
    drawingContext.setLineDash([]);
    drawingContext.beginPath();
    drawingContext.moveTo(upper.x, upper.y);
    drawingContext.lineTo(lower.x, lower.y);
    drawingContext.moveTo(upper.x - cap, upper.y);
    drawingContext.lineTo(upper.x + cap, upper.y);
    drawingContext.moveTo(lower.x - cap, lower.y);
    drawingContext.lineTo(lower.x + cap, lower.y);
    drawingContext.stroke();
  }
  drawingContext.fillStyle = inferred ? "#ffd884" : "#ffffff";
  drawingContext.strokeStyle = color;
  drawingContext.lineWidth = transform ? 2 : Math.max(1.4, 2 / state.zoom);
  if (inferred || (point.confidence ?? 1) < 0.5) {
    drawingContext.setLineDash(transform ? [3, 2] : [Math.max(2, 3 / state.zoom), Math.max(1.5, 2 / state.zoom)]);
  }
  drawingContext.beginPath();
  drawingContext.arc(position.x, position.y, radius, 0, Math.PI * 2);
  drawingContext.fill();
  drawingContext.stroke();
  drawingContext.strokeStyle = "rgb(8 16 26 / 72%)";
  drawingContext.lineWidth = transform ? 0.65 : Math.max(0.55, 0.7 / state.zoom);
  drawingContext.stroke();
  drawingContext.restore();
}

function drawGuideAnchor(anchor, index, drawingContext = context, transform = null) {
  const position = transform ? transform(anchor) : anchor;
  const hovered = index === state.hoveredAnchorIndex;
  const selected = index === state.selectedAnchorIndex;
  const dragged = index === state.draggedAnchorIndex;
  const radius = transform
    ? (hovered || selected || dragged ? 8.5 : 7)
    : Math.max(4.5, (hovered || selected || dragged ? 8 : 6) / state.zoom);
  const outlineWidth = transform ? 2.2 : Math.max(1.5, 2.2 / state.zoom);

  drawingContext.save();
  drawingContext.translate(position.x, position.y);
  drawingContext.rotate(Math.PI / 4);
  drawingContext.fillStyle = hovered || dragged ? "#ff3154" : (index === 0 ? "#00a9a5" : "#f09a2a");
  drawingContext.strokeStyle = "#ffffff";
  drawingContext.lineWidth = outlineWidth;
  drawingContext.fillRect(-radius, -radius, radius * 2, radius * 2);
  drawingContext.strokeRect(-radius, -radius, radius * 2, radius * 2);
  drawingContext.strokeStyle = hovered || dragged ? "#64101f" : "#27384c";
  drawingContext.lineWidth = transform ? 0.9 : Math.max(0.7, 0.9 / state.zoom);
  drawingContext.strokeRect(-radius - 0.6, -radius - 0.6, radius * 2 + 1.2, radius * 2 + 1.2);
  drawingContext.restore();

  drawingContext.save();
  drawingContext.fillStyle = "#14283c";
  drawingContext.font = `700 ${transform ? 11 : Math.max(9, 10 / state.zoom)}px ui-sans-serif`;
  drawingContext.fillText(
    `A${index + 1}`,
    position.x + radius + (transform ? 4 : 3 / state.zoom),
    position.y - radius - (transform ? 3 : 2 / state.zoom),
  );
  drawingContext.restore();
}

function drawGuideAnchors(drawingContext = context, transform = null) {
  state.anchors.forEach((anchor, index) => drawGuideAnchor(anchor, index, drawingContext, transform));
}

function pathReviewRegions() {
  if (state.traceStale) return [];
  return findPathReviewRegions(state.path, state.plotRect);
}

function pathAmbiguityTarget() {
  if (state.traceStale) return null;
  const evidencePath = state.rawPath.length ? state.rawPath : state.path;
  return findMostInformativeAmbiguity(evidencePath, state.plotRect, state.anchors);
}

function currentPathReviewRegion(regions = pathReviewRegions()) {
  if (!regions.length) {
    state.reviewRegionIndex = 0;
    return null;
  }
  state.reviewRegionIndex = clamp(state.reviewRegionIndex, 0, regions.length - 1);
  return regions[state.reviewRegionIndex];
}

function drawCurrentReviewRegion(drawingContext = context, transform = null) {
  const regions = pathReviewRegions();
  const region = currentPathReviewRegion(regions);
  if (!region) return;
  const representative = state.path[region.representativeIndex];
  const unit = transform ? 1 : 1 / state.zoom;
  drawingContext.save();
  for (const pointIndex of region.pointIndices) {
    const point = state.path[pointIndex];
    if (!point) continue;
    const position = transform ? transform(point) : point;
    const representativePoint = pointIndex === region.representativeIndex;
    const radius = transform
      ? (representativePoint ? 12 : 9)
      : Math.max(6, (representativePoint ? 11 : 8) * unit);
    drawingContext.fillStyle = representativePoint
      ? "rgb(215 38 79 / 22%)"
      : "rgb(231 145 28 / 18%)";
    drawingContext.strokeStyle = representativePoint ? "#d7264f" : "#d98a1c";
    drawingContext.lineWidth = transform ? 2 : Math.max(1.2, 1.6 * unit);
    drawingContext.setLineDash(transform ? [4, 3] : [4 * unit, 3 * unit]);
    drawingContext.beginPath();
    drawingContext.arc(position.x, position.y, radius, 0, Math.PI * 2);
    drawingContext.fill();
    drawingContext.stroke();
  }
  if (!transform && representative) {
    const label = translateMessage(`待检查 ${state.reviewRegionIndex + 1}/${regions.length}`);
    const fontSize = Math.max(10, 11 * unit);
    const padding = 4 * unit;
    drawingContext.setLineDash([]);
    drawingContext.font = `700 ${fontSize}px ui-sans-serif`;
    const labelWidth = drawingContext.measureText(label).width + padding * 2;
    const labelX = clamp(
      representative.x + 13 * unit,
      padding,
      drawingContext.canvas.width - labelWidth - padding,
    );
    const labelY = clamp(
      representative.y - 13 * unit,
      fontSize + padding,
      drawingContext.canvas.height - padding,
    );
    drawingContext.fillStyle = "rgb(255 255 255 / 94%)";
    drawingContext.strokeStyle = "#d7264f";
    drawingContext.lineWidth = Math.max(1, unit);
    drawingContext.fillRect(labelX, labelY - fontSize, labelWidth, fontSize + padding);
    drawingContext.strokeRect(labelX, labelY - fontSize, labelWidth, fontSize + padding);
    drawingContext.fillStyle = "#8f1730";
    drawingContext.fillText(label, labelX + padding, labelY);
  }
  drawingContext.restore();
}

function drawAmbiguityResolutionTarget(drawingContext = context, transform = null) {
  if (state.traceStale) return;
  const target = state.ambiguityResolutionTarget;
  if (!target || state.mode !== "guide") return;
  const candidateYs = [...new Set(target.candidateYs ?? [target.y])].filter(Number.isFinite);
  if (!candidateYs.length) return;
  const unit = transform ? 1 : 1 / state.zoom;
  const positions = candidateYs.map((y) => (
    transform ? transform({ x: target.x, y }) : { x: target.x, y }
  ));
  drawingContext.save();
  drawingContext.strokeStyle = "#006f78";
  drawingContext.fillStyle = "rgb(255 255 255 / 78%)";
  drawingContext.lineWidth = transform ? 2 : Math.max(1.4, 1.8 * unit);
  drawingContext.setLineDash(transform ? [4, 3] : [4 * unit, 3 * unit]);
  if (positions.length > 1) {
    drawingContext.beginPath();
    drawingContext.moveTo(positions[0].x, Math.min(...positions.map((point) => point.y)));
    drawingContext.lineTo(positions[0].x, Math.max(...positions.map((point) => point.y)));
    drawingContext.stroke();
  }
  drawingContext.setLineDash([]);
  for (const position of positions) {
    drawingContext.beginPath();
    drawingContext.arc(position.x, position.y, transform ? 7 : Math.max(4.5, 6 * unit), 0, Math.PI * 2);
    drawingContext.fill();
    drawingContext.stroke();
  }
  if (!transform) {
    const label = translateMessage("请点击正确分支");
    const fontSize = Math.max(10, 11 * unit);
    const padding = 4 * unit;
    drawingContext.font = `700 ${fontSize}px ui-sans-serif`;
    const labelWidth = drawingContext.measureText(label).width + padding * 2;
    const maximumY = Math.max(...candidateYs);
    const labelX = clamp(target.x + 10 * unit, padding, drawingContext.canvas.width - labelWidth - padding);
    const labelY = clamp(maximumY + 18 * unit, fontSize + padding, drawingContext.canvas.height - padding);
    drawingContext.fillStyle = "rgb(236 253 252 / 96%)";
    drawingContext.strokeStyle = "#006f78";
    drawingContext.lineWidth = Math.max(1, unit);
    drawingContext.fillRect(labelX, labelY - fontSize, labelWidth, fontSize + padding);
    drawingContext.strokeRect(labelX, labelY - fontSize, labelWidth, fontSize + padding);
    drawingContext.fillStyle = "#00545b";
    drawingContext.fillText(label, labelX + padding, labelY);
  }
  drawingContext.restore();
}

function drawMagnifierReticle({ alignment = false } = {}) {
  const center = magnifierCanvas.width / 2;
  const drawLines = () => {
    magnifierContext.beginPath();
    magnifierContext.moveTo(center, 0);
    magnifierContext.lineTo(center, magnifierCanvas.height);
    magnifierContext.moveTo(0, center);
    magnifierContext.lineTo(magnifierCanvas.width, center);
    magnifierContext.stroke();
  };

  magnifierContext.save();
  magnifierContext.strokeStyle = "rgba(255, 255, 255, 0.96)";
  magnifierContext.lineWidth = 3;
  drawLines();
  magnifierContext.strokeStyle = alignment ? "#8f1730" : "#10487c";
  magnifierContext.lineWidth = alignment ? 2 : 1;
  drawLines();
  magnifierContext.fillStyle = alignment ? "#ff3154" : "rgba(255, 255, 255, 0.94)";
  magnifierContext.strokeStyle = alignment ? "#ffffff" : "#10487c";
  magnifierContext.lineWidth = 2;
  magnifierContext.beginPath();
  magnifierContext.arc(center, center, alignment ? 4.5 : 3.5, 0, Math.PI * 2);
  magnifierContext.fill();
  magnifierContext.stroke();
  if (alignment) {
    magnifierContext.strokeStyle = "#64101f";
    magnifierContext.lineWidth = 1;
    magnifierContext.stroke();
  }
  magnifierContext.restore();
}

function drawMagnifier(point = state.magnifierPoint, { includeAllSaved = false } = {}) {
  const size = magnifierCanvas.width;
  magnifierContext.save();
  magnifierContext.clearRect(0, 0, size, size);
  magnifierContext.fillStyle = "#eef2f6";
  magnifierContext.fillRect(0, 0, size, size);
  const displayImage = currentDisplayImage();
  if (!displayImage || !point) {

    magnifierContext.fillStyle = "#7c8998";
    magnifierContext.font = "11px ui-sans-serif";
    magnifierContext.textAlign = "center";
    magnifierContext.fillText(translateMessage("将鼠标移入图像"), size / 2, size / 2);
    $("#magnifier-coordinate").textContent = "pixel: —\ndata: —";
    magnifierContext.restore();
    return;
  }

  const sourceSize = 24;
  const sourceLeft = point.x - sourceSize / 2;
  const sourceTop = point.y - sourceSize / 2;
  const magnification = size / sourceSize;
  magnifierContext.imageSmoothingEnabled = false;
  magnifierContext.drawImage(
    displayImage,
    sourceLeft,
    sourceTop,
    sourceSize,
    sourceSize,
    0,
    0,
    size,
    size,
  );
  const magnifierTransform = (value) => ({
    x: (value.x - sourceLeft) * magnification,
    y: (value.y - sourceTop) * magnification,
  });
  if (!state.rotationPreviewActive) {
    drawTraceCorridor(magnifierContext, point);
    drawCurrentReviewRegion(magnifierContext, magnifierTransform);
    drawAmbiguityResolutionTarget(magnifierContext, magnifierTransform);
    for (const series of state.series) {
      if (series.id === state.editingSeriesId || !(includeAllSaved || series.visible)) continue;
      drawDataPoints(series.path, {
        drawingContext: magnifierContext,
        transform: magnifierTransform,
        color: seriesTargetColor(series, state.series.indexOf(series)),
      });
    }
    drawDataPoints(state.path, {
      drawingContext: magnifierContext,
      transform: magnifierTransform,
      active: true,
      color: colorToCss(state.seedColor),
    });
  }
  const aligning = state.rotationPreviewActive
    && (state.mode === "align-horizontal" || state.mode === "align-vertical");
  if (aligning) drawRotationAlignmentOverlay(magnifierContext, magnifierTransform, point);
  if (!state.rotationPreviewActive) {
    drawCalibrationPoints(magnifierContext, magnifierTransform);
    drawGuideAnchors(magnifierContext, magnifierTransform);
  }
  drawMagnifierReticle({ alignment: aligning });
  const pixelLine = `pixel: ${Math.round(point.x)}, ${Math.round(point.y)}`;
  const dataLine = state.rotationPreviewActive
    ? "data: 校直预览中"
    : calibrationsValid()
      ? `data: ${formatNumber(pixelToValue(point.x, xCalibration()), 6)}, ${formatNumber(pixelToValue(point.y, yCalibration()), 6)}`
      : "data: 未标定";
  $("#magnifier-coordinate").textContent = `${pixelLine}\n${dataLine}`;
  magnifierContext.restore();
}

function normalizeTracePointCount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return defaultTracePointCount;
  return clamp(Math.round(numeric), 2, maximumTracePointCount);
}

function activeTracePointCount() {
  return normalizeTracePointCount($("#trace-point-count")?.value);
}

function activeSamplingParameters() {
  return {
    samplingMode: $("#sampling-mode")?.value ?? "geometry",
    peakDensity: Number($("#peak-density")?.value ?? 4),
    peakWidth: Number($("#peak-width")?.value ?? 8),
    noiseDensity: Number($("#noise-density")?.value ?? 4),
    noiseWindow: Number($("#noise-window")?.value ?? 3),
  };
}

function resolvedTraceOrientation(parameters, path = []) {
  const explicit = parameters?.resolvedOrientation;
  if (["horizontal", "vertical", "parametric"].includes(explicit)) return explicit;
  if (path.some((point) => point.traceOrientation === "parametric" || point.closedPath)) {
    return "parametric";
  }
  return path.some((point) => point.traceOrientation === "vertical") ? "vertical" : "horizontal";
}

function drawDataPoints(path, {
  drawingContext = context,
  transform = null,
  active = false,
  color = "#111111",
} = {}) {
  if (!path?.length) return;
  if (active && state.traceStale) return;
  for (const point of path) drawDataPointCircle(point, drawingContext, transform, { active, color });
}

function drawPointLayers({ includeAllSaved = false } = {}) {
  state.series.forEach((series, index) => {
    if (series.id === state.editingSeriesId || !(includeAllSaved || series.visible)) return;
    drawDataPoints(series.path, { color: seriesTargetColor(series, index) });
  });
  drawDataPoints(state.path, { active: true, color: colorToCss(state.seedColor) });
}

function draw({ includeAllSaved = false, includeGuides = true, includeCorridor = true } = {}) {
  const displayImage = currentDisplayImage();
  if (!displayImage) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (state.rotationPreviewActive) {
    drawRotationAssist();
    drawMagnifier(state.cursor ?? state.magnifierPoint, { includeAllSaved });
    return;
  }

  const rect = state.draftRect ?? state.plotRect;
  if (rect) {
    context.save();
    context.strokeStyle = "#1671d9";
    context.fillStyle = "rgba(22, 113, 217, 0.045)";
    context.lineWidth = Math.max(1.5, 2 / state.zoom);
    context.setLineDash([8 / state.zoom, 5 / state.zoom]);
    context.fillRect(rect.left, rect.top, rect.width, rect.height);
    context.strokeRect(rect.left, rect.top, rect.width, rect.height);
    context.restore();
  }

  for (const exclusion of [...state.exclusions, ...(state.draftExclusion ? [state.draftExclusion] : [])]) {
    context.save();
    context.strokeStyle = "#d1495b";
    context.fillStyle = "rgba(209, 73, 91, 0.10)";
    context.lineWidth = Math.max(1.2, 1.6 / state.zoom);
    context.setLineDash([6 / state.zoom, 4 / state.zoom]);
    context.fillRect(exclusion.left, exclusion.top, exclusion.width, exclusion.height);
    context.strokeRect(exclusion.left, exclusion.top, exclusion.width, exclusion.height);
    context.restore();
  }

  const suggestedExclusion = state.exclusionSuggestions[state.exclusionSuggestionIndex];
  if (suggestedExclusion) {
    context.save();
    context.strokeStyle = "#e09124";
    context.fillStyle = "rgba(232, 151, 38, 0.13)";
    context.lineWidth = Math.max(1.4, 2 / state.zoom);
    context.setLineDash([7 / state.zoom, 4 / state.zoom]);
    context.fillRect(
      suggestedExclusion.left,
      suggestedExclusion.top,
      suggestedExclusion.width,
      suggestedExclusion.height,
    );
    context.strokeRect(
      suggestedExclusion.left,
      suggestedExclusion.top,
      suggestedExclusion.width,
      suggestedExclusion.height,
    );
    context.setLineDash([]);
    context.fillStyle = "#9a5b08";
    context.font = `${Math.max(9, 11 / state.zoom)}px system-ui, sans-serif`;
    context.fillText(
      `建议 ${state.exclusionSuggestionIndex + 1}`,
      suggestedExclusion.left + 4 / state.zoom,
      Math.max(12 / state.zoom, suggestedExclusion.top - 4 / state.zoom),
    );
    context.restore();
  }

  if (includeCorridor) {
    drawTraceCorridor();
    drawDraftTraceCorridor();
  }

  if (!includeAllSaved) drawCurrentReviewRegion();
  if (!includeAllSaved) drawAmbiguityResolutionTarget();
  drawPointLayers({ includeAllSaved });
  if (includeGuides) drawGuideAnchors();
  drawCalibrationPoints();
  if (state.cursor && state.mode && state.mode !== "plot") {
    context.save();
    context.strokeStyle = "rgba(23, 50, 77, 0.36)";
    context.lineWidth = 1 / state.zoom;
    context.beginPath();
    context.moveTo(0, state.cursor.y);
    context.lineTo(canvas.width, state.cursor.y);
    context.moveTo(state.cursor.x, 0);
    context.lineTo(state.cursor.x, canvas.height);
    context.stroke();
    context.restore();
  }
  if (state.cursor && (state.mode === "corridor-pen" || state.mode === "corridor-erase")) {
    const radius = traceCorridorWidth() / 2;
    context.save();
    context.fillStyle = state.mode === "corridor-erase"
      ? "rgba(255, 255, 255, 0.20)"
      : "rgba(0, 169, 165, 0.18)";
    context.strokeStyle = state.mode === "corridor-erase" ? "#d1495b" : "#087f8c";
    context.lineWidth = Math.max(1, 1.5 / state.zoom);
    context.setLineDash([4 / state.zoom, 3 / state.zoom]);
    context.beginPath();
    context.arc(state.cursor.x, state.cursor.y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }
  const calibrationFocus = state.draggedCalibrationKey
    ? state.calibrationPoints[state.draggedCalibrationKey]
    : null;
  drawMagnifier(calibrationFocus ?? state.cursor ?? state.magnifierPoint, { includeAllSaved });
}

let interactiveDrawFrame = null;

function scheduleInteractiveDraw() {
  if (interactiveDrawFrame !== null) return;
  interactiveDrawFrame = window.requestAnimationFrame(() => {
    interactiveDrawFrame = null;
    draw();
  });
}

function xCalibration() {
  const points = axisCalibrationPointKeys("x").map((key, index) => ({
    key,
    pixel: state.calibrationPoints[key]?.x,
    value: numericInputValue(`#x-value-${index + 1}`),
    uncertaintyPx: state.calibrationPoints[key]?.uncertaintyPx,
    snapped: Boolean(state.calibrationPoints[key]?.snapped),
    snapConfidence: state.calibrationPoints[key]?.snapConfidence,
  }));
  const calibration = {
    scale: $("#x-scale").value,
    point1: points[0]?.pixel,
    point2: points[1]?.pixel,
    value1: points[0]?.value,
    value2: points[1]?.value,
    points,
  };
  return calibration;
}

function numericInputValue(selector) {
  const value = $(selector).value.trim();
  return value === "" ? Number.NaN : Number(value);
}

function yCalibration() {
  const points = axisCalibrationPointKeys("y").map((key, index) => ({
    key,
    pixel: state.calibrationPoints[key]?.y,
    value: numericInputValue(`#y-value-${index + 1}`),
    uncertaintyPx: state.calibrationPoints[key]?.uncertaintyPx,
    snapped: Boolean(state.calibrationPoints[key]?.snapped),
    snapConfidence: state.calibrationPoints[key]?.snapConfidence,
  }));
  const calibration = {
    scale: $("#y-scale").value,
    point1: points[0]?.pixel,
    point2: points[1]?.pixel,
    value1: points[0]?.value,
    value2: points[1]?.value,
    points,
  };
  return calibration;
}

function currentCalibrationSnapshot() {
  return cloneSerializable({
    version: 2,
    x: xCalibration(),
    y: yCalibration(),
    points: state.calibrationPoints,
    referenceCounts: state.calibrationReferenceCounts,
    snapEnabled: Boolean($("#calibration-snap")?.checked),
    labels: {
      x: $("#x-label").value.trim(),
      y: $("#y-label").value.trim(),
    },
  });
}

function projectCalibrationSnapshot(project) {
  const xAxis = project?.axes?.x ?? {};
  const yAxis = project?.axes?.y ?? {};
  return cloneSerializable({
    version: 2,
    x: {
      scale: xAxis.scale ?? "linear",
      point1: xAxis.point1,
      point2: xAxis.point2,
      value1: xAxis.value1,
      value2: xAxis.value2,
      points: xAxis.points ?? [],
    },
    y: {
      scale: yAxis.scale ?? "linear",
      point1: yAxis.point1,
      point2: yAxis.point2,
      value1: yAxis.value1,
      value2: yAxis.value2,
      points: yAxis.points ?? [],
    },
    points: { ...emptyCalibrationPoints(), ...(project?.calibrationPoints ?? {}) },
    referenceCounts: project?.calibrationReferenceCounts,
    snapEnabled: project?.calibrationSnapEnabled,
    labels: {
      x: xAxis.label ?? "",
      y: yAxis.label ?? "",
    },
  });
}

function curveCalibrationSnapshot(series) {
  return series?.calibration ?? currentCalibrationSnapshot();
}

function applyCalibrationSnapshot(snapshot) {
  if (!snapshot?.x || !snapshot?.y) return false;
  state.calibrationPoints = cloneSerializable({ ...emptyCalibrationPoints(), ...(snapshot.points ?? {}) });
  for (const axis of ["x", "y"]) {
    const calibration = snapshot[axis] ?? {};
    $(`#${axis}-scale`).value = calibration.scale ?? "linear";
    const populatedPointCount = Math.max(
      2,
      ...(calibration.points ?? []).map((point, index) => (
        point && (
          (point.pixel !== null && point.pixel !== undefined && point.pixel !== "" && Number.isFinite(Number(point.pixel)))
          || (point.value !== null && point.value !== undefined && point.value !== "" && Number.isFinite(Number(point.value)))
        ) ? index + 1 : 0
      )),
    );
    state.calibrationReferenceCounts[axis] = clamp(
      Number(snapshot.referenceCounts?.[axis]) || populatedPointCount || (calibration.scale === "piecewise" ? 3 : 2),
      calibration.scale === "piecewise" ? 3 : 2,
      maximumCalibrationReferences,
    );
    for (let index = 1; index <= maximumCalibrationReferences; index += 1) {
      const legacyValue = index === 1 ? calibration.value1 : index === 2 ? calibration.value2 : undefined;
      const pointValue = calibration.points?.[index - 1]?.value ?? legacyValue;
      $(`#${axis}-value-${index}`).value = pointValue !== null && pointValue !== undefined
        && Number.isFinite(Number(pointValue)) ? String(pointValue) : "";
    }
    $(`#${axis}-label`).value = snapshot.labels?.[axis] ?? "";
  }
  if (typeof snapshot.snapEnabled === "boolean") $("#calibration-snap").checked = snapshot.snapEnabled;
  state.selectedCalibrationKey = null;
  state.draggedCalibrationKey = null;
  state.calibrationDragMoved = false;
  return true;
}

function curveCalibrationErrors(series, index = 0) {
  const snapshot = curveCalibrationSnapshot(series);
  const label = String(series?.label ?? "").trim() || `Curve ${index + 1}`;
  return [
    calibrationError(snapshot.x, `${label} 的 X 轴`),
    calibrationError(snapshot.y, `${label} 的 Y 轴`),
  ].filter(Boolean);
}

function calibrationsValid() {
  return validateCalibration(xCalibration()) && validateCalibration(yCalibration());
}

function syncCalibrationValidation() {
  const xError = calibrationError(xCalibration(), "X 轴");
  const yError = calibrationError(yCalibration(), "Y 轴");
  for (const axis of ["x", "y"]) {
    const ids = axisCalibrationPointKeys(axis).map((_, index) => `#${axis}-value-${index + 1}`);
    const error = axis === "x" ? xError : yError;
    const valueError = Boolean(error && /(刻度值|Log10)/.test(error));
    for (const selector of ids) {
      const input = $(selector);
      input.classList.toggle("input-invalid", valueError);
      input.setAttribute("aria-invalid", String(valueError));
      input.title = valueError ? error : "";
    }
  }
  const errors = [xError, yError].filter(Boolean);
  const status = $("#calibration-status");
  status.classList.toggle("invalid", errors.length > 0);
  status.textContent = errors.length
    ? errors.join(" · ")
    : "标定完成 · 可导出物理坐标";
  return { xError, yError, errors };
}

function axisCalibrationPointKeys(axis) {
  return Array.from({ length: activeCalibrationReferenceCount(axis) }, (_, index) => `${axis}${index + 1}`);
}

function calibrationAxisAudit(axis) {
  const calibration = axis === "x" ? xCalibration() : yCalibration();
  const axisSpan = axis === "x"
    ? (state.plotRect?.width ?? canvas.width)
    : (state.plotRect?.height ?? canvas.height);
  const quality = assessCalibrationQuality(calibration, axisSpan);
  if (!quality) return { axis, valid: false, quality: null, orthogonalSpread: null, uncertainty: null, warnings: [] };
  const coordinate = axis === "x" ? "y" : "x";
  const points = axisCalibrationPointKeys(axis)
    .map((key) => state.calibrationPoints[key])
    .filter(Boolean);
  const orthogonalValues = points.map((point) => point[coordinate]);
  const orthogonalSpread = orthogonalValues.length >= 2
    ? Math.max(...orthogonalValues) - Math.min(...orthogonalValues)
    : 0;
  const orthogonalSpan = axis === "x"
    ? (state.plotRect?.height ?? canvas.height)
    : (state.plotRect?.width ?? canvas.width);
  const warnings = [...quality.warnings];
  if (orthogonalSpread > Math.max(2, orthogonalSpan * 0.01)) {
    warnings.push(`${axis.toUpperCase()} 标定点未落在同一${axis === "x" ? "水平" : "垂直"}刻度线上（偏差 ${formatNumber(orthogonalSpread, 4)} px）`);
  }
  const plotStart = axis === "x" ? state.plotRect?.left : state.plotRect?.top;
  const midpoint = Number.isFinite(plotStart) ? plotStart + axisSpan / 2 : axisSpan / 2;
  const uncertainty = calibrationUncertaintyAtPixel(midpoint, calibration);
  return { axis, valid: true, quality, orthogonalSpread, uncertainty, warnings };
}

function calibrationAudit() {
  return {
    x: calibrationAxisAudit("x"),
    y: calibrationAxisAudit("y"),
  };
}

function describeCalibrationAudit(audit) {
  const axis = audit.axis.toUpperCase();
  if (!audit.valid) return `${axis}：等待完整人工标定`;
  const quality = audit.quality;
  const span = `${Math.round(quality.spanFraction * 100)}%`;
  const sensitivity = quality.sensitivityKind === "ratio"
    ? `1 px 约 ×/÷${formatNumber(quality.sensitivity, 6)}`
    : `1 px ≈ ${formatNumber(quality.sensitivity, 6)} 坐标单位`;
  const referenceText = `${quality.referenceCount ?? 2} 个参考点`;
  const residualText = (quality.referenceCount ?? 2) > 2
    ? ` · 拟合 RMS ${formatNumber(quality.residualRmsPx ?? 0, 4)} px`
    : "";
  const uncertaintyText = Number.isFinite(audit.uncertainty?.valueSigma)
    ? ` · 中部约 ±${formatNumber(audit.uncertainty.valueSigma, 4)} 坐标单位`
    : "";
  const warning = audit.warnings.length ? ` · ${audit.warnings.join("；")}` : " · 基准跨度良好";
  return `${axis}：${referenceText} · 跨度 ${formatNumber(quality.pixelSpan, 6)} px（轴宽 ${span}） · ${sensitivity}${residualText}${uncertaintyText}${warning}`;
}

function syncCalibrationQuality() {
  const audit = calibrationAudit();
  $("#x-calibration-quality").textContent = describeCalibrationAudit(audit.x);
  $("#y-calibration-quality").textContent = describeCalibrationAudit(audit.y);
  const element = $("#calibration-quality");
  const validAudits = [audit.x, audit.y].filter((entry) => entry.valid);
  const hasPoor = validAudits.some((entry) => entry.quality.grade === "poor");
  const hasReview = validAudits.some((entry) => entry.quality.grade === "review" || entry.warnings.length);
  element.className = `calibration-quality ${hasPoor ? "poor" : hasReview ? "review" : validAudits.length === 2 ? "good" : "waiting"}`;
  const outlierKeys = new Set(validAudits.flatMap((entry) => entry.quality.outliers?.map((point) => point.key) ?? []));
  for (const [key, button] of Object.entries(pickButtonByMode)) {
    button.classList.toggle("calibration-outlier", outlierKeys.has(key));
    if (outlierKeys.has(key)) button.title = "此参考点与其他点的稳健拟合偏差较大，建议复核";
    else if (button.title === "此参考点与其他点的稳健拟合偏差较大，建议复核") button.title = "";
  }
  return audit;
}

function markCalibrationPointManuallyAdjusted(point) {
  if (!point) return;
  point.snapped = false;
  point.snapConfidence = 0;
  point.snapShift = 0;
  point.uncertaintyPx = 0.35;
}

function setCalibrationPixel(key, value) {
  const point = state.calibrationPoints[key];
  if (!point || !Number.isFinite(Number(value))) return false;
  const coordinate = calibrationCoordinate(key);
  const maximum = coordinate === "x" ? canvas.width - 1 : canvas.height - 1;
  point[coordinate] = clamp(Number(value), 0, maximum);
  markCalibrationPointManuallyAdjusted(point);
  state.selectedCalibrationKey = key;
  state.magnifierPoint = { ...point };
  state.cursor = null;
  updateUi();
  updateCursorReadout(point);
  draw();
  scheduleDraftSave();
  return true;
}

function setCalibrationPointPosition(key, x, y) {
  const point = state.calibrationPoints[key];
  if (!point || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  point.x = clamp(x, 0, canvas.width - 1);
  point.y = clamp(y, 0, canvas.height - 1);
  markCalibrationPointManuallyAdjusted(point);
  state.selectedCalibrationKey = key;
  state.selectedPointId = null;
  state.selectedAnchorIndex = null;
  state.magnifierPoint = { ...point };
  state.cursor = null;
  updateUi();
  updateCursorReadout(point);
  draw();
  scheduleDraftSave();
  return true;
}

function nudgeCalibrationPoint(key, delta, { commit = true } = {}) {
  const point = state.calibrationPoints[key];
  const coordinate = calibrationCoordinate(key);
  if (!point || !Number.isFinite(Number(delta))) return false;
  const moved = setCalibrationPixel(key, point[coordinate] + Number(delta));
  if (moved && commit) commitHistory(`微调标定点 ${calibrationPointLabel(key)}`);
  return moved;
}

function nudgeCalibrationPoint2d(key, deltaX, deltaY, { commit = true } = {}) {
  const point = state.calibrationPoints[key];
  if (!point || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return false;
  const moved = setCalibrationPointPosition(key, point.x + deltaX, point.y + deltaY);
  if (moved && commit) commitHistory(`方向键微调标定点 ${calibrationPointLabel(key)}`);
  return moved;
}

function syncCalibrationRefinement() {
  const key = state.selectedCalibrationKey;
  const point = key ? state.calibrationPoints[key] : null;
  const panel = $("#calibration-refine");
  panel.hidden = !point || !calibrationPointVisible(key) || state.rotationPreviewActive;
  if (panel.hidden) return;
  const coordinate = calibrationCoordinate(key);
  $("#calibration-refine-title").textContent = `微调 ${calibrationPointLabel(key)}`;
  $("#calibration-refine-axis").textContent = coordinate === "x" ? "沿水平方向" : "沿垂直方向";
  const input = $("#calibration-pixel-position");
  if (document.activeElement !== input) input.value = formatNumber(point[coordinate], 8);
  $("#calibration-refine-hint").textContent = coordinate === "x"
    ? "方向键可上下左右移动蓝色十字；每次 1 px，Shift+方向键为 0.1 px。"
    : "方向键可上下左右移动紫色十字；每次 1 px，Shift+方向键为 0.1 px。";
}

function renderSeriesList() {
  const list = $("#series-list");
  if (!state.series.length) {
    list.innerHTML = '<div class="series-empty">尚未保存曲线</div>';
    return;
  }
  list.innerHTML = state.series.map((series, index) => {
    const observed = series.path.filter((point) => point.observed).length;
    const coverage = series.path.length ? ((observed / series.path.length) * 100).toFixed(0) : "0";
    const displayPointCount = series.path.length;
    const guideCount = series.anchors?.length || (series.seed ? 1 : 0);
    const samplingLabel = series.parameters?.samplingMode === "peak"
      ? "峰值加密"
      : series.parameters?.samplingMode === "noise"
        ? "波动加密"
        : series.parameters?.samplingMode === "geometry" ? "几何加密" : "等间距";
    const styleLabels = {
      line: "连续细线",
      dashed: "虚线指纹",
      dashdot: "点划线指纹",
      dotted: "点线指纹",
      noisy: "实验噪声线",
      markers: "marker 中心",
    };
    const objectLabel = styleLabels[series.parameters?.targetStyle] ?? null;
    const distributionLabel = series.parameters?.targetStyle === "markers"
      ? objectLabel
      : objectLabel ? `${objectLabel} · ${samplingLabel}` : samplingLabel;
    const safeLabel = escapeHtml(series.label || `Curve ${index + 1}`);
    const safeSeriesId = escapeHtml(series.id);
    const color = seriesTargetColor(series, index);
    const editing = series.id === state.editingSeriesId;
    const visibilityLabel = series.visible ? "隐藏" : "显示";
    const visibilityStatus = series.visible ? "画布已显示" : "画布已隐藏";
    return `
      <div class="series-item ${editing ? "editing" : ""} ${series.visible ? "visible" : ""}" data-series-id="${safeSeriesId}">
        <span class="series-color" style="background:${color}" title="目标曲线采样颜色"></span>
        <div class="series-copy">
          <strong data-i18n-skip>${safeLabel}</strong>
          <span>${displayPointCount} 数据点 · ${guideCount} 引导点 · ${distributionLabel} · ${coverage}% 观测 · ${visibilityStatus}</span>
        </div>
        <div class="series-actions">
          <button type="button" data-action="visibility" aria-pressed="${Boolean(series.visible)}">${visibilityLabel}</button>
          <button type="button" data-action="edit">${editing ? "取消" : "编辑"}</button>
          <button type="button" data-action="delete">删除</button>
        </div>
      </div>`;
  }).join("");
}

function pointInsidePlot(point) {
  return Boolean(state.plotRect && point
    && point.x >= state.plotRect.left && point.x <= state.plotRect.right
    && point.y >= state.plotRect.top && point.y <= state.plotRect.bottom);
}

function createDataPoint(point, origin = "auto") {
  pointIdSequence += 1;
  return {
    ...point,
    pointId: point.pointId ?? `point-${Date.now().toString(36)}-${pointIdSequence.toString(36)}`,
    origin: point.origin ?? origin,
  };
}

function createDataPath(path, origin = "auto") {
  return (path ?? []).map((point) => createDataPoint(point, origin));
}

function dataPointById(pointId) {
  return state.path.find((point) => point.pointId === pointId) ?? null;
}

function dataPointAt(position) {
  if (state.traceStale) return null;
  if (!position || !state.path.length) return null;
  const hitRadius = Math.max(6, 8 / state.zoom);
  let bestId = null;
  let bestDistance = Infinity;
  state.path.forEach((point) => {
    const distance = Math.hypot(point.x - position.x, point.y - position.y);
    if (distance <= hitRadius && distance < bestDistance) {
      bestId = point.pointId;
      bestDistance = distance;
    }
  });
  return bestId;
}

function nearestDeletableDataPoint(position, screenRadius = 28) {
  if (state.traceStale) return null;
  if (!position || !state.path.length) return null;
  const maximumDistance = Math.max(2, screenRadius / state.zoom);
  let bestId = null;
  let bestDistance = Infinity;
  for (const point of state.path) {
    if (point.anchor) continue;
    const distance = Math.hypot(point.x - position.x, point.y - position.y);
    if (distance <= maximumDistance && distance < bestDistance) {
      bestId = point.pointId;
      bestDistance = distance;
    }
  }
  return bestId === null ? null : { pointId: bestId, distance: bestDistance };
}

function guideAnchorAt(position) {
  if (!position || !state.anchors.length) return null;
  const hitRadius = Math.max(8, 10 / state.zoom);
  let bestIndex = null;
  let bestDistance = Infinity;
  state.anchors.forEach((anchor, index) => {
    const distance = Math.hypot(anchor.x - position.x, anchor.y - position.y);
    if (distance <= hitRadius && distance < bestDistance) {
      bestIndex = index;
      bestDistance = distance;
    }
  });
  return bestIndex;
}

function deleteGuideAnchor(index) {
  if (index === null || index < 0 || index >= state.anchors.length) return;
  if (state.anchors.length <= 1) {
    showToast("必须保留一个取色种子；如需重选，请点击“选择目标曲线”");
    return;
  }

  const removedLabel = `A${index + 1}`;
  const [removed] = state.anchors.splice(index, 1);
  if (removed === state.seed || index === 0) state.seed = state.anchors[0];
  if (state.hoveredAnchorIndex === index) state.hoveredAnchorIndex = null;
  else if (state.hoveredAnchorIndex > index) state.hoveredAnchorIndex -= 1;
  if (state.selectedAnchorIndex === index) state.selectedAnchorIndex = null;
  else if (state.selectedAnchorIndex > index) state.selectedAnchorIndex -= 1;
  state.draggedAnchorIndex = null;

  const minimumAnchors = minimumTraceAnchorCount();
  if (retraceIfReady()) {
    showToast(`已删除引导点 ${removedLabel}；已用剩余 ${state.anchors.length} 个引导点重新追踪`);
  } else if (state.path.length) {
    state.rawPath = [];
    state.path = [];
    state.hoveredPointId = null;
    state.pointHoverSource = null;
    state.selectedPointId = null;
    state.draggedPointId = null;
    state.hoveredAnchorIndex = null;
    state.selectedAnchorIndex = null;
    state.draggedAnchorIndex = null;
    const missingGuides = Math.max(1, minimumAnchors - state.anchors.length);
    showToast(`已删除引导点 ${removedLabel}；marker 模式还需添加 ${missingGuides} 个引导点后重新追踪`);
  } else {
    showToast(`已删除引导点 ${removedLabel}；当前保留 ${state.anchors.length} 个`);
  }
  updateUi();
  draw();
  commitHistory("删除引导点");
}

function sortDataPoints() {
  if (state.traceOrientation === "parametric") {
    // The array itself is the editable traversal. Sorting a loop by X or Y
    // would split it into two branches and corrupt export order.
  } else if (state.traceOrientation === "vertical") {
    state.path.sort((a, b) => a.y - b.y || a.x - b.x);
  } else {
    state.path.sort((a, b) => a.x - b.x || a.y - b.y);
  }
  state.path.forEach((point, index) => {
    point.parametricOrder = index;
    point.traceOrientation = state.traceOrientation;
  });
}

function squaredDistanceToSegment(point, left, right) {
  const deltaX = right.x - left.x;
  const deltaY = right.y - left.y;
  const denominator = deltaX * deltaX + deltaY * deltaY;
  if (!(denominator > 0)) return (point.x - left.x) ** 2 + (point.y - left.y) ** 2;
  const fraction = clamp(
    ((point.x - left.x) * deltaX + (point.y - left.y) * deltaY) / denominator,
    0,
    1,
  );
  const projectedX = left.x + deltaX * fraction;
  const projectedY = left.y + deltaY * fraction;
  return (point.x - projectedX) ** 2 + (point.y - projectedY) ** 2;
}

function nearestParametricSegmentIndex(path, point) {
  if (!path?.length) return -1;
  const closed = path.some((candidate) => candidate.closedPath);
  const segmentCount = closed ? path.length : path.length - 1;
  if (segmentCount <= 0) return path.length - 1;
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < segmentCount; index += 1) {
    const next = path[(index + 1) % path.length];
    const distance = squaredDistanceToSegment(point, path[index], next);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function automaticMarkerSeriesActive() {
  return $("#target-style").value === "markers"
    && state.automaticMarkerSeries
    && state.automaticMarkerConfidence >= 0.78;
}

function minimumTraceAnchorCount() {
  if ($("#target-style").value !== "markers") return 1;
  return automaticMarkerSeriesActive() ? 1 : 3;
}

function syncPointCountInput() {
  if (state.path.length) $("#trace-point-count").value = String(state.path.length);
}

function syncPointCursor() {
  canvas.classList.toggle("point-hover", state.hoveredPointId !== null && state.pointHoverSource === "canvas");
  canvas.classList.toggle("point-dragging", state.draggedPointId !== null);
  canvas.classList.toggle("guide-hover", state.hoveredAnchorIndex !== null);
  canvas.classList.toggle("guide-dragging", state.draggedAnchorIndex !== null);
}

function syncPointListSelection() {
  for (const row of document.querySelectorAll(".data-point-row")) {
    const pointId = row.dataset.pointId;
    row.classList.toggle("selected", pointId === state.selectedPointId
      || (pointId === state.hoveredPointId && state.pointHoverSource === "table"));
    row.classList.toggle("dragging", pointId === state.draggedPointId);
  }
}

function revealPointInList(pointId) {
  const row = [...document.querySelectorAll(".data-point-row")]
    .find((candidate) => candidate.dataset.pointId === pointId);
  row?.scrollIntoView({ block: "nearest" });
}

function displayedPointCoordinate(point, coordinate) {
  if (!calibrationsValid()) return point[coordinate];
  return pixelToValue(point[coordinate], coordinate === "x" ? xCalibration() : yCalibration());
}

function pointCoordinateInputStep(point, coordinate) {
  const pixelStep = 0.1;
  if (!calibrationsValid()) return String(pixelStep);
  const calibration = coordinate === "x" ? xCalibration() : yCalibration();
  const valueStep = valueStepForPixelNudge(point[coordinate], calibration, pixelStep);
  return Number.isFinite(valueStep) && valueStep > 0
    ? valueStep.toPrecision(12)
    : String(pixelStep);
}

function pointCoordinateUncertaintyText(point) {
  if (!calibrationsValid()) return "";
  const xUncertainty = calibrationUncertaintyAtPixel(point.x, xCalibration());
  const yUncertainty = calibrationUncertaintyAtPixel(
    point.y,
    yCalibration(),
    Number(point.inferenceUncertainty) || 0,
  );
  if (!Number.isFinite(xUncertainty?.valueSigma) || !Number.isFinite(yUncertainty?.valueSigma)) return "";
  return ` · 坐标估计约 ±${formatNumber(xUncertainty.valueSigma, 4)}, ±${formatNumber(yUncertainty.valueSigma, 4)}`;
}

function updatePointListRow(point) {
  const row = [...document.querySelectorAll(".data-point-row")]
    .find((candidate) => candidate.dataset.pointId === point.pointId);
  if (!row) return;
  const xInput = row.querySelector('[data-coordinate="x"]');
  const yInput = row.querySelector('[data-coordinate="y"]');
  xInput.value = formatNumber(displayedPointCoordinate(point, "x"), 12);
  yInput.value = formatNumber(displayedPointCoordinate(point, "y"), 12);
  xInput.step = pointCoordinateInputStep(point, "x");
  yInput.step = pointCoordinateInputStep(point, "y");
  const originLabel = point.anchor
    ? "引导基准点"
    : point.origin === "manual" ? "用户新增" : point.observed === false ? "遮挡推断" : "自动追踪";
  const uncertainty = Number.isFinite(point.inferenceUncertainty)
    ? ` · 估计不确定度 ±${formatNumber(point.inferenceUncertainty, 3)} px`
    : "";
  const inferenceModel = point.inferenceModel ? ` · 遮挡恢复 ${point.inferenceModel}` : "";
  const corridorLabel = point.corridorConstrained ? " · Pen 边界修正" : "";
  const coordinateUncertainty = pointCoordinateUncertaintyText(point);
  row.title = `pixel (${formatNumber(point.x, 8)}, ${formatNumber(point.y, 8)}) · ${originLabel}${inferenceModel}${uncertainty}${coordinateUncertainty}${corridorLabel}`;
}

function renderPointList() {
  $("#point-list").inert = state.traceStale;
  $("#point-list-stale").hidden = !state.traceStale || !state.path.length;
  $("#point-count").textContent = `${state.path.length} 点`;
  const calibrated = calibrationsValid();
  $("#point-x-heading").textContent = calibrated ? ($("#x-label").value.trim() || "x") : "x (px)";
  $("#point-y-heading").textContent = calibrated ? ($("#y-label").value.trim() || "y") : "y (px)";
  if (!state.path.length) {
    const message = state.editingSeriesId
      ? "当前编辑曲线已清空；可重新自动追踪，或重置当前曲线恢复已存版本"
      : state.series.length
        ? '当前没有正在编辑的曲线；点击已存曲线的“编辑”载入坐标'
        : "自动追踪后显示全部数据点";
    $("#point-list").innerHTML = `<div class="point-list-empty">${message}</div>`;
    return;
  }
  const currentReview = currentPathReviewRegion();
  const reviewPointIndices = new Set(currentReview?.pointIndices ?? []);
  $("#point-list").innerHTML = state.path.map((point, index) => {
    const classes = [
      "data-point-row",
      point.anchor ? "guide-point" : "",
      point.observed === false ? "inferred-point" : "",
      reviewPointIndices.has(index) ? "review-point" : "",
      point.pointId === state.selectedPointId ? "selected" : "",
      point.pointId === state.hoveredPointId && state.pointHoverSource === "table" ? "selected" : "",
      point.pointId === state.draggedPointId ? "dragging" : "",
    ].filter(Boolean).join(" ");
    const xValue = displayedPointCoordinate(point, "x");
    const yValue = displayedPointCoordinate(point, "y");
    const xStep = pointCoordinateInputStep(point, "x");
    const yStep = pointCoordinateInputStep(point, "y");
    const originLabel = point.anchor
      ? "引导基准点"
      : point.origin === "manual" ? "用户新增" : point.observed === false ? "遮挡推断" : "自动追踪";
    const uncertainty = Number.isFinite(point.inferenceUncertainty)
      ? ` · 估计不确定度 ±${formatNumber(point.inferenceUncertainty, 3)} px`
      : "";
    const inferenceModel = point.inferenceModel
      ? ` · 遮挡恢复 ${point.inferenceModel}`
      : "";
    const reviewLabel = reviewPointIndices.has(index) ? " · 当前智能复核区" : "";
    const corridorLabel = point.corridorConstrained ? " · Pen 边界修正" : "";
    const coordinateUncertainty = pointCoordinateUncertaintyText(point);
    const title = `pixel (${formatNumber(point.x, 8)}, ${formatNumber(point.y, 8)}) · ${originLabel}${inferenceModel}${uncertainty}${coordinateUncertainty}${corridorLabel}${reviewLabel}`;
    return `<div class="${classes}" data-point-id="${escapeHtml(point.pointId)}" title="${escapeHtml(title)}">
      <span class="point-list-index">${index + 1}</span>
      <input class="point-coordinate-input" data-coordinate="x" type="number" step="${escapeHtml(xStep)}" value="${escapeHtml(formatNumber(xValue, 12))}" title="上下箭头每次约移动 0.1 px" aria-label="第 ${index + 1} 点 x 坐标" />
      <input class="point-coordinate-input" data-coordinate="y" type="number" step="${escapeHtml(yStep)}" value="${escapeHtml(formatNumber(yValue, 12))}" title="上下箭头每次约移动 0.1 px" aria-label="第 ${index + 1} 点 y 坐标" />
      <button class="point-delete-button" type="button" data-action="delete-point" title="删除第 ${index + 1} 点" aria-label="删除第 ${index + 1} 点">×</button>
    </div>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function activeTraceParameters() {
  return {
    threshold: Number($("#color-threshold").value),
    maxJump: Number($("#max-jump").value),
    maxGap: Number($("#max-gap").value),
    pointCount: state.path.length || activeTracePointCount(),
    strictGuidance: $("#strict-guide").checked,
    targetStyle: $("#target-style").value,
    automaticMarkerSeries: automaticMarkerSeriesActive(),
    automaticMarkerConfidence: state.automaticMarkerConfidence,
    orientationMode: $("#trace-orientation").value,
    resolvedOrientation: state.traceOrientation,
    refinementMode: $("#path-refinement").value,
    corridorWidth: traceCorridorWidth(),
    corridorMode: $("#trace-corridor-mode").value,
    ...activeSamplingParameters(),
  };
}

function curvesForExport() {
  const saved = state.series.flatMap((series) => {
    if (series.id !== state.editingSeriesId) return [series];
    if (!state.path.length) return [];
    return [{
        ...series,
        label: $("#series-label").value.trim() || series.label,
        path: state.path,
        seed: state.seed,
        seedColor: state.seedColor,
        anchors: state.anchors,
        rawPath: state.rawPath,
        traceCorridorOperations: state.traceCorridorOperations,
        parameters: activeTraceParameters(),
        traceStale: state.traceStale,
        calibration: currentCalibrationSnapshot(),
      }];
  });
  if (state.path.length && !state.editingSeriesId) {
    saved.push({
      id: "active-unsaved",
      label: $("#series-label").value.trim() || `Curve ${saved.length + 1}`,
      path: state.path,
      seed: state.seed,
      seedColor: state.seedColor,
      anchors: state.anchors,
      rawPath: state.rawPath,
      traceCorridorOperations: state.traceCorridorOperations,
      overlayColor: colorToCss(state.seedColor, seriesPalette[saved.length % seriesPalette.length]),
      parameters: activeTraceParameters(),
      calibration: currentCalibrationSnapshot(),
    });
  }
  return saved;
}

function curvesForMetrics() {
  const curves = state.series.map((series) => (
    series.id === state.editingSeriesId && state.path.length
      ? { ...series, path: state.path, calibration: currentCalibrationSnapshot() }
      : series
  ));
  if (state.path.length && !state.editingSeriesId) {
    curves.push({ path: state.path, calibration: currentCalibrationSnapshot() });
  }
  return curves;
}

function reviewRegionRangeLabel(region) {
  if (!region) return "";
  if (calibrationsValid()) {
    const left = pixelToValue(region.xMin, xCalibration());
    const right = pixelToValue(region.xMax, xCalibration());
    return `x ${formatNumber(Math.min(left, right), 5)}–${formatNumber(Math.max(left, right), 5)}`;
  }
  return `pixel x ${formatNumber(region.xMin, 5)}–${formatNumber(region.xMax, 5)}`;
}

function syncReviewAssistant() {
  const element = $("#review-assistant");
  const regions = pathReviewRegions();
  const region = currentPathReviewRegion(regions);
  const ambiguityTarget = pathAmbiguityTarget();
  const issueCount = Math.max(regions.length, ambiguityTarget ? 1 : 0);
  $("#review-region-count").textContent = `${issueCount} 处`;
  $("#review-resolve").disabled = !(ambiguityTarget || region);
  $("#review-next").hidden = Boolean(ambiguityTarget);
  $("#review-next").disabled = regions.length <= 1;
  if (!state.path.length) {
    element.hidden = true;
    element.className = "review-assistant waiting";
    $("#review-region-status").textContent = "追踪后自动标出最需要检查的位置";
    return regions;
  }
  if (!region && !ambiguityTarget) {
    element.hidden = true;
    element.className = "review-assistant good";
    $("#review-region-status").textContent = "未发现需要重点复核的局部区间；用户修正点和引导基准已自动排除";
    return regions;
  }
  element.hidden = false;
  if (ambiguityTarget) {
    element.className = "review-assistant review";
    $("#review-region-status").textContent = "检测到同色候选分支。点击下方按钮后，在高亮列点击正确曲线；这个引导点会立即触发全局重追踪。";
    $("#review-resolve").textContent = "定位并确认分支";
    return regions;
  }
  element.className = `review-assistant ${region.severity}`;
  const reasonText = region.reasons
    .map((reason) => `${reason.label} ${reason.count} 点`)
    .join("、");
  $("#review-region-status").textContent = `当前 ${state.reviewRegionIndex + 1}/${regions.length} · ${reviewRegionRangeLabel(region)} · ${reasonText}`;
  $("#review-resolve").textContent = "定位并添加基准";
  return regions;
}

function revealPointOnCanvas(point) {
  const scroller = $("#canvas-scroller");
  if (!scroller || !point) return;
  const left = plotSurface.offsetLeft + point.x * state.zoom - scroller.clientWidth / 2;
  const top = plotSurface.offsetTop + point.y * state.zoom - scroller.clientHeight / 2;
  scroller.scrollTo({
    left: Math.max(0, left),
    top: Math.max(0, top),
    behavior: "smooth",
  });
}

function focusReviewRegion(offset = 0) {
  const regions = pathReviewRegions();
  if (!regions.length) return false;
  state.reviewRegionIndex = (state.reviewRegionIndex + offset + regions.length) % regions.length;
  const region = regions[state.reviewRegionIndex];
  const point = state.path[region.representativeIndex];
  if (!point) return false;
  state.selectedPointId = point.pointId;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.magnifierPoint = { ...point };
  state.cursor = null;
  updateUi();
  draw();
  window.requestAnimationFrame(() => {
    revealPointInList(point.pointId);
    revealPointOnCanvas(point);
  });
  showToast(`已定位复核区 ${state.reviewRegionIndex + 1}/${regions.length}：${region.reasons.map((reason) => reason.label).join("、")}`);
  return true;
}

function beginReviewResolution() {
  const ambiguityTarget = pathAmbiguityTarget();
  const regions = pathReviewRegions();
  const region = currentPathReviewRegion(regions);
  const fallbackPoint = region ? state.path[region.representativeIndex] : null;
  const target = ambiguityTarget ?? (fallbackPoint ? {
    x: fallbackPoint.x,
    y: fallbackPoint.y,
    candidateYs: [fallbackPoint.y],
    kind: "review",
  } : null);
  if (!target) return false;
  state.ambiguityResolutionTarget = { ...target };
  const candidateYs = target.candidateYs?.length ? target.candidateYs : [target.y];
  state.magnifierPoint = {
    x: target.x,
    y: candidateYs.reduce((sum, y) => sum + y, 0) / candidateYs.length,
  };
  state.cursor = null;
  const nearestDataPoint = [...state.path].sort((left, right) => (
    Math.abs(left.x - target.x) - Math.abs(right.x - target.x)
    || Math.abs(left.y - target.y) - Math.abs(right.y - target.y)
  ))[0];
  state.selectedPointId = nearestDataPoint?.pointId ?? null;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  syncPointListSelection();
  syncPointCursor();
  if (state.mode !== "guide") setMode("guide");
  else {
    updateUi();
    draw();
  }
  window.requestAnimationFrame(() => {
    if (nearestDataPoint) revealPointInList(nearestDataPoint.pointId);
    revealPointOnCanvas(target);
  });
  showToast(ambiguityTarget
    ? "已定位最有信息量的分叉；请在高亮候选中点击正确曲线，随后将自动全局重追踪"
    : "已定位需要复核的位置；请点击曲线应经过的位置，随后将自动重新追踪");
  return true;
}

function updateUi() {
  document.documentElement.dataset.computeMode = computeClient.mode();
  document.documentElement.dataset.computeBusy = state.computeBusy ?? "idle";
  document.documentElement.dataset.traceState = state.traceStale ? "stale" : "current";
  if (state.selectedCalibrationKey && !calibrationPointVisible(state.selectedCalibrationKey)) {
    state.selectedCalibrationKey = null;
  }
  syncModeControls();
  if (!state.mode) {
    $("#mode-hint").textContent = state.seedColor
      ? "左键空白处新增 · 拖动圆圈/菱形 · 右键删除附近最近的普通点"
      : "可继续标定或调整追踪参数";
  }
  for (const axis of ["x", "y"]) {
    const referenceCount = activeCalibrationReferenceCount(axis);
    state.calibrationReferenceCounts[axis] = referenceCount;
    for (let index = 3; index <= maximumCalibrationReferences; index += 1) {
      $(`#${axis}-reference-row-${index}`).hidden = index > referenceCount;
    }
    $(`#${axis}-reference-count`).textContent = `${referenceCount} 个参考点`;
    $(`#add-${axis}-reference`).disabled = referenceCount >= maximumCalibrationReferences;
    $(`#remove-${axis}-reference`).disabled = referenceCount <= ($(`#${axis}-scale`).value === "piecewise" ? 3 : 2);
  }
  const rect = state.plotRect;
  const suggestionSuffix = state.plotSuggestions.length
    ? ` · 建议 ${state.plotSuggestionIndex + 1}/${state.plotSuggestions.length}`
    : "";
  const interferenceSuggestionSuffix = state.exclusionSuggestions.length
    ? ` · 待复核干扰建议 ${state.exclusionSuggestions.length}`
    : "";
  $("#plot-status").textContent = rect
    ? `x ${rect.left}–${rect.right} · y ${rect.top}–${rect.bottom} · ${rect.width}×${rect.height} px${suggestionSuffix} · 屏蔽区 ${state.exclusions.length}${interferenceSuggestionSuffix}`
    : "尚未框选";
  $("#auto-plot").textContent = state.plotSuggestions.length ? "下一个建议" : "自动建议";
  for (const [key, button] of Object.entries(pickButtonByMode)) {
    const point = state.calibrationPoints[key];
    button.classList.toggle("complete", Boolean(point));
    button.classList.toggle("selected", key === state.selectedCalibrationKey && state.mode !== key);
    button.textContent = point
      ? `${key} @ ${formatNumber(key.startsWith("x") ? point.x : point.y, 6)} px${point.snapped ? " · 吸附" : ""}`
      : `点击刻度 ${key.at(-1)}`;
  }

  syncCalibrationValidation();
  syncCalibrationRefinement();
  const coordinateAudit = syncCalibrationQuality();

  if (state.seedColor) {
    const { r, g, b } = state.seedColor;
    $("#seed-swatch").style.background = `rgb(${r} ${g} ${b})`;
    const guideText = `${state.anchors.length || 1} 个引导基准点`;
    const styleText = {
      line: "连续细线",
      dashed: "虚线指纹",
      dashdot: "点划线指纹",
      dotted: "点线指纹",
      noisy: "实验噪声线",
      markers: "marker 中心",
    }[$("#target-style").value] ?? "自动线型";
    const orientationText = {
      horizontal: "横向追踪",
      vertical: "纵向追踪",
      parametric: "二维路径追踪",
    }[state.traceOrientation] ?? "横向追踪";
    $("#seed-status").textContent = state.computeBusy
      ? `RGB(${r}, ${g}, ${b}) · 正在后台${state.computeBusy === "classify" ? "识别目标" : "追踪曲线"}…`
      : state.traceStale
        ? `RGB(${r}, ${g}, ${b}) · ${guideText} · ${translateMessage("追踪未完成")}`
      : state.path.length
        ? `RGB(${r}, ${g}, ${b}) · ${styleText} · ${orientationText} · ${guideText} · ${state.path.length} 个数据点`
        : `RGB(${r}, ${g}, ${b}) · ${styleText} · ${guideText} · 等待自动追踪`;
  } else {
    $("#seed-swatch").removeAttribute("style");
    $("#seed-status").textContent = "尚未选择曲线";
  }
  renderPointList();
  syncPointCursor();

  const markerMode = $("#target-style").value === "markers";
  const requestedOrientation = $("#trace-orientation").value;
  const parametricMode = !markerMode && (requestedOrientation === "parametric"
    || (requestedOrientation === "auto" && state.traceOrientation === "parametric"));
  $("#trace-2d-settings-help").hidden = !parametricMode;
  const hasTarget = Boolean(state.seedColor);
  $("#trace-primary-action").classList.toggle("has-target", hasTarget);
  $("#trace-refinement-tools").hidden = !hasTarget;
  $("#trace-output-options").hidden = !hasTarget;
  $("#trace-current-actions").hidden = !hasTarget && !state.editingSeriesId;
  $("#save-series").hidden = !state.path.length && !state.series.length;
  $("#restart-session").disabled = !state.image;
  syncDraftRecovery();
  $("#pick-seed").disabled = Boolean(state.computeBusy);
  $("#pick-seed").textContent = state.mode === "seed"
    ? "请在图中点击曲线"
    : hasTarget
      ? "重新选择目标"
      : "选择目标曲线";
  $("#target-style-summary").textContent = $("#target-style").selectedOptions[0]?.textContent ?? "自动 / 普通曲线";
  $("#trace-point-count-summary").textContent = `${$("#trace-point-count").value} 点`;
  const minimumAnchors = minimumTraceAnchorCount();
  $("#trace-curve").disabled = Boolean(state.computeBusy)
    || !(state.imageData && state.plotRect && state.seedColor && state.anchors.length >= minimumAnchors);
  $("#retry-trace").disabled = $("#trace-curve").disabled;
  $("#trace-error").hidden = !state.traceStale;
  $("#trace-error-title").textContent = state.computeBusy ? "正在重新追踪…" : "追踪未完成";
  $("#trace-error-history").hidden = !state.path.length;
  $("#trace-error-message").textContent = state.traceStale
    ? translateMessage(state.traceError ?? "正在按当前设置计算，请稍候")
    : "";
  if (state.traceStale && state.traceError) {
    const mask = traceCorridorMask();
    if (mask?.mode === "strict") {
      const outside = state.anchors.flatMap((point, index) => inclusionMaskAllows(mask, canvas.width, point.x, point.y) ? [] : [`A${index + 1}`]);
      if (outside.length) $("#trace-error-message").textContent = `${outside.join(", ")} · ${translateMessage("引导点在 Pen 外；请补涂完整路径，或选择局部辅助。引导点不会被移动或删除。")}`;
    }
  }
  $("#add-guide").disabled = Boolean(state.computeBusy) || !(state.plotRect && state.seedColor);
  $("#undo-guide").disabled = Boolean(state.computeBusy) || state.anchors.length <= 1;
  const markerStrictReady = !markerMode || state.anchors.length >= 4;
  if (markerMode && !markerStrictReady && $("#strict-guide").checked) $("#strict-guide").checked = false;
  $("#strict-guide").disabled = !state.seedColor || !markerStrictReady || parametricMode;
  $("#strict-guide-help").textContent = markerMode
    ? (markerStrictReady
      ? "已有至少 4 个引导点；仅当附近还有同色 marker 分支时开启"
      : "marker 默认使用柔性引导；添加到至少 4 个引导点后才可强约束")
    : "拒绝偏离引导走廊的同色分支；普通曲线无需开启";
  const patternedLineMode = ["dashed", "dashdot", "dotted"].includes($("#target-style").value);
  $("#trace-point-count").disabled = Boolean(state.computeBusy) || state.traceStale;
  $("#sampling-mode").disabled = markerMode || parametricMode;
  $("#peak-density").disabled = markerMode || parametricMode;
  $("#peak-width").disabled = markerMode || parametricMode;
  $("#noise-density").disabled = markerMode || parametricMode;
  $("#noise-window").disabled = markerMode || parametricMode;
  $("#max-jump").disabled = markerMode || parametricMode;
  $("#max-gap").disabled = markerMode || parametricMode;
  $("#trace-orientation").disabled = markerMode;
  $("#path-refinement").disabled = markerMode;
  $("#trace-point-count-hint").textContent = markerMode
    ? "marker 数量由图像决定；可输入更小数量，仅保留真实中心"
    : "自动追踪生成，可继续增删修改";
  $("#target-style-hint").textContent = markerMode
    ? (automaticMarkerSeriesActive()
      ? "已从一次点击识别重复 marker；请直接复核中心。只有附近存在同色点列时才需要补引导点。"
      : "选择孤立圆点，再在点列的弯曲处和另一端各加 1 个引导点。保持柔性引导；程序会识别粘在线上的局部圆核和规则间距。右键菱形可删除。")
    : patternedLineMode
      ? "在清晰、孤立且较平缓的目标划线上取色；程序会学习划线长度和间隔。交叉或陡峭处仍需添加引导点；右键菱形可删除。"
      : $("#target-style").value === "noisy"
        ? "适合带抖动的实验连续线：降低曲率平滑约束，并在快速波动处增加采样点。右键菱形可删除引导点。"
      : "普通曲线只需选择目标即可；分叉、重叠或遮挡时再添加引导点并打开可选辅助工具。";
  $("#clear-curve").disabled = !(state.path.length || state.seedColor || state.editingSeriesId);
  $("#clear-all-points").disabled = state.path.length === 0;
  $("#save-series").disabled = Boolean(state.computeBusy) || state.traceStale || (!state.path.length && !state.series.length);
  $("#add-exclusion").disabled = !state.plotRect;
  $("#exclude-trace").disabled = !state.plotRect;
  $("#undo-exclusion").disabled = state.exclusions.length === 0;
  $("#suggest-exclusions").disabled = !state.plotRect || Boolean($("#suggest-exclusions").dataset.scanning);
  syncExclusionSuggestionUi();
  syncColorSuggestionUi();
  const corridorMask = traceCorridorMask();
  const corridorColumns = traceCorridorColumnCount(corridorMask);
  $("#draw-trace-corridor").disabled = !state.plotRect;
  $("#erase-trace-corridor").disabled = !state.plotRect || !corridorMask;
  $("#clear-trace-corridor").disabled = !corridorMask;
  $("#trace-corridor-status").textContent = corridorMask
    ? (corridorMask.mode === "strict" ? "仅搜索涂画区域" : "涂画区段内约束 · 两端允许延伸")
    : "未绘制 · 全绘图区搜索";
  if (corridorMask || $("#strict-guide").checked) $("#trace-assist-tools").open = true;
  $("#save-series").textContent = state.path.length
    ? (state.editingSeriesId ? "更新当前曲线 · 准备下一条" : "保存当前曲线 · 准备下一条")
    : "开始下一条曲线";
  const exportCurves = curvesForExport();
  const exportCalibrationErrors = exportCurves.flatMap(curveCalibrationErrors);
  const staleSavedCurve = exportCurves.find((curve) => curve.traceStale);
  const outdated = Boolean(state.computeBusy) || state.traceStale || Boolean(staleSavedCurve);
  const canExportData = Boolean(exportCurves.length && exportCalibrationErrors.length === 0 && !outdated);
  $("#export-csv").disabled = !canExportData;
  $("#export-txt").disabled = !canExportData;
  $("#export-project").disabled = !state.image;
  $("#export-overlay").disabled = !exportCurves.length || outdated;
  const exportStatus = $("#export-status");
  if (outdated) {
    exportStatus.className = "export-status blocked";
    exportStatus.textContent = state.computeBusy
      ? "正在计算；完成后可导出"
      : staleSavedCurve && !state.traceStale
        ? `${translateMessage("请编辑并重新追踪此已存曲线")}: ${staleSavedCurve.label}`
        : "当前结果尚未按新设置更新；请重新追踪，或撤销本次调整";
  } else if (!exportCurves.length) {
    exportStatus.className = "export-status waiting";
    exportStatus.textContent = "完成至少一条曲线后可导出数据";
  } else if (exportCalibrationErrors.length) {
    exportStatus.className = "export-status blocked";
    exportStatus.textContent = `CSV/TXT 暂不可用：${exportCalibrationErrors.join("；")}`;
  } else {
    exportStatus.className = "export-status ready";
    const auditWarning = [coordinateAudit.x, coordinateAudit.y].some((entry) => entry.warnings.length);
    exportStatus.textContent = auditWarning
      ? `可导出 ${exportCurves.length} 条曲线；标定质量有黄色提示，建议复核后导出`
      : `可导出 ${exportCurves.length} 条曲线的物理坐标`;
  }
  for (const selector of ["#export-csv", "#export-txt"]) {
    $(selector).title = canExportData ? "" : exportStatus.textContent;
  }

  const metricCurves = curvesForMetrics();
  const metricPaths = metricCurves.flatMap((series) => series.path ?? []);
  const data = metricCurves.flatMap((series) => {
    const snapshot = curveCalibrationSnapshot(series);
    return pathToData(series.path ?? [], snapshot.x, snapshot.y);
  });
  if (metricPaths.length) {
    const observed = metricPaths.filter((point) => point.observed).length;
    const lowConfidence = metricPaths.filter((point) => (point.confidence ?? 0) < 0.5).length;
    $("#metric-points").textContent = metricPaths.length.toLocaleString();
    $("#metric-coverage").textContent = `${((observed / metricPaths.length) * 100).toFixed(1)}%`;
    $("#metric-low-confidence").textContent = `${((lowConfidence / metricPaths.length) * 100).toFixed(1)}%`;
  } else {
    $("#metric-points").textContent = "—";
    $("#metric-coverage").textContent = "—";
    $("#metric-low-confidence").textContent = "—";
  }
  $("#metric-series").textContent = String(state.series.length);
  if (data.length) {
    const xs = data.map((point) => point.dataX);
    const ys = data.map((point) => point.dataY);
    $("#metric-x-range").textContent = `${formatNumber(Math.min(...xs), 4)}…${formatNumber(Math.max(...xs), 4)}`;
    $("#metric-y-range").textContent = `${formatNumber(Math.min(...ys), 4)}…${formatNumber(Math.max(...ys), 4)}`;
  } else {
    $("#metric-x-range").textContent = "—";
    $("#metric-y-range").textContent = "—";
  }
  const qualityElement = $("#quality-status");
  qualityElement.className = "quality-status empty";
  if (state.path.length) {
    const quality = assessPathQuality(state.path, state.plotRect);
    qualityElement.className = `quality-status ${quality.grade}`;
    const lead = `质量 ${quality.score}/100`;
    qualityElement.textContent = quality.warnings.length
      ? `${lead} · ${quality.warnings[0].message}`
      : `${lead} · 路径覆盖、观测比例和边界检查均通过`;
  } else if (state.editingSeriesId) {
    qualityElement.textContent = "当前编辑曲线没有数据点 · 可重新追踪，或重置以恢复已保存数据";
  } else if (state.series.length) {
    const scores = state.series.map((series) => assessPathQuality(series.path, state.plotRect).score);
    qualityElement.className = `quality-status ${Math.min(...scores) >= 85 ? "good" : Math.min(...scores) >= 65 ? "review" : "poor"}`;
    qualityElement.textContent = `已保存 ${scores.length} 条曲线 · 最低质量分 ${Math.min(...scores)}/100`;
  } else {
    qualityElement.textContent = "等待曲线路径";
  }
  syncReviewAssistant();
  renderSeriesList();
  syncRotationControls();
  syncRotationLock();
  if (state.image) {
    updateSourceMeta();
    updateGeometryDiagnosis();
  }
  updatePanelSectionSummaries();
}

function setZoom(percent) {
  const value = clamp(Number(percent), 20, 200);
  state.zoom = value / 100;
  const displayWidth = `${canvas.width * state.zoom}px`;
  const displayHeight = `${canvas.height * state.zoom}px`;
  canvas.style.width = displayWidth;
  canvas.style.height = displayHeight;
  imageCanvas.style.width = displayWidth;
  imageCanvas.style.height = displayHeight;
  $("#zoom-range").value = String(value);
  $("#zoom-output").value = `${Math.round(value)}%`;
  draw();
}

function fitZoom() {
  const displayImage = currentDisplayImage();
  if (!displayImage) return;
  const availableWidth = scroller.clientWidth - 70;
  const availableHeight = scroller.clientHeight - 70;
  const fit = Math.min(1.5, availableWidth / canvas.width, availableHeight / canvas.height);
  setZoom(Math.max(20, Math.floor(fit * 100)));
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFinitePixelPoint(point) {
  return isPlainRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function assertPointArray(value, label) {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (!value.every(isFinitePixelPoint)) throw new Error(`${label}包含非法像素点`);
}

function isFiniteRect(rect) {
  return isPlainRecord(rect)
    && ["left", "top", "right", "bottom", "width", "height"].every((key) => Number.isFinite(rect[key]));
}

function assertRectArray(value, label) {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  if (!value.every(isFiniteRect)) throw new Error(`${label}包含非法矩形`);
}

function validateCalibrationPayload(calibration, label) {
  if (calibration === null || calibration === undefined) return;
  if (!isPlainRecord(calibration)) throw new Error(`${label}格式无效`);
  if (calibration.points !== null && calibration.points !== undefined) {
    if (!isPlainRecord(calibration.points)) throw new Error(`${label}的标定点格式无效`);
    for (const point of Object.values(calibration.points)) {
      if (point !== null && !isFinitePixelPoint(point)) throw new Error(`${label}包含非法标定点`);
    }
  }
  for (const axis of ["x", "y"]) {
    const axisRecord = calibration[axis];
    if (axisRecord === null || axisRecord === undefined) continue;
    if (!isPlainRecord(axisRecord)) throw new Error(`${label}的 ${axis.toUpperCase()} 轴格式无效`);
    if (axisRecord.points !== null && axisRecord.points !== undefined) {
      if (!Array.isArray(axisRecord.points)) throw new Error(`${label}的 ${axis.toUpperCase()} 轴参考点必须是数组`);
      for (const point of axisRecord.points) {
        if (point === null || point === undefined) continue;
        if (!isPlainRecord(point)) throw new Error(`${label}的 ${axis.toUpperCase()} 轴包含非法参考点`);
        for (const key of ["pixel", "value"]) {
          const value = point[key];
          if (value !== null && value !== undefined && value !== "" && !Number.isFinite(Number(value))) {
            throw new Error(`${label}的 ${axis.toUpperCase()} 轴包含非法参考点`);
          }
        }
      }
    }
  }
}

function validateTraceCorridorPayload(operations, label) {
  if (operations === null || operations === undefined) return;
  if (!Array.isArray(operations)) throw new Error(`${label}必须是数组`);
  for (const operation of operations) {
    if (!isPlainRecord(operation)) throw new Error(`${label}包含非法笔画`);
    assertPointArray(operation.points, `${label}的笔画点`);
    if (operation.width !== null && operation.width !== undefined && !Number.isFinite(Number(operation.width))) {
      throw new Error(`${label}包含非法笔宽`);
    }
  }
}

function validateCurvePayload(curve, label) {
  if (!isPlainRecord(curve)) throw new Error(`${label}格式无效`);
  assertPointArray(curve.path, `${label}的数据点`);
  assertPointArray(curve.rawPath, `${label}的原始路径`);
  assertPointArray(curve.anchors, `${label}的引导点`);
  if (curve.seed !== null && curve.seed !== undefined && !isFinitePixelPoint(curve.seed)) {
    throw new Error(`${label}包含非法取色点`);
  }
  if (curve.parameters !== null && curve.parameters !== undefined && !isPlainRecord(curve.parameters)) {
    throw new Error(`${label}的追踪参数格式无效`);
  }
  if (curve.id !== null && curve.id !== undefined && typeof curve.id !== "string") {
    throw new Error(`${label}的 ID 格式无效`);
  }
  if (curve.visible !== null && curve.visible !== undefined && typeof curve.visible !== "boolean") {
    throw new Error(`${label}的显示状态格式无效`);
  }
  validateTraceCorridorPayload(curve.traceCorridorOperations, `${label}的 Pen 走廊`);
  validateCalibrationPayload(curve.calibration, `${label}的标定`);
  validateCalibrationPayload(curve.calibrationBeforeSeriesEdit, `${label}的编辑前标定`);
}

function validateEditableGeometry(geometry) {
  if (!isPlainRecord(geometry)) return false;
  try {
    if (geometry.plotRect !== null && geometry.plotRect !== undefined && !isFiniteRect(geometry.plotRect)) return false;
    assertRectArray(geometry.exclusions, "屏蔽区");
    assertRectArray(geometry.exclusionSuggestions, "屏蔽区建议");
    assertRectArray(geometry.plotSuggestions, "绘图区建议");
    assertPointArray(geometry.anchors, "引导点");
    assertPointArray(geometry.rawPath, "原始路径");
    assertPointArray(geometry.path, "数据路径");
    if (geometry.seed !== null && geometry.seed !== undefined && !isFinitePixelPoint(geometry.seed)) return false;
    validateTraceCorridorPayload(geometry.traceCorridorOperations, "Pen 走廊");
    validateCalibrationPayload({ points: geometry.calibrationPoints }, "标定");
    validateCalibrationPayload(geometry.calibrationBeforeSeriesEdit, "编辑前标定");
    if (geometry.series !== null && geometry.series !== undefined) {
      if (!Array.isArray(geometry.series)) return false;
      geometry.series.forEach((curve, index) => validateCurvePayload(curve, `曲线 ${index + 1}`));
    }
    if (
      geometry.traceOrientation !== null
      && geometry.traceOrientation !== undefined
      && !["horizontal", "vertical", "parametric"].includes(geometry.traceOrientation)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

function validateProjectPayload(project) {
  if (!isPlainRecord(project)) throw new Error("项目文件顶层格式无效");
  if (!supportedProjectSchemaVersions.has(project.schemaVersion)) throw new Error("不支持的项目文件版本");
  if (!isPlainRecord(project.source)) throw new Error("项目缺少有效的原图信息");
  if (project.source.name !== null && project.source.name !== undefined && typeof project.source.name !== "string") {
    throw new Error("项目原图名称格式无效");
  }
  const samplePath = project.source.samplePath;
  if (samplePath !== null && samplePath !== undefined && samplePath !== builtInSamplePath) {
    throw new Error("项目中的示例图片路径不受支持");
  }
  for (const key of ["width", "height"]) {
    const value = project.source[key];
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`项目原图${key === "width" ? "宽度" : "高度"}无效`);
    }
  }
  if (project.plotRect !== null && project.plotRect !== undefined && !isFiniteRect(project.plotRect)) {
    throw new Error("项目绘图区格式无效");
  }
  assertRectArray(project.exclusions, "项目屏蔽区");
  if (project.series !== null && project.series !== undefined) {
    if (!Array.isArray(project.series)) throw new Error("项目曲线列表必须是数组");
    project.series.forEach((curve, index) => validateCurvePayload(curve, `项目曲线 ${index + 1}`));
  }
  if (project.activeCurve !== null && project.activeCurve !== undefined) {
    validateCurvePayload(project.activeCurve, "项目当前曲线");
  }
  if (project.curve !== null && project.curve !== undefined) {
    validateCurvePayload(project.curve, "项目旧版当前曲线");
  }
  if (project.axes !== null && project.axes !== undefined && !isPlainRecord(project.axes)) {
    throw new Error("项目坐标轴格式无效");
  }
  validateCalibrationPayload({
    x: project.axes?.x,
    y: project.axes?.y,
    points: project.calibrationPoints,
  }, "项目标定");
  const perspective = project.preprocessing?.perspective;
  if (perspective !== null && perspective !== undefined) {
    if (!isPlainRecord(perspective)) throw new Error("项目透视矫正格式无效");
    for (const key of ["sourceCorners", "destinationCorners"]) {
      if (perspective[key] !== null && perspective[key] !== undefined) {
        assertPointArray(perspective[key], `项目透视矫正的 ${key}`);
        if (perspective[key].length !== 4) throw new Error("项目透视矫正必须包含四个角点");
      }
    }
  }
  return true;
}

function restoredSeriesId(value, index, usedIds) {
  const candidate = typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : null;
  if (candidate && !usedIds?.has(candidate)) {
    usedIds?.add(candidate);
    return candidate;
  }
  let suffix = 0;
  let fallback;
  do {
    fallback = `series-restored-${String(index)}-${suffix}`;
    suffix += 1;
  } while (usedIds?.has(fallback));
  usedIds?.add(fallback);
  return fallback;
}

function applyProject(project) {
  validateProjectPayload(project);
  interferenceScanSequence += 1;
  colorDiscoverySequence += 1;
  targetSelectionSequence += 1;
  traceTaskSequence += 1;
  state.computeBusy = null;
  delete $("#suggest-exclusions").dataset.scanning;
  const legacyCalibration = projectCalibrationSnapshot(project);
  const projectDegrees = projectRotationDegrees(project);
  const projectPerspective = project?.preprocessing?.perspective?.applied
    ? cloneSerializable(project.preprocessing.perspective)
    : null;
  const rotationChanged = Math.abs(projectDegrees - state.rotationCommitted.degrees) > 1e-8;
  const perspectiveChanged = JSON.stringify(projectPerspective) !== JSON.stringify(state.perspectiveCommitted);
  const restorePreviewCanvas = state.rotationPreviewActive;
  if (state.rotationPreviewFrame !== null) window.cancelAnimationFrame(state.rotationPreviewFrame);
  state.rotationPreviewFrame = null;
  state.perspectiveCommitted = projectPerspective;
  state.preprocessingDiagnostics = cloneSerializable(project?.preprocessing?.diagnostics ?? state.preprocessingDiagnostics);
  if (state.originalImage && (rotationChanged || perspectiveChanged)) {
    state.image = renderCommittedImage(projectDegrees, projectPerspective);
  }
  if (state.image && (rotationChanged || perspectiveChanged || restorePreviewCanvas)) updateWorkingCanvas(state.image);
  state.rotationCommitted = { degrees: projectDegrees };
  state.rotationPreviewActive = false;
  state.rotationDraft = null;
  state.rotationPreviewImage = null;
  state.rotationAlignmentPoints = [];
  state.rotationPendingCommit = null;
  state.mode = null;
  state.dragStart = null;
  state.cursor = null;
  state.source.rotationDegrees = projectDegrees;
  state.source.perspectiveCorrected = Boolean(projectPerspective);
  state.source.workingWidth = state.image?.width ?? state.source.workingWidth;
  state.source.workingHeight = state.image?.height ?? state.source.workingHeight;
  state.plotRect = project.plotRect ?? null;
  state.exclusions = project.exclusions ?? [];
  state.exclusionSuggestions = [];
  state.exclusionSuggestionIndex = 0;
  state.colorSuggestions = [];
  state.calibrationPoints = cloneSerializable(legacyCalibration.points);
  state.selectedCalibrationKey = null;
  state.draggedCalibrationKey = null;
  state.calibrationDragMoved = false;
  const activeCurve = project.activeCurve ?? project.curve ?? null;
  const usedSeriesIds = new Set();
  const restoreCurve = (curve, index = 0, registerSeriesId = false) => {
    const originalPath = curve?.path ?? [];
    const pointCount = normalizeTracePointCount(curve?.parameters?.pointCount);
    const preserveDiscreteMarkers = curve?.parameters?.targetStyle === "markers";
    const traceOrientation = resolvedTraceOrientation(curve?.parameters, originalPath);
    // Before the scope selector existed, 2D tracing used a global painted
    // region, while scan-line tracing used local assistance.
    const savedScope = curve?.parameters?.corridorMode;
    const corridorMode = ["strict", "local"].includes(savedScope)
      ? savedScope : traceOrientation === "parametric" ? "strict" : "local";
    const traceCorridorOperations = normalizeTraceCorridorOperations(curve?.traceCorridorOperations);
    const restored = prepareRestoredTrace({ ...curve, path: originalPath }, {
      count: originalPath.every((point) => point.pointId) ? null : pointCount,
      markerData: preserveDiscreteMarkers, orientation: traceOrientation,
      parameters: { samplingMode: "geometry", ...curve?.parameters },
      inclusionMask: buildTraceCorridorMask(traceCorridorOperations, corridorMode),
      width: canvas.width, height: canvas.height, rect: state.plotRect,
    });
    const path = createDataPath(restored.path);
    const restoredAnchors = (curve?.anchors?.length
      ? curve.anchors
      : (curve?.seed ? [curve.seed] : [])
    ).map((anchor) => createGuideAnchor(anchor));
    const seed = restoredAnchors.find((anchor) => anchor.anchorId === curve?.seed?.anchorId)
      ?? restoredAnchors[0]
      ?? null;
    const restoredId = registerSeriesId
      ? restoredSeriesId(curve.id, index, usedSeriesIds)
      : restoredSeriesId(curve.id, index, null);
    return {
      ...curve,
      id: restoredId,
      seed,
      anchors: restoredAnchors,
      visible: curve?.visible ?? false,
      path,
      traceStale: Boolean(restored.traceStale),
      traceError: restored.traceError ?? null,
      rawPath: (restored.rawPath ?? []).map((point) => ({ ...point })),
      traceCorridorOperations,
      parameters: {
        ...curve?.parameters,
        pointCount: path.length || pointCount,
        resolvedOrientation: traceOrientation,
        corridorMode,
      },
      calibration: cloneSerializable(curve?.calibration ?? legacyCalibration),
    };
  };
  const restoredActive = activeCurve ? restoreCurve(activeCurve, "active") : null;
  state.seed = restoredActive?.seed ?? null;
  state.seedColor = restoredActive?.seedColor ?? null;
  state.anchors = restoredActive?.anchors ?? [];
  state.rawPath = restoredActive?.rawPath ?? [];
  state.path = restoredActive?.path ?? [];
  state.traceOrientation = resolvedTraceOrientation(restoredActive?.parameters, state.path);
  state.traceStale = Boolean(restoredActive?.traceStale);
  state.traceError = restoredActive?.traceError ?? null;
  state.traceCorridorOperations = restoredActive?.traceCorridorOperations ?? [];
  state.draftTraceCorridor = null;
  invalidateTraceCorridor();
  state.reviewRegionIndex = 0;
  state.ambiguityResolutionTarget = null;
  state.series = (project.series ?? []).map((curve, index) => restoreCurve(curve, index, true));
  const requestedEditingId = activeCurve?.editingSeriesId ?? null;
  state.editingSeriesId = state.series.some((series) => series.id === requestedEditingId)
    ? requestedEditingId
    : null;
  state.calibrationBeforeSeriesEdit = cloneSerializable(activeCurve?.calibrationBeforeSeriesEdit ?? null);
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.selectedPointId = null;
  state.draggedPointId = null;
  state.hoveredAnchorIndex = null;
  state.selectedAnchorIndex = null;
  state.draggedAnchorIndex = null;
  applyCalibrationSnapshot(restoredActive?.calibration ?? legacyCalibration);
  $("#series-label").value = activeCurve?.label ?? "";
  const savedDensity = project.exportSettings?.csvDensity;
  $("#export-density").value = savedDensity === "raw" ? "curve" : (savedDensity ?? "curve");
  $("#color-threshold").value = activeCurve?.parameters?.threshold ?? 15;
  $("#max-jump").value = activeCurve?.parameters?.maxJump ?? 14;
  $("#max-gap").value = activeCurve?.parameters?.maxGap ?? 24;
  $("#sampling-mode").value = activeCurve?.parameters?.samplingMode ?? "geometry";
  $("#peak-density").value = activeCurve?.parameters?.peakDensity ?? 4;
  $("#peak-width").value = activeCurve?.parameters?.peakWidth ?? 8;
  $("#noise-density").value = activeCurve?.parameters?.noiseDensity ?? 4;
  $("#noise-window").value = activeCurve?.parameters?.noiseWindow ?? 3;
  $("#strict-guide").checked = activeCurve?.parameters?.strictGuidance ?? false;
  $("#trace-orientation").value = activeCurve?.parameters?.orientationMode ?? "auto";
  $("#target-style").value = activeCurve?.parameters?.targetStyle ?? "auto";
  delete $("#target-style").dataset.autoDetected;
  delete $("#target-style").dataset.autoConfidence;
  delete $("#target-style").dataset.autoFallback;
  state.automaticMarkerSeries = Boolean(activeCurve?.parameters?.automaticMarkerSeries);
  state.automaticMarkerConfidence = Number(activeCurve?.parameters?.automaticMarkerConfidence) || 0;
  if (state.automaticMarkerSeries && $("#target-style").value === "markers") {
    $("#target-style").dataset.autoDetected = "markers";
    $("#target-style").dataset.autoConfidence = String(state.automaticMarkerConfidence);
  }
  $("#path-refinement").value = activeCurve?.parameters?.refinementMode ?? "full";
  $("#trace-corridor-mode").value = restoredActive?.parameters?.corridorMode ?? "strict";
  $("#trace-corridor-width").value = String(activeCurve?.parameters?.corridorWidth ?? 24);
  $("#trace-point-count").value = String(state.path.length || normalizeTracePointCount(activeCurve?.parameters?.pointCount));
  state.magnifierPoint = { x: canvas.width / 2, y: canvas.height / 2 };
  syncRangeOutputs();
  updateUi();
  draw();
  showToast("项目参数和提取路径已恢复");
  if (state.plotRect) void scanColorSuggestions();
}

function loadImageSource(source, name, samplePath = null, project = null) {
  if (samplePath !== null && (samplePath !== builtInSamplePath || source !== builtInSamplePath)) {
    showToast("仅允许载入应用内置的示例图片");
    return false;
  }
  const loadId = ++imageLoadSequence;
  const resolvedSource = globalThis.__SCIDIGITIZER_EMBEDDED_ASSETS__?.[source] ?? source;
  const isObjectUrl = String(resolvedSource).startsWith("blob:");
  let objectUrlReleased = false;
  const releaseObjectUrl = () => {
    if (!isObjectUrl || objectUrlReleased) return;
    URL.revokeObjectURL(resolvedSource);
    objectUrlReleased = true;
  };
  const image = new Image();
  image.onload = () => {
    if (loadId !== imageLoadSequence) {
      releaseObjectUrl();
      return;
    }
    releaseObjectUrl();
    // Finish the previous image's delayed save before changing its fingerprint.
    // Merely opening an image must not save the fresh state over its old draft.
    editSession?.flushPendingSave();
    draftRecoveryAvailable = false;
    $("#autosave-status").textContent = "自动保存待命";
    if (state.rotationPreviewFrame !== null) window.cancelAnimationFrame(state.rotationPreviewFrame);
    state.rotationPreviewFrame = null;
    state.originalImage = image;
    const uncorrected = renderRotatedImage(image, { degrees: 0, background: "#ffffff" });
    const uncorrectedContext = uncorrected.getContext("2d", { willReadFrequently: true });
    const uncorrectedData = uncorrectedContext.getImageData(0, 0, uncorrected.width, uncorrected.height);
    const skew = project ? null : estimateAxisSkew({
      rgba: uncorrectedData.data,
      width: uncorrected.width,
      height: uncorrected.height,
    });
    const automaticSkewCorrection = skew
      && skew.confidence >= 0.62
      && Math.abs(skew.angleDegrees) >= 0.25
      && Math.abs(skew.angleDegrees) <= 8
      ? -skew.angleDegrees
      : 0;
    const projectDegrees = project ? projectRotationDegrees(project) : automaticSkewCorrection;
    const workingImage = renderRotatedImage(image, { degrees: projectDegrees, background: "#ffffff" });
    state.image = workingImage;
    state.rotationCommitted = { degrees: projectDegrees };
    state.perspectiveCommitted = null;
    state.preprocessingDiagnostics = {
      skew,
      automaticRotationDegrees: automaticSkewCorrection,
      perspective: null,
    };
    state.rotationPreviewActive = false;
    state.rotationDraft = null;
    state.rotationPreviewImage = null;
    state.rotationAlignmentPoints = [];
    state.rotationPendingCommit = null;
    state.source = {
      name,
      samplePath,
      width: image.naturalWidth,
      height: image.naturalHeight,
      rotationDegrees: projectDegrees,
      perspectiveCorrected: false,
      workingWidth: workingImage.width,
      workingHeight: workingImage.height,
      imageFingerprint: sourceImageFingerprint(image),
    };
    updateWorkingCanvas(workingImage);
    $("#empty-state").hidden = true;
    updateSourceMeta();
    updateGeometryDiagnosis();
    $("#workspace-title").textContent = name;
    resetExtraction({ keepCalibrationValues: false });
    state.magnifierPoint = { x: canvas.width / 2, y: canvas.height / 2 };
    window.requestAnimationFrame(fitZoom);
    if (project) {
      try {
        applyProject(project);
        resetHistorySession();
        scheduleDraftSave();
      } catch (error) {
        resetExtraction({ keepCalibrationValues: false });
        resetHistorySession();
        draw();
        showToast(`项目载入失败：${error.message}`);
      }
    }
    else {
      resetHistorySession();
      const freshStart = new URLSearchParams(window.location.search).has("fresh");
      if (freshStart) {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("fresh");
        window.history.replaceState(null, "", cleanUrl);
      }
      draftRecoveryAvailable = Boolean(editSession?.readDraft());
      syncDraftRecovery();
      draw();
      suggestPlotRect({ automatic: true });
    }
  };
  image.onerror = () => {
    releaseObjectUrl();
    if (loadId !== imageLoadSequence) return;
    showToast(`无法载入 ${name}；请确认应用文件完整，或重新打开图片`);
  };
  image.src = resolvedSource;
  return true;
}

function rasterImportFailureMessage(validation) {
  if (validation?.code === "too-large") return "图片文件超过 80 MiB；请先裁剪或压缩后再导入";
  if (validation?.code === "empty") return "图片文件为空，未改变当前项目";
  return "仅支持 PNG、JPEG 和 WebP 图片；未改变当前项目";
}

function importRasterImageFile(file, { pasted = false } = {}) {
  const validation = validateRasterImageFile(file);
  if (!validation.valid) {
    showToast(rasterImportFailureMessage(validation));
    return false;
  }
  const name = rasterImageDisplayName(file, { pasted });
  loadImageSource(URL.createObjectURL(file), name);
  return true;
}

function importTransferredRasterImages(files, options = {}) {
  const picked = pickRasterImageFile(files);
  if (!picked.file) {
    showToast(rasterImportFailureMessage(picked.validation));
    return false;
  }
  return importRasterImageFile(picked.file, options);
}

function retraceIfReady(options) {
  if (!state.seedColor || !state.plotRect || state.anchors.length < minimumTraceAnchorCount()) return false;
  void traceCurrentCurve(options);
  return true;
}

async function traceCurrentCurve({ silent = false, refreshHistory = true } = {}) {
  if (state.rotationPreviewActive || !state.imageData || !state.plotRect || !state.anchors.length || !state.seedColor) return false;
  const taskId = ++traceTaskSequence;
  const seedAnchorId = state.seed?.anchorId;
  state.ambiguityResolutionTarget = null;
  try {
    const previouslySelectedAnchor = state.selectedAnchorIndex;
    let targetStyle = $("#target-style").value;
    if (targetStyle === "markers" && state.anchors.length < minimumTraceAnchorCount()) {
      throw new Error("marker 模式需要取色种子，并在点列弯曲处和另一端各添加 1 个引导点");
    }
    const effectiveStrictGuidance = $("#strict-guide").checked
      && (targetStyle !== "markers" || state.anchors.length >= 4);
    const avoidPaths = targetStyle === "markers" ? [] : sameColorAvoidancePaths();
    const inclusionMask = traceCorridorMask();
    const commonOptions = {
      rect: state.plotRect,
      anchors: state.anchors,
      target: state.seedColor,
      threshold: Number($("#color-threshold").value),
      exclusions: state.exclusions,
      strictGuideCorridor: effectiveStrictGuidance,
      avoidPaths,
      avoidanceRadius: 2.5,
      inclusionMask,
    };
    const outputOptions = {
      inclusionMask, width: canvas.width, height: canvas.height, rect: state.plotRect,
      parameters: activeSamplingParameters(), count: activeTracePointCount(),
    };
    const inputGuides = state.anchors.map((point) => ({ ...point }));
    const requestedParameters = { ...activeTraceParameters() };
    state.traceStale = true;
    state.traceError = null;
    state.computeBusy = "trace";
    updateUi();
    draw();
    let rawPath;
    let prepared;
    let nextOrientation = "horizontal";
    let autoFallback = false;
    if (targetStyle === "markers") {
      const automatic = automaticMarkerSeriesActive() && state.anchors.length === 1;
      const result = await runBackgroundOperation("trace-marker", {
        ...commonOptions,
        automatic,
        seed: state.seed,
      });
      if (taskId !== traceTaskSequence || state.seed?.anchorId !== seedAnchorId) return false;
      if (automatic) {
        if (!result.inference?.detected) {
          throw new Error("自动 marker 证据已不足；请重选一个清晰标记，或手动选择 marker 类型后添加引导点");
        }
        $("#target-style").dataset.autoConfidence = String(result.inference.confidence);
      }
      rawPath = result.path;
      if (!rawPath.length) {
        throw new Error("没有检测到符合条件的 marker；请检查目标颜色、引导点和图例屏蔽区");
      }
      prepared = prepareTraceOutput(rawPath, { ...outputOptions, markerData: true });
    } else {
      const refinementMode = $("#path-refinement").value;
      const result = await runBackgroundOperation("trace-line", {
        ...commonOptions,
        maxJump: Number($("#max-jump").value),
        maxGap: Number($("#max-gap").value),
        targetStyle,
        autoPatternedStyle: Boolean($("#target-style").dataset.autoDetected)
          && ["dashed", "dashdot", "dotted"].includes(targetStyle),
        autoStyleConfidence: Number($("#target-style").dataset.autoConfidence ?? 1),
        refinementMode,
        orientationMode: $("#trace-orientation").value,
      });
      if (taskId !== traceTaskSequence || state.seed?.anchorId !== seedAnchorId) return false;
      rawPath = result.path;
      nextOrientation = ["vertical", "parametric"].includes(result.orientation)
        ? result.orientation
        : "horizontal";
      targetStyle = result.targetStyle;
      autoFallback = result.autoFallback;
      // Gap recovery and interpolation may synthesize coordinates outside the
      // painted ROI, so the Pen remains a final boundary after the Worker.
      prepared = prepareTraceOutput(rawPath, { ...outputOptions, orientation: nextOrientation, guides: inputGuides });
    }
    // Commit all derived data together, only after the shared output validator
    // has accepted raw geometry, guide retention and final sampled points.
    const nextPath = createDataPath(prepared.path, targetStyle === "markers" ? "marker" : "auto");
    state.rawPath = prepared.rawPath;
    state.path = nextPath;
    state.traceOrientation = nextOrientation;
    rawPath = prepared.rawPath;
    state.traceStale = false;
    state.traceError = null;
    if (autoFallback) {
      $("#target-style").value = "line";
      $("#target-style").dataset.autoDetected = "line";
      $("#target-style").dataset.autoFallback = "true";
    }
    $("#trace-point-count").value = String(state.path.length);
    state.reviewRegionIndex = 0;
    state.hoveredPointId = null;
    state.pointHoverSource = null;
    state.selectedPointId = null;
    state.draggedPointId = null;
    state.hoveredAnchorIndex = null;
    state.selectedAnchorIndex = Number.isInteger(previouslySelectedAnchor)
      && previouslySelectedAnchor >= 0
      && previouslySelectedAnchor < state.anchors.length
      ? previouslySelectedAnchor
      : (state.anchors.length ? 0 : null);
    state.draggedAnchorIndex = null;
    state.computeBusy = null;
    updateUi();
    draw();
    scheduleDraftSave();
    if (refreshHistory) editSession?.refreshCurrent();
    const observed = state.path.filter((point) => point.observed).length;
    if (targetStyle === "markers") {
      const markerGuidance = effectiveStrictGuidance ? "强约束" : "柔性引导";
      if (!silent) showToast(`识别到 ${state.path.length} 个 marker 中心 · ${markerGuidance}。已检测独立圆点及粘在线上的局部圆核`);
    } else {
      const samplingLabel = nextOrientation === "parametric" ? "二维弧长采样" : $("#sampling-mode").value === "peak"
        ? "峰值自适应"
        : $("#sampling-mode").value === "noise"
          ? "波动自适应"
          : $("#sampling-mode").value === "geometry" ? "几何自适应" : "等间距";
      const hiddenGuideCount = rawPath.filter((point) => point.anchor && point.occlusionGuide).length;
      const guidanceLabel = nextOrientation === "parametric" ? "二维引导路径" : $("#strict-guide").checked
        ? "同色/遮挡强约束"
        : hiddenGuideCount
          ? `${hiddenGuideCount} 个遮挡内引导点已自动局部强约束`
          : "柔性引导";
      const detectedStyleLabels = {
        line: "连续线",
        dashed: "虚线",
        dashdot: "点划线",
        dotted: "点线",
      };
      const autoStyleLabel = $("#target-style").dataset.autoDetected
        ? `自动识别${detectedStyleLabels[targetStyle] ?? "线型"} · `
        : "";
      const styleLabel = autoStyleLabel || (["dashed", "dashdot", "dotted"].includes(targetStyle) ? "线型指纹 · " : "");
      const orientationLabel = state.traceOrientation === "vertical"
        ? " · 自动采用纵向追踪"
        : state.traceOrientation === "parametric" ? " · 自动采用二维路径追踪" : "";
      const topologyReviewLabel = rawPath.some((point) => point.topologyReview)
        ? " · 自交节点已按切向连续连接，请复核"
        : "";
      const avoidanceLabel = avoidPaths.length && nextOrientation !== "parametric" ? ` · 已避让 ${avoidPaths.length} 条同色已存曲线` : "";
      const corridorLabel = inclusionMask
        ? ` · Pen 走廊约束 ${traceCorridorColumnCount(inclusionMask)} 列`
        : "";
      const corridorCorrectedCount = state.path.filter((point) => point.corridorConstrained).length;
      const corridorCorrectionLabel = corridorCorrectedCount
        ? ` / 边界修正 ${corridorCorrectedCount} 点`
        : "";
      const refinementMode = requestedParameters.refinementMode;
      const centeredCount = rawPath.filter((point) => point.centerRefined).length;
      const fittedCount = rawPath.filter((point) => point.occlusionInferred).length;
      const patternedGapCount = rawPath.filter((point) => point.patternInferred).length;
      const patternedGapLabel = patternedGapCount
        ? ` / 虚线间隔 ${patternedGapCount} 个推断点`
        : "";
      const reconnectedCount = rawPath.filter((point) => point.reconnectedAfterOcclusion).length;
      const reconnectionLabel = reconnectedCount
        ? ` · 跨遮挡自动重连 ${reconnectedCount} 段`
        : "";
      const refinementLabel = refinementMode === "full"
        ? ` · 中心校正 ${centeredCount} 点 / 遮挡恢复 ${fittedCount} 点${patternedGapLabel}`
        : refinementMode === "center"
          ? ` · 中心校正 ${centeredCount} 点`
          : "";
      if (!silent) showToast(`追踪完成：${state.anchors.length}/${state.anchors.length} 个引导点已锁定 · ${styleLabel}${guidanceLabel}${orientationLabel}${topologyReviewLabel}${avoidanceLabel}${corridorLabel}${corridorCorrectionLabel}${reconnectionLabel}${refinementLabel} · ${samplingLabel}生成 ${state.path.length} 个数据点；其中 ${observed} 个直接来自图像`);
    }
    return true;
  } catch (error) {
    if (taskId !== traceTaskSequence) return false;
    state.traceStale = true;
    state.traceError = error.message;
    showToast(`${translateMessage("追踪失败")}：${translateMessage(error.message)}`);
    scheduleDraftSave();
    if (refreshHistory) editSession?.refreshCurrent();
    return false;
  } finally {
    if (taskId === traceTaskSequence) {
      state.computeBusy = null;
      updateUi();
      draw();
    }
  }
}

function updateCursorReadout(point) {
  if (!point) {
    $("#cursor-readout").textContent = "pixel: — · data: —";
    return;
  }
  const pixelText = `pixel: ${Math.round(point.x)}, ${Math.round(point.y)}`;
  if (state.rotationPreviewActive) {
    $("#cursor-readout").textContent = `${pixelText} · data: 校直预览中`;
  } else if (calibrationsValid()) {
    const dataX = pixelToValue(point.x, xCalibration());
    const dataY = pixelToValue(point.y, yCalibration());
    $("#cursor-readout").textContent = `${pixelText} · data: ${formatNumber(dataX, 6)}, ${formatNumber(dataY, 6)}`;
  } else {
    $("#cursor-readout").textContent = `${pixelText} · data: 未标定`;
  }
}

function clearActiveCurve({ keepLabel = false, keepTargetStyle = false } = {}) {
  state.traceStale = false;
  state.traceError = null;
  $("#trace-corridor-mode").value = "strict";
  targetSelectionSequence += 1;
  traceTaskSequence += 1;
  state.computeBusy = null;
  const calibrationToRestore = state.editingSeriesId
    ? state.calibrationBeforeSeriesEdit
    : null;
  state.seed = null;
  state.seedColor = null;
  state.automaticMarkerSeries = false;
  state.automaticMarkerConfidence = 0;
  state.traceOrientation = "horizontal";
  state.anchors = [];
  state.traceCorridorOperations = [];
  state.draftTraceCorridor = null;
  invalidateTraceCorridor();
  if (state.mode === "corridor-pen" || state.mode === "corridor-erase") state.mode = null;
  $("#strict-guide").checked = false;
  if (!keepTargetStyle || $("#target-style").dataset.autoDetected) $("#target-style").value = "auto";
  $("#trace-orientation").value = "auto";
  delete $("#target-style").dataset.autoDetected;
  delete $("#target-style").dataset.autoConfidence;
  delete $("#target-style").dataset.autoFallback;
  $("#trace-assist-tools").open = false;
  state.rawPath = [];
  state.path = [];
  state.reviewRegionIndex = 0;
  state.editingSeriesId = null;
  state.calibrationBeforeSeriesEdit = null;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.selectedPointId = null;
  state.draggedPointId = null;
  state.hoveredAnchorIndex = null;
  state.selectedAnchorIndex = null;
  state.draggedAnchorIndex = null;
  state.anchorDragMoved = false;
  if (!keepLabel) $("#series-label").value = "";
  if (calibrationToRestore) applyCalibrationSnapshot(calibrationToRestore);
  updateUi();
  draw();
}

function resetCurvesForNewPlot() {
  interferenceScanSequence += 1;
  colorDiscoverySequence += 1;
  delete $("#suggest-exclusions").dataset.scanning;
  clearActiveCurve();
  state.series = [];
  state.colorSuggestions = [];
  state.exclusions = [];
  state.exclusionSuggestions = [];
  state.exclusionSuggestionIndex = 0;
  state.draftExclusion = null;
  state.calibrationPoints = emptyCalibrationPoints();
  state.selectedCalibrationKey = null;
  state.draggedCalibrationKey = null;
  state.calibrationDragMoved = false;
  state.calibrationBeforeSeriesEdit = null;
  updateUi();
}

function currentExclusionSuggestion() {
  if (!state.exclusionSuggestions.length) return null;
  state.exclusionSuggestionIndex = clamp(
    state.exclusionSuggestionIndex,
    0,
    state.exclusionSuggestions.length - 1,
  );
  return state.exclusionSuggestions[state.exclusionSuggestionIndex] ?? null;
}

function rectanglesIntersect(left, right) {
  return left.left <= right.right
    && left.right >= right.left
    && left.top <= right.bottom
    && left.bottom >= right.top;
}

function syncExclusionSuggestionUi() {
  const review = $("#exclusion-suggestion-review");
  const suggestion = currentExclusionSuggestion();
  review.hidden = !suggestion;
  const scanButton = $("#suggest-exclusions");
  if (!scanButton.dataset.scanning) {
    scanButton.textContent = suggestion ? "重新扫描图例 / 文字干扰" : "扫描图例 / 文字干扰";
  }
  if (!suggestion) return;
  $("#exclusion-suggestion-count").textContent = `${state.exclusionSuggestionIndex + 1} / ${state.exclusionSuggestions.length}`;
  const type = suggestion.kind === "legend"
    ? "带边框图例"
    : suggestion.kind === "annotation" ? "文字标注" : "图例或文字标注";
  $("#exclusion-suggestion-status").textContent = `${type} · 可信度 ${Math.round(suggestion.confidence * 100)}% · 橙色框仅供复核，接受前不会影响追踪。`;
  $("#previous-exclusion-suggestion").disabled = state.exclusionSuggestions.length <= 1;
  $("#next-exclusion-suggestion").disabled = state.exclusionSuggestions.length <= 1;
}

async function scanInterferenceSuggestions({ automatic = false } = {}) {
  if (!state.imageData || !state.plotRect) return [];
  const scanId = ++interferenceScanSequence;
  const plotRect = { ...state.plotRect };
  const button = $("#suggest-exclusions");
  button.dataset.scanning = "true";
  button.disabled = true;
  button.textContent = "正在扫描干扰区…";
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  const suggestions = suggestInterferenceMasks({
    rgba: state.imageData.data,
    width: canvas.width,
    height: canvas.height,
    plotRect,
    exclusions: state.exclusions,
  });
  if (scanId !== interferenceScanSequence || JSON.stringify(plotRect) !== JSON.stringify(state.plotRect)) return [];
  state.exclusionSuggestions = suggestions;
  state.exclusionSuggestionIndex = 0;
  delete button.dataset.scanning;
  updateUi();
  draw();
  if (!automatic) {
    showToast(suggestions.length
      ? `发现 ${suggestions.length} 个可能的图例或文字干扰区；请逐个复核后接受`
      : "未发现足够可靠的图例或文字干扰区；不会自动添加屏蔽");
  }
  return suggestions;
}

function availableColorSuggestions() {
  return state.colorSuggestions.filter((suggestion) => state.series.every((series) => (
    colorDistance(series.seedColor, suggestion.color) > 24
  )));
}

function syncColorSuggestionUi() {
  const panel = $("#color-suggestions");
  const list = $("#color-suggestion-list");
  const suggestions = state.seedColor ? [] : availableColorSuggestions();
  panel.hidden = suggestions.length === 0;
  list.replaceChildren(...suggestions.map((suggestion, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "color-suggestion-chip";
    button.dataset.colorSuggestion = String(state.colorSuggestions.indexOf(suggestion));
    button.title = `候选 ${index + 1} · 可信度 ${Math.round(suggestion.confidence * 100)}%`;
    button.setAttribute("aria-label", `选择可能的彩色曲线 ${index + 1}`);
    button.setAttribute("role", "listitem");
    const swatch = document.createElement("span");
    swatch.style.background = colorToCss(suggestion.color);
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch);
    return button;
  }));
}

async function scanColorSuggestions() {
  if (!state.imageData || !state.plotRect) return [];
  const scanId = ++colorDiscoverySequence;
  const plotRect = { ...state.plotRect };
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  let suggestions;
  try {
    suggestions = await runBackgroundOperation("discover-colors", {
      plotRect,
      exclusions: state.exclusions,
    });
  } catch (error) {
    // Loading or geometrically correcting another raster invalidates the scan.
    // This is routine cancellation, not an application error.
    if (error?.name === "AbortError" || scanId !== colorDiscoverySequence) return [];
    showToast(`颜色候选分析失败：${error.message}`);
    return [];
  }
  if (
    scanId !== colorDiscoverySequence
    || JSON.stringify(plotRect) !== JSON.stringify(state.plotRect)
  ) return [];
  state.colorSuggestions = suggestions;
  syncColorSuggestionUi();
  return suggestions;
}

function acceptExclusionSuggestions({ all = false } = {}) {
  const accepted = all
    ? state.exclusionSuggestions.splice(0)
    : state.exclusionSuggestions.splice(state.exclusionSuggestionIndex, 1);
  if (!accepted.length) return;
  for (const suggestion of accepted) {
    state.exclusions.push({
      left: suggestion.left,
      top: suggestion.top,
      right: suggestion.right,
      bottom: suggestion.bottom,
      width: suggestion.width,
      height: suggestion.height,
      suggested: true,
      suggestionKind: suggestion.kind,
      suggestionConfidence: suggestion.confidence,
    });
  }
  state.exclusionSuggestionIndex = clamp(
    state.exclusionSuggestionIndex,
    0,
    Math.max(0, state.exclusionSuggestions.length - 1),
  );
  retraceIfReady({ silent: true });
  updateUi();
  draw();
  showToast(`已接受 ${accepted.length} 个干扰区建议${state.path.length ? "，并已自动重新追踪" : ""}`);
  commitHistory(all ? "接受全部干扰屏蔽建议" : "接受干扰屏蔽建议");
  void scanColorSuggestions();
}

function addDataPoint(point) {
  if (state.traceStale || state.rotationPreviewActive || !state.seedColor || !pointInsidePlot(point)) return false;
  const dataPoint = createDataPoint({
    x: point.x,
    y: point.y,
    observed: true,
    confidence: 1,
    candidateCount: 1,
    thickness: 1,
    userEdited: true,
    marker: $("#target-style").value === "markers",
  }, "manual");
  state.rawPath = [];
  if (state.traceOrientation === "parametric" && state.path.length >= 2) {
    const segmentIndex = nearestParametricSegmentIndex(state.path, dataPoint);
    state.path.splice(segmentIndex + 1, 0, dataPoint);
  } else {
    state.path.push(dataPoint);
  }
  sortDataPoints();
  state.selectedPointId = dataPoint.pointId;
  state.hoveredPointId = dataPoint.pointId;
  state.pointHoverSource = "canvas";
  syncPointCountInput();
  updateUi();
  draw();
  showToast(`已新增数据点；当前共 ${state.path.length} 点`);
  commitHistory("新增数据点");
  return true;
}

function nudgeGuideAnchor(index, deltaX, deltaY) {
  const anchor = state.anchors[index];
  if (!anchor || !state.plotRect) return false;
  const next = boundedPlotPoint({ x: anchor.x + deltaX, y: anchor.y + deltaY });
  if (next.x === anchor.x && next.y === anchor.y) return false;
  anchor.x = next.x;
  anchor.y = next.y;
  anchor.occlusionGuide = !targetInkNearGuide(anchor);
  if (anchor.anchorId === state.seed?.anchorId) state.seed = anchor;
  state.selectedCalibrationKey = null;
  state.selectedPointId = null;
  state.selectedAnchorIndex = index;
  state.magnifierPoint = { ...anchor };
  state.cursor = null;
  if (!retraceIfReady({ silent: true })) {
    updateUi();
    draw();
  }
  state.selectedAnchorIndex = index;
  state.magnifierPoint = { ...anchor };
  draw();
  commitHistory(`方向键微调引导点 A${index + 1}`);
  return true;
}

function nudgeDataPoint(pointId, deltaX, deltaY) {
  const point = dataPointById(pointId);
  if (!point || !state.plotRect) return false;
  if (point.anchor) {
    const anchorIndex = state.anchors.findIndex((anchor) => anchor.anchorId === point.anchorId);
    if (anchorIndex >= 0) return nudgeGuideAnchor(anchorIndex, deltaX, deltaY);
  }
  if (state.traceStale) return false;
  const next = boundedPlotPoint({ x: point.x + deltaX, y: point.y + deltaY });
  if (next.x === point.x && next.y === point.y) return false;
  state.rawPath = [];
  point.x = next.x;
  point.y = next.y;
  point.userEdited = true;
  state.selectedCalibrationKey = null;
  state.selectedAnchorIndex = null;
  state.selectedPointId = point.pointId;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.magnifierPoint = { ...point };
  state.cursor = null;
  sortDataPoints();
  updateUi();
  draw();
  window.requestAnimationFrame(() => revealPointInList(point.pointId));
  commitHistory("方向键微调数据点");
  return true;
}

function deleteDataPoint(pointId, { nearby = false } = {}) {
  if (state.computeBusy || state.traceStale) return false;
  const index = state.path.findIndex((point) => point.pointId === pointId);
  if (index < 0) return false;
  if (state.path[index].anchor) {
    showToast("该数据点是引导基准点，已受保护；如需删除，请右键对应引导菱形");
    return false;
  }
  const label = `第 ${index + 1} 点`;
  state.rawPath = [];
  state.path.splice(index, 1);
  if (state.hoveredPointId === pointId) state.hoveredPointId = null;
  if (state.selectedPointId === pointId) state.selectedPointId = null;
  if (state.draggedPointId === pointId) state.draggedPointId = null;
  state.pointHoverSource = null;
  syncPointCountInput();
  updateUi();
  draw();
  showToast(nearby
    ? `已删除鼠标附近最近的${label}；可在同一区域继续右键删除`
    : `已删除${label}；当前剩余 ${state.path.length} 点`);
  commitHistory("删除数据点");
  return true;
}

function clearAllDataPoints() {
  if (state.computeBusy) return;
  if (!state.path.length) return;
  const removedCount = state.path.length;
  state.rawPath = [];
  state.path = [];
  state.reviewRegionIndex = 0;
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.selectedPointId = null;
  state.draggedPointId = null;
  updateUi();
  draw();
  showToast(`已清空当前曲线的 ${removedCount} 个数据点；可重新自动追踪`);
  commitHistory("清空当前曲线数据点");
}

async function selectTraceTarget(point) {
  if (!state.imageData || !state.plotRect || !pointInsidePlot(point)) {
    showToast("曲线种子需要位于已框选的绘图区内");
    return false;
  }
  const sampledColor = sampleRepresentativeColor(
    state.imageData.data,
    canvas.width,
    canvas.height,
    point,
  );
  const inkStrength = Math.hypot(255 - sampledColor.r, 255 - sampledColor.g, 255 - sampledColor.b);
  if (inkStrength < 12) {
    showToast("这里接近纯白背景，没有采到曲线；请放大后重新点击线条中心");
    return false;
  }
  const preliminaryThreshold = estimateColorThreshold(
    state.imageData.data,
    canvas.width,
    canvas.height,
    point,
    sampledColor,
  );
  const snappedPoint = snapTargetPoint({
    rgba: state.imageData.data,
    width: canvas.width,
    height: canvas.height,
    rect: state.plotRect,
    point,
    target: sampledColor,
    threshold: preliminaryThreshold,
    exclusions: state.exclusions,
  });
  // Picking a target begins a fresh, simple trace. Pen and strict-guide
  // constraints are opt-in aids for ambiguities and must never leak from a
  // previous attempt into an ordinary one-click trace.
  state.traceCorridorOperations = [];
  state.draftTraceCorridor = null;
  invalidateTraceCorridor();
  $("#strict-guide").checked = false;
  // A target pick is the ordinary one-click entry point. A forced direction
  // restored from an older draft or previous attempt must not silently turn a
  // simple y(x) curve into a half-length vertical branch. Users can still
  // choose a manual direction after the first automatic result when needed.
  $("#trace-orientation").value = "auto";
  state.traceOrientation = "horizontal";
  $("#trace-assist-tools").open = false;
  state.seed = createGuideAnchor(snappedPoint);
  state.traceStale = false;
  state.traceError = null;
  state.magnifierPoint = { ...snappedPoint };
  state.seedColor = sampledColor;
  state.anchors = [state.seed];
  const selectedAnchorId = state.seed.anchorId;
  const selectionId = ++targetSelectionSequence;
  traceTaskSequence += 1;
  $("#color-threshold").value = String(estimateColorThreshold(
    state.imageData.data,
    canvas.width,
    canvas.height,
    snappedPoint,
    sampledColor,
  ));
  syncRangeOutputs();
  state.rawPath = [];
  state.path = [];
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  state.selectedPointId = null;
  state.draggedPointId = null;
  state.hoveredAnchorIndex = null;
  state.selectedAnchorIndex = 0;
  state.draggedAnchorIndex = null;
  setMode(null);
  try {
    if ($("#target-style").value === "auto") {
      state.computeBusy = "classify";
      updateUi();
      draw();
      const { markerInference, lineInference } = await runBackgroundOperation("classify-target", {
        rect: state.plotRect,
        seed: snappedPoint,
        target: sampledColor,
        threshold: Number($("#color-threshold").value),
        exclusions: state.exclusions,
      });
      if (selectionId !== targetSelectionSequence || state.seed?.anchorId !== selectedAnchorId) return false;
      const inferredStyle = markerInference.detected ? {
        style: "markers",
        confidence: markerInference.confidence,
      } : lineInference;
      $("#target-style").value = inferredStyle.style;
      state.automaticMarkerSeries = markerInference.detected;
      state.automaticMarkerConfidence = markerInference.detected ? markerInference.confidence : 0;
      $("#target-style").dataset.autoDetected = inferredStyle.style;
      $("#target-style").dataset.autoConfidence = String(inferredStyle.confidence);
      delete $("#target-style").dataset.autoFallback;
    } else {
      state.automaticMarkerSeries = false;
      state.automaticMarkerConfidence = 0;
      delete $("#target-style").dataset.autoDetected;
      delete $("#target-style").dataset.autoConfidence;
      delete $("#target-style").dataset.autoFallback;
    }
    state.computeBusy = null;
    updateUi();
    draw();
    if ($("#target-style").value === "markers" && !automaticMarkerSeriesActive()) {
      showToast("marker 颜色已采样；请在点列弯曲处和另一端各添加 1 个引导点");
    } else {
      const traced = await traceCurrentCurve({ refreshHistory: false });
      if (!traced) return false;
    }
    if (selectionId !== targetSelectionSequence || state.seed?.anchorId !== selectedAnchorId) return false;
    commitHistory("选择目标并智能追踪");
    return true;
  } catch (error) {
    if (selectionId !== targetSelectionSequence) return false;
    state.computeBusy = null;
    updateUi();
    draw();
    showToast(`目标识别失败：${error.message}`);
    return false;
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.computeBusy) return;
  if (!state.image) return;
  const point = imageCoordinates(event);
  state.cursor = point;
  state.magnifierPoint = point;
  if (state.rotationPreviewActive && !state.mode?.startsWith("align-")) {
    draw();
    return;
  }

  if (event.button === 0 && !state.mode) {
    const calibrationHit = calibrationPointAt(point);
    if (calibrationHit !== null) {
      state.selectedCalibrationKey = calibrationHit;
      state.selectedPointId = null;
      state.selectedAnchorIndex = null;
      state.draggedCalibrationKey = calibrationHit;
      state.calibrationDragMoved = false;
      state.magnifierPoint = { ...state.calibrationPoints[calibrationHit] };
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      updateUi();
      draw();
      return;
    }
    const guideHit = guideAnchorAt(point);
    if (guideHit !== null) {
      state.draggedAnchorIndex = guideHit;
      state.selectedAnchorIndex = guideHit;
      state.hoveredAnchorIndex = guideHit;
      state.anchorDragMoved = false;
      state.hoveredPointId = null;
      state.pointHoverSource = null;
      state.selectedPointId = null;
      state.selectedCalibrationKey = null;
      syncPointCursor();
      syncPointListSelection();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      draw();
      return;
    }
    const hit = dataPointAt(point);
    if (hit !== null) {
      state.draggedPointId = hit;
      state.selectedPointId = hit;
      state.hoveredPointId = hit;
      state.pointHoverSource = "canvas";
      state.pointDragMoved = false;
      state.selectedCalibrationKey = null;
      state.selectedAnchorIndex = null;
      syncPointCursor();
      syncPointListSelection();
      revealPointInList(hit);
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
      draw();
      return;
    }
  }

  if (!state.mode) return;
  if (event.button === 0 && (state.mode === "corridor-pen" || state.mode === "corridor-erase")) {
    if (!pointInsidePlot(point)) {
      showToast("Pen 走廊需要从已框选的绘图区内开始");
      return;
    }
    const operation = {
      mode: state.mode === "corridor-erase" ? "erase" : "paint",
      width: traceCorridorWidth(),
      points: [boundedPlotPoint(point)],
    };
    state.draftTraceCorridor = operation;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    draw();
    return;
  }
  if (state.mode === "plot" || state.mode === "exclude") {
    state.dragStart = point;
    const draft = normalizeRect(point, point, { width: canvas.width, height: canvas.height });
    if (state.mode === "plot") state.draftRect = draft;
    else state.draftExclusion = draft;
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!state.image) return;
  const point = imageCoordinates(event);
  state.cursor = point;
  state.magnifierPoint = point;
  updateCursorReadout(point);
  if (state.rotationPreviewActive && !state.mode?.startsWith("align-")) {
    scheduleInteractiveDraw();
    return;
  }
  if (state.draggedCalibrationKey !== null) {
    const key = state.draggedCalibrationKey;
    const coordinate = calibrationCoordinate(key);
    const calibrationPoint = state.calibrationPoints[key];
    if (calibrationPoint) {
      state.calibrationDragMoved ||= Math.abs(calibrationPoint[coordinate] - point[coordinate]) > 0.01;
      calibrationPoint[coordinate] = point[coordinate];
      if (state.calibrationDragMoved) markCalibrationPointManuallyAdjusted(calibrationPoint);
      state.magnifierPoint = { ...calibrationPoint };
    }
    updateUi();
    scheduleInteractiveDraw();
    return;
  }
  if (state.draggedAnchorIndex !== null) {
    const bounded = pointInsidePlot(point)
      ? point
      : {
        x: clamp(point.x, state.plotRect.left, state.plotRect.right),
        y: clamp(point.y, state.plotRect.top, state.plotRect.bottom),
      };
    const anchor = state.anchors[state.draggedAnchorIndex];
    if (anchor) {
      state.anchorDragMoved ||= Math.hypot(anchor.x - bounded.x, anchor.y - bounded.y) > 0.05;
      anchor.x = bounded.x;
      anchor.y = bounded.y;
      if (anchor.anchorId === state.seed?.anchorId) state.seed = anchor;
    }
    syncPointCursor();
    scheduleInteractiveDraw();
    return;
  }
  if (state.draggedPointId !== null) {
    const bounded = pointInsidePlot(point)
      ? point
      : {
        x: clamp(point.x, state.plotRect.left, state.plotRect.right),
        y: clamp(point.y, state.plotRect.top, state.plotRect.bottom),
      };
    const current = dataPointById(state.draggedPointId);
    if (current) {
      state.pointDragMoved ||= Math.hypot(current.x - bounded.x, current.y - bounded.y) > 0.05;
      if (state.pointDragMoved) state.rawPath = [];
      current.x = bounded.x;
      current.y = bounded.y;
      current.userEdited = true;
      updatePointListRow(current);
    }
    syncPointCursor();
    scheduleInteractiveDraw();
    return;
  }
  if (state.draftTraceCorridor) {
    appendTraceCorridorPoint(point);
    scheduleInteractiveDraw();
    return;
  }
  const hoveredAnchor = state.mode ? null : guideAnchorAt(point);
  const hoveredPoint = state.mode || hoveredAnchor !== null ? null : dataPointAt(point);
  if (
    hoveredAnchor !== state.hoveredAnchorIndex
    || hoveredPoint !== state.hoveredPointId
    || (hoveredPoint !== null && state.pointHoverSource !== "canvas")
  ) {
    state.hoveredAnchorIndex = hoveredAnchor;
    state.hoveredPointId = hoveredPoint;
    state.pointHoverSource = hoveredPoint === null ? null : "canvas";
    syncPointListSelection();
    syncPointCursor();
  }
  if ((state.mode === "plot" || state.mode === "exclude") && state.dragStart) {
    const draft = normalizeRect(state.dragStart, point, { width: canvas.width, height: canvas.height });
    if (state.mode === "plot") state.draftRect = draft;
    else state.draftExclusion = draft;
  }
  scheduleInteractiveDraw();
});

canvas.addEventListener("pointerleave", () => {
  state.cursor = null;
  if (state.draggedAnchorIndex === null) state.hoveredAnchorIndex = null;
  if (state.draggedPointId === null && state.pointHoverSource === "canvas") {
    state.hoveredPointId = null;
    state.pointHoverSource = null;
  }
  updateCursorReadout(null);
  syncPointListSelection();
  syncPointCursor();
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (state.computeBusy) return;
  if (!state.image) return;
  const point = imageCoordinates(event);
  state.cursor = point;
  state.magnifierPoint = point;
  updateCursorReadout(point);

  if (state.rotationPreviewActive) {
    if (event.button === 0 && (state.mode === "align-horizontal" || state.mode === "align-vertical")) {
      finishRotationAlignment(point);
    }
    return;
  }

  if (state.draggedCalibrationKey !== null) {
    const key = state.draggedCalibrationKey;
    const moved = state.calibrationDragMoved;
    state.draggedCalibrationKey = null;
    state.calibrationDragMoved = false;
    state.selectedCalibrationKey = key;
    state.magnifierPoint = { ...state.calibrationPoints[key] };
    state.cursor = null;
    updateUi();
    draw();
    if (moved) {
      showToast(`标定点 ${calibrationPointLabel(key)} 已移动；请查看标定质量`);
      commitHistory(`拖动标定点 ${calibrationPointLabel(key)}`);
    }
    return;
  }

  if (state.draggedAnchorIndex !== null) {
    const moved = state.anchorDragMoved;
    const movedIndex = state.draggedAnchorIndex;
    const movedAnchor = state.anchors[movedIndex];
    if (moved && movedAnchor) movedAnchor.occlusionGuide = !targetInkNearGuide(movedAnchor);
    state.draggedAnchorIndex = null;
    state.anchorDragMoved = false;
    state.selectedAnchorIndex = movedIndex;
    state.hoveredAnchorIndex = guideAnchorAt(point) ?? movedIndex;
    syncPointCursor();
    if (moved && retraceIfReady()) {
      state.selectedAnchorIndex = movedIndex;
      state.hoveredAnchorIndex = movedIndex;
      draw();
      const occlusionText = movedAnchor?.occlusionGuide ? "；遮挡区已自动局部强约束" : "";
      showToast(`引导点 A${movedIndex + 1} 已移动；已作为基准重新追踪${occlusionText}`);
    } else {
      updateUi();
      draw();
      if (moved) showToast(`引导点 A${movedIndex + 1} 已移动；自动追踪将以新位置为基准`);
    }
    if (moved) commitHistory("移动引导点并重新追踪");
    return;
  }

  if (state.draggedPointId !== null) {
    const moved = state.pointDragMoved;
    const draggedPointId = state.draggedPointId;
    state.draggedPointId = null;
    state.pointDragMoved = false;
    sortDataPoints();
    state.hoveredPointId = dataPointAt(point) ?? draggedPointId;
    state.pointHoverSource = "canvas";
    syncPointCursor();
    updateUi();
    draw();
    if (moved) {
      showToast("数据点已移动；人工修正已保留，不会重新自动追踪");
      commitHistory("移动数据点");
    }
    return;
  }

  if (state.draftTraceCorridor) {
    const operation = state.draftTraceCorridor;
    const operationMode = operation.mode;
    appendTraceCorridorPoint(point);
    state.draftTraceCorridor = null;
    state.traceCorridorOperations.push(operation);
    invalidateTraceCorridor();
    const corridorMask = traceCorridorMask();
    if (!corridorMask && operationMode === "erase") {
      state.traceCorridorOperations = [];
      invalidateTraceCorridor();
    }
    if (!retraceIfReady({ silent: true })) {
      updateUi();
      draw();
    }
    const columns = traceCorridorColumnCount();
    showToast(operationMode === "erase"
      ? (columns ? `已擦除部分 Pen 走廊；当前约束 ${columns} 列` : "Pen 走廊已完全擦除；恢复全绘图区搜索")
      : `Pen 走廊已更新；当前约束 ${columns} 列${state.path.length ? "，已自动重新追踪" : ""}`);
    commitHistory(operationMode === "erase" ? "擦除 Pen 曲线走廊" : "绘制 Pen 曲线走廊");
    return;
  }

  if (event.button !== 0) return;
  if (!state.mode) {
    addDataPoint(point);
    return;
  }

  if (state.mode === "plot" && state.dragStart) {
    const rect = normalizeRect(state.dragStart, point, { width: canvas.width, height: canvas.height });
    state.dragStart = null;
    state.draftRect = null;
    if (rect.width < 20 || rect.height < 20) {
      showToast("绘图区太小，请从一个角拖到对角重新框选");
    } else {
      state.plotSuggestions = [];
      state.plotSuggestionIndex = -1;
      state.plotRect = rect;
      resetCurvesForNewPlot();
      setMode(null);
      showToast("绘图区已设置；下一步点击坐标刻度进行标定");
      commitHistory("手动设置绘图区");
      void scanInterferenceSuggestions({ automatic: true });
      void scanColorSuggestions();
    }
  } else if (state.mode === "exclude" && state.dragStart) {
    const exclusion = normalizeRect(state.dragStart, point, { width: canvas.width, height: canvas.height });
    state.dragStart = null;
    state.draftExclusion = null;
    if (exclusion.width < 4 || exclusion.height < 4) {
      showToast("屏蔽区太小，请拖拽框住完整的遮挡、图例或文字");
    } else {
      state.exclusions.push(exclusion);
      state.exclusionSuggestions = state.exclusionSuggestions.filter(
        (suggestion) => !rectanglesIntersect(suggestion, exclusion),
      );
      state.exclusionSuggestionIndex = clamp(
        state.exclusionSuggestionIndex,
        0,
        Math.max(0, state.exclusionSuggestions.length - 1),
      );
      setMode(null);
      retraceIfReady();
      showToast(`已添加遮挡/干扰屏蔽区 ${state.exclusions.length}；框内像素不参与追踪，程序会在远端自动重连；若仍有歧义再添加引导点`);
      commitHistory("添加屏蔽区");
      void scanColorSuggestions();
    }
  } else if (Object.keys(pickButtonByMode).includes(state.mode)) {
    const key = state.mode;
    const axis = calibrationCoordinate(key);
    const snapResult = $("#calibration-snap")?.checked
      ? snapCalibrationPoint({
        rgba: state.imageData?.data,
        width: canvas.width,
        height: canvas.height,
        point,
        axis,
      })
      : { point: { ...point }, snapped: false, confidence: 0, shift: 0, uncertaintyPx: 0.5 };
    state.calibrationPoints[key] = {
      ...snapResult.point,
      snapped: snapResult.snapped,
      snapConfidence: snapResult.confidence,
      snapShift: snapResult.shift,
      uncertaintyPx: snapResult.uncertaintyPx,
    };
    state.selectedCalibrationKey = key;
    state.selectedPointId = null;
    state.selectedAnchorIndex = null;
    state.magnifierPoint = { ...state.calibrationPoints[key] };
    setMode(null);
    updateUi();
    draw();
    showToast(snapResult.snapped
      ? `${calibrationPointLabel(key)} 已吸附到附近刻度中心（移动 ${formatNumber(Math.abs(snapResult.shift), 3)} px）`
      : `${calibrationPointLabel(key)} 已按点击位置设置${$("#calibration-snap")?.checked ? "；附近刻度证据不足，未自动移动" : ""}`);
    commitHistory(`设置${key.startsWith("x") ? "X" : "Y"}轴刻度点`);
  } else if (state.mode === "seed") {
    selectTraceTarget(point);
  } else if (state.mode === "guide") {
    if (!pointInsidePlot(point)) {
      showToast("引导点需要位于已框选的绘图区内");
      return;
    }
    const duplicate = isDuplicateGuidePoint(state.anchors, point);
    if (duplicate) {
      showToast("这里已经有引导点；请沿二维路径换一个位置");
      return;
    }
    state.anchors.push(createGuideAnchor({
      ...point,
      occlusionGuide: !targetInkNearGuide(point),
    }));
    state.selectedAnchorIndex = state.anchors.length - 1;
    setMode(null);
    if (!retraceIfReady()) showToast("marker 颜色已采样；请在点列弯曲处和另一端各添加 1 个引导点");
    commitHistory("添加引导点并重新追踪");
  }
  updateUi();
  draw();
});

canvas.addEventListener("pointercancel", () => {
  if (!state.draftTraceCorridor) return;
  state.draftTraceCorridor = null;
  updateUi();
  draw();
});

canvas.addEventListener("contextmenu", (event) => {
  if (state.computeBusy) { event.preventDefault(); return; }
  if (!state.image || state.rotationPreviewActive) return;
  const point = imageCoordinates(event);
  if (calibrationPointAt(point) !== null) {
    event.preventDefault();
    showToast("标定十字不会被右键删除；请左键拖动或使用微调控件");
    return;
  }
  const guideHit = guideAnchorAt(point);
  if (guideHit !== null) {
    event.preventDefault();
    deleteGuideAnchor(guideHit);
    return;
  }
  const nearest = nearestDeletableDataPoint(point);
  if (nearest === null) return;
  event.preventDefault();
  deleteDataPoint(nearest.pointId, { nearby: true });
});

canvas.addEventListener("pointercancel", () => {
  if (state.dragStart) {
    state.dragStart = null;
    state.draftRect = null;
    state.draftExclusion = null;
    draw();
    return;
  }
  if (state.draggedCalibrationKey !== null) {
    state.draggedCalibrationKey = null;
    state.calibrationDragMoved = false;
    updateUi();
    draw();
    return;
  }
  if (state.draggedAnchorIndex !== null) {
    state.draggedAnchorIndex = null;
    state.anchorDragMoved = false;
    state.hoveredAnchorIndex = null;
    syncPointCursor();
    updateUi();
    draw();
    return;
  }
  if (state.draggedPointId === null) return;
  state.draggedPointId = null;
  state.pointDragMoved = false;
  sortDataPoints();
  state.hoveredPointId = null;
  state.pointHoverSource = null;
  syncPointCursor();
  updateUi();
  draw();
});

$("#point-list").addEventListener("mouseover", (event) => {
  const row = event.target.closest(".data-point-row");
  if (!row) return;
  state.hoveredPointId = row.dataset.pointId;
  state.pointHoverSource = "table";
  const point = dataPointById(row.dataset.pointId);
  state.hoveredAnchorIndex = point?.anchor
    ? state.anchors.findIndex((anchor) => anchor.anchorId === point.anchorId)
    : null;
  if (state.hoveredAnchorIndex < 0) state.hoveredAnchorIndex = null;
  syncPointListSelection();
  syncPointCursor();
  draw();
});

$("#point-list").addEventListener("mouseout", (event) => {
  const row = event.target.closest(".data-point-row");
  if (!row || row.contains(event.relatedTarget)) return;
  if (state.pointHoverSource === "table" && state.hoveredPointId === row.dataset.pointId) {
    state.hoveredPointId = null;
    state.pointHoverSource = null;
    state.hoveredAnchorIndex = null;
    syncPointListSelection();
    syncPointCursor();
    draw();
  }
});

$("#point-list").addEventListener("focusin", (event) => {
  const row = event.target.closest(".data-point-row");
  if (!row) return;
  state.selectedPointId = row.dataset.pointId;
  state.selectedCalibrationKey = null;
  state.selectedAnchorIndex = null;
  const point = dataPointById(row.dataset.pointId);
  if (point?.anchor) {
    const anchorIndex = state.anchors.findIndex((anchor) => anchor.anchorId === point.anchorId);
    if (anchorIndex >= 0) state.selectedAnchorIndex = anchorIndex;
  }
  syncPointListSelection();
  draw();
});

$("#point-list").addEventListener("click", (event) => {
  const row = event.target.closest(".data-point-row");
  if (!row) return;
  if (event.target.closest('[data-action="delete-point"]')) {
    deleteDataPoint(row.dataset.pointId);
    return;
  }
  state.selectedPointId = row.dataset.pointId;
  state.selectedCalibrationKey = null;
  state.selectedAnchorIndex = null;
  const point = dataPointById(row.dataset.pointId);
  if (point?.anchor) {
    const anchorIndex = state.anchors.findIndex((anchor) => anchor.anchorId === point.anchorId);
    if (anchorIndex >= 0) state.selectedAnchorIndex = anchorIndex;
  }
  syncPointListSelection();
  draw();
});

$("#point-list").addEventListener("change", (event) => {
  if (state.computeBusy || state.traceStale) {
    renderPointList();
    return;
  }
  const input = event.target.closest(".point-coordinate-input");
  const row = event.target.closest(".data-point-row");
  if (!input || !row) return;
  const point = dataPointById(row.dataset.pointId);
  const value = Number(input.value);
  if (!point || !Number.isFinite(value)) {
    renderPointList();
    showToast("坐标必须是有效数字");
    return;
  }
  const coordinate = input.dataset.coordinate;
  const originalPosition = { x: point.x, y: point.y };
  const calibrated = calibrationsValid();
  const pixel = calibrated
    ? valueToPixel(value, coordinate === "x" ? xCalibration() : yCalibration())
    : value;
  if (!Number.isFinite(pixel)) {
    renderPointList();
    showToast("该坐标无法映射到当前坐标轴；请检查对数轴数值");
    return;
  }
  const minimum = coordinate === "x" ? state.plotRect.left : state.plotRect.top;
  const maximum = coordinate === "x" ? state.plotRect.right : state.plotRect.bottom;
  point[coordinate] = clamp(pixel, minimum, maximum);
  point.userEdited = true;
  if (point.anchor) {
    let anchorIndex = state.anchors.findIndex((anchor) => anchor.anchorId === point.anchorId);
    if (anchorIndex < 0) {
      anchorIndex = state.anchors.findIndex((anchor) => (
        Math.hypot(anchor.x - originalPosition.x, anchor.y - originalPosition.y) < 1
      ));
    }
    if (anchorIndex >= 0) {
      state.anchors[anchorIndex][coordinate] = point[coordinate];
      state.anchors[anchorIndex].occlusionGuide = !targetInkNearGuide(state.anchors[anchorIndex]);
      if (state.anchors[anchorIndex].anchorId === state.seed?.anchorId) state.seed = state.anchors[anchorIndex];
      state.selectedAnchorIndex = anchorIndex;
      traceCurrentCurve();
      const occlusionText = state.anchors[anchorIndex].occlusionGuide ? "；遮挡区已自动局部强约束" : "";
      showToast(`引导点 A${anchorIndex + 1} 已更新；已作为基准重新追踪${occlusionText}`);
      commitHistory("修改引导点坐标并重新追踪");
      return;
    }
  }
  state.rawPath = [];
  state.selectedPointId = point.pointId;
  sortDataPoints();
  updateUi();
  draw();
  showToast("坐标已更新；对应数据点已移动");
  commitHistory("修改数据点坐标");
});

$("#clear-all-points").addEventListener("click", clearAllDataPoints);
$("#review-resolve").addEventListener("click", beginReviewResolution);
$("#review-next").addEventListener("click", () => focusReviewRegion(1));

$("#select-plot").addEventListener("click", () => setMode("plot"));
$("#add-exclusion").addEventListener("click", () => setMode("exclude"));
$("#exclude-trace").addEventListener("click", () => setMode("exclude"));
$("#suggest-exclusions").addEventListener("click", () => scanInterferenceSuggestions());
$("#previous-exclusion-suggestion").addEventListener("click", () => {
  if (state.exclusionSuggestions.length <= 1) return;
  state.exclusionSuggestionIndex = (
    state.exclusionSuggestionIndex - 1 + state.exclusionSuggestions.length
  ) % state.exclusionSuggestions.length;
  updateUi();
  draw();
});
$("#next-exclusion-suggestion").addEventListener("click", () => {
  if (state.exclusionSuggestions.length <= 1) return;
  state.exclusionSuggestionIndex = (state.exclusionSuggestionIndex + 1) % state.exclusionSuggestions.length;
  updateUi();
  draw();
});
$("#accept-exclusion-suggestion").addEventListener("click", () => acceptExclusionSuggestions());
$("#accept-all-exclusion-suggestions").addEventListener("click", () => acceptExclusionSuggestions({ all: true }));
$("#dismiss-exclusion-suggestions").addEventListener("click", () => {
  state.exclusionSuggestions = [];
  state.exclusionSuggestionIndex = 0;
  updateUi();
  draw();
  showToast("已忽略本次干扰区建议；没有添加任何屏蔽");
});
$("#draw-trace-corridor").addEventListener("click", () => setMode("corridor-pen"));
$("#erase-trace-corridor").addEventListener("click", () => setMode("corridor-erase"));
$("#clear-trace-corridor").addEventListener("click", () => {
  if (!traceCorridorMask()) return;
  state.traceCorridorOperations = [];
  state.draftTraceCorridor = null;
  invalidateTraceCorridor();
  if (state.mode === "corridor-erase") setMode(null);
  retraceIfReady({ silent: true });
  updateUi();
  draw();
  showToast(`Pen 走廊已清除；恢复全绘图区搜索${state.path.length ? "，并已自动重新追踪" : ""}`);
  commitHistory("清除 Pen 曲线走廊");
});
$("#undo-exclusion").addEventListener("click", () => {
  if (!state.exclusions.length) return;
  state.exclusions.pop();
  retraceIfReady();
  updateUi();
  draw();
  showToast("已撤销最后一个屏蔽区");
  commitHistory("移除最后一个屏蔽区");
  void scanColorSuggestions();
});

function maybeApplyAutomaticPerspective(suggestions, suppliedDiagnosis = null) {
  const suggestion = suggestions?.[0];
  if (!suggestion || state.perspectiveCommitted || !state.imageData) return suggestions;
  const diagnosis = suppliedDiagnosis ?? detectFrameQuadrilateral({
    rgba: state.imageData.data,
    width: state.imageData.width,
    height: state.imageData.height,
    rect: suggestion,
  });
  if (!state.preprocessingDiagnostics) state.preprocessingDiagnostics = {};
  state.preprocessingDiagnostics.perspective = diagnosis;
  if (
    !diagnosis
    || diagnosis.confidence < (suppliedDiagnosis ? 0.62 : 0.88)
    || diagnosis.perspectivePixels < 3
    || diagnosis.severity < 0.008
  ) {
    updateGeometryDiagnosis();
    return suggestions;
  }
  const { topLeft, topRight, bottomRight, bottomLeft } = diagnosis.corners;
  const targetLeft = (topLeft.x + bottomLeft.x) / 2;
  const targetRight = (topRight.x + bottomRight.x) / 2;
  const targetTop = (topLeft.y + topRight.y) / 2;
  const targetBottom = (bottomLeft.y + bottomRight.y) / 2;
  const sourceCorners = [topLeft, topRight, bottomRight, bottomLeft].map((point) => ({ ...point }));
  const destinationCorners = [
    { x: targetLeft, y: targetTop },
    { x: targetRight, y: targetTop },
    { x: targetRight, y: targetBottom },
    { x: targetLeft, y: targetBottom },
  ];
  try {
    const warped = warpPerspectiveRgba({
      rgba: state.imageData.data,
      width: state.imageData.width,
      height: state.imageData.height,
      sourceCorners,
      destinationCorners,
    });
    state.image = canvasFromRgba(warped.rgba, warped.width, warped.height);
    state.perspectiveCommitted = {
      applied: true,
      sourceCorners,
      destinationCorners,
      confidence: diagnosis.confidence,
      severity: diagnosis.severity,
      interpolation: "bilinear",
    };
    state.source.perspectiveCorrected = true;
    state.source.workingWidth = state.image.width;
    state.source.workingHeight = state.image.height;
    updateWorkingCanvas(state.image);
    updateGeometryDiagnosis();
    showToast("检测到可靠的梯形畸变，已自动执行透视矫正");
    return detectPlotRects(state.imageData.data, canvas.width, canvas.height);
  } catch (error) {
    state.preprocessingDiagnostics.perspectiveError = error.message;
    updateGeometryDiagnosis();
    return suggestions;
  }
}

function suggestPlotRect({ automatic = false } = {}) {
  if (!state.imageData) return;
  const detectionId = ++plotDetectionSequence;
  const imageId = imageLoadSequence;
  if (state.plotSuggestions.length) {
    state.plotSuggestionIndex = (state.plotSuggestionIndex + 1) % state.plotSuggestions.length;
    state.plotRect = state.plotSuggestions[state.plotSuggestionIndex];
    resetCurvesForNewPlot();
    setMode(null);
    showToast(`已切换到图框建议 ${state.plotSuggestionIndex + 1}/${state.plotSuggestions.length}`);
    commitHistory("切换绘图区建议");
    void scanInterferenceSuggestions({ automatic: true });
    void scanColorSuggestions();
    return;
  }
  $("#mode-hint").textContent = automatic ? "正在自动识别绘图区…" : "正在分析候选图框…";
  window.requestAnimationFrame(() => {
    if (detectionId !== plotDetectionSequence || imageId !== imageLoadSequence) return;
    let suggestions = detectPlotRects(state.imageData.data, canvas.width, canvas.height);
    if (!suggestions.length) {
      const perspectiveFrame = detectPerspectiveFrame({
        rgba: state.imageData.data,
        width: state.imageData.width,
        height: state.imageData.height,
      });
      if (perspectiveFrame?.confidence >= 0.62) {
        suggestions = [{ ...perspectiveFrame.rect, confidence: perspectiveFrame.confidence, score: perspectiveFrame.score }];
        suggestions = maybeApplyAutomaticPerspective(suggestions, perspectiveFrame);
      }
    } else {
      suggestions = maybeApplyAutomaticPerspective(suggestions);
    }
    const suggestion = suggestions[0];
    if (!suggestion || suggestion.width < 20 || suggestion.height < 20) {
      showToast("没有找到可靠的矩形图框，请手动框选");
      $("#mode-hint").textContent = "自动建议失败；请手动框选单个 panel";
      setMode("plot");
      return;
    }
    state.plotSuggestions = suggestions;
    state.plotSuggestionIndex = 0;
    state.plotRect = suggestion;
    resetCurvesForNewPlot();
    setMode(null);
    $("#mode-hint").textContent = suggestions.length > 1
      ? `已自动选择图框 1/${suggestions.length}；如不正确可切换建议`
      : "已自动识别绘图区；下一步标定坐标或选择曲线";
    showToast(automatic
      ? `已自动选择最可信绘图区；共发现 ${suggestions.length} 个候选`
      : `找到 ${suggestions.length} 个候选图框；可点“下一个建议”切换，或手动框选`);
    // Initial frame detection is a fresh baseline, not an edit/autosave.
    if (automatic) resetHistorySession();
    else commitHistory("自动选择绘图区");
    void scanInterferenceSuggestions({ automatic: true });
    void scanColorSuggestions();
  });
}

$("#auto-plot").addEventListener("click", () => suggestPlotRect());
$("#pick-seed").addEventListener("click", () => setMode("seed"));
$("#color-suggestion-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-color-suggestion]");
  if (!button || state.seedColor) return;
  const suggestion = state.colorSuggestions[Number(button.dataset.colorSuggestion)];
  if (!suggestion) return;
  selectTraceTarget(suggestion.seed);
});
$("#add-guide").addEventListener("click", () => setMode("guide"));
$("#undo-guide").addEventListener("click", () => {
  if (state.anchors.length <= 1) return;
  deleteGuideAnchor(state.anchors.length - 1);
});
for (const [mode, button] of Object.entries(pickButtonByMode)) {
  button.addEventListener("click", () => {
    state.selectedCalibrationKey = mode;
    const point = state.calibrationPoints[mode];
    if (point) {
      state.magnifierPoint = { ...point };
      state.cursor = null;
    }
    setMode(mode);
    updateUi();
    draw();
  });
}

for (const axis of ["x", "y"]) {
  $(`#add-${axis}-reference`).addEventListener("click", () => {
    const count = setCalibrationReferenceCount(axis, activeCalibrationReferenceCount(axis) + 1, { clearRemoved: false });
    updateUi();
    setMode(`${axis}${count}`);
    showToast(`已增加 ${axis.toUpperCase()} 轴参考点 ${count}；请输入刻度值并点击对应刻度`);
    commitHistory(`增加 ${axis.toUpperCase()} 轴标定参考点`);
  });
  $(`#remove-${axis}-reference`).addEventListener("click", () => {
    const previous = activeCalibrationReferenceCount(axis);
    const count = setCalibrationReferenceCount(axis, previous - 1);
    if (count === previous) return;
    setMode(null);
    updateUi();
    draw();
    showToast(`已移除 ${axis.toUpperCase()} 轴末个参考点；保留 ${count} 个`);
    commitHistory(`移除 ${axis.toUpperCase()} 轴标定参考点`);
  });
  $(`#${axis}-scale`).addEventListener("change", () => {
    if ($(`#${axis}-scale`).value === "piecewise") {
      setCalibrationReferenceCount(axis, Math.max(3, activeCalibrationReferenceCount(axis)), { clearRemoved: false });
    }
    updateUi();
  });
}

for (const button of document.querySelectorAll("[data-calibration-nudge]")) {
  button.addEventListener("click", () => {
    if (!state.selectedCalibrationKey) return;
    nudgeCalibrationPoint(state.selectedCalibrationKey, Number(button.dataset.calibrationNudge));
  });
}

$("#calibration-pixel-position").addEventListener("input", (event) => {
  if (!state.selectedCalibrationKey || event.target.value.trim() === "") return;
  setCalibrationPixel(state.selectedCalibrationKey, Number(event.target.value));
});
$("#calibration-pixel-position").addEventListener("change", (event) => {
  const key = state.selectedCalibrationKey;
  const point = key ? state.calibrationPoints[key] : null;
  if (!point) return;
  const coordinate = calibrationCoordinate(key);
  const accepted = event.target.value.trim() !== ""
    && setCalibrationPixel(key, Number(event.target.value));
  event.target.value = formatNumber(point[coordinate], 8);
  if (!accepted) {
    showToast("请输入有效的像素位置");
    return;
  }
  commitHistory(`输入标定点 ${calibrationPointLabel(key)} 像素位置`);
});

$("#sample-select").addEventListener("change", (event) => {
  const path = event.target.value;
  if (path !== builtInSamplePath) {
    event.target.value = builtInSamplePath;
    showToast("仅允许载入应用内置的示例图片");
    return;
  }
  loadImageSource(path, path.split("/").at(-1), path);
});

$("#image-upload").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  importRasterImageFile(file);
});

let imageDragDepth = 0;

function transferContainsFiles(transfer) {
  return Array.from(transfer?.types ?? []).includes("Files") || Boolean(transfer?.files?.length);
}

function setImageDropOverlayVisible(visible) {
  const overlay = $("#image-drop-overlay");
  if (overlay) overlay.hidden = !visible;
}

document.addEventListener("dragenter", (event) => {
  if (!transferContainsFiles(event.dataTransfer)) return;
  event.preventDefault();
  imageDragDepth += 1;
  setImageDropOverlayVisible(true);
});

document.addEventListener("dragover", (event) => {
  if (!transferContainsFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  setImageDropOverlayVisible(true);
});

document.addEventListener("dragleave", (event) => {
  if (!transferContainsFiles(event.dataTransfer)) return;
  imageDragDepth = Math.max(0, imageDragDepth - 1);
  if (!imageDragDepth) setImageDropOverlayVisible(false);
});

document.addEventListener("drop", (event) => {
  if (!transferContainsFiles(event.dataTransfer)) return;
  event.preventDefault();
  imageDragDepth = 0;
  setImageDropOverlayVisible(false);
  importTransferredRasterImages(event.dataTransfer.files);
});

document.addEventListener("paste", (event) => {
  const itemFiles = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData?.files ?? []);
  const includesImage = files.some((file) => (
    String(file.type ?? "").toLowerCase().startsWith("image/")
    || validateRasterImageFile(file).valid
  ));
  if (!includesImage) return;
  event.preventDefault();
  importTransferredRasterImages(files, { pasted: true });
});

window.addEventListener("blur", () => {
  imageDragDepth = 0;
  setImageDropOverlayVisible(false);
});

$("#project-upload").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    validateProjectPayload(project);
    if (project.source.samplePath === builtInSamplePath) {
      $("#sample-select").value = builtInSamplePath;
      loadImageSource(builtInSamplePath, project.source.name, builtInSamplePath, project);
    } else if (state.image && state.source.name === project.source?.name) {
      if ((project.source?.width && project.source.width !== state.source.width) || (project.source?.height && project.source.height !== state.source.height)) {
        throw new Error("项目对应的原图尺寸不同，请重新导入匹配的原图");
      }
      if (project.source?.imageFingerprint && project.source.imageFingerprint !== state.source.imageFingerprint) {
        throw new Error("项目对应的原图内容不同；文件名和尺寸相同但像素指纹不匹配");
      }
      applyProject(project);
      resetHistorySession();
      scheduleDraftSave();
    } else {
      throw new Error(`请先打开原图 ${project.source?.name ?? ""}，再载入项目文件`);
    }
  } catch (error) {
    showToast(`项目载入失败：${error.message}`);
  }
});

function syncRangeOutputs() {
  $("#color-threshold-output").value = $("#color-threshold").value;
  $("#max-jump-output").value = $("#max-jump").value;
  $("#max-gap-output").value = $("#max-gap").value;
  $("#peak-density-output").value = `${$("#peak-density").value}×`;
  $("#peak-width-output").value = `${$("#peak-width").value}%`;
  $("#noise-density-output").value = `${$("#noise-density").value}×`;
  $("#noise-window-output").value = `${$("#noise-window").value}%`;
  $("#trace-corridor-width-output").value = $("#trace-corridor-width").value;
  $("#peak-sampling-options").hidden = $("#sampling-mode").value !== "peak";
  $("#noise-sampling-options").hidden = $("#sampling-mode").value !== "noise";
  $("#sampling-mode-hint").textContent = $("#sampling-mode").value === "peak"
    ? "保持总点数不变，在几何加密基础上进一步提高峰顶及两侧密度。"
    : $("#sampling-mode").value === "noise"
      ? "保持总点数不变，在几何加密基础上进一步保留偏离局部趋势的快速起伏。"
      : $("#sampling-mode").value === "geometry"
        ? "推荐：按平滑后的屏幕弧长和转折自动分配；高斜率和急转弯处更密。"
        : "保持总点数不变，严格沿 X 等间距分布。";
}

$("#trace-corridor-width").addEventListener("input", () => {
  syncRangeOutputs();
  draw();
});
$("#trace-corridor-width").addEventListener("change", () => commitHistory("调整 Pen 宽度"));
$("#trace-corridor-mode").addEventListener("change", () => {
  invalidateTraceCorridor();
  retraceIfReady();
  updateUi();
  draw();
  commitHistory("更改 Pen 范围");
});

for (const selector of ["#color-threshold", "#max-jump", "#max-gap"]) {
  $(selector).addEventListener("input", () => {
    syncRangeOutputs();
    retraceIfReady();
  });
  $(selector).addEventListener("change", () => commitHistory("调整追踪参数"));
}

$("#sampling-mode").addEventListener("change", () => {
  syncRangeOutputs();
  retraceIfReady();
  commitHistory("更改数据点分布");
});

$("#trace-orientation").addEventListener("change", () => {
  if (state.seedColor && $("#target-style").value !== "markers") {
    traceCurrentCurve();
  } else if ($("#trace-orientation").value === "vertical") {
    showToast("已选择纵向追踪；适合近垂直且同一 X 对应多个 Y 的曲线");
  } else if ($("#trace-orientation").value === "parametric") {
    showToast("已选择二维路径追踪；发卡弯和圆环可直接识别，有额外分叉时请沿目标顺序添加至少 2 个引导点");
  }
  commitHistory("更改追踪方向");
});

$("#path-refinement").addEventListener("change", () => {
  if (retraceIfReady()) {
    // Settings are applied even when the previous attempt yielded no points.
  } else if ($("#path-refinement").value === "full") {
    showToast("已开启线宽中心校正和自适应多模型遮挡恢复；引导点位置保持不变");
  }
  commitHistory("更改路径精细化方式");
});

$("#target-style").addEventListener("change", () => {
  state.automaticMarkerSeries = false;
  state.automaticMarkerConfidence = 0;
  delete $("#target-style").dataset.autoDetected;
  delete $("#target-style").dataset.autoConfidence;
  delete $("#target-style").dataset.autoFallback;
  if ($("#target-style").value === "markers" && state.anchors.length < 4) {
    $("#strict-guide").checked = false;
  }
  if ($("#target-style").value === "noisy" && ["uniform", "geometry"].includes($("#sampling-mode").value)) {
    $("#sampling-mode").value = "noise";
    syncRangeOutputs();
  } else if ($("#target-style").value !== "noisy" && $("#sampling-mode").value === "noise") {
    $("#sampling-mode").value = "geometry";
    syncRangeOutputs();
  }
  updateUi();
  if (state.seedColor && state.anchors.length) {
    traceCurrentCurve();
  } else if (["dashed", "dashdot", "dotted"].includes($("#target-style").value)) {
    showToast("线型指纹已开启；请在目标曲线一段清晰、孤立的划线上取色");
  } else if ($("#target-style").value === "noisy") {
    showToast("实验噪声线模式已开启；波动自适应采样会保留更多局部起伏");
  }
  commitHistory("更改目标对象类型");
});

$("#strict-guide").addEventListener("change", () => {
  if ($("#strict-guide").checked && $("#target-style").value === "markers" && state.anchors.length < 4) {
    $("#strict-guide").checked = false;
    showToast("marker 强约束至少需要 4 个引导点；当前继续使用柔性引导");
    updateUi();
    return;
  }
  if (!retraceIfReady() && $("#strict-guide").checked) {
    showToast("强约束已开启；请在同色分支或遮挡区前后添加引导点");
  }
  commitHistory("切换同色遮挡约束");
});

for (const selector of ["#peak-density", "#peak-width"]) {
  $(selector).addEventListener("input", syncRangeOutputs);
  $(selector).addEventListener("change", () => {
    retraceIfReady();
    commitHistory("调整峰值采样密度");
  });
}

for (const selector of ["#noise-density", "#noise-window"]) {
  $(selector).addEventListener("input", syncRangeOutputs);
  $(selector).addEventListener("change", () => {
    retraceIfReady();
    commitHistory("调整波动采样密度");
  });
}

function selectExistingDataPoints(path, count) {
  if (count >= path.length) return [...path];
  if (count <= 1) return [{ ...path[0] }];
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index / (count - 1)) * (path.length - 1));
    return { ...path[sourceIndex] };
  });
}

$("#trace-point-count").addEventListener("change", (event) => {
  if (state.computeBusy || state.traceStale) return;
  const pointCount = normalizeTracePointCount(event.target.value);
  event.target.value = String(pointCount);
  if (state.path.length && state.path.length !== pointCount) {
    const sourcePath = state.rawPath.length ? state.rawPath : state.path;
    const markerData = sourcePath.every((point) => point.marker || point.origin === "marker");
    state.reviewRegionIndex = 0;
    if (markerData && pointCount > sourcePath.length) {
      state.path = createDataPath(sourcePath, "marker");
      event.target.value = String(sourcePath.length);
      showToast(`图中只检测到 ${sourcePath.length} 个真实 marker；已恢复全部点，不会插值制造实验数据`);
      updateUi();
      draw();
      commitHistory("调整 marker 数据点数量");
      return;
    }
    try {
      const prepared = prepareTraceOutput(markerData ? selectExistingDataPoints(sourcePath, pointCount) : sourcePath, {
        count: pointCount, parameters: activeSamplingParameters(), orientation: state.traceOrientation,
        markerData, inclusionMask: traceCorridorMask(), rect: state.plotRect,
        width: canvas.width, height: canvas.height,
      });
      state.path = createDataPath(prepared.path, markerData ? "marker" : "resampled");
    } catch (error) {
      event.target.value = String(state.path.length);
      showToast(translateMessage(error.message));
      return;
    }
    event.target.value = String(state.path.length);
    state.hoveredPointId = null;
    state.pointHoverSource = null;
    state.selectedPointId = null;
    state.draggedPointId = null;
    showToast(markerData
      ? `已从真实 marker 中等范围保留 ${state.path.length} 个点；没有生成插值点`
      : `当前曲线已重采样为 ${state.path.length} 个可编辑数据点`);
  }
  updateUi();
  draw();
  commitHistory("调整曲线数据点数量");
});

for (const selector of [
  "#x-scale", "#y-scale", "#x-value-1", "#x-value-2", "#x-value-3", "#x-value-4", "#x-value-5",
  "#y-value-1", "#y-value-2", "#y-value-3", "#y-value-4", "#y-value-5",
  "#x-label", "#y-label", "#series-label",
]) {
  $(selector).addEventListener("input", () => {
    updateUi();
    updateCursorReadout(state.cursor);
    scheduleDraftSave();
  });
  $(selector).addEventListener("change", () => commitHistory("修改标定或标签"));
}

$("#calibration-snap").addEventListener("change", () => {
  scheduleDraftSave();
  commitHistory($("#calibration-snap").checked ? "启用刻度中心吸附" : "关闭刻度中心吸附");
});

$("#trace-curve").addEventListener("click", async () => {
  if (await traceCurrentCurve({ refreshHistory: false })) commitHistory("重新自动追踪");
});
$("#retry-trace").addEventListener("click", () => $("#trace-curve").click());
$("#clear-curve").addEventListener("click", () => {
  clearActiveCurve({ keepTargetStyle: true });
  commitHistory("重置当前曲线");
});

$("#save-series").addEventListener("click", () => {
  if (state.computeBusy || state.traceStale) return;
  if (!state.path.length) {
    if (!state.series.length) return;
    clearActiveCurve();
    if (state.mode !== "seed") setMode("seed");
    showToast("已准备下一条曲线；请点击目标曲线取色");
    commitHistory("准备下一条曲线");
    return;
  }
  const existingIndex = state.series.findIndex((series) => series.id === state.editingSeriesId);
  const label = $("#series-label").value.trim() || `Curve ${existingIndex >= 0 ? existingIndex + 1 : state.series.length + 1}`;
  const record = {
    id: state.editingSeriesId ?? (globalThis.crypto?.randomUUID?.() ?? `series-${Date.now()}`),
    label,
    path: state.path,
    rawPath: state.rawPath,
    seed: state.seed,
    seedColor: state.seedColor,
    anchors: state.anchors,
    traceCorridorOperations: cloneSerializable(state.traceCorridorOperations),
    visible: false,
    overlayColor: colorToCss(state.seedColor, seriesPalette[
      (existingIndex >= 0 ? existingIndex : state.series.length) % seriesPalette.length
    ]),
    parameters: activeTraceParameters(),
    calibration: currentCalibrationSnapshot(),
  };
  if (existingIndex >= 0) state.series.splice(existingIndex, 1, record);
  else state.series.push(record);
  const action = existingIndex >= 0 ? "已更新" : "已保存";
  clearActiveCurve();
  showToast(`${action}曲线“${label}”；数据点已隐藏，可继续选择下一条曲线`);
  commitHistory(`${action}曲线`);
});

$("#series-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const item = event.target.closest("[data-series-id]");
  if (!button || !item) return;
  const id = item.dataset.seriesId;
  const index = state.series.findIndex((series) => series.id === id);
  if (index < 0) return;
  const series = state.series[index];
  if (button.dataset.action === "visibility") {
    series.visible = !series.visible;
    updateUi();
    draw();
    showToast(`已${series.visible ? "显示" : "隐藏"}曲线“${series.label}”`);
    commitHistory(`${series.visible ? "显示" : "隐藏"}已存曲线`);
  } else if (button.dataset.action === "delete") {
    state.series.splice(index, 1);
    if (state.editingSeriesId === id) clearActiveCurve();
    updateUi();
    draw();
    showToast(`已删除曲线“${series.label}”`);
    commitHistory("删除已存曲线");
  } else if (button.dataset.action === "edit") {
    if (state.editingSeriesId === id) {
      clearActiveCurve();
      showToast(`已取消编辑“${series.label}”；保留已保存的数据`);
      commitHistory("取消编辑已存曲线");
      return;
    }
    if (!state.editingSeriesId) state.calibrationBeforeSeriesEdit = currentCalibrationSnapshot();
    state.editingSeriesId = id;
    applyCalibrationSnapshot(curveCalibrationSnapshot(series));
    state.path = createDataPath(series.path);
    state.reviewRegionIndex = 0;
    state.seedColor = series.seedColor;
    state.anchors = series.anchors?.length
      ? series.anchors.map((anchor) => createGuideAnchor(anchor))
      : (series.seed ? [createGuideAnchor(series.seed)] : []);
    state.seed = state.anchors.find((anchor) => anchor.anchorId === series.seed?.anchorId)
      ?? state.anchors[0]
      ?? state.path[0]
      ?? null;
    state.rawPath = (series.rawPath ?? []).map((point) => ({ ...point }));
    state.traceStale = Boolean(series.traceStale);
    state.traceError = series.traceError ?? null;
    state.traceOrientation = resolvedTraceOrientation(series.parameters, state.rawPath.length
      ? state.rawPath
      : state.path);
    state.traceCorridorOperations = normalizeTraceCorridorOperations(series.traceCorridorOperations);
    state.draftTraceCorridor = null;
    invalidateTraceCorridor();
    state.hoveredPointId = null;
    state.pointHoverSource = null;
    state.selectedPointId = null;
    state.draggedPointId = null;
    state.hoveredAnchorIndex = null;
    state.selectedAnchorIndex = state.anchors.length ? 0 : null;
    state.draggedAnchorIndex = null;
    $("#series-label").value = series.label;
    $("#color-threshold").value = series.parameters?.threshold ?? 15;
    $("#max-jump").value = series.parameters?.maxJump ?? 14;
    $("#max-gap").value = series.parameters?.maxGap ?? 24;
    $("#sampling-mode").value = series.parameters?.samplingMode ?? "geometry";
    $("#peak-density").value = series.parameters?.peakDensity ?? 4;
    $("#peak-width").value = series.parameters?.peakWidth ?? 8;
    $("#noise-density").value = series.parameters?.noiseDensity ?? 4;
    $("#noise-window").value = series.parameters?.noiseWindow ?? 3;
    $("#strict-guide").checked = series.parameters?.strictGuidance ?? false;
    $("#trace-orientation").value = series.parameters?.orientationMode ?? "auto";
    $("#target-style").value = series.parameters?.targetStyle ?? "auto";
    delete $("#target-style").dataset.autoDetected;
    delete $("#target-style").dataset.autoConfidence;
    delete $("#target-style").dataset.autoFallback;
    state.automaticMarkerSeries = Boolean(series.parameters?.automaticMarkerSeries);
    state.automaticMarkerConfidence = Number(series.parameters?.automaticMarkerConfidence) || 0;
    if (state.automaticMarkerSeries && $("#target-style").value === "markers") {
      $("#target-style").dataset.autoDetected = "markers";
      $("#target-style").dataset.autoConfidence = String(state.automaticMarkerConfidence);
    }
    $("#path-refinement").value = series.parameters?.refinementMode ?? "full";
    $("#trace-corridor-mode").value = series.parameters?.corridorMode ?? "local";
    $("#trace-corridor-width").value = String(series.parameters?.corridorWidth ?? 24);
    $("#trace-point-count").value = String(state.path.length || normalizeTracePointCount(series.parameters?.pointCount));
    syncRangeOutputs();
    updateUi();
    draw();
    showToast(`正在编辑“${series.label}”；可拖动圆圈或在坐标表中修正数据`);
    commitHistory("编辑已存曲线");
  }
});

$("#zoom-range").addEventListener("input", (event) => setZoom(event.target.value));
$("#zoom-fit").addEventListener("click", fitZoom);
$("#undo-action").addEventListener("click", () => navigateHistory("undo"));
$("#redo-action").addEventListener("click", () => navigateHistory("redo"));
$("#restore-draft").addEventListener("click", restorePreviousDraft);
$("#restart-session").addEventListener("click", () => {
  const dialog = $("#clear-draft-confirm");
  if (dialog?.showModal) dialog.showModal();
});
$("#clear-draft-cancel").addEventListener("click", (event) => {
  event.preventDefault();
  $("#clear-draft-confirm")?.close("cancel");
});
$("#clear-draft-apply").addEventListener("click", (event) => {
  event.preventDefault();
  if (!editSession?.clearDraft()) {
    showToast("无法清除当前草稿，请检查浏览器存储权限");
    return;
  }
  $("#clear-draft-confirm")?.close("default");
  resetExtraction({ keepCalibrationValues: false });
  resetHistorySession();
  draw();
  showToast("已清除当前图片的草稿和提取数据；原图与工作图保持不变");
  suggestPlotRect({ automatic: true });
});
$("#export-density").addEventListener("change", () => commitHistory("更改导出采样密度"));
window.addEventListener("keydown", (event) => {
  const editingText = Boolean(event.target.closest("input, textarea, [contenteditable='true']"));
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    if (editingText) return;
    event.preventDefault();
    navigateHistory(event.shiftKey ? "redo" : "undo");
    return;
  }
  if (state.computeBusy || editingText || event.ctrlKey || event.metaKey || event.altKey) return;
  const direction = {
    ArrowLeft: { x: -1, y: 0 },
    ArrowRight: { x: 1, y: 0 },
    ArrowUp: { x: 0, y: -1 },
    ArrowDown: { x: 0, y: 1 },
  }[event.key];
  if (!direction) return;
  const hasSelection = Boolean(
    state.selectedPointId
    || Number.isInteger(state.selectedAnchorIndex)
    || state.selectedCalibrationKey,
  );
  if (!hasSelection) return;
  event.preventDefault();
  const step = event.shiftKey ? 0.1 : 1;
  const deltaX = direction.x * step;
  const deltaY = direction.y * step;
  if (state.selectedPointId) {
    nudgeDataPoint(state.selectedPointId, deltaX, deltaY);
  } else if (Number.isInteger(state.selectedAnchorIndex)) {
    nudgeGuideAnchor(state.selectedAnchorIndex, deltaX, deltaY);
  } else if (state.selectedCalibrationKey) {
    nudgeCalibrationPoint2d(state.selectedCalibrationKey, deltaX, deltaY);
  }
});

async function downloadBlob(content, mimeType, fileName) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const desktopSaver = globalThis.SciDigitizerDesktop?.saveBlob;
  if (typeof desktopSaver === "function") {
    try {
      return await desktopSaver(blob, { mimeType, fileName });
    } catch (error) {
      console.error("Desktop save failed", error);
      showToast("文件保存失败，请检查目标目录权限");
      return false;
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}

function baseName() {
  return (state.source.name || "curve").replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}_.-]+/gu, "_");
}

function buildCurveExportRows() {
  if (state.computeBusy || state.traceStale) throw new Error("当前结果尚未按新设置更新；请重新追踪，或撤销本次调整");
  const exportSeries = curvesForExport();
  const density = $("#export-density").value;
  const pairedSeries = exportSeries.map((series) => {
    if (series.traceStale) throw new Error(`${translateMessage("请编辑并重新追踪此已存曲线")}: ${series.label}`);
    const calibration = curveCalibrationSnapshot(series);
    const preserveDiscreteMarkers = series.parameters?.targetStyle === "markers";
    const orientation = resolvedTraceOrientation(series.parameters, series.path);
    const prepared = prepareTraceOutput(series.path, {
      count: density === "curve" ? null : normalizeTracePointCount(density),
      parameters: series.parameters ?? { samplingMode: "geometry" },
      markerData: preserveDiscreteMarkers, orientation,
      inclusionMask: buildTraceCorridorMask(series.traceCorridorOperations, series.parameters?.corridorMode),
      width: canvas.width, height: canvas.height, rect: state.plotRect,
    });
    const data = pathToData(prepared.path, calibration.x, calibration.y);
    return {
      label: series.label,
      data,
      xLabel: calibration.labels?.x,
      yLabel: calibration.labels?.y,
    };
  });
  const rows = buildPairedCurveRows(
    pairedSeries,
    $("#x-label").value.trim() || "x",
    $("#y-label").value.trim() || "y",
  );
  return { rows, curveCount: exportSeries.length };
}

async function exportDelimitedCurves(format) {
  let prepared;
  try {
    prepared = buildCurveExportRows();
  } catch (error) {
    showToast(translateMessage(error.message));
    return false;
  }
  const { rows, curveCount } = prepared;
  if (!curveCount) return;
  const csv = format === "csv";
  const content = rows.map((row) => row.map((value) => (
    csv ? csvEscape(value) : String(value).replace(/[\t\r\n]+/g, " ")
  )).join(csv ? "," : "\t")).join("\n");
  const extension = csv ? "csv" : "txt";
  const mimeType = csv ? "text/csv;charset=utf-8" : "text/plain;charset=utf-8";
  const saved = await downloadBlob(`${content}\n`, mimeType, `${baseName()}-curves.${extension}`);
  if (saved) showToast(`${extension.toUpperCase()} 已导出 ${curveCount} 条曲线；每条曲线占相邻的 X/Y 两列`);
}

$("#export-csv").addEventListener("click", () => {
  exportDelimitedCurves("csv");
});

$("#export-txt").addEventListener("click", () => {
  exportDelimitedCurves("txt");
});

$("#export-overlay").addEventListener("click", () => {
  draw({ includeAllSaved: true, includeGuides: false, includeCorridor: false });
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = canvas.width;
  exportCanvas.height = canvas.height;
  const exportContext = exportCanvas.getContext("2d");
  exportContext.drawImage(currentDisplayImage(), 0, 0);
  exportContext.drawImage(canvas, 0, 0);
  draw();
  exportCanvas.toBlob(async (blob) => {
    if (!blob) {
      showToast("Overlay PNG 生成失败");
      return;
    }
    const saved = await downloadBlob(blob, "image/png", `${baseName()}-overlay.png`);
    if (saved) showToast("Overlay PNG 已导出，其中包含全部已保存曲线的数据点");
  }, "image/png");
});

$("#export-project").addEventListener("click", async () => {
  const qualityReport = curvesForExport().map((series) => ({
    id: series.id,
    label: series.label,
    ...assessPathQuality(series.path, state.plotRect),
    reviewRegions: findPathReviewRegions(series.path, state.plotRect),
  }));
  const project = {
    schemaVersion: 8,
    createdAt: new Date().toISOString(),
    source: state.source,
    preprocessing: {
      version: 1,
      rotation: {
        ...splitRotationDegrees(state.rotationCommitted.degrees),
        totalDegrees: state.rotationCommitted.degrees,
        expandCanvas: true,
        background: "#ffffff",
        interpolation: "high-quality-bilinear",
        outputWidth: state.image?.width ?? null,
        outputHeight: state.image?.height ?? null,
      },
      perspective: state.perspectiveCommitted,
      diagnostics: state.preprocessingDiagnostics,
    },
    plotRect: state.plotRect,
    exclusions: state.exclusions,
    calibrationPoints: state.calibrationPoints,
    calibrationReferenceCounts: state.calibrationReferenceCounts,
    calibrationSnapEnabled: Boolean($("#calibration-snap").checked),
    axes: {
      x: { ...xCalibration(), label: $("#x-label").value.trim() },
      y: { ...yCalibration(), label: $("#y-label").value.trim() },
    },
    series: state.series,
    qualityReport,
    calibrationAudit: cloneSerializable(calibrationAudit()),
    exportSettings: { csvDensity: $("#export-density").value },
    activeCurve: {
      traceStale: state.traceStale || Boolean(state.computeBusy),
      traceError: state.traceError,
      label: $("#series-label").value.trim(),
      seed: state.seed,
      seedColor: state.seedColor,
      anchors: state.anchors,
      editingSeriesId: state.editingSeriesId,
      parameters: activeTraceParameters(),
      path: state.path,
      rawPath: state.rawPath,
      traceCorridorOperations: state.traceCorridorOperations,
      calibration: currentCalibrationSnapshot(),
      calibrationBeforeSeriesEdit: state.calibrationBeforeSeriesEdit,
    },
    extractor: { name: "SciDigitizer", version: "0.20.0-preview.3.21", engine: "parametric-orientation-adaptive-bilingual-occlusion-pattern-gap-ensemble-risk-ranked-review-low-friction-import-responsive-worker-guided-color-centerline-multicurve-core" },
  };
  const saved = await downloadBlob(`${JSON.stringify(project, null, 2)}\n`, "application/json", `${baseName()}-project.json`);
  if (saved) showToast("项目文件已保存，可恢复标定、参数和路径");
});

initializePanelAccordion();
window.addEventListener("languagechange", () => window.requestAnimationFrame(updatePanelSectionSummaries));
syncRangeOutputs();
updateUi();
loadImageSource(builtInSamplePath, "fig1.png", builtInSamplePath);

function currentDisplayImage() {
  return state.rotationPreviewImage ?? state.image;
}

function projectRotationDegrees(project) {
  const rotation = project?.preprocessing?.rotation;
  if (!rotation) return 0;
  const direct = Number(rotation.totalDegrees);
  if (Number.isFinite(direct)) return normalizeRotationDegrees(direct);
  return composeRotationDegrees({
    quarterTurns: rotation.quarterTurns ?? 0,
    fineDegrees: rotation.fineDegrees ?? 0,
  });
}

function rotationHasGeometry() {
  return Boolean(
    state.plotRect
    || state.exclusions.length
    || state.traceCorridorOperations.length
    || state.series.length
    || state.path.length
    || state.rawPath.length
    || state.anchors.length
    || state.seedColor
    || Object.values(state.calibrationPoints).some(Boolean),
  );
}

function workingImageDimensions(image = state.image) {
  return {
    width: Math.max(1, Math.round(image?.width || image?.naturalWidth || canvas.width || 1)),
    height: Math.max(1, Math.round(image?.height || image?.naturalHeight || canvas.height || 1)),
  };
}

function updateWorkingCanvas(image, { preview = false } = {}) {
  if (!image) return;
  const dimensions = workingImageDimensions(image);
  imageCanvas.width = dimensions.width;
  imageCanvas.height = dimensions.height;
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  invalidateTraceCorridor();
  imageContext.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
  imageContext.drawImage(image, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!preview) {
    // Any computation launched for the previous raster is obsolete even when
    // the plot geometry happens to have the same dimensions.
    targetSelectionSequence += 1;
    traceTaskSequence += 1;
    state.computeBusy = null;
    state.imageData = imageContext.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
    computeClient.setImage(currentComputeImage());
    document.documentElement.dataset.computeMode = computeClient.mode();
  }
}

function updateSourceMeta() {
  const originalWidth = state.source.width || state.originalImage?.naturalWidth || state.image?.width || 0;
  const originalHeight = state.source.height || state.originalImage?.naturalHeight || state.image?.height || 0;
  const dimensions = workingImageDimensions(state.rotationPreviewActive ? state.rotationPreviewImage : state.image);
  if (!originalWidth || !originalHeight) return;
  const angle = normalizeRotationDegrees(state.rotationPreviewActive
    ? (state.rotationDraft?.degrees ?? state.rotationCommitted.degrees)
    : state.rotationCommitted.degrees);
  const angleLabel = Math.abs(angle) < 1e-8 ? "原图方向" : `旋转 ${formatAngleDegrees(angle)}°`;
  const previewLabel = state.rotationPreviewActive ? " · 预览（尚未应用）" : "";
  const perspectiveLabel = state.perspectiveCommitted ? " · 已透视矫正" : "";
  $("#source-meta").textContent = `${state.source.name || "图像"} · 原图 ${originalWidth} × ${originalHeight} px · 工作图 ${dimensions.width} × ${dimensions.height} px · ${angleLabel}${perspectiveLabel}${previewLabel}`;
}

function updateGeometryDiagnosis() {
  const element = $("#geometry-diagnosis");
  if (!element) return;
  const diagnostics = state.preprocessingDiagnostics;
  element.className = "geometry-diagnosis waiting";
  if (!state.image || !diagnostics) {
    element.textContent = "导入后自动检查水平、垂直与透视畸变";
    return;
  }
  const messages = [];
  if (Math.abs(diagnostics.automaticRotationDegrees ?? 0) >= 0.25) {
    messages.push(`已自动校直 ${formatAngleDegrees(diagnostics.automaticRotationDegrees)}°`);
  } else if (diagnostics.skew?.confidence >= 0.35) {
    messages.push(`方向偏差约 ${formatAngleDegrees(diagnostics.skew.angleDegrees)}°，在安全阈值内`);
  } else {
    messages.push("未发现需要自动旋转的可靠证据");
  }
  if (state.perspectiveCommitted) {
    messages.push("已自动消除可靠的梯形透视畸变");
    element.className = "geometry-diagnosis corrected";
  } else if (diagnostics.perspective?.severity >= 0.008) {
    messages.push("疑似透视畸变但置信度不足，建议人工核对边框");
    element.className = "geometry-diagnosis review";
  } else {
    messages.push("绘图区边框未见明显透视畸变");
    if (Math.abs(diagnostics.automaticRotationDegrees ?? 0) >= 0.25) element.className = "geometry-diagnosis corrected";
  }
  element.textContent = messages.join(" · ");
}

function rotationUi() {
  return {
    details: $("#rotation-details"),
    fine: $("#rotation-fine"),
    range: $("#rotation-range"),
    output: $("#rotation-angle-output"),
    status: $("#rotation-status"),
    grid: $("#rotation-grid"),
    apply: $("#rotation-apply"),
    cancel: $("#rotation-cancel"),
  };
}

function syncRotationControls({ forceFine = false } = {}) {
  const ui = rotationUi();
  if (!ui.fine) return;
  const degrees = normalizeRotationDegrees(state.rotationPreviewActive
    ? (state.rotationDraft?.degrees ?? state.rotationCommitted.degrees)
    : state.rotationCommitted.degrees);
  const split = splitRotationDegrees(degrees);
  const fine = clamp(split.fineDegrees, -45, 45);
  const fineInputIsEditing = document.activeElement === ui.fine;
  if (forceFine || !fineInputIsEditing) ui.fine.value = String(fine);
  ui.range.value = String(fine);
  ui.output.value = `${formatAngleDegrees(degrees)}°`;
  const alignmentAxis = state.mode === "align-vertical"
    ? "垂直"
    : state.mode === "align-horizontal" ? "水平" : null;
  if (state.rotationPreviewActive && alignmentAxis) {
    ui.status.textContent = state.rotationAlignmentPoints.length
      ? `${alignmentAxis}取点 · R1 已选，请将十字移到较远的 R2`
      : `${alignmentAxis}取点 · 请将放大窗十字中心对准 R1`;
  } else {
    ui.status.textContent = state.rotationPreviewActive
      ? `预览 ${formatAngleDegrees(degrees)}° · 尚未应用`
      : Math.abs(degrees) < 1e-8 ? "未旋转 · 可先导入图片再校直" : `已应用 ${formatAngleDegrees(degrees)}° · 可继续微调`;
  }
  const changed = Math.abs(normalizeRotationDegrees(degrees - state.rotationCommitted.degrees)) > 1e-8;
  ui.apply.disabled = !state.rotationPreviewActive || !changed;
  ui.cancel.disabled = !state.rotationPreviewActive;
  ui.details?.classList.toggle("preview-active", state.rotationPreviewActive);
}

var rotationLockSelectors = [
  "#select-plot", "#auto-plot", "#pick-seed", "#add-guide", "#undo-guide",
  "#add-exclusion", "#exclude-trace", "#undo-exclusion", "#trace-curve",
  "#clear-curve", "#clear-all-points", "#save-series", "#export-csv",
  "#export-txt", "#export-overlay", "#export-project", "#zoom-range", "#zoom-fit",
  "#restart-session", "#restore-draft",
  ...Object.keys(pickButtonByMode).map((key) => `#pick-${key.replace(/[0-9]/g, "-$&")}`),
];

function syncRotationLock() {
  if (!rotationLockSelectors) return;
  const locked = state.rotationPreviewActive;
  for (const selector of rotationLockSelectors) {
    const element = $(selector);
    if (!element) continue;
    if (locked) {
      if (element.dataset.rotationDisabled === undefined) element.dataset.rotationDisabled = String(element.disabled);
      element.disabled = true;
    } else if (element.dataset.rotationDisabled !== undefined) {
      element.disabled = element.dataset.rotationDisabled === "true";
      delete element.dataset.rotationDisabled;
    }
  }
  syncHistoryControls();
}

function drawRotationAlignmentOverlay(drawingContext = context, transform = null, cursor = state.cursor) {
  const points = state.rotationAlignmentPoints;
  const aligning = state.mode === "align-horizontal" || state.mode === "align-vertical";
  if (!aligning && !points.length) return;
  const mapPoint = (point) => transform ? transform(point) : point;
  const mappedPoints = points.map(mapPoint);
  const mappedCursor = cursor ? mapPoint(cursor) : null;
  const unit = transform ? 1 : 1 / state.zoom;
  const markerRadius = transform ? 7 : Math.max(6, 8 / state.zoom);

  drawingContext.save();
  if (mappedPoints.length && mappedCursor) {
    drawingContext.strokeStyle = "rgba(209, 73, 91, 0.9)";
    drawingContext.lineWidth = transform ? 2 : Math.max(1.5, 2 * unit);
    drawingContext.setLineDash(transform ? [6, 4] : [6 * unit, 4 * unit]);
    drawingContext.beginPath();
    drawingContext.moveTo(mappedPoints[0].x, mappedPoints[0].y);
    drawingContext.lineTo(mappedCursor.x, mappedCursor.y);
    drawingContext.stroke();
  }
  drawingContext.setLineDash([]);
  mappedPoints.forEach((point, index) => {
    drawingContext.fillStyle = "#ffffff";
    drawingContext.strokeStyle = "#d1495b";
    drawingContext.lineWidth = transform ? 2.2 : Math.max(2, 2 * unit);
    drawingContext.beginPath();
    drawingContext.arc(point.x, point.y, markerRadius, 0, Math.PI * 2);
    drawingContext.fill();
    drawingContext.stroke();
    drawingContext.fillStyle = "#8f1730";
    drawingContext.font = `700 ${transform ? 12 : Math.max(11, 12 * unit)}px ui-sans-serif`;
    drawingContext.fillText(`R${index + 1}`, point.x + markerRadius + 3 * unit, point.y - markerRadius - 2 * unit);
  });
  if (aligning && mappedCursor && !transform) {
    const radius = Math.max(7, 9 / state.zoom);
    drawingContext.strokeStyle = "rgba(255, 255, 255, 0.96)";
    drawingContext.lineWidth = Math.max(3, 3 / state.zoom);
    drawingContext.beginPath();
    drawingContext.moveTo(mappedCursor.x - radius, mappedCursor.y);
    drawingContext.lineTo(mappedCursor.x + radius, mappedCursor.y);
    drawingContext.moveTo(mappedCursor.x, mappedCursor.y - radius);
    drawingContext.lineTo(mappedCursor.x, mappedCursor.y + radius);
    drawingContext.stroke();
    drawingContext.strokeStyle = "#8f1730";
    drawingContext.lineWidth = Math.max(1, 1 / state.zoom);
    drawingContext.stroke();
  }
  drawingContext.restore();
}

function drawRotationAssist() {
  if (!state.rotationPreviewActive) return;
  const ui = rotationUi();
  const showGrid = ui.grid?.checked ?? true;
  context.save();
  if (showGrid) {
    const step = Math.max(32, Math.round(Math.min(canvas.width, canvas.height) / 12));
    context.strokeStyle = "rgba(20, 85, 130, 0.22)";
    context.lineWidth = Math.max(1, 1 / state.zoom);
    context.setLineDash([5 / state.zoom, 5 / state.zoom]);
    for (let x = 0; x <= canvas.width; x += step) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvas.height);
      context.stroke();
    }
    for (let y = 0; y <= canvas.height; y += step) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvas.width, y);
      context.stroke();
    }
  }
  context.restore();
  drawRotationAlignmentOverlay();
}

function renderRotationPreviewNow() {
  state.rotationPreviewFrame = null;
  if (!state.rotationPreviewActive || !state.originalImage || !state.rotationDraft) return;
  try {
    state.rotationPreviewImage = renderRotatedImage(state.originalImage, {
      degrees: state.rotationDraft.degrees,
      background: "#ffffff",
      maxDimension: 2400,
    });
    updateWorkingCanvas(state.rotationPreviewImage, { preview: true });
    state.magnifierPoint = { x: canvas.width / 2, y: canvas.height / 2 };
    updateSourceMeta();
    fitZoom();
    syncRotationControls();
    draw();
  } catch (error) {
    showToast(`旋转预览失败：${error.message}`);
  }
}

function scheduleRotationPreview() {
  if (state.rotationPreviewFrame !== null) window.cancelAnimationFrame(state.rotationPreviewFrame);
  state.rotationPreviewFrame = window.requestAnimationFrame(renderRotationPreviewNow);
}

function beginRotationPreview() {
  if (!state.originalImage) {
    showToast("请先导入图片");
    return;
  }
  if (!state.rotationPreviewActive) {
    state.rotationPreviewActive = true;
    state.rotationDraft = { degrees: state.rotationCommitted.degrees };
    state.rotationAlignmentPoints = [];
    state.mode = null;
    state.dragStart = null;
    rotationUi().details?.setAttribute("open", "");
  }
  syncRotationControls();
  scheduleRotationPreview();
  updateUi();
}

function cancelRotationPreview() {
  if (!state.rotationPreviewActive) return;
  if (state.rotationPreviewFrame !== null) window.cancelAnimationFrame(state.rotationPreviewFrame);
  state.rotationPreviewFrame = null;
  state.rotationPreviewActive = false;
  state.rotationDraft = null;
  state.rotationPreviewImage = null;
  state.rotationAlignmentPoints = [];
  state.rotationPendingCommit = null;
  state.mode = null;
  updateWorkingCanvas(state.image);
  state.magnifierPoint = { x: canvas.width / 2, y: canvas.height / 2 };
  updateSourceMeta();
  fitZoom();
  syncRotationControls();
  updateUi();
  draw();
  showToast("已取消旋转预览");
}

function commitRotation(degrees, { clearExtraction = true } = {}) {
  if (!state.originalImage) return;
  const normalized = normalizeRotationDegrees(degrees);
  try {
    const image = renderRotatedImage(state.originalImage, {
      degrees: normalized,
      background: "#ffffff",
    });
    state.image = image;
    state.rotationCommitted = { degrees: normalized };
    state.perspectiveCommitted = null;
    state.preprocessingDiagnostics = {
      skew: null,
      automaticRotationDegrees: 0,
      manualRotationDegrees: normalized,
      perspective: null,
    };
    state.rotationPreviewActive = false;
    state.rotationDraft = null;
    state.rotationPreviewImage = null;
    state.rotationAlignmentPoints = [];
    state.rotationPendingCommit = null;
    state.mode = null;
    updateWorkingCanvas(image);
    state.source.rotationDegrees = normalized;
    state.source.perspectiveCorrected = false;
    state.source.workingWidth = canvas.width;
    state.source.workingHeight = canvas.height;
    state.magnifierPoint = { x: canvas.width / 2, y: canvas.height / 2 };
    if (clearExtraction) resetExtraction({ keepCalibrationValues: true });
    updateSourceMeta();
    updateGeometryDiagnosis();
    fitZoom();
    syncRotationControls();
    updateUi();
    draw();
    const clearedSuffix = clearExtraction ? "；已有提取几何已清除" : "";
    showToast(Math.abs(normalized) < 1e-8
      ? `已恢复原图方向${clearedSuffix}`
      : `已应用旋转 ${formatAngleDegrees(normalized)}°${clearedSuffix}；请重新框选和校准绘图区`);
    commitHistory("应用图片旋转");
    window.requestAnimationFrame(() => suggestPlotRect({ automatic: true }));
  } catch (error) {
    showToast(`应用旋转失败：${error.message}`);
  }
}

function requestRotationApply() {
  if (!state.rotationPreviewActive) return;
  const degrees = state.rotationDraft?.degrees ?? state.rotationCommitted.degrees;
  if (Math.abs(normalizeRotationDegrees(degrees - state.rotationCommitted.degrees)) <= 1e-8) {
    cancelRotationPreview();
    showToast("角度没有变化，已退出旋转预览并保留当前提取数据");
    return;
  }
  if (rotationHasGeometry()) {
    state.rotationPendingCommit = degrees;
    const dialog = $("#rotation-confirm");
    if (dialog?.showModal) dialog.showModal();
    else if (window.confirm("应用旋转会清除当前框选、标定和曲线数据，是否继续？")) commitRotation(degrees);
    return;
  }
  commitRotation(degrees, { clearExtraction: false });
}

function setRotationDraftDegrees(degrees) {
  if (!Number.isFinite(Number(degrees))) return;
  beginRotationPreview();
  if (!state.rotationPreviewActive || !state.rotationDraft) return;
  if (state.mode?.startsWith("align-") || state.rotationAlignmentPoints.length) {
    state.rotationAlignmentPoints = [];
    state.mode = null;
    syncModeControls();
  }
  state.rotationDraft.degrees = normalizeRotationDegrees(degrees);
  scheduleRotationPreview();
}

function rotateByQuarterTurn(direction) {
  const current = state.rotationDraft?.degrees ?? state.rotationCommitted.degrees;
  setRotationDraftDegrees(current + 90 * direction);
}

function setFineRotation(value) {
  const text = String(value).trim();
  if (!text || !Number.isFinite(Number(text))) return false;
  const current = state.rotationDraft?.degrees ?? state.rotationCommitted.degrees;
  const split = splitRotationDegrees(current);
  setRotationDraftDegrees(split.quarterTurns * 90 + clamp(Number(text), -45, 45));
  return true;
}

function selectRotationAlignment(axis) {
  const nextMode = `align-${axis}`;
  if (state.rotationPreviewActive && state.mode === nextMode) {
    state.rotationAlignmentPoints = [];
    setMode(null);
    syncRotationControls();
    showToast(`已取消两点校${axis === "horizontal" ? "水平" : "垂直"}取点`);
    return;
  }
  beginRotationPreview();
  if (!state.rotationPreviewActive) return;
  state.rotationAlignmentPoints = [];
  setMode(nextMode);
  syncRotationControls();
  showToast(`请借助放大窗十字，依次点击一条${axis === "horizontal" ? "水平" : "垂直"}参考线的两个远端点`);
}

function finishRotationAlignment(point) {
  state.rotationAlignmentPoints.push(point);
  if (state.rotationAlignmentPoints.length < 2) {
    syncModeControls();
    syncRotationControls();
    draw();
    showToast("R1 已选；请沿同一参考线选择相距较远的 R2");
    return;
  }
  const [start, end] = state.rotationAlignmentPoints;
  if (Math.hypot(end.x - start.x, end.y - start.y) < 24) {
    state.rotationAlignmentPoints.pop();
    syncModeControls();
    syncRotationControls();
    draw();
    showToast("R2 离 R1 太近；请沿同一参考线选择至少相距 24 px 的位置");
    return;
  }
  const axis = state.mode === "align-vertical" ? "vertical" : "horizontal";
  const correction = alignmentCorrectionDegrees(start, end, axis);
  if (correction === null) {
    state.rotationAlignmentPoints.pop();
    syncRotationControls();
    draw();
    showToast("无法计算该参考线，请重新选择 R2");
    return;
  }
  state.rotationAlignmentPoints = [];
  setMode(null);
  const current = state.rotationDraft?.degrees ?? state.rotationCommitted.degrees;
  setRotationDraftDegrees(current + correction);
  showToast(`已按${axis === "horizontal" ? "水平" : "垂直"}参考线校直 ${formatAngleDegrees(correction)}°；确认后应用`);
}

Object.assign(state, {
  originalImage: state.originalImage ?? null,
  rotationCommitted: state.rotationCommitted ?? { degrees: 0 },
  rotationDraft: state.rotationDraft ?? null,
  rotationPreviewImage: state.rotationPreviewImage ?? null,
  rotationPreviewActive: state.rotationPreviewActive ?? false,
  rotationAlignmentPoints: state.rotationAlignmentPoints ?? [],
  rotationPendingCommit: state.rotationPendingCommit ?? null,
  rotationPreviewFrame: state.rotationPreviewFrame ?? null,
});


$("#rotation-left")?.addEventListener("click", () => rotateByQuarterTurn(-1));
$("#rotation-right")?.addEventListener("click", () => rotateByQuarterTurn(1));
$("#rotation-reset")?.addEventListener("click", () => setRotationDraftDegrees(0));
const rotationFineInput = $("#rotation-fine");
rotationFineInput?.addEventListener("input", (event) => setFineRotation(event.target.value));
const finishFineInputEditing = () => syncRotationControls({ forceFine: true });
rotationFineInput?.addEventListener("change", finishFineInputEditing);
rotationFineInput?.addEventListener("blur", finishFineInputEditing);
$("#rotation-range")?.addEventListener("input", (event) => setFineRotation(event.target.value));
$("#rotation-align-horizontal")?.addEventListener("click", () => selectRotationAlignment("horizontal"));
$("#rotation-align-vertical")?.addEventListener("click", () => selectRotationAlignment("vertical"));
$("#rotation-grid")?.addEventListener("change", draw);
$("#rotation-apply")?.addEventListener("click", requestRotationApply);
$("#rotation-cancel")?.addEventListener("click", cancelRotationPreview);

$("#rotation-confirm-cancel")?.addEventListener("click", (event) => {
  event.preventDefault();
  $("#rotation-confirm")?.close("cancel");
});
$("#rotation-confirm-apply")?.addEventListener("click", (event) => {
  event.preventDefault();
  const dialog = $("#rotation-confirm");
  const degrees = state.rotationPendingCommit;
  dialog?.close("default");
  if (Number.isFinite(Number(degrees))) commitRotation(degrees);
});
$("#rotation-confirm")?.addEventListener("close", () => {
  if ($("#rotation-confirm")?.returnValue !== "default") state.rotationPendingCommit = null;
  updateUi();
});

syncRotationControls();
