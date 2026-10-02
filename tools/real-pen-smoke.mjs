// Optional regression for the externally supplied Gamma_ee regime diagram.
// The third-party image is read locally, never bundled in the repository.
import assert from "node:assert/strict";
import { decodePng } from "./png-decode.mjs";
import { prepareInclusionMask, inclusionMaskAllows } from "../src/core.js";
import { runComputeOperation } from "../src/compute-engine.js";
import { prepareTraceOutput } from "../src/trace-output.js";

if (!process.argv[2]) throw new Error("Usage: node tools/real-pen-smoke.mjs /path/to/regime-diagram.png");
const image = decodePng(process.argv[2]);
const { width, height } = image;
assert.deepEqual([width, height], [1243, 811], "This regression expects the original 1243 × 811 regime diagram");
const rect = { left: 125, top: 17, right: 1191, bottom: 691, width: 1067, height: 675 };
const anchors = [[195, 423], [721, 329], [790, 522], [789, 398]].map(([x, y], index) => ({
  x, y, anchorId: `guide-${index}`, userGuided: true,
}));
const route = [[126, 438], [195, 423], [300, 401], [430, 374], [550, 349], [640, 329],
  [670, 324], [705, 327], [738, 336], [765, 351], [781, 369], [789, 386], [789, 691]];
function penMask(points, mode, penWidth = 24) {
  const data = new Uint8Array(width * height);
  const radius = penWidth / 2;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1], [x1, y1] = points[index];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const x = x0 + (x1 - x0) * step / steps, y = y0 + (y1 - y0) * step / steps;
      for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, y + radius); yy += 1) {
        for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, x + radius); xx += 1) {
          if (Math.hypot(xx - x, yy - y) <= radius) data[yy * width + xx] = 1;
        }
      }
    }
  }
  return prepareInclusionMask(data, width, height, mode);
}
const cases = [
  { name: "guides only", mask: null },
  ...[12, 24, 40].flatMap(penWidth => [
    { name: `local Pen ${penWidth}px`, mask: penMask(route.slice(4), "local", penWidth) },
    { name: `full strict Pen ${penWidth}px`, mask: penMask(route, "strict", penWidth) },
  ]),
];
const reports = [];
for (const threshold of [9, 15]) {
for (const reverseGuides of [false, true]) {
  const options = { rect, anchors: reverseGuides ? [...anchors].reverse() : anchors,
    target: { r: 0, g: 0, b: 0 }, threshold, maxJump: 14, maxGap: 24,
    targetStyle: "line", refinementMode: "full", orientationMode: "auto" };
  for (const { name, mask: inclusionMask } of cases) {
    const result = runComputeOperation("trace-line", { ...options, inclusionMask }, image);
    assert.equal(result.orientation, "parametric");
    const path = prepareTraceOutput(result.path, {
      count: 100, parameters: { samplingMode: "geometry" }, orientation: result.orientation,
      guides: anchors, inclusionMask, width, height, rect,
    }).path;
    assert.equal(path.length, 100);
    for (const anchor of anchors) assert.ok(path.some(point => point.anchorId === anchor.anchorId
      && point.x === anchor.x && point.y === anchor.y));
    assert.ok(path.every(point => point.anchor || inclusionMaskAllows(inclusionMask, width, point.x, point.y)));
    assert.ok(path.every(point => point.x <= 803 && point.y >= 315), "must not follow the other black line");
    assert.ok(Math.min(...path.map(point => point.x)) < 145, "must retain the left curve segment");
    assert.ok(Math.max(...path.map(point => point.y)) >= 686, "must reach the bottom of the vertical segment");
    const vertical = path.filter(point => point.y > 398 && point.x > 740);
    assert.ok(vertical.length >= 20);
    assert.ok(vertical.filter(point => point.y < 681).every(point => Math.abs(point.x - 789) <= 3));
    if (inclusionMask?.mode !== "strict") assert.ok(vertical.every(point => Math.abs(point.x - 789) <= 3),
      "must not extend along the bottom axis");
    reports.push({ name, threshold, reverseGuides, points: path.length, verticalPoints: vertical.length,
      penEntryBridges: result.parametricDiagnostics.penEntryBridges });
  }
  assert.throws(() => runComputeOperation("trace-line", {
    ...options, inclusionMask: penMask(route.slice(4), "strict"),
  }, image), /二维 Pen 路径不连续/);
}
}
console.log(JSON.stringify(reports, null, 2));
