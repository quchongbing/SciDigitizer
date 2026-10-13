import test from "node:test";
import assert from "node:assert/strict";
import { extractMarkerCenters, prepareInclusionMask } from "../src/core.js";
import { prepareTraceOutput } from "../src/trace-output.js";
import { scatterFixtures, createScatterFixture, drawScatterMarker, coincidentScatterFixture } from "../tools/scatter-fixtures.mjs";
import { runScatterCase, measureScatter } from "../tools/scatter-benchmark.mjs";

for (const image of scatterFixtures()) test(`measured scatter centres and export: ${image.name}`, () => {
  const report = runScatterCase(image);
  assert.equal(report.missed, 0, JSON.stringify(report));
  assert.equal(report.falsePositives, 0, JSON.stringify(report));
  assert.ok(report.maximumCenterErrorPx <= 1.5, JSON.stringify(report));
});

test("only explicit strict guidance filters a multi-valued scatter cloud", () => {
  const image = createScatterFixture();
  const unconstrained = extractMarkerCenters({ ...image, threshold: 20 });
  assert.equal(unconstrained.length, image.truth.length);
  const constrained = extractMarkerCenters({ ...image, threshold: 20, strictGuideCorridor: true });
  assert.equal(constrained.length, 9);
  assert.ok(constrained.every(point => point.y < 50));
  for (const guide of image.anchors) assert.ok(constrained.some(point => point.anchorId === guide.anchorId));
});

test("scatter Pen retains measured points without connecting or filling between dabs", () => {
  for (const shape of ["disc", "ring", "cross", "plus", "star"]) {
    const image = createScatterFixture({ shape });
    const data = new Uint8Array(image.width * image.height);
    for (let y = 30; y <= 95; y++) for (let x = 25; x <= 178; x++) data[y * image.width + x] = 1;
    const inclusionMask = prepareInclusionMask(data, image.width, image.height, "strict");
    const path = extractMarkerCenters({ ...image, inclusionMask, threshold: 20 });
    const truth = image.truth.filter(point => point.y < 95);
    const metrics = measureScatter(path, truth);
    assert.equal(metrics.missed, 0, `${shape}: ${JSON.stringify(metrics)}`);
    assert.equal(metrics.falsePositives, 0, `${shape}: ${JSON.stringify(metrics)}`);
    assert.equal(prepareTraceOutput(path, { ...image, inclusionMask, markerData: true, count: 100 }).path.length, truth.length);
  }
});

test("scatter exclusions reject a same-colour legend symbol and other colours", () => {
  const image = createScatterFixture();
  drawScatterMarker(image, { x: 300, y: 40 }, "disc", 4);
  drawScatterMarker(image, { x: 270, y: 80 }, "star", 5, { r: 220, g: 30, b: 40 });
  const path = extractMarkerCenters({ ...image, threshold: 20,
    exclusions: [{ left: 290, top: 30, right: 310, bottom: 50 }] });
  assert.equal(path.length, image.truth.length);
  assert.equal(measureScatter(path, image.truth).missed, 0);
});

test("coincident records are not falsely reconstructed from an indistinguishable raster", () => {
  const image = coincidentScatterFixture();
  const report = runScatterCase(image);
  assert.equal(report.expected, 18);
  assert.equal(report.extracted, 16);
  assert.equal(report.missed, 2);
  assert.equal(report.falsePositives, 0);
});
