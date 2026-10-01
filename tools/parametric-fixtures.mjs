const TARGETS = Object.freeze({
  blue: { r: 20, g: 125, b: 205 },
  purple: { r: 155, g: 65, b: 195 },
  green: { r: 20, g: 165, b: 115 },
  orange: { r: 210, g: 85, b: 45 },
  indigo: { r: 65, g: 105, b: 220 },
});

function whiteImage(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  return { rgba, width, height };
}

function setPixel(image, x, y, color) {
  if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
  const index = (y * image.width + x) * 4;
  image.rgba[index] = color.r;
  image.rgba[index + 1] = color.g;
  image.rgba[index + 2] = color.b;
  image.rgba[index + 3] = 255;
}

function drawParametricStroke(image, pointAt, color, { samples = 8000, radius = 0 } = {}) {
  for (let index = 0; index <= samples; index += 1) {
    const point = pointAt(index / samples);
    const centerX = Math.round(point.x);
    const centerY = Math.round(point.y);
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (Math.hypot(offsetX, offsetY) > radius + 0.25) continue;
        setPixel(image, centerX + offsetX, centerY + offsetY, color);
      }
    }
  }
}

function drawPatternedParametricStroke(
  image,
  pointAt,
  color,
  { samples = 9000, onLength = 10, offLength = 6, segments = null } = {},
) {
  const pattern = segments ?? [onLength, offLength];
  const patternLength = pattern.reduce((sum, length) => sum + length, 0);
  const paintsAt = (distance) => {
    let phase = distance % patternLength;
    for (let index = 0; index < pattern.length; index += 1) {
      if (phase < pattern[index]) return index % 2 === 0;
      phase -= pattern[index];
    }
    return false;
  };
  let previous = pointAt(0);
  let arcLength = 0;
  for (let index = 0; index <= samples; index += 1) {
    const point = pointAt(index / samples);
    if (index > 0) arcLength += Math.hypot(point.x - previous.x, point.y - previous.y);
    if (paintsAt(arcLength)) {
      setPixel(image, Math.round(point.x), Math.round(point.y), color);
    }
    previous = point;
  }
}

function boxBlur(image, passes = 1) {
  let source = new Uint8ClampedArray(image.rgba);
  for (let pass = 0; pass < passes; pass += 1) {
    const output = new Uint8ClampedArray(source.length);
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const totals = [0, 0, 0];
        let count = 0;
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          const sampleY = Math.max(0, Math.min(image.height - 1, y + offsetY));
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const sampleX = Math.max(0, Math.min(image.width - 1, x + offsetX));
            const sourceIndex = (sampleY * image.width + sampleX) * 4;
            totals[0] += source[sourceIndex];
            totals[1] += source[sourceIndex + 1];
            totals[2] += source[sourceIndex + 2];
            count += 1;
          }
        }
        const targetIndex = (y * image.width + x) * 4;
        output[targetIndex] = Math.round(totals[0] / count);
        output[targetIndex + 1] = Math.round(totals[1] / count);
        output[targetIndex + 2] = Math.round(totals[2] / count);
        output[targetIndex + 3] = 255;
      }
    }
    source = output;
  }
  image.rgba.set(source);
}

function addSeededQuantisationNoise(image, seed, amplitude = 6, quantum = 4) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let index = 0; index < image.rgba.length; index += 4) {
    const noise = Math.round((random() - 0.5) * amplitude * 2);
    for (let channel = 0; channel < 3; channel += 1) {
      const value = Math.max(0, Math.min(255, image.rgba[index + channel] + noise));
      image.rgba[index + channel] = Math.round(value / quantum) * quantum;
    }
  }
}

function sampleTruth(pointAt, count = 1601) {
  return Array.from({ length: count }, (_, index) => pointAt(index / (count - 1)));
}

function fixture({
  id,
  category,
  width,
  height,
  rect,
  pointAt,
  target,
  anchors,
  expectedTopology,
  closed,
  orientationMode,
  targetStyle = "line",
  radius = 0,
  pattern = null,
  exclusions = [],
  decorate = null,
  transform = null,
}) {
  const image = whiteImage(width, height);
  if (pattern) drawPatternedParametricStroke(image, pointAt, target, pattern);
  else drawParametricStroke(image, pointAt, target, { radius });
  decorate?.(image, target);
  transform?.(image, target);
  return {
    id,
    category,
    image,
    rect,
    target,
    anchors,
    expectedTopology,
    closed,
    orientationMode,
    targetStyle,
    pattern,
    exclusions,
    truth: sampleTruth(pointAt),
  };
}

