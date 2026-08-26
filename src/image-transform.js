const EPSILON = 1e-9;

export function normalizeRotationDegrees(degrees) {
  const numeric = Number(degrees);
  if (!Number.isFinite(numeric)) return 0;
  let normalized = ((numeric + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(normalized) < EPSILON) normalized = 0;
  return normalized;
}

export function splitRotationDegrees(degrees) {
  const normalized = normalizeRotationDegrees(degrees);
  let quarterTurns = Math.round(normalized / 90);
  let fineDegrees = normalized - quarterTurns * 90;
  if (fineDegrees > 45) {
    quarterTurns += 1;
    fineDegrees -= 90;
  } else if (fineDegrees < -45) {
    quarterTurns -= 1;
    fineDegrees += 90;
  }
  quarterTurns = ((quarterTurns % 4) + 4) % 4;
  if (Math.abs(fineDegrees) < EPSILON) fineDegrees = 0;
  return { quarterTurns, fineDegrees };
}

export function composeRotationDegrees({ quarterTurns = 0, fineDegrees = 0 } = {}) {
  return normalizeRotationDegrees(Number(quarterTurns) * 90 + Number(fineDegrees));
}

function snapDimension(value) {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < EPSILON ? rounded : Math.ceil(value);
}

export function rotatedCanvasBounds(width, height, degrees = 0) {
  const safeWidth = Math.max(1, Math.round(Number(width) || 0));
  const safeHeight = Math.max(1, Math.round(Number(height) || 0));
  const radians = normalizeRotationDegrees(degrees) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rotatedWidth = snapDimension(Math.abs(safeWidth * cosine) + Math.abs(safeHeight * sine));
  const rotatedHeight = snapDimension(Math.abs(safeWidth * sine) + Math.abs(safeHeight * cosine));
  return { width: Math.max(1, rotatedWidth), height: Math.max(1, rotatedHeight) };
}

export function normalizeLineAngleDegrees(degrees) {
  let normalized = ((Number(degrees) + 90) % 180 + 180) % 180 - 90;
  if (Math.abs(normalized + 90) < EPSILON) normalized = 90;
  if (Math.abs(normalized) < EPSILON) normalized = 0;
  return normalized;
}

export function alignmentCorrectionDegrees(start, end, axis = "horizontal") {
  const dx = Number(end?.x) - Number(start?.x);
  const dy = Number(end?.y) - Number(start?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-6) return null;
  const lineAngle = normalizeLineAngleDegrees(Math.atan2(dy, dx) * 180 / Math.PI);
  const targetAngle = axis === "vertical" ? 90 : 0;
  return normalizeLineAngleDegrees(targetAngle - lineAngle);
}

function sourceDimensions(source) {
  return {
    width: Math.max(1, Math.round(source?.naturalWidth || source?.videoWidth || source?.width || 0)),
    height: Math.max(1, Math.round(source?.naturalHeight || source?.videoHeight || source?.height || 0)),
  };
}

export function rotateImageDataQuarterTurn(rgba, width, height, quarterTurns = 0) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
  const outputWidth = turns % 2 ? height : width;
  const outputHeight = turns % 2 ? width : height;
  const output = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let outputX;
      let outputY;
      if (turns === 1) {
        outputX = height - 1 - y;
        outputY = x;
      } else if (turns === 2) {
        outputX = width - 1 - x;
        outputY = height - 1 - y;
      } else if (turns === 3) {
        outputX = y;
        outputY = width - 1 - x;
      } else {
        outputX = x;
        outputY = y;
      }
      const sourceIndex = (y * width + x) * 4;
      const outputIndex = (outputY * outputWidth + outputX) * 4;
      output[outputIndex] = rgba[sourceIndex];
      output[outputIndex + 1] = rgba[sourceIndex + 1];
      output[outputIndex + 2] = rgba[sourceIndex + 2];
      output[outputIndex + 3] = rgba[sourceIndex + 3];
    }
  }
  return { rgba: output, width: outputWidth, height: outputHeight };
}

function canvasFromImageData(imageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const browserImageData = typeof ImageData === "function"
    ? new ImageData(imageData.data, imageData.width, imageData.height)
    : context.createImageData(imageData.width, imageData.height);
  if (browserImageData.data !== imageData.data) browserImageData.data.set(imageData.data);
  context.putImageData(browserImageData, 0, 0);
  return canvas;
}

function rasterizeSource(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

export function renderRotatedImage(source, {
  degrees = 0,
  background = "#ffffff",
  maxDimension = null,
} = {}) {
  if (typeof document === "undefined") throw new Error("Image rendering requires a browser document");
  const dimensions = sourceDimensions(source);
  const scale = Number.isFinite(Number(maxDimension)) && Number(maxDimension) > 0
    ? Math.min(1, Number(maxDimension) / Math.max(dimensions.width, dimensions.height))
    : 1;
  const sourceWidth = Math.max(1, Math.round(dimensions.width * scale));
  const sourceHeight = Math.max(1, Math.round(dimensions.height * scale));
  const safeDegrees = normalizeRotationDegrees(degrees);
  const split = splitRotationDegrees(safeDegrees);
  const isExactQuarterTurn = Math.abs(split.fineDegrees) < EPSILON;

  if (isExactQuarterTurn) {
    const raster = rasterizeSource(source, sourceWidth, sourceHeight);
    const sourceData = raster.getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, sourceWidth, sourceHeight);
    const rotated = rotateImageDataQuarterTurn(
      sourceData.data,
      sourceWidth,
      sourceHeight,
      split.quarterTurns,
    );
    return canvasFromImageData({
      data: rotated.rgba,
      width: rotated.width,
      height: rotated.height,
    });
  }

  const bounds = rotatedCanvasBounds(sourceWidth, sourceHeight, safeDegrees);
  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = background;
  context.fillRect(0, 0, bounds.width, bounds.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(bounds.width / 2, bounds.height / 2);
  context.rotate(safeDegrees * Math.PI / 180);
  context.drawImage(source, -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
  return canvas;
}
