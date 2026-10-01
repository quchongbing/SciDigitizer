import { clamp } from "../src/core.js";

const WIDTH = 280;
const HEIGHT = 190;
const PLOT_RECT = Object.freeze({
  left: 24,
  top: 18,
  right: 255,
  bottom: 166,
  width: 232,
  height: 149,
});

const COLORS = Object.freeze({
  blue: [31, 119, 180],
  closeBlue: [38, 126, 185],
  green: [44, 160, 72],
  orange: [239, 126, 38],
  red: [214, 55, 65],
  purple: [137, 82, 188],
  black: [12, 12, 12],
  grid: [203, 209, 216],
  frame: [25, 29, 34],
});

function rgbaImage(width = WIDTH, height = HEIGHT, color = [255, 255, 255, 255]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < rgba.length; index += 4) {
    rgba[index] = color[0];
    rgba[index + 1] = color[1];
    rgba[index + 2] = color[2];
    rgba[index + 3] = color[3];
  }
  return rgba;
}

function blendPixel(rgba, width, height, x, y, color, opacity) {
  const pixelX = Math.round(x);
  const pixelY = Math.round(y);
  if (pixelX < 0 || pixelX >= width || pixelY < 0 || pixelY >= height || opacity <= 0) return;
  const index = (pixelY * width + pixelX) * 4;
  const alpha = clamp(opacity, 0, 1);
  rgba[index] = Math.round(rgba[index] * (1 - alpha) + color[0] * alpha);
  rgba[index + 1] = Math.round(rgba[index + 1] * (1 - alpha) + color[1] * alpha);
  rgba[index + 2] = Math.round(rgba[index + 2] * (1 - alpha) + color[2] * alpha);
  rgba[index + 3] = 255;
}

function pointSegmentDistance(px, py, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator > 0
    ? clamp(((px - start.x) * dx + (py - start.y) * dy) / denominator, 0, 1)
    : 0;
  return Math.hypot(px - (start.x + fraction * dx), py - (start.y + fraction * dy));
}

function drawSegment(rgba, width, height, start, end, color, lineWidth = 2, opacity = 1) {
  const radius = Math.max(0.5, lineWidth / 2);
  const padding = Math.ceil(radius + 1.25);
  const left = Math.max(0, Math.floor(Math.min(start.x, end.x)) - padding);
  const right = Math.min(width - 1, Math.ceil(Math.max(start.x, end.x)) + padding);
  const top = Math.max(0, Math.floor(Math.min(start.y, end.y)) - padding);
  const bottom = Math.min(height - 1, Math.ceil(Math.max(start.y, end.y)) + padding);
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const distance = pointSegmentDistance(x, y, start, end);
      const coverage = clamp(radius + 0.72 - distance, 0, 1) * opacity;
      blendPixel(rgba, width, height, x, y, color, coverage);
    }
  }
}

function drawDisc(rgba, width, height, center, radius, color, opacity = 1) {
  const padding = Math.ceil(radius + 1);
  for (let y = Math.floor(center.y) - padding; y <= Math.ceil(center.y) + padding; y += 1) {
    for (let x = Math.floor(center.x) - padding; x <= Math.ceil(center.x) + padding; x += 1) {
      const coverage = clamp(radius + 0.7 - Math.hypot(x - center.x, y - center.y), 0, 1) * opacity;
      blendPixel(rgba, width, height, x, y, color, coverage);
    }
  }
}

function dashPattern(style) {
  return {
    dashed: [11, 6],
    dashdot: [13, 5, 2, 5],
    dotted: [2, 5],
  }[style] ?? null;
}

function patternVisible(distance, style, phase = 0) {
  const pattern = dashPattern(style);
  if (!pattern) return true;
  const period = pattern.reduce((sum, value) => sum + value, 0);
  let position = ((distance + phase) % period + period) % period;
  for (let index = 0; index < pattern.length; index += 1) {
    if (position < pattern[index]) return index % 2 === 0;
    position -= pattern[index];
  }
  return true;
}

