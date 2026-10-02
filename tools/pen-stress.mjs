// Deterministic geometry stress checks: no external images or generated files.
import assert from "node:assert/strict";
import { prepareInclusionMask, inclusionMaskAllows } from "../src/core.js";
import { prepareTraceOutput, prepareRestoredTrace } from "../src/trace-output.js";
import { runComputeOperation } from "../src/compute-engine.js";

const width = 144, height = 144;
const rect = { left: 0, top: 0, right: width - 1, bottom: height - 1, width, height };
const counts = [2, 3, 8, 20, 100, 200];
const shapes = [
  { name: "diagonal", at: t => ({ x: 20 + 100 * t, y: 35 + 70 * t }) },
  { name: "sine", at: t => ({ x: 20 + 100 * t, y: 72 + 28 * Math.sin(t * 2 * Math.PI) }) },
  { name: "right-angle", at: t => t <= .5 ? { x: 20 + 180 * t, y: 30 } : { x: 110, y: 30 + 180 * (t - .5) } },
  { name: "hairpin", at: t => ({ x: 72 + 45 * Math.cos(Math.PI * (t + .5)), y: 72 + 45 * Math.sin(Math.PI * (t + .5)) }) },
  { name: "closed-oval", closed: true, at: t => ({ x: 72 + 48 * Math.cos(t * 2 * Math.PI), y: 72 + 33 * Math.sin(t * 2 * Math.PI) }) },
];

function transform(point, variant) {
  let { x, y } = point;
  if (variant & 1) [x, y] = [y, x];
  if (variant & 2) x = width - 1 - x;
  if (variant & 4) y = height - 1 - y;
  return { ...point, x, y };
}

function paint(path, radius) {
  const data = new Uint8Array(width * height);
  for (const p of path) {
    for (let y = Math.max(0, Math.floor(p.y - radius)); y <= Math.min(height - 1, p.y + radius); y++) {
      for (let x = Math.max(0, Math.floor(p.x - radius)); x <= Math.min(width - 1, p.x + radius); x++) {
        if (Math.hypot(x - p.x, y - p.y) <= radius) data[y * width + x] = 1;
      }
    }
  }
  return data;
}

let geometryCases = 0, erasedCutCases = 0, extractionCases = 0;
const failures = [];
for (const shape of shapes) for (let variant = 0; variant < 8; variant++) {
  const raw = Array.from({ length: 401 }, (_, i) => transform({
    ...shape.at(i / (shape.closed ? 401 : 400)), observed: true,
    closedPath: Boolean(shape.closed),
    ...(i === 80 || i === 200 || i === 320 ? { anchor: true, userGuided: true, anchorId: `guide-${i}` } : {}),
  }, variant));
  const before = JSON.stringify(raw);
  const guides = raw.filter(p => p.anchor);
  for (const radius of [2, 4, 8]) for (const scope of ["strict", "local"]) {
    const data = paint(raw, radius);
    const inclusionMask = prepareInclusionMask(data, width, height, scope);
    const options = { rect, width, height, inclusionMask, orientation: "parametric", guides };
    for (const count of counts) {
      const label = `${shape.name}/${variant}/${radius}/${scope}/${count}`;
      geometryCases++;
      try {
        const displayed = prepareTraceOutput(raw, { ...options, count });
        assert.equal(displayed.path.length, Math.max(count, guides.length));
        for (const output of [displayed, prepareTraceOutput(displayed.path, {
          ...options, geometryPath: displayed.rawPath, count: 200,
        })]) {
          assert.ok(output.path.every(p => inclusionMaskAllows(inclusionMask, width, p.x, p.y)), "point left Pen");
          for (const g of guides) assert.ok(output.path.some(p => p.anchorId === g.anchorId && p.x === g.x && p.y === g.y), "guide moved");
        }
        const restored = prepareRestoredTrace({ path: displayed.path, rawPath: displayed.rawPath }, options);
        assert.equal(restored.traceStale, false, restored.traceError);
        assert.deepEqual(restored.path, displayed.path, "restore changed displayed coordinates or metadata");
        assert.equal(JSON.stringify(raw), before, "source geometry was mutated");
      } catch (error) { failures.push({ label, error: error.code ?? error.message }); }
    }
  }
}

