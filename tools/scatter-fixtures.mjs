// Deterministic marker rasters with independently known centres. No paper
// images or inferred curve fits are used as numerical ground truth.
const clamp01 = value => Math.max(0, Math.min(1, value));

function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp01(((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
}

export function drawScatterMarker(image, point, shape, radius, color = image.target) {
  const { rgba, width, height } = image;
  const extent = Math.ceil(radius + 2);
  for (let y = Math.floor(point.y) - extent; y <= Math.ceil(point.y) + extent; y++) {
    for (let x = Math.floor(point.x) - extent; x <= Math.ceil(point.x) + extent; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const dx = x - point.x, dy = y - point.y;
      let distance;
      if (shape === "disc") distance = Math.hypot(dx, dy) - radius;
      else if (shape === "ring") distance = Math.abs(Math.hypot(dx, dy) - (radius - 0.5)) - 0.8;
      else {
        const angles = shape === "cross" ? [Math.PI / 4, -Math.PI / 4]
          : shape === "plus" ? [0, Math.PI / 2] : [0, Math.PI / 3, Math.PI * 2 / 3];
        distance = Math.min(...angles.map(angle => {
          const a = { x: -radius * Math.cos(angle), y: -radius * Math.sin(angle) };
          const b = { x: -a.x, y: -a.y };
          return segmentDistance(dx, dy, a, b);
        })) - 0.8;
      }
      const alpha = clamp01(0.7 - distance);
      if (!alpha) continue;
      const offset = (y * width + x) * 4;
      for (const [channel, key] of ["r", "g", "b"].entries()) {
        rgba[offset + channel] = Math.round(rgba[offset + channel] * (1 - alpha) + color[key] * alpha);
      }
    }
  }
}

export function createScatterFixture({ shape = "disc", layout = "cloud", scale = 1, radius = 4 } = {}) {
  const width = Math.round(360 * scale), height = Math.round(240 * scale);
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = { left: 8 * scale, top: 8 * scale, right: width - 9 * scale, bottom: height - 9 * scale,
    width: width - 17 * scale, height: height - 17 * scale };
  const target = { r: 31, g: 119, b: 180 };
  let truth;
  if (layout === "dense") {
    // Dense, but glyphs still have a visible gap (including their antialias
    // fringe). Touching glyphs must not be advertised as separated markers.
    truth = Array.from({ length: 345 }, (_, i) => ({ x: 22 + (i % 23) * 14, y: 20 + Math.floor(i / 23) * 14 }));
  } else if (layout === "cloud") {
    // More than one legitimate y at each x, with close, regular columns. A
    // y(x) corridor or a one-marker-per-x grid must NOT delete observations.
    truth = Array.from({ length: 36 }, (_, i) => ({ x: 40 + (i % 9) * 15,
      y: 42 + Math.floor(i / 9) * 43 + 2 * Math.sin(i * 1.7) }));
  } else if (layout === "vertical") {
    truth = Array.from({ length: 12 }, (_, i) => ({ x: 150, y: 25 + i * 17 }));
  } else {
    truth = Array.from({ length: 16 }, (_, i) => ({ x: 22 + i * 19 + (i % 3) * 0.4,
      y: 165 - i * 6 + 18 * Math.sin(i * 0.5) }));
  }
  truth = truth.map(point => ({ x: point.x * scale + 0.25, y: point.y * scale + 0.35 }));
  const image = { rgba, width, height, rect, target, truth, shape, layout, radius: radius * scale,
    name: `${shape}/${layout}/${scale}x/r${radius}` };
  for (const point of truth) drawScatterMarker(image, point, shape, image.radius);
  const guideIndices = ["cloud", "dense"].includes(layout) ? [1, 7] : [0, truth.length - 1];
  image.anchors = guideIndices.map((index, i) => ({ ...truth[index], anchorId: `scatter-${i + 1}`, userGuided: true }));
  return image;
}

export function scatterFixtures() {
  return ["disc", "ring", "cross", "plus", "star"].flatMap(shape => (
    ["series", "cloud", "vertical", "dense"].flatMap(layout => (
      [{ scale: 1, radius: 3 }, { scale: 1, radius: 5 }, { scale: 2, radius: 4 }]
        .map(options => createScatterFixture({ shape, layout, ...options }))
    ))
  ));
}

// A deliberately non-identifiable input: two data records at precisely the
// same pixel produce the same raster as one record. This is NOT an accuracy
// gate; a digitizer cannot recover the hidden multiplicity from this image.
export function coincidentScatterFixture() {
  const image = createScatterFixture({ shape: "disc", layout: "series" });
  image.truth = [...image.truth, { ...image.truth[4] }, { ...image.truth[8] }];
  image.name = "coincident records (ambiguous raster)";
  return image;
}