function drawCurve(rgba, width, height, points, {
  color,
  lineWidth = 2,
  style = "line",
  phase = 0,
  opacity = 1,
} = {}) {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (patternVisible(distance + length / 2, style, phase)) {
      drawSegment(rgba, width, height, start, end, color, lineWidth, opacity);
    }
    distance += length;
  }
}

function drawMarker(rgba, width, height, point, {
  color,
  marker = "circle",
  radius = 3.5,
  lineWidth = 1.7,
} = {}) {
  if (marker === "plus") {
    drawSegment(rgba, width, height, { x: point.x - radius, y: point.y }, { x: point.x + radius, y: point.y }, color, lineWidth);
    drawSegment(rgba, width, height, { x: point.x, y: point.y - radius }, { x: point.x, y: point.y + radius }, color, lineWidth);
    return;
  }
  drawDisc(rgba, width, height, point, radius, color);
}

function fillRect(rgba, width, height, rect, color, opacity = 1) {
  for (let y = Math.max(0, Math.floor(rect.top)); y <= Math.min(height - 1, Math.ceil(rect.bottom)); y += 1) {
    for (let x = Math.max(0, Math.floor(rect.left)); x <= Math.min(width - 1, Math.ceil(rect.right)); x += 1) {
      blendPixel(rgba, width, height, x, y, color, opacity);
    }
  }
}

function drawFrameAndGrid(rgba, width, height, rect, { grid = false } = {}) {
  if (grid) {
    for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
      const x = rect.left + rect.width * fraction;
      const y = rect.top + rect.height * fraction;
      drawSegment(rgba, width, height, { x, y: rect.top }, { x, y: rect.bottom }, COLORS.grid, 1);
      drawSegment(rgba, width, height, { x: rect.left, y }, { x: rect.right, y }, COLORS.grid, 1);
    }
  }
  drawSegment(rgba, width, height, { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, COLORS.frame, 2);
  drawSegment(rgba, width, height, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, COLORS.frame, 2);
  drawSegment(rgba, width, height, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }, COLORS.frame, 2);
  drawSegment(rgba, width, height, { x: rect.left, y: rect.bottom }, { x: rect.left, y: rect.top }, COLORS.frame, 2);
}

function sampleTruth(formula, rect = PLOT_RECT) {
  const points = [];
  const left = rect.left + 4;
  const right = rect.right - 4;
  for (let x = left; x <= right; x += 1) {
    const t = (x - left) / Math.max(1, right - left);
    points.push({
      x,
      y: clamp(formula(t), rect.top + 5, rect.bottom - 5),
    });
  }
  return points;
}

function truthAtFraction(points, fraction) {
  return points[Math.round(clamp(fraction, 0, 1) * (points.length - 1))];
}

function boxBlur(rgba, width, height, passes = 1) {
  let source = new Uint8ClampedArray(rgba);
  for (let pass = 0; pass < passes; pass += 1) {
    const output = new Uint8ClampedArray(source.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const totals = [0, 0, 0];
        let count = 0;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          const sampleY = clamp(y + offsetY, 0, height - 1);
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const sampleX = clamp(x + offsetX, 0, width - 1);
            const index = (sampleY * width + sampleX) * 4;
            totals[0] += source[index];
            totals[1] += source[index + 1];
            totals[2] += source[index + 2];
            count += 1;
          }
        }
        const targetIndex = (y * width + x) * 4;
        output[targetIndex] = Math.round(totals[0] / count);
        output[targetIndex + 1] = Math.round(totals[1] / count);
        output[targetIndex + 2] = Math.round(totals[2] / count);
        output[targetIndex + 3] = 255;
      }
    }
    source = output;
  }
  rgba.set(source);
}

