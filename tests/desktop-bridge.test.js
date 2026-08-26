import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const bridgeSource = await readFile(new URL("../desktop/bridge.js", import.meta.url), "utf8");

function loadBridge({ selectedPath = "/tmp/curve-export", fail = false } = {}) {
  const writes = [];
  const context = {
    Blob,
    console,
    document: { documentElement: { dataset: {} } },
    Neutralino: {
      init() {},
      os: {
        async showSaveDialog() {
          return selectedPath;
        },
      },
      filesystem: {
        async writeBinaryFile(path, data) {
          if (fail) throw new Error("mock write failure");
          writes.push({ path, data: new Uint8Array(data) });
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(bridgeSource, context);
  return { bridge: context.SciDigitizerDesktop, writes, context };
}

test("desktop bridge uses Save As and preserves binary content", async () => {
  const { bridge, writes, context } = loadBridge();
  const saved = await bridge.saveBlob(new Blob(["x,y\n1,2\n"]), { fileName: "curve.csv" });
  assert.equal(saved, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/tmp/curve-export.csv");
  assert.equal(new TextDecoder().decode(writes[0].data), "x,y\n1,2\n");
  assert.equal(context.document.documentElement.dataset.desktopRuntime, "neutralino");
});

test("desktop bridge treats a cancelled Save As dialog as a non-error", async () => {
  const { bridge, writes } = loadBridge({ selectedPath: "" });
  const saved = await bridge.saveBlob(new Blob(["unused"]), { fileName: "project.json" });
  assert.equal(saved, false);
  assert.equal(writes.length, 0);
});