// Every octant, including exact half-pixel boundaries, must detect an explicit
// erased band even when the output has only two points or runs in reverse.
for (let variant = 0; variant < 8; variant++) for (const offset of [0, .25, .5]) {
  const raw = Array.from({ length: 401 }, (_, i) => transform({
    x: 20 + i / 4, y: 40 + i / 8 + offset,
  }, variant));
  for (const scope of ["strict", "local"]) {
    const data = paint(raw, 4), erased = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = transform({ x: 70, y: 40 }, variant);
      const cut = variant & 1 ? y === p.y : x === p.x;
      if (cut && data[y * width + x]) { data[y * width + x] = 0; erased[y * width + x] = 1; }
    }
    const inclusionMask = prepareInclusionMask(data, width, height, scope, { erased });
    for (const count of counts) for (const reversed of [false, true]) {
      erasedCutCases++;
      const path = reversed ? [raw.at(-1), raw[0]] : [raw[0], raw.at(-1)];
      try {
        assert.throws(() => prepareTraceOutput(path, {
          rect, width, height, inclusionMask, orientation: "parametric", count,
        }), { code: "PEN_OUTSIDE" });
      } catch (error) { failures.push({ label: `cut/${variant}/${offset}/${scope}/${count}/${reversed}`, error: error.message }); }
    }
  }
}

// Whole computation pipeline: a same-colour crossing, frame, dashed gaps,
// multiple brush widths and rotations, including almost vertical target ink.
for (const degrees of [0, 22.5, 45, 67.5, 89, 90, 135]) {
  const angle = degrees * Math.PI / 180, ux = Math.cos(angle), uy = Math.sin(angle);
  const at = (t, perpendicular = false) => ({
    x: 72 + (perpendicular ? -uy : ux) * (t - .5) * 110,
    y: 72 + (perpendicular ? ux : uy) * (t - .5) * 110,
  });
  const route = Array.from({ length: 441 }, (_, i) => at(i / 440));
  for (const style of ["line", "dashed"]) for (const radius of [2, 6, 12]) for (const scope of ["strict", "local"]) {
    extractionCases++;
    const label = `extract/${degrees}/${style}/${radius}/${scope}`;
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
    const set = (p, color) => rgba.set([...color, 255], (Math.round(p.y) * width + Math.round(p.x)) * 4);
    for (let v = 8; v <= 136; v++) for (const edge of [8, 136]) {
      set({ x: edge, y: v }, [17, 17, 17]); set({ x: v, y: edge }, [17, 17, 17]);
    }
    for (let i = 0; i <= 440; i++) {
      set(at(i / 440, true), [20, 80, 210]);
      if (style === "line" || (i / 4) % 12 < 8) set(route[i], [20, 80, 210]);
    }
    const image = { width, height, rgba };
    const data = paint(scope === "strict" ? route : route.slice(100, 341), radius);
    const inclusionMask = prepareInclusionMask(data, width, height, scope);
    const guides = [320, 80, 200].map((i, index) => ({ ...route[i], anchorId: `g-${index}`, userGuided: true }));
    try {
      const traced = runComputeOperation("trace-line", {
        rect, anchors: guides, target: { r: 20, g: 80, b: 210 }, threshold: 5,
        inclusionMask, targetStyle: style, orientationMode: "auto", refinementMode: "full", maxJump: 14, maxGap: 24,
      }, image);
      const options = { rect, width, height, inclusionMask, guides, orientation: traced.orientation };
      for (const count of [20, 100]) {
        const output = prepareTraceOutput(traced.path, { ...options, count });
        const projected = output.path.map(p => (p.x - 72) * ux + (p.y - 72) * uy);
        const deviation = Math.max(...output.path.map(p => Math.abs(-(p.x - 72) * uy + (p.y - 72) * ux)));
        assert.ok(Math.max(...projected) - Math.min(...projected) >= 99, "trace lost more than 10% of target span");
        assert.ok(deviation <= 2, `trace switched branch (${deviation.toFixed(2)}px)`);
        assert.ok(output.path.every(p => p.anchor || inclusionMaskAllows(inclusionMask, width, p.x, p.y)), "extraction left Pen");
        assert.equal(prepareRestoredTrace({ path: output.path, rawPath: output.rawPath }, options).traceStale, false);
      }
    } catch (error) { failures.push({ label, error: error.message, code: error.code }); }
  }
}

console.log(JSON.stringify({ geometryCases, erasedCutCases, extractionCases, failures: failures.slice(0, 15), failureCount: failures.length }, null, 2));
if (failures.length) process.exitCode = 1;
