const supportedMimeTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp"]);

function normalizedMimeType(file) {
  return String(file?.type ?? "").split(";", 1)[0].trim().toLowerCase();
}

function fileExtension(file) {
  const match = String(file?.name ?? "").trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

export function validateRasterImageFile(file, { maximumBytes = 80 * 1024 * 1024 } = {}) {
  if (!file) return { valid: false, code: "missing" };
  const mimeType = normalizedMimeType(file);
  const extension = fileExtension(file);
  const supported = mimeType
    ? supportedMimeTypes.has(mimeType)
    : supportedExtensions.has(extension);
  if (!supported) return { valid: false, code: "unsupported-type" };
  const size = Number(file.size);
  if (Number.isFinite(size) && size <= 0) return { valid: false, code: "empty" };
  if (Number.isFinite(size) && size > maximumBytes) {
    return { valid: false, code: "too-large", maximumBytes };
  }
  return { valid: true, code: "ok", mimeType: mimeType || `image/${extension}` };
}

export function pickRasterImageFile(files, options) {
  const entries = Array.from(files ?? []);
  let firstFailure = { valid: false, code: "missing" };
  for (const file of entries) {
    const validation = validateRasterImageFile(file, options);
    if (validation.valid) return { file, validation };
    if (firstFailure.code === "missing" || validation.code === "too-large") firstFailure = validation;
  }
  return { file: null, validation: firstFailure };
}

export function rasterImageDisplayName(file, { pasted = false } = {}) {
  const original = String(file?.name ?? "").trim();
  if (!pasted && original) return original;
  const mimeType = normalizedMimeType(file);
  const extension = supportedMimeTypes.get(mimeType)
    ?? (supportedExtensions.has(fileExtension(file)) ? fileExtension(file) : "png");
  return `pasted-image.${extension}`;
}
