(function initializeSciDigitizerDesktopBridge() {
  "use strict";

  if (!globalThis.Neutralino) return;

  Neutralino.init();
  document.documentElement.dataset.desktopRuntime = "neutralino";

  function extensionOf(fileName) {
    const match = String(fileName || "").match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : "*";
  }

  function ensureExtension(filePath, extension) {
    if (!filePath || extension === "*" || filePath.toLowerCase().endsWith(`.${extension}`)) return filePath;
    return `${filePath}.${extension}`;
  }

  globalThis.SciDigitizerDesktop = Object.freeze({
    runtime: "neutralino",

    async saveBlob(blob, options = {}) {
      const fileName = options.fileName || "scidigitizer-export.dat";
      const extension = extensionOf(fileName);
      const selectedPath = await Neutralino.os.showSaveDialog("Save SciDigitizer export", {
        defaultPath: fileName,
        filters: [{ name: "SciDigitizer export", extensions: [extension] }],
      });
      if (!selectedPath) return false;

      const targetPath = ensureExtension(selectedPath, extension);
      await Neutralino.filesystem.writeBinaryFile(targetPath, await blob.arrayBuffer());
      return true;
    },
  });
})();