function addRasterArtefacts(rgba, width, height, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  boxBlur(rgba, width, height, 1);
  for (let index = 0; index < rgba.length; index += 4) {
    const noise = Math.round((random() - 0.5) * 8);
    for (let channel = 0; channel < 3; channel += 1) {
      const noisy = clamp(rgba[index + channel] + noise, 0, 255);
      rgba[index + channel] = Math.round(noisy / 8) * 8;
    }
  }
}

function drawLegendOcclusion(rgba, width, height, rect) {
  fillRect(rgba, width, height, rect, [250, 250, 250], 1);
  drawSegment(rgba, width, height, { x: rect.left, y: rect.top }, { x: rect.right, y: rect.top }, [110, 110, 110], 1);
  drawSegment(rgba, width, height, { x: rect.right, y: rect.top }, { x: rect.right, y: rect.bottom }, [110, 110, 110], 1);
  drawSegment(rgba, width, height, { x: rect.right, y: rect.bottom }, { x: rect.left, y: rect.bottom }, [110, 110, 110], 1);
  drawSegment(rgba, width, height, { x: rect.left, y: rect.bottom }, { x: rect.left, y: rect.top }, [110, 110, 110], 1);
  for (let row = 0; row < 3; row += 1) {
    const y = rect.top + 8 + row * 9;
    drawSegment(rgba, width, height, { x: rect.left + 7, y }, { x: rect.left + 22, y }, [30, 30, 30], 1.3);
    drawSegment(rgba, width, height, { x: rect.left + 28, y }, { x: rect.right - 6, y }, [75, 75, 75], 1);
  }
}

