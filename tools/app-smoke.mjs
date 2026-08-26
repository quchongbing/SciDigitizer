import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const debuggingPort = process.env.CHROME_DEBUG_PORT ?? "9222";
const appOrigin = process.env.SCIDITIZER_ORIGIN ?? "http://127.0.0.1:8000";
const target = await fetch(
  `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(`${appOrigin}/?fresh=1`)}`,
  { method: "PUT" },
).then((response) => response.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let messageId = 0;
const pending = new Map();
const consoleErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params.exceptionDetails.text);
  }
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  const id = ++messageId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function untranslatedVisibleEnglish() {
  return evaluate(`document.body.innerText
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line && /\\p{Script=Han}/u.test(line) && line !== '中文' && !line.includes('瞿崇兵'))`);
}

function clickAtNaturalPoint(buttonSelector, x, y) {
  return evaluate(`(() => {
    document.querySelector(${JSON.stringify(buttonSelector)}).click();
    const canvas = document.querySelector('#plot-canvas');
    const bounds = canvas.getBoundingClientRect();
    const event = new PointerEvent('pointerup', {
      bubbles: true,
      clientX: bounds.left + ${x} / canvas.width * bounds.width,
      clientY: bounds.top + ${y} / canvas.height * bounds.height,
    });
    canvas.dispatchEvent(event);
  })()`);
}

function clickNaturalPoint(x, y) {
  return evaluate(`(() => {
    const canvas = document.querySelector('#plot-canvas');
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      button: 0,
      clientX: bounds.left + ${x} / canvas.width * bounds.width,
      clientY: bounds.top + ${y} / canvas.height * bounds.height,
    }));
  })()`);
}

async function clientPoint(x, y) {
  return evaluate(`(() => {
    const canvas = document.querySelector('#plot-canvas');
    const bounds = canvas.getBoundingClientRect();
    return {
      x: bounds.left + ${x} / canvas.width * bounds.width,
      y: bounds.top + ${y} / canvas.height * bounds.height,
    };
  })()`);
}

async function dragNaturalPoint(fromX, fromY, toX, toY) {
  const from = await clientPoint(fromX, fromY);
  const to = await clientPoint(toX, toY);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...to, button: "left", buttons: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
}

async function rightClickNaturalPoint(x, y) {
  const point = await clientPoint(x, y);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", buttons: 2, clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", buttons: 0, clickCount: 1 });
}

