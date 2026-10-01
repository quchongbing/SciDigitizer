import test from "node:test";
import assert from "node:assert/strict";

import {
  pickRasterImageFile,
  rasterImageDisplayName,
  validateRasterImageFile,
} from "../src/image-import.js";

test("raster import accepts PNG, JPEG, and WebP while rejecting SVG and text", () => {
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    assert.equal(validateRasterImageFile({ type, size: 1024 }).valid, true);
  }
  assert.equal(validateRasterImageFile({ type: "image/svg+xml", size: 1024 }).code, "unsupported-type");
  assert.equal(validateRasterImageFile({ type: "text/plain", size: 1024 }).code, "unsupported-type");
});

test("raster import uses a safe extension fallback only when MIME type is absent", () => {
  assert.equal(validateRasterImageFile({ name: "plot.JPEG", type: "", size: 100 }).valid, true);
  assert.equal(validateRasterImageFile({ name: "plot.png", type: "application/json", size: 100 }).valid, false);
});

test("raster import rejects empty and excessively large files", () => {
  assert.equal(validateRasterImageFile({ type: "image/png", size: 0 }).code, "empty");
  assert.equal(validateRasterImageFile({ type: "image/png", size: 101 }, { maximumBytes: 100 }).code, "too-large");
});

test("raster import picks the first valid image and gives clipboard images a stable name", () => {
  const png = { name: "figure.png", type: "image/png", size: 100 };
  assert.equal(pickRasterImageFile([
    { name: "notes.txt", type: "text/plain", size: 20 },
    png,
  ]).file, png);
  assert.equal(rasterImageDisplayName(png), "figure.png");
  assert.equal(rasterImageDisplayName(png, { pasted: true }), "pasted-image.png");
});