function buildLineFixture(category, variant) {
  const rgba = rgbaImage();
  const shift = (variant - 1) * 4;
  let targetColor = COLORS.blue;
  let targetStyle = "line";
  let lineWidth = 2.2;
  let targetTruth;
  let distractors = [];
  let drawOptions = {};
  let seedFraction = 0.16 + variant * 0.03;
  let guideFractions = [0.38, 0.64, 0.92];
  let exclusions = [];
  let postDraw = null;
  let grid = variant !== 0;

  if (category === "simple-solid") {
    targetColor = COLORS.green;
    targetTruth = sampleTruth((t) => 112 + shift - 34 * Math.sin(Math.PI * t) + 7 * Math.sin(3 * Math.PI * t));
  } else if (category === "thick-antialiased") {
    targetColor = COLORS.orange;
    lineWidth = 4.5 + variant;
    targetTruth = sampleTruth((t) => 125 - 64 * t + 15 * Math.sin(2.4 * Math.PI * t + variant * 0.35));
  } else if (category === "patterned-line") {
    targetColor = COLORS.purple;
    targetStyle = ["dashed", "dashdot", "dotted"][variant];
    lineWidth = targetStyle === "dotted" ? 2.5 : 2;
    targetTruth = sampleTruth((t) => 108 + 28 * Math.sin(2 * Math.PI * t + variant * 0.4));
    distractors = [sampleTruth((t) => 137 - 17 * Math.sin(2 * Math.PI * t + variant * 0.25))];
    drawOptions.distractorStyles = ["line"];
    drawOptions.distractorColors = [targetColor];
  } else if (category === "close-colour") {
    targetColor = COLORS.blue;
    targetTruth = sampleTruth((t) => 126 - 55 * t + 10 * Math.sin(3 * Math.PI * t));
    distractors = [sampleTruth((t) => 82 + 42 * t + 8 * Math.sin(2.5 * Math.PI * t + 0.4))];
    drawOptions.distractorColors = [COLORS.closeBlue];
  } else if (category === "same-colour-crossing") {
    targetColor = COLORS.red;
    targetTruth = sampleTruth((t) => 137 - 76 * t + 7 * Math.sin(2 * Math.PI * t + variant * 0.25));
    distractors = [sampleTruth((t) => 61 + 76 * t + 7 * Math.sin(2 * Math.PI * t + 1.2))];
    drawOptions.distractorColors = [targetColor];
    seedFraction = 0.12;
    guideFractions = [0.34, 0.68, 0.93];
  } else if (category === "same-colour-overlap") {
    targetColor = COLORS.blue;
    const common = (t) => 96 + 12 * Math.sin(2 * Math.PI * t + variant * 0.2);
    const separation = (t) => {
      if (t < 0.38) return (0.38 - t) / 0.38;
      if (t > 0.62) return (t - 0.62) / 0.38;
      return 0;
    };
    targetTruth = sampleTruth((t) => common(t) - 31 * separation(t));
    distractors = [sampleTruth((t) => common(t) + 31 * separation(t))];
    drawOptions.distractorColors = [targetColor];
    seedFraction = 0.13;
    guideFractions = [0.36, 0.65, 0.92];
  } else if (category === "occluded-curve") {
    targetColor = COLORS.green;
    targetTruth = sampleTruth((t) => 139 - 84 * t + 22 * Math.sin(2.2 * Math.PI * t + variant * 0.25));
    const occlusion = {
      left: PLOT_RECT.left + PLOT_RECT.width * (0.42 + variant * 0.015),
      right: PLOT_RECT.left + PLOT_RECT.width * (0.61 + variant * 0.015),
      top: PLOT_RECT.top + 18,
      bottom: PLOT_RECT.bottom - 18,
    };
    exclusions = [occlusion];
    guideFractions = [0.38, 0.66, 0.92];
    postDraw = () => drawLegendOcclusion(rgba, WIDTH, HEIGHT, occlusion);
  } else if (category === "noisy-experimental") {
    targetColor = COLORS.red;
    targetStyle = "noisy";
    targetTruth = sampleTruth((t) => 104 + 27 * Math.sin(3.2 * Math.PI * t) + 7 * Math.sin((19 + variant * 2) * Math.PI * t));
    distractors = [sampleTruth((t) => 142 - 18 * Math.sin(2.1 * Math.PI * t))];
    drawOptions.distractorColors = [COLORS.orange];
  } else if (category === "raster-artefacts") {
    targetColor = COLORS.blue;
    lineWidth = 2.8;
    targetTruth = sampleTruth((t) => 132 - 69 * Math.exp(-(((t - 0.58) / 0.17) ** 2)) + 7 * t);
    postDraw = () => addRasterArtefacts(rgba, WIDTH, HEIGHT, 20260820 + variant);
  } else {
    throw new Error(`Unknown line fixture category: ${category}`);
  }

  drawFrameAndGrid(rgba, WIDTH, HEIGHT, PLOT_RECT, { grid });
  distractors.forEach((truth, index) => drawCurve(rgba, WIDTH, HEIGHT, truth, {
    color: drawOptions.distractorColors?.[index] ?? COLORS.orange,
    style: drawOptions.distractorStyles?.[index] ?? "line",
    lineWidth: 2.1,
    phase: variant * 3,
  }));
  drawCurve(rgba, WIDTH, HEIGHT, targetTruth, {
    color: targetColor,
    style: targetStyle === "noisy" ? "line" : targetStyle,
    lineWidth,
    phase: variant * 4,
  });
  postDraw?.();
  // Keep the frame measurable even when raster artefacts are added.
  drawFrameAndGrid(rgba, WIDTH, HEIGHT, PLOT_RECT, { grid: false });

  return {
    id: `${category}-${variant + 1}`,
    category,
    difficulty: ["simple-solid", "thick-antialiased"].includes(category) ? "ordinary" : "stress",
    width: WIDTH,
    height: HEIGHT,
    rgba,
    plotRect: { ...PLOT_RECT },
    target: {
      kind: "line",
      color: [...targetColor],
      expectedStyle: targetStyle,
      truth: targetTruth,
      seedFraction,
      guideFractions,
    },
    distractors,
    assistedExclusions: exclusions,
  };
}

