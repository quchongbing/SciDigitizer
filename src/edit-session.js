export function cloneSerializable(value) {
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function fingerprintImageData(imageData) {
  if (!imageData?.data?.length) return null;
  let hash = 2166136261;
  const data = imageData.data;
  // Hash every source pixel. Sampling is faster for very large photographs,
  // but can silently treat two same-sized figures as identical when their
  // changed curve pixels happen to fall between samples.
  for (let index = 0; index < data.length; index += 4) {
    hash ^= data[index];
    hash = Math.imul(hash, 16777619);
    hash ^= data[index + 1] ?? 0;
    hash = Math.imul(hash, 16777619);
    hash ^= data[index + 2] ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= imageData.width;
  hash = Math.imul(hash, 16777619);
  hash ^= imageData.height;
  return `${imageData.width}x${imageData.height}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function snapshotRecord(snapshot) {
  return snapshot ? { snapshot, serialized: JSON.stringify(snapshot) } : null;
}

export function createEditSession({
  capture,
  restore,
  storageKey,
  storage = globalThis.localStorage,
  maximumEntries = 60,
  saveDelay = 450,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis),
  onHistoryChange = () => {},
  onSaveStatus = () => {},
} = {}) {
  if (typeof capture !== "function" || typeof restore !== "function" || typeof storageKey !== "function") {
    throw new Error("Edit session requires capture, restore, and storageKey callbacks");
  }
  let undoEntries = [];
  let redoEntries = [];
  let current = null;
  let saveTimer = null;
  let restoring = false;
  let lastCommitAt = 0;
  let lastCommitLabel = null;

  const historyStatus = () => ({
    canUndo: undoEntries.length > 0,
    canRedo: redoEntries.length > 0,
    undoLabel: undoEntries.at(-1)?.label ?? null,
    redoLabel: redoEntries.at(-1)?.label ?? null,
  });
  const emitHistory = () => onHistoryChange(historyStatus());

  function saveNow() {
    saveTimer = null;
    const key = storageKey();
    const snapshot = capture();
    if (!storage || !key || !snapshot) return false;
    try {
      storage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), snapshot }));
      onSaveStatus("saved");
      return true;
    } catch {
      onSaveStatus("error");
      return false;
    }
  }

  function scheduleSave() {
    if (!setTimer) return saveNow();
    if (saveTimer !== null && clearTimer) clearTimer(saveTimer);
    onSaveStatus("saving");
    saveTimer = setTimer(saveNow, saveDelay);
    return true;
  }

  function reset() {
    undoEntries = [];
    redoEntries = [];
    current = snapshotRecord(capture());
    lastCommitAt = 0;
    lastCommitLabel = null;
    emitHistory();
  }

  function commit(label, { coalesce = false } = {}) {
    if (restoring) return false;
    const next = snapshotRecord(capture());
    if (!next) return false;
    if (!current) {
      current = next;
      emitHistory();
      return false;
    }
    if (next.serialized === current.serialized) return false;
    const now = Date.now();
    const shouldCoalesce = coalesce
      && lastCommitLabel === label
      && now - lastCommitAt < 700
      && undoEntries.length > 0;
    if (!shouldCoalesce) undoEntries.push({ ...current, label });
    if (undoEntries.length > maximumEntries) undoEntries.shift();
    redoEntries = [];
    current = next;
    lastCommitAt = now;
    lastCommitLabel = label;
    emitHistory();
    scheduleSave();
    return true;
  }

  function navigate(direction) {
    const source = direction === "undo" ? undoEntries : redoEntries;
    const target = direction === "undo" ? redoEntries : undoEntries;
    const entry = source.pop();
    if (!entry || !current) return null;
    target.push({ ...current, label: entry.label });
    restoring = true;
    let restored = false;
    try {
      restored = restore(entry.snapshot);
    } finally {
      restoring = false;
    }
    if (!restored) {
      source.push(entry);
      target.pop();
      emitHistory();
      return null;
    }
    current = snapshotRecord(capture());
    emitHistory();
    scheduleSave();
    return { direction, label: entry.label };
  }

  function restoreDraft() {
    const key = storageKey();
    if (!storage || !key) return false;
    try {
      const stored = JSON.parse(storage.getItem(key) ?? "null");
      if (!stored?.snapshot) return false;
      restoring = true;
      const restored = restore(stored.snapshot);
      restoring = false;
      if (!restored) return false;
      reset();
      onSaveStatus("restored");
      return true;
    } catch {
      restoring = false;
      return false;
    }
  }

  return {
    commit,
    historyStatus,
    navigate,
    reset,
    restoreDraft,
    saveNow,
    scheduleSave,
  };
}
