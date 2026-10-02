import { runComputeOperation } from "./compute-engine.js?v=0.20.0-preview.3.22";

let image = null;
let imageRevision = 0;

self.addEventListener("message", (event) => {
  const message = event.data ?? {};
  if (message.type === "set-image") {
    image = {
      rgba: message.image.rgba instanceof Uint8ClampedArray
        ? message.image.rgba
        : new Uint8ClampedArray(message.image.rgba),
      width: message.image.width,
      height: message.image.height,
    };
    imageRevision = message.revision;
    self.postMessage({ type: "image-ready", revision: imageRevision });
    return;
  }
  if (message.type !== "task") return;
  const { id, revision, operation, payload } = message;
  if (!image || revision !== imageRevision) {
    self.postMessage({ type: "task-stale", id, revision });
    return;
  }
  try {
    const result = runComputeOperation(operation, payload, image);
    self.postMessage({ type: "task-result", id, revision, result });
  } catch (error) {
    self.postMessage({
      type: "task-error",
      id,
      revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