await command("Runtime.enable");
await command("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await waitFor("document.querySelector('#source-meta').textContent.includes('578 × 450')");
assert.equal(await evaluate("document.querySelectorAll('[data-language]').length"), 2);
await waitFor("document.documentElement.lang === 'en' && document.querySelector('.panel-section h2').textContent === 'Choose image'");
assert.equal(await evaluate("document.querySelector('[data-language=\"en\"]').getAttribute('aria-pressed')"), "true");
assert.equal(await evaluate("document.querySelector('.privacy-pill').textContent.trim()"), "Local processing · images never leave your device");
assert.equal(await evaluate("document.querySelector('.creator-credit').textContent.trim()"), "Created by Chongbing Qu（瞿崇兵）");
assert.equal(await evaluate("document.querySelector('#pick-seed').textContent"), "Pick target curve");
assert.equal(await evaluate("localStorage.getItem('scidigitizer:language:v1')"), null);
const untranslatedEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedEnglish, [], `untranslated visible English UI: ${untranslatedEnglish.join(' | ')}`);
if (process.env.ENGLISH_SCREENSHOT_PATH) {
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.ENGLISH_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}
await evaluate("document.querySelector('[data-language=\"zh\"]').click()");
await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('.panel-section h2').textContent === '选择图像'");
assert.equal(await evaluate("localStorage.getItem('scidigitizer:language:v1')"), "zh");
await evaluate("location.reload()");
await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('#source-meta').textContent.includes('578 × 450')");
assert.equal(await evaluate("document.querySelector('.panel-section h2').textContent"), "选择图像");
assert.equal(await evaluate("document.querySelector('.creator-credit').textContent.trim()"), "作者 Chongbing Qu（瞿崇兵）");
assert.equal(await evaluate("document.querySelector('#trace-point-count').value"), "100");
assert.equal(await evaluate("document.querySelector('#export-density').value"), "curve");
assert.equal(await evaluate("document.querySelector('#sampling-mode').value"), "geometry");
assert.equal(await evaluate("document.querySelector('#target-style').value"), "auto");
assert.equal(await evaluate("document.querySelector('#path-refinement').value"), "full");
assert.equal(await evaluate("document.querySelector('#rotation-range').step"), "0.01");
assert.equal(await evaluate("document.querySelector('#rotation-fine').step"), "0.01");
await evaluate("(() => { document.querySelector('#rotation-details').open = true; const input = document.querySelector('#rotation-fine'); input.focus(); input.select(); })()");
for (const key of [
  { key: "1", code: "Digit1", keyCode: 49 },
  { key: ".", code: "Period", keyCode: 190 },
  { key: "2", code: "Digit2", keyCode: 50 },
  { key: "5", code: "Digit5", keyCode: 53 },
]) {
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: key.key,
    code: key.code,
    text: key.key,
    unmodifiedText: key.key,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
}
await waitFor("document.querySelector('#rotation-angle-output').value === '1.25°' && document.querySelector('#rotation-range').value === '1.25'");
assert.equal(await evaluate("document.querySelector('#rotation-fine').value"), "1.25");
assert.equal(await evaluate("document.querySelector('#rotation-apply').disabled"), false);
await evaluate("document.querySelector('#rotation-fine').select()");
await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
assert.equal(await evaluate("document.querySelector('#rotation-fine').value"), "");
await evaluate("document.querySelector('#rotation-fine').blur()");
assert.equal(await evaluate("document.querySelector('#rotation-fine').value"), "1.25");
assert.equal(await evaluate("document.querySelector('#rotation-angle-output').value"), "1.25°");
const angleInputLayout = await evaluate("(() => { const range = document.querySelector('#rotation-range').getBoundingClientRect(); const field = document.querySelector('.rotation-number-field').getBoundingClientRect(); const input = document.querySelector('#rotation-fine').getBoundingClientRect(); return { besideRange: field.left > range.right, inputVisible: input.width >= 50 && input.height >= 24 }; })()");
assert.equal(angleInputLayout.besideRange, true);
assert.equal(angleInputLayout.inputVisible, true);
await evaluate("document.querySelector('#rotation-cancel').click()");
await waitFor("!document.querySelector('#rotation-details').classList.contains('preview-active')");
assert.equal(await evaluate("document.querySelector('#rotation-angle-output').value"), "0°");
await evaluate("document.querySelector('#rotation-align-horizontal').click()");
await waitFor("document.querySelector('#rotation-details').classList.contains('preview-active') && document.querySelector('#rotation-align-horizontal').getAttribute('aria-pressed') === 'true'");
assert.equal(await evaluate("document.querySelector('#rotation-apply').disabled"), true);
const alignmentCursor = await clientPoint(110, 90);
await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...alignmentCursor });
const alignmentReticle = await evaluate("(() => { const canvas = document.querySelector('#magnifier-canvas'); const context = canvas.getContext('2d'); const center = canvas.width / 2; return { center: [...context.getImageData(center, center, 1, 1).data], cross: [...context.getImageData(center, center - 28, 1, 1).data] }; })()");
assert.ok(
  alignmentReticle.center[0] > 220
    && alignmentReticle.center[1] < 110
    && alignmentReticle.center[2] < 140,
  "alignment center marker is not high contrast",
);
assert.ok(
  alignmentReticle.cross[0] > alignmentReticle.cross[1] * 1.8
    && alignmentReticle.cross[0] > alignmentReticle.cross[2] * 1.3,
  "alignment crosshair is not visible",
);
assert.match(await evaluate("document.querySelector('#magnifier-coordinate').textContent"), /校直预览中/);
await clickNaturalPoint(110, 90);
assert.match(await evaluate("document.querySelector('#rotation-status').textContent"), /R1 已选/);
assert.match(await evaluate("document.querySelector('#magnifier-hint').textContent"), /R1 已选/);
await clickNaturalPoint(120, 95);
assert.match(await evaluate("document.querySelector('#rotation-status').textContent"), /R1 已选/);
assert.equal(await evaluate("document.querySelector('#rotation-apply').disabled"), true);
await clickNaturalPoint(310, 100);
await waitFor("document.querySelector('#rotation-align-horizontal').getAttribute('aria-pressed') === 'false' && !document.querySelector('#rotation-apply').disabled");
assert.notEqual(await evaluate("document.querySelector('#rotation-angle-output').value"), "0°");
await evaluate("document.querySelector('#rotation-cancel').click()");
await waitFor("!document.querySelector('#rotation-details').classList.contains('preview-active')");
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('mode-active')"), false);
assert.equal(await evaluate("document.querySelector('#rotation-align-horizontal').getAttribute('aria-pressed')"), "false");
await evaluate("document.querySelector('#rotation-right').click()");
await waitFor("document.querySelector('#rotation-details').classList.contains('preview-active') && !document.querySelector('#rotation-apply').disabled && document.querySelector('#plot-canvas').width === 450");
assert.match(await evaluate("document.querySelector('#rotation-status').textContent"), /预览/);
assert.equal(await evaluate("document.querySelector('#plot-canvas').width"), 450);
await evaluate("document.querySelector('#rotation-cancel').click()");
await waitFor("!document.querySelector('#rotation-details').classList.contains('preview-active')");
assert.equal(await evaluate("document.querySelector('#plot-canvas').width"), 578);
assert.equal(await evaluate("document.querySelector('#rotation-angle-output').value"), '0°');
assert.equal(await evaluate("document.querySelector('#peak-sampling-options').hidden"), true);
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'markers';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#trace-point-count').disabled"), false);
assert.equal(await evaluate("document.querySelector('#path-refinement').disabled"), true);
assert.match(await evaluate("document.querySelector('#trace-point-count-hint').textContent"), /数量由图像决定/);
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'dashed';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#trace-point-count').disabled"), false);
assert.equal(await evaluate("document.querySelector('#path-refinement').disabled"), false);
assert.equal(await evaluate("document.querySelector('#exclude-trace').textContent"), "框选遮挡 / 图例");
assert.match(await evaluate("document.querySelector('#target-style-hint').textContent"), /划线长度和间隔/);
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'noisy';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#sampling-mode').value"), "noise");
assert.equal(await evaluate("document.querySelector('#noise-sampling-options').hidden"), false);
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'auto';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await evaluate(`(() => {
  const select = document.querySelector('#sampling-mode');
  select.value = 'peak';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#peak-sampling-options').hidden"), false);
await evaluate(`(() => {
  const select = document.querySelector('#sampling-mode');
  select.value = 'uniform';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
if (!await evaluate("document.querySelector('#plot-status').textContent.includes('73–548')")) {
  await evaluate("document.querySelector('#auto-plot').click()");
}
await waitFor("document.querySelector('#plot-status').textContent.includes('73–548')");
assert.deepEqual(await evaluate(`[
  document.querySelector('#x-value-1').value,
  document.querySelector('#x-value-2').value,
  document.querySelector('#x-value-3').value,
  document.querySelector('#y-value-1').value,
  document.querySelector('#y-value-2').value,
  document.querySelector('#y-value-3').value,
]`), ["", "", "", "", "", ""]);
assert.equal(await evaluate("document.querySelector('#pick-x-1').textContent"), "点击刻度 1");
assert.equal(await evaluate("document.querySelector('#pick-x-2').textContent"), "点击刻度 2");
assert.equal(await evaluate("document.querySelector('#pick-y-1').textContent"), "点击刻度 1");
assert.equal(await evaluate("document.querySelector('#pick-y-2').textContent"), "点击刻度 2");
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"), true);

await evaluate(`(() => {
  document.querySelector('#x-label').value = 'k [1/angstrom]';
  document.querySelector('#y-label').value = 'W(k)';
  document.querySelector('#series-label').value = 'Ti = 0.4 eV';
  document.querySelector('#x-value-1').value = '0';
  document.querySelector('#x-value-2').value = '8';
  document.querySelector('#y-value-1').value = '7';
  document.querySelector('#y-value-2').value = '1';
})()`);

await clickAtNaturalPoint("#pick-x-1", 75, 324);
await clickAtNaturalPoint("#pick-x-2", 546, 324);
await clickAtNaturalPoint("#pick-y-1", 75, 31);
await clickAtNaturalPoint("#pick-y-2", 75, 324);
assert.match(await evaluate("document.querySelector('#pick-x-1').textContent"), /75 px/);
assert.match(await evaluate("document.querySelector('#pick-x-2').textContent"), /546 px/);
assert.match(await evaluate("document.querySelector('#pick-y-1').textContent"), /31 px/);
assert.match(await evaluate("document.querySelector('#pick-y-2').textContent"), /324 px/);
assert.match(await evaluate("document.querySelector('#calibration-status').textContent"), /标定完成/);
assert.equal(await evaluate("document.querySelector('#calibration-quality').classList.contains('good')"), true);
assert.match(await evaluate("document.querySelector('#x-calibration-quality').textContent"), /1 px/);
assert.equal(await evaluate("document.querySelector('#calibration-refine').hidden"), false);
assert.equal(await evaluate("document.querySelector('#calibration-refine-title').textContent"), "微调 y₂");
assert.equal(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)"), 324);
await evaluate("document.querySelector('[data-calibration-nudge=\"0.1\"]').click()");
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - 324.1) < 1e-8);
await evaluate("document.querySelector('[data-calibration-nudge=\"-0.1\"]').click()");
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - 324) < 1e-8);
await clickAtNaturalPoint("#pick-seed", 276, 85);
assert.equal(await evaluate("document.querySelector('#add-guide').disabled"), false);
assert.equal(await evaluate("document.querySelector('#exclude-trace').disabled"), false);
assert.equal(await evaluate("document.querySelector('#strict-guide').disabled"), false);
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /1 个引导基准点/);
await clickAtNaturalPoint("#add-guide", 320, 150);
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /2 个引导基准点/);
assert.equal(await evaluate("document.querySelector('#undo-guide').disabled"), false);
await rightClickNaturalPoint(320, 150);
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /1 个引导基准点/);
await clickAtNaturalPoint("#add-guide", 320, 150);
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /2 个引导基准点/);
await evaluate("document.querySelector('#undo-guide').click()");
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /1 个引导基准点/);
await clickAtNaturalPoint("#add-guide", 320, 215);
const guideClient = await clientPoint(320, 215);
await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...guideClient });
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('guide-hover')"), true);
const magnifierGuideInk = await evaluate(`(() => {
  const canvas = document.querySelector('#magnifier-canvas');
  // The reticle deliberately covers the exact center, and CSS-to-canvas
  // rounding can shift the guide by a few pixels. Verify the hovered guide's
  // red ink within its expected neighborhood instead of one brittle pixel.
  const radius = 15;
  const pixels = canvas.getContext('2d').getImageData(
    canvas.width / 2 - radius,
    canvas.height / 2 - radius,
    radius * 2,
    radius * 2,
  ).data;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] > 220 && pixels[index + 1] < 110 && pixels[index + 2] < 140) {
      return [...pixels.slice(index, index + 4)];
    }
  }
  return null;
})()`);
assert.ok(
  magnifierGuideInk,
  "guide is not visible near the magnifier center",
);
await dragNaturalPoint(320, 215, 324, 226);
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('guide-dragging')"), false);
await evaluate(`(() => {
  const toggle = document.querySelector('#strict-guide');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await evaluate("document.querySelector('#trace-curve').click()");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row.guide-point').length"), 2);
assert.equal(await evaluate("document.querySelector('#review-assistant').classList.contains('waiting')"), false);
const initialReviewRegionCount = await evaluate("Number.parseInt(document.querySelector('#review-region-count').textContent, 10)");
if (initialReviewRegionCount > 0) {
  assert.equal(await evaluate("document.querySelector('#review-focus').disabled"), false);
  await evaluate("document.querySelector('#review-focus').click()");
  assert.equal(await evaluate("document.querySelectorAll('.data-point-row.review-point').length > 0"), true);
  assert.equal(await evaluate("document.querySelectorAll('.data-point-row.selected').length"), 1);
  assert.match(await evaluate("document.querySelector('#magnifier-coordinate').textContent"), /pixel:\s*\d+/);
}
assert.match(
  await evaluate("document.querySelectorAll('.data-point-row.guide-point')[1]?.title"),
  /324/,
);
const originalTraceCoordinates = await evaluate(`[...document.querySelectorAll('.data-point-row')].map((row) => [
  Number(row.querySelector('[data-coordinate="x"]').value),
  Number(row.querySelector('[data-coordinate="y"]').value),
])`);

await evaluate(`(() => {
  const input = document.querySelector('#trace-point-count');
  input.value = '37';
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#metric-points').textContent"), "37");
await evaluate(`(() => {
  const input = document.querySelector('#trace-point-count');
  input.value = '100';
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
const restoredTraceCoordinates = await evaluate(`[...document.querySelectorAll('.data-point-row')].map((row) => [
  Number(row.querySelector('[data-coordinate="x"]').value),
  Number(row.querySelector('[data-coordinate="y"]').value),
])`);
assert.deepEqual(restoredTraceCoordinates, originalTraceCoordinates);

assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);
const coordinateNudgeSteps = await evaluate(`[...document.querySelectorAll('.data-point-row')[0].querySelectorAll('.point-coordinate-input')]
  .map((input) => Number(input.step))`);
assert.ok(coordinateNudgeSteps.every((step) => step > 0 && step < 0.003),
  `coordinate nudge should be about 0.1 px: ${coordinateNudgeSteps}`);
const exportedCsv = await evaluate(`(async () => {
  let exportedBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return 'blob:sciditizer-smoke';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  try {
    document.querySelector('#export-csv').click();
    return exportedBlob ? await exportedBlob.text() : null;
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
})()`);
const [curveNameHeader, coordinateHeader, firstDataRow] = exportedCsv.trimEnd().split("\n");
assert.equal(curveNameHeader, "Ti = 0.4 eV,");
assert.equal(coordinateHeader, "k [1/angstrom],W(k)");
assert.equal(firstDataRow.split(",").length, 2);
assert.doesNotMatch(exportedCsv, /pixel_x|confidence|candidate_count|^series,/m);
const exportedProject = await evaluate(`(async () => {
  let exportedBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return 'blob:sciditizer-project-smoke';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  try {
    document.querySelector('#export-project').click();
    return exportedBlob ? await exportedBlob.text() : null;
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
})()`);
const parsedProject = JSON.parse(exportedProject);
assert.equal(parsedProject.schemaVersion, 6);
assert.equal(parsedProject.extractor.version, "0.20.0");
assert.equal("calibrationSuggestion" in parsedProject, false);
assert.match(parsedProject.extractor.engine, /^bilingual-adaptive-occlusion-ensemble-risk-ranked-review-/);
assert.equal(parsedProject.calibrationAudit.x.valid, true);
assert.equal(parsedProject.calibrationAudit.y.valid, true);
assert.equal(parsedProject.activeCurve.calibration.y.value1, 7);
assert.equal(parsedProject.activeCurve.calibration.y.value2, 1);
assert.ok(Array.isArray(parsedProject.qualityReport[0].reviewRegions));
assert.ok("perspective" in parsedProject.preprocessing);
await clickNaturalPoint(360, 280);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 101);
await dragNaturalPoint(360, 280, 370, 270);
const movedPoint = await evaluate("document.querySelector('.data-point-row.selected')?.title");
assert.match(movedPoint, /370/);
const movedClient = await clientPoint(370, 270);
await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...movedClient });
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('point-hover')"), true);
const hoveredPointPixel = await evaluate(`(() => {
  const pixel = document.querySelector('#plot-canvas').getContext('2d').getImageData(370, 270, 1, 1).data;
  return [...pixel];
})()`);
assert.ok(
  hoveredPointPixel[0] > 220 && hoveredPointPixel[1] < 110 && hoveredPointPixel[2] < 140,
  `hovered point is not high contrast: ${hoveredPointPixel}`,
);
const magnifierCoordinate = await evaluate("document.querySelector('#magnifier-coordinate').textContent");
assert.match(magnifierCoordinate, /pixel:\s*370/);
assert.match(magnifierCoordinate, /data:\s*\S+/);
assert.doesNotMatch(magnifierCoordinate, /未标定/);
await evaluate("document.querySelector('.data-point-row .point-coordinate-input').focus()");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row.selected').length"), 1);
const editedCoordinate = await evaluate(`(() => {
  const input = document.querySelector('.data-point-row.selected [data-coordinate="x"]');
  const requested = Number(input.value) + 0.05;
  input.value = String(requested);
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    requested,
    displayed: Number(document.querySelector('.data-point-row.selected [data-coordinate="x"]').value),
  };
})()`);
assert.ok(Math.abs(editedCoordinate.requested - editedCoordinate.displayed) < 1e-8);
const inspectorLayout = await evaluate(`(() => {
  const magnifier = document.querySelector('#magnifier-window').getBoundingClientRect();
  const table = document.querySelector('.data-point-window').getBoundingClientRect();
  const scroller = document.querySelector('#canvas-scroller').getBoundingClientRect();
  const inspector = document.querySelector('.inspector-stack').getBoundingClientRect();
  return {
    tableBelowMagnifier: table.top > magnifier.bottom,
    tableRight: table.right === magnifier.right,
    tableWidth: table.width,
    inspectorBesideCanvas: inspector.left >= scroller.right,
  };
})()`);
assert.equal(inspectorLayout.tableBelowMagnifier, true);
assert.equal(inspectorLayout.tableRight, true);
assert.equal(inspectorLayout.inspectorBesideCanvas, true);
assert.ok(inspectorLayout.tableWidth <= 260, `coordinate table is too wide: ${inspectorLayout.tableWidth}px`);
if (process.env.SCREENSHOT_PATH) {
  await evaluate(`(() => {
    const refinement = document.querySelector('#path-refinement');
    refinement.closest('details').open = true;
    refinement.scrollIntoView({ block: 'center' });
  })()`);
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}
await rightClickNaturalPoint(382, 282);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);
await rightClickNaturalPoint(382, 282);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 99);
await evaluate("document.querySelector('.data-point-row .point-delete-button').click()");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 98);
await clickNaturalPoint(360, 280);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 99);
await clickNaturalPoint(350, 280);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);

const beforeSave = await evaluate(`({
  points: document.querySelector('#metric-points').textContent,
  coverage: document.querySelector('#metric-coverage').textContent,
  calibration: document.querySelector('#calibration-status').textContent,
  csvDisabled: document.querySelector('#export-csv').disabled,
  txtDisabled: document.querySelector('#export-txt').disabled,
  dataPoints: document.querySelectorAll('.data-point-row').length,
  magnifierVisible: getComputedStyle(document.querySelector('#magnifier-window')).display !== 'none',
  seedColor: getComputedStyle(document.querySelector('#seed-swatch')).backgroundColor,
})`);
assert.equal(beforeSave.points, "100");
assert.ok(Number.parseFloat(beforeSave.coverage) >= 95, `unexpected observed coverage: ${beforeSave.coverage}`);
assert.match(beforeSave.calibration, /标定完成/);
assert.equal(beforeSave.csvDisabled, false);
assert.equal(beforeSave.txtDisabled, false);
assert.equal(beforeSave.dataPoints, 100);
assert.equal(beforeSave.magnifierVisible, true);

await evaluate("document.querySelector('[data-language=\"en\"]').click()");
await waitFor("document.documentElement.lang === 'en'");
const untranslatedTraceEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedTraceEnglish, [], `untranslated traced English UI: ${untranslatedTraceEnglish.join(' | ')}`);
if (process.env.ENGLISH_TRACE_SCREENSHOT_PATH) {
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.ENGLISH_TRACE_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}
await evaluate("document.querySelector('[data-language=\"zh\"]').click()");
await waitFor("document.documentElement.lang === 'zh-CN'");

await evaluate("document.querySelector('#save-series').click()");
const afterSave = await evaluate(`({
  saved: document.querySelector('#metric-series').textContent,
  label: document.querySelector('.series-copy strong')?.textContent,
  details: document.querySelector('.series-copy span')?.textContent,
  csvDisabled: document.querySelector('#export-csv').disabled,
  txtDisabled: document.querySelector('#export-txt').disabled,
  activePoints: document.querySelectorAll('.data-point-row').length,
  emptyMessage: document.querySelector('.point-list-empty')?.textContent,
  clearDisabled: document.querySelector('#clear-all-points').disabled,
  saveDisabled: document.querySelector('#save-series').disabled,
  saveLabel: document.querySelector('#save-series').textContent,
  visibilityAction: document.querySelector('[data-action="visibility"]')?.textContent,
  seriesColor: getComputedStyle(document.querySelector('.series-color')).backgroundColor,
})`);
assert.equal(afterSave.saved, "1");
assert.equal(afterSave.label, "Ti = 0.4 eV");
assert.match(afterSave.details, /100 数据点/);
assert.equal(afterSave.csvDisabled, false);
assert.equal(afterSave.txtDisabled, false);
assert.equal(afterSave.activePoints, 0);
assert.match(afterSave.emptyMessage, /“编辑”载入坐标/);
assert.equal(afterSave.clearDisabled, true);
assert.equal(afterSave.saveDisabled, false);
assert.equal(afterSave.saveLabel, "开始下一条曲线");
assert.equal(afterSave.visibilityAction, "显示");
assert.equal(afterSave.seriesColor, beforeSave.seedColor);

const savedCalibrationCsv = await evaluate(`(async () => {
  let exportedBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return 'blob:sciditizer-saved-calibration';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  try {
    document.querySelector('#export-csv').click();
    return exportedBlob ? await exportedBlob.text() : null;
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
})()`);
await evaluate(`(() => {
  document.querySelector('#y-value-1').value = '17';
  document.querySelector('#y-value-2').value = '11';
  document.querySelector('#y-value-2').dispatchEvent(new Event('input', { bubbles: true }));
})()`);
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"), false);
const savedCsvAfterNewYCalibration = await evaluate(`(async () => {
  let exportedBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return 'blob:sciditizer-new-y-calibration';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  try {
    document.querySelector('#export-csv').click();
    return exportedBlob ? await exportedBlob.text() : null;
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }
})()`);
assert.equal(savedCsvAfterNewYCalibration, savedCalibrationCsv,
  "changing the workspace Y calibration must not change a saved curve export");

await evaluate("document.querySelector('[data-language=\"en\"]').click()");
await waitFor("document.documentElement.lang === 'en'");
const untranslatedSavedEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedSavedEnglish, [], `untranslated saved English UI: ${untranslatedSavedEnglish.join(' | ')}`);
await evaluate("document.querySelector('[data-language=\"zh\"]').click()");
await waitFor("document.documentElement.lang === 'zh-CN'");

await evaluate("document.querySelector('[data-action=\"visibility\"]').click()");
assert.equal(await evaluate("document.querySelector('[data-action=\"visibility\"]').textContent"), "隐藏");
assert.equal(await evaluate("document.querySelector('[data-action=\"visibility\"]').getAttribute('aria-pressed')"), "true");
await evaluate("document.querySelector('[data-action=\"visibility\"]').click()");
assert.equal(await evaluate("document.querySelector('[data-action=\"visibility\"]').textContent"), "显示");
assert.equal(await evaluate("document.querySelectorAll('.legend-line').length"), 0);

await evaluate("document.querySelector('[data-action=\"edit\"]').click()");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);
assert.deepEqual(await evaluate(`[
  document.querySelector('#y-value-1').value,
  document.querySelector('#y-value-2').value,
]`), ["7", "1"]);
assert.equal(await evaluate("document.querySelector('[data-action=\"edit\"]').textContent"), "取消");
assert.equal(await evaluate("document.querySelector('#clear-all-points').disabled"), false);
await evaluate("document.querySelector('#clear-all-points').click()");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 0);
assert.equal(await evaluate("document.querySelector('#clear-all-points').disabled"), true);
assert.match(await evaluate("document.querySelector('.point-list-empty').textContent"), /重置当前曲线恢复已存版本/);
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"), true);
assert.equal(await evaluate("document.querySelector('#metric-series').textContent"), "1");
await evaluate("document.querySelector('[data-action=\"edit\"]').click()");
assert.equal(await evaluate("document.querySelector('[data-action=\"edit\"]').textContent"), "编辑");
assert.deepEqual(await evaluate(`[
  document.querySelector('#y-value-1').value,
  document.querySelector('#y-value-2').value,
]`), ["17", "11"]);
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"), false);
await evaluate("document.querySelector('#save-series').click()");
assert.match(await evaluate("document.querySelector('#mode-hint').textContent"), /点击目标曲线/);
assert.equal(await evaluate("document.querySelector('#pick-seed').classList.contains('button-accent')"), true);
await evaluate("document.querySelector('[data-language=\"en\"]').click()");
await waitFor("document.documentElement.lang === 'en'");
const untranslatedNextCurveEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedNextCurveEnglish, [], `untranslated next-curve English UI: ${untranslatedNextCurveEnglish.join(' | ')}`);
await evaluate("document.querySelector('[data-language=\"zh\"]').click()");
await waitFor("document.documentElement.lang === 'zh-CN'");
assert.deepEqual(consoleErrors, []);

process.stdout.write(`${JSON.stringify({ beforeSave, afterSave, consoleErrors }, null, 2)}\n`);
socket.close();