export function createParametricFixtures() {
  const ellipse = (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 52 + Math.cos(angle) * 31, y: 52 + Math.sin(angle) * 27 };
  };
  const thickEllipse = (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 60 + Math.cos(angle) * 36, y: 54 + Math.sin(angle) * 23 };
  };
  const hairpin = (fraction) => {
    const parameter = fraction * 2 - 1;
    return { x: 25 + 55 * parameter * parameter, y: 54 + 32 * parameter };
  };
  const figureEight = (fraction) => {
    const angle = fraction * Math.PI * 2;
    return { x: 68 + Math.sin(angle) * 42, y: 58 + Math.sin(angle * 2) * 30 };
  };
  const spurredHairpin = (fraction) => {
    const parameter = fraction * 2 - 1;
    return { x: 28 + 58 * parameter * parameter, y: 54 + 32 * parameter };
  };

  return [
    fixture({
      id: "closed-loop-thin-auto",
      category: "closed-loop",
      width: 104,
      height: 104,
      rect: { left: 8, top: 8, right: 96, bottom: 96, width: 89, height: 89 },
      pointAt: ellipse,
      target: TARGETS.blue,
      anchors: [{ x: 83, y: 52, anchorId: "loop-seed" }],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "auto",
    }),
    fixture({
      id: "closed-loop-thick-guided",
      category: "closed-loop",
      width: 120,
      height: 108,
      rect: { left: 8, top: 8, right: 112, bottom: 100, width: 105, height: 93 },
      pointAt: thickEllipse,
      target: TARGETS.purple,
      anchors: [
        { x: 96, y: 54, anchorId: "right" },
        { x: 60, y: 31, anchorId: "top" },
      ],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "parametric",
      radius: 2,
    }),
    fixture({
      id: "open-hairpin-auto",
      category: "open-hairpin",
      width: 112,
      height: 112,
      rect: { left: 8, top: 8, right: 104, bottom: 104, width: 97, height: 97 },
      pointAt: hairpin,
      target: TARGETS.green,
      anchors: [{ x: 25, y: 54, anchorId: "hairpin-seed" }],
      expectedTopology: "open-path",
      closed: false,
      orientationMode: "auto",
    }),
    fixture({
      id: "self-intersecting-loop-guided",
      category: "self-intersection",
      width: 136,
      height: 116,
      rect: { left: 8, top: 8, right: 128, bottom: 108, width: 121, height: 101 },
      pointAt: figureEight,
      target: TARGETS.orange,
      anchors: [
        { x: 104, y: 84, anchorId: "right-lobe" },
        { x: 32, y: 84, anchorId: "left-lobe" },
      ],
      expectedTopology: "self-intersecting-cycle",
      closed: true,
      orientationMode: "parametric",
    }),
    fixture({
      id: "open-hairpin-spur-guided",
      category: "guided-branch",
      width: 118,
      height: 112,
      rect: { left: 6, top: 8, right: 110, bottom: 104, width: 105, height: 97 },
      pointAt: spurredHairpin,
      target: TARGETS.indigo,
      anchors: [
        { x: 74, y: 25, anchorId: "upper-arm" },
        { x: 74, y: 83, anchorId: "lower-arm" },
      ],
      expectedTopology: "guided-branched-path",
      closed: false,
      orientationMode: "parametric",
      decorate(image, color) {
        for (let x = 10; x <= 28; x += 1) setPixel(image, x, 54, color);
      },
    }),
    fixture({
      id: "closed-loop-masked-occlusion-auto",
      category: "parametric-occlusion",
      width: 120,
      height: 112,
      rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
      pointAt: (fraction) => {
        const angle = fraction * Math.PI * 2;
        return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
      },
      target: { r: 185, g: 75, b: 125 },
      anchors: [{ x: 96, y: 55, anchorId: "loop-seed" }],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "auto",
      exclusions: [{ left: 38, top: 23, right: 82, bottom: 35, width: 45, height: 13 }],
    }),
    fixture({
      id: "closed-loop-dashed-auto",
      category: "parametric-patterned",
      width: 120,
      height: 112,
      rect: { left: 8, top: 8, right: 112, bottom: 104, width: 105, height: 97 },
      pointAt: (fraction) => {
        const angle = fraction * Math.PI * 2;
        return { x: 60 + Math.cos(angle) * 36, y: 55 + Math.sin(angle) * 25 };
      },
      target: { r: 105, g: 70, b: 205 },
      anchors: [{ x: 96, y: 55, anchorId: "dashed-loop-seed" }],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "auto",
      targetStyle: "dashed",
      pattern: { onLength: 10, offLength: 6 },
    }),
    fixture({
      id: "open-hairpin-dotted-explicit",
      category: "parametric-patterned",
      width: 112,
      height: 112,
      rect: { left: 8, top: 8, right: 104, bottom: 104, width: 97, height: 97 },
      pointAt: hairpin,
      target: { r: 40, g: 145, b: 120 },
      anchors: [{ x: 80, y: 22, anchorId: "dotted-hairpin-seed" }],
      expectedTopology: "open-path",
      closed: false,
      orientationMode: "parametric",
      targetStyle: "dotted",
      pattern: { segments: [3.5, 3.5] },
    }),
    fixture({
      id: "open-hairpin-dashdot-explicit",
      category: "parametric-patterned",
      width: 112,
      height: 112,
      rect: { left: 8, top: 8, right: 104, bottom: 104, width: 97, height: 97 },
      pointAt: hairpin,
      target: { r: 205, g: 90, b: 45 },
      anchors: [{ x: 80, y: 22, anchorId: "dashdot-hairpin-seed" }],
      expectedTopology: "open-path",
      closed: false,
      orientationMode: "parametric",
      targetStyle: "dashdot",
      pattern: { segments: [9, 3.5, 4, 3.5] },
    }),
    fixture({
      id: "closed-loop-blurred-auto",
      category: "parametric-degraded",
      width: 100,
      height: 96,
      rect: { left: 6, top: 6, right: 94, bottom: 90, width: 89, height: 85 },
      pointAt: (fraction) => {
        const angle = fraction * Math.PI * 2;
        return { x: 50 + Math.cos(angle) * 29, y: 48 + Math.sin(angle) * 21 };
      },
      target: { r: 120, g: 75, b: 205 },
      anchors: [{ x: 79, y: 48, anchorId: "blurred-loop-seed" }],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "auto",
      radius: 1,
      transform(image) {
        boxBlur(image, 1);
      },
    }),
    fixture({
      id: "open-hairpin-quantised-noise-auto",
      category: "parametric-degraded",
      width: 100,
      height: 104,
      rect: { left: 6, top: 6, right: 94, bottom: 98, width: 89, height: 93 },
      pointAt: (fraction) => {
        const parameter = fraction * 2 - 1;
        return { x: 22 + 48 * parameter * parameter, y: 52 + 29 * parameter };
      },
      target: { r: 35, g: 150, b: 105 },
      anchors: [{ x: 22, y: 52, anchorId: "noisy-hairpin-seed" }],
      expectedTopology: "open-path",
      closed: false,
      orientationMode: "auto",
      radius: 1,
      transform(image) {
        addSeededQuantisationNoise(image, 0x51cd17, 6, 4);
      },
    }),
    fixture({
      id: "closed-loop-low-resolution-auto",
      category: "parametric-degraded",
      width: 68,
      height: 68,
      rect: { left: 4, top: 4, right: 64, bottom: 64, width: 61, height: 61 },
      pointAt: (fraction) => {
        const angle = fraction * Math.PI * 2;
        return { x: 34 + Math.cos(angle) * 22, y: 34 + Math.sin(angle) * 17 };
      },
      target: { r: 205, g: 95, b: 40 },
      anchors: [{ x: 56, y: 34, anchorId: "low-resolution-loop-seed" }],
      expectedTopology: "closed-cycle",
      closed: true,
      orientationMode: "auto",
    }),
  ];
}
