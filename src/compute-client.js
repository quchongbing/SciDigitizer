function safeFallback(fallback) {
  try {
    return Promise.resolve(fallback());
  } catch (error) {
    return Promise.reject(error);
  }
}

function staleComputationError() {
  const error = new Error("background computation was superseded by a newer image");
  error.name = "AbortError";
  return error;
}

/**
 * Create a single-image worker client. Direct file:// copies and browsers that
 * reject module workers use the supplied synchronous fallback automatically.
 */
export function createComputeClient({ workerUrl, startupTimeoutMs = 2500 } = {}) {
  let worker = null;
  let disabled = typeof Worker === "undefined" || globalThis.location?.protocol === "file:";
  let revision = 0;
  let taskSequence = 0;
  let readyRevision = 0;
  let readyResolve = null;
  let readyTimer = null;
  let readyPromise = Promise.resolve(false);
  const pending = new Map();

  const settleWithFallback = (entry) => {
    safeFallback(entry.fallback).then(entry.resolve, entry.reject);
  };

  const disable = () => {
    if (disabled) return;
    disabled = true;
    if (readyTimer !== null) globalThis.clearTimeout(readyTimer);
    readyTimer = null;
    readyResolve?.(false);
    readyResolve = null;
    worker?.terminate();
    worker = null;
    for (const entry of pending.values()) settleWithFallback(entry);
    pending.clear();
  };

  const ensureWorker = () => {
    if (disabled || worker) return worker;
    try {
      worker = new Worker(workerUrl, { type: "module", name: "scidigitizer-compute" });
    } catch {
      disabled = true;
      return null;
    }
    worker.addEventListener("error", disable);
    worker.addEventListener("messageerror", disable);
    worker.addEventListener("message", (event) => {
      const message = event.data ?? {};
      if (message.type === "image-ready") {
        if (message.revision !== revision) return;
        readyRevision = message.revision;
        if (readyTimer !== null) globalThis.clearTimeout(readyTimer);
        readyTimer = null;
        readyResolve?.(true);
        readyResolve = null;
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.type === "task-result" && message.revision === entry.revision) {
        entry.resolve(message.result);
      } else if (message.type === "task-error") {
        entry.reject(new Error(message.error || "background computation failed"));
      } else {
        entry.reject(staleComputationError());
      }
    });
    return worker;
  };

  const setImage = (image) => {
    revision += 1;
    readyRevision = 0;
    readyResolve?.(false);
    readyResolve = null;
    for (const entry of pending.values()) entry.reject(staleComputationError());
    pending.clear();
    if (!ensureWorker()) {
      readyPromise = Promise.resolve(false);
      return revision;
    }
    readyPromise = new Promise((resolve) => {
      readyResolve = resolve;
      if (readyTimer !== null) globalThis.clearTimeout(readyTimer);
      readyTimer = globalThis.setTimeout(disable, startupTimeoutMs);
    });
    worker.postMessage({
      type: "set-image",
      revision,
      image: {
        rgba: image.rgba,
        width: image.width,
        height: image.height,
      },
    });
    return revision;
  };

  const run = async (operation, payload, fallback) => {
    if (disabled || !worker) return safeFallback(fallback);
    const requestedRevision = revision;
    const ready = readyRevision === requestedRevision ? true : await readyPromise;
    if (!ready || disabled || requestedRevision !== revision || !worker) {
      return safeFallback(fallback);
    }
    taskSequence += 1;
    const id = `compute-${taskSequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, fallback, revision: requestedRevision });
      worker.postMessage({
        type: "task",
        id,
        revision: requestedRevision,
        operation,
        payload,
      });
    });
  };

  const mode = () => (disabled ? "synchronous" : "worker");
  const stop = () => disable();
  return Object.freeze({ setImage, run, mode, stop });
}