function buildMarkerFixture(variant) {
  const rgba = rgbaImage();
  drawFrameAndGrid(rgba, WIDTH, HEIGHT, PLOT_RECT, { grid: true });
  const underlying = sampleTruth((t) => 132 - 70 * t + 8 * Math.sin(2 * Math.PI * t));
  drawCurve(rgba, WIDTH, HEIGHT, underlying, { color: COLORS.blue, lineWidth: 2.4 });
  const markerTruth = Array.from({ length: 14 }, (_, index) => {
    const t = 0.04 + index * 0.92 / 13;
    const base = truthAtFraction(underlying, t);
    return { x: base.x, y: base.y + 18 + 5 * Math.sin(index * 0.9 + variant * 0.2) };
  });
  const marker = variant === 0 ? "plus" : "circle";
  markerTruth.forEach((point) => drawMarker(rgba, WIDTH, HEIGHT, point, {
    color: COLORS.black,
    marker,
    radius: variant === 2 ? 4.2 : 3.4,
    lineWidth: 1.8,
  }));
  if (variant === 2) addRasterArtefacts(rgba, WIDTH, HEIGHT, 20260830);
  drawFrameAndGrid(rgba, WIDTH, HEIGHT, PLOT_RECT, { grid: false });
  return {
    id: `black-marker-${variant + 1}`,
    category: "black-marker",
    difficulty: "stress",
    width: WIDTH,
    height: HEIGHT,
    rgba,
    plotRect: { ...PLOT_RECT },
    target: {
      kind: "markers",
      marker,
      color: [...COLORS.black],
      markerTruth,
      seedFraction: 0.08,
      guideFractions: [0.36, 0.66, 0.94],
    },
    distractors: [underlying],
    assistedExclusions: [],
  };
}

export function createAccuracyFixtures() {
  const categories = [
    "simple-solid",
    "thick-antialiased",
    "patterned-line",
    "close-colour",
    "same-colour-crossing",
    "same-colour-overlap",
    "occluded-curve",
    "noisy-experimental",
    "raster-artefacts",
  ];
  return [
    ...categories.flatMap((category) => [0, 1, 2].map((variant) => buildLineFixture(category, variant))),
    ...[0, 1, 2].map(buildMarkerFixture),
  ];
}

export function createGeometryFixtures() {
  const skew = [-4, -2, -0.75, 0.75, 2, 4].map((angleDegrees, index) => {
    const width = 320;
    const height = 220;
    const rgba = rgbaImage(width, height);
    const tangent = Math.tan(angleDegrees * Math.PI / 180);
    const corners = [
      { x: 40, y: 45 },
      { x: 285, y: 45 + tangent * 245 },
      { x: 285 - tangent * 130, y: 175 + tangent * 245 },
      { x: 40 - tangent * 130, y: 175 },
    ];
    for (let side = 0; side < 4; side += 1) {
      drawSegment(rgba, width, height, corners[side], corners[(side + 1) % 4], COLORS.frame, 3);
    }
    return { id: `skew-${index + 1}`, rgba, width, height, angleDegrees };
  });
  const perspectiveCorners = [
    [{ x: 24, y: 18 }, { x: 113, y: 23 }, { x: 106, y: 91 }, { x: 29, y: 86 }],
    [{ x: 20, y: 25 }, { x: 110, y: 16 }, { x: 115, y: 86 }, { x: 25, y: 94 }],
    [{ x: 28, y: 14 }, { x: 108, y: 20 }, { x: 116, y: 88 }, { x: 20, y: 82 }],
  ];
  const perspective = perspectiveCorners.map((corners, index) => {
    const width = 136;
    const height = 108;
    const rgba = rgbaImage(width, height);
    for (let side = 0; side < 4; side += 1) {
      drawSegment(rgba, width, height, corners[side], corners[(side + 1) % 4], COLORS.frame, 3);
    }
    return { id: `perspective-${index + 1}`, rgba, width, height, corners };
  });
  return { skew, perspective };
}
