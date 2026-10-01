import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

const debuggingPort = process.env.CHROME_DEBUG_PORT ?? "9222";
const appOrigin = process.env.SCIDITIZER_ORIGIN ?? "http://127.0.0.1:8000";
const appUrl = process.env.SCIDITIZER_URL ?? `${appOrigin}/`;
const expectedComputeMode = appUrl.startsWith("file:") ? "synchronous" : "worker";
const target = await fetch(
  `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(appUrl)}`,
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
    try {
      if (await evaluate(expression)) return;
    } catch (error) {
      // DevTools can briefly reject Runtime.evaluate while a deliberate page
      // navigation replaces the execution context. Retry until the new page
      // becomes available; application exceptions are collected separately.
      if (!/Uncaught|execution context|navigated|closed/i.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function waitForComputeIdle(timeoutMs = 20_000) {
  await waitFor("document.documentElement.dataset.computeBusy === 'idle'", timeoutMs);
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

async function paintGreenPeakCorridor() {
  // This workflow test paints over the already-verified green result. A
  // straight chord over just one side of the peak excludes the other side
  // (and its guide), so it is not a valid successful-retrace fixture.
  const route = await evaluate(`[...document.querySelectorAll('.data-point-row')].map(row => {
    const match = row.title.match(/pixel \\(([-+\\d.]+), ([-+\\d.]+)\\)/);
    return [Number(match[1]), Number(match[2])];
  })`);
  const from = await clientPoint(...route[0]);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
  for (const point of route.slice(1)) {
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...await clientPoint(...point), button: "left", buttons: 1 });
  }
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...await clientPoint(...route.at(-1)), button: "left", buttons: 0, clickCount: 1 });
}

async function rightClickNaturalPoint(x, y) {
  const point = await clientPoint(x, y);
  await command("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await command("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", buttons: 2, clickCount: 1 });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", buttons: 0, clickCount: 1 });
}

async function pressArrow(key, { shift = false } = {}) {
  const code = key;
  const keyCode = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key];
  await command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers: shift ? 8 : 0,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers: shift ? 8 : 0,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

await command("Runtime.enable");
// A fresh Chrome profile can attach DevTools before the requested navigation
// leaves about:blank, where localStorage is unavailable. Wait for this exact
// app URL before touching storage rather than relying on browser startup speed.
await waitFor(`location.href === ${JSON.stringify(new URL(appUrl).href)}
  && document.readyState !== 'loading'
  && document.querySelector('#source-meta') !== null`);
// Keep the smoke run deterministic even when the shared test browser was used
// manually or by a screenshot helper before this run.
await evaluate("localStorage.removeItem('scidigitizer:language:v1')");
await command("Page.navigate", { url: appUrl });
await command("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});
await waitFor("document.querySelector('#source-meta').textContent.includes('578 × 450')");
const canvasLayers = await evaluate(`(() => {
  const imageCanvas = document.querySelector('#plot-image-canvas');
  const overlayCanvas = document.querySelector('#plot-canvas');
  const surface = document.querySelector('#plot-surface');
  return {
    sameDimensions: imageCanvas.width === overlayCanvas.width
      && imageCanvas.height === overlayCanvas.height,
    overlayPosition: getComputedStyle(overlayCanvas).position,
    imagePointerEvents: getComputedStyle(imageCanvas).pointerEvents,
    surfaceContainsBoth: surface.contains(imageCanvas) && surface.contains(overlayCanvas),
  };
})()`);
assert.equal(canvasLayers.sameDimensions, true);
assert.equal(canvasLayers.overlayPosition, "absolute");
assert.equal(canvasLayers.imagePointerEvents, "none");
assert.equal(canvasLayers.surfaceContainsBoth, true);
const interactiveRenderAudit = await evaluate(`new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const imageCanvas = document.querySelector('#plot-image-canvas');
    const overlayCanvas = document.querySelector('#plot-canvas');
    const imageContext = imageCanvas.getContext('2d');
    const overlayContext = overlayCanvas.getContext('2d');
    const originalImageDraw = imageContext.drawImage;
    const originalOverlayDraw = overlayContext.drawImage;
    const originalOverlayClear = overlayContext.clearRect;
    let imageDraws = 0;
    let overlayImageDraws = 0;
    let overlayClears = 0;
    imageContext.drawImage = function (...args) {
      imageDraws += 1;
      return originalImageDraw.apply(this, args);
    };
    overlayContext.drawImage = function (...args) {
      overlayImageDraws += 1;
      return originalOverlayDraw.apply(this, args);
    };
    overlayContext.clearRect = function (...args) {
      overlayClears += 1;
      return originalOverlayClear.apply(this, args);
    };
    const bounds = overlayCanvas.getBoundingClientRect();
    for (let index = 0; index < 40; index += 1) {
      overlayCanvas.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: bounds.left + 30 + index,
        clientY: bounds.top + 80,
      }));
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      imageContext.drawImage = originalImageDraw;
      overlayContext.drawImage = originalOverlayDraw;
      overlayContext.clearRect = originalOverlayClear;
      resolve({ imageDraws, overlayImageDraws, overlayClears });
    }));
  }));
})`);
assert.equal(interactiveRenderAudit.imageDraws, 0, "pointer movement must not redraw the source image");
assert.equal(interactiveRenderAudit.overlayImageDraws, 0, "the overlay must remain transparent over the stable image layer");
assert.equal(interactiveRenderAudit.overlayClears, 1, "pointer movement should be coalesced into one animation-frame draw");
assert.equal(await evaluate("document.querySelectorAll('[data-language]').length"), 2);
await waitFor("document.documentElement.lang === 'en' && document.querySelector('.panel-section h2').textContent === 'Choose image'");
assert.equal(await evaluate("document.querySelector('[data-language=\"en\"]').getAttribute('aria-pressed')"), "true");
assert.equal(await evaluate("document.querySelector('.privacy-pill').textContent.trim()"), "Local processing · images never leave your device");
assert.equal(await evaluate("document.querySelector('.creator-credit').textContent.trim()"), "Created by Chongbing Qu（瞿崇兵）");
assert.equal(await evaluate("document.querySelector('#pick-seed').textContent"), "Pick target curve");
assert.equal(await evaluate("document.querySelector('#restart-session').textContent"), "Start fresh");
assert.equal(
  await evaluate("document.querySelector('.image-import-hint').textContent"),
  "You can also drop a PNG, JPEG, or WebP anywhere, or paste a screenshot",
);
assert.equal(await evaluate("document.querySelector('#trace-refinement-tools').hidden"), true);
assert.equal(await evaluate("document.querySelector('#trace-output-options').hidden"), true);
assert.equal(await evaluate("document.querySelector('#save-series').hidden"), true);
assert.equal(await evaluate("localStorage.getItem('scidigitizer:language:v1')"), null);
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.panel-collapsible.is-expanded')]
  .map((section) => section.dataset.panelStep)`), ["image"]);
assert.equal(await evaluate("document.querySelector('[data-panel-step=\"plot\"] .section-compact-status').textContent.length > 0"), true);
await evaluate("document.querySelector('[data-panel-step=\"plot\"] > .section-heading').click()");
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.panel-collapsible.is-expanded')]
  .map((section) => section.dataset.panelStep)`), ["plot"]);
assert.equal(await evaluate("document.querySelector('[data-panel-step=\"image\"] > .section-heading').getAttribute('aria-expanded')"), "false");
await evaluate("document.querySelector('[data-panel-step=\"plot\"] > .section-heading').click()");
assert.equal(await evaluate("document.querySelectorAll('.panel-collapsible.is-expanded').length"), 0);
await evaluate(`(() => {
  const heading = document.querySelector('[data-panel-step="calibration"] > .section-heading');
  heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
})()`);
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.panel-collapsible.is-expanded')]
  .map((section) => section.dataset.panelStep)`), ["calibration"]);
await evaluate("document.querySelector('[data-panel-step=\"image\"] > .section-heading').click()");
const untranslatedEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedEnglish, [], `untranslated visible English UI: ${untranslatedEnglish.join(' | ')}`);
if (process.env.ENGLISH_SCREENSHOT_PATH) {
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.ENGLISH_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}
await evaluate("document.querySelector('[data-language=\"zh\"]').click()");
await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('.panel-section h2').textContent === '选择图像'");
assert.equal(await evaluate("localStorage.getItem('scidigitizer:language:v1')"), "zh");
await command("Page.navigate", { url: appUrl });
await waitFor("document.documentElement.lang === 'zh-CN' && document.querySelector('#source-meta')?.textContent.includes('578 × 450')");
assert.equal(await evaluate("document.querySelector('.panel-section h2').textContent"), "选择图像");
assert.equal(await evaluate("document.querySelector('.creator-credit').textContent.trim()"), "作者 Chongbing Qu（瞿崇兵）");
assert.equal(await evaluate("document.querySelector('#trace-point-count').value"), "100");
assert.equal(await evaluate("document.querySelector('#export-density').value"), "curve");
assert.equal(await evaluate("document.querySelector('#sampling-mode').value"), "geometry");
assert.equal(await evaluate("document.querySelector('#target-style').value"), "auto");
assert.equal(await evaluate("document.querySelector('#trace-orientation').value"), "auto");
assert.equal(await evaluate("document.querySelector('#path-refinement').value"), "full");
assert.equal(await evaluate("document.querySelector('#trace-assist-tools').open"), false);
assert.equal(await evaluate("document.querySelector('#color-threshold').closest('details').open"), false);
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
await waitFor("!document.querySelector('#suggest-exclusions').dataset.scanning");
await waitFor("!document.querySelector('#color-suggestions').hidden");
assert.equal(await evaluate("document.documentElement.dataset.computeMode"), expectedComputeMode);
const discoveredColorState = await evaluate(`({
  count: document.querySelectorAll('.color-suggestion-chip').length,
  colors: [...document.querySelectorAll('.color-suggestion-chip span')]
    .map((swatch) => getComputedStyle(swatch).backgroundColor),
  labels: [...document.querySelectorAll('.color-suggestion-chip')]
    .map((button) => button.getAttribute('aria-label')),
})`);
assert.ok(discoveredColorState.count >= 3, JSON.stringify(discoveredColorState));
assert.ok(discoveredColorState.colors.every((color) => {
  const channels = color.match(/\d+/g).slice(0, 3).map(Number);
  return Math.max(...channels) - Math.min(...channels) >= 30;
}), JSON.stringify(discoveredColorState));
assert.ok(discoveredColorState.labels.every((label) => /彩色曲线/.test(label)));
await evaluate("document.querySelector('.color-suggestion-chip').click()");
await waitFor("document.querySelectorAll('.data-point-row').length > 20");
assert.equal(await evaluate("document.querySelector('#color-suggestions').hidden"), true);
assert.match(await evaluate("document.querySelector('#seed-status').textContent"), /RGB\(/);
await evaluate("document.querySelector('#clear-curve').click()");
await waitFor("document.querySelector('#seed-status').textContent === '尚未选择曲线' && !document.querySelector('#color-suggestions').hidden");
assert.equal(await evaluate("document.querySelector('#exclusion-suggestion-review').hidden"), false);
assert.match(await evaluate("document.querySelector('#exclusion-suggestion-status').textContent"), /可信度/);
assert.match(await evaluate("document.querySelector('#plot-status').textContent"), /待复核干扰建议/);
if (process.env.INTERFERENCE_SCREENSHOT_PATH) {
  await evaluate("document.querySelector('[data-panel-step=\"plot\"] > .section-heading').click()");
  await waitFor("document.querySelector('[data-panel-step=\"plot\"]').classList.contains('is-expanded')");
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.INTERFERENCE_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}
await evaluate("document.querySelector('#accept-exclusion-suggestion').click()");
assert.match(await evaluate("document.querySelector('#plot-status').textContent"), /屏蔽区 1/);
assert.equal(await evaluate("document.querySelector('#undo-exclusion').disabled"), false);
await evaluate("document.querySelector('#undo-exclusion').click()");
assert.match(await evaluate("document.querySelector('#plot-status').textContent"), /屏蔽区 0/);
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
assert.equal(await evaluate("document.querySelector('#calibration-snap').checked"), true);
assert.equal(await evaluate("document.querySelector('#x-reference-row-3').hidden"), true);
await evaluate("document.querySelector('#add-x-reference').click()");
assert.equal(await evaluate("document.querySelector('#x-reference-row-3').hidden"), false);
assert.match(await evaluate("document.querySelector('#x-reference-count').textContent"), /3 个参考点/);
await evaluate("document.querySelector('#remove-x-reference').click()");
assert.equal(await evaluate("document.querySelector('#x-reference-row-3').hidden"), true);
if (process.env.CALIBRATION_SCREENSHOT_PATH) {
  await evaluate("document.querySelector('[data-panel-step=\"calibration\"] > .section-heading').click()");
  await waitFor("document.querySelector('[data-panel-step=\"calibration\"]').classList.contains('is-expanded')");
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(process.env.CALIBRATION_SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
}

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
assert.match(await evaluate("document.querySelector('#pick-x-1').textContent"), /px/);
assert.match(await evaluate("document.querySelector('#pick-x-2').textContent"), /px/);
assert.match(await evaluate("document.querySelector('#pick-y-1').textContent"), /px/);
assert.match(await evaluate("document.querySelector('#pick-y-2').textContent"), /px/);
assert.match(await evaluate("document.querySelector('#calibration-status').textContent"), /标定完成/);
assert.equal(await evaluate("document.querySelector('#calibration-quality').classList.contains('good')"), true);
assert.match(await evaluate("document.querySelector('#x-calibration-quality').textContent"), /1 px/);
assert.equal(await evaluate("document.querySelector('#calibration-refine').hidden"), false);
assert.equal(await evaluate("document.querySelector('#calibration-refine-title').textContent"), "微调 y₂");
const calibratedY2 = await evaluate("Number(document.querySelector('#calibration-pixel-position').value)");
assert.ok(Number.isFinite(calibratedY2));
await evaluate("document.querySelector('[data-calibration-nudge=\"0.1\"]').click()");
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - (calibratedY2 + 0.1)) < 1e-8);
await evaluate("document.querySelector('[data-calibration-nudge=\"-0.1\"]').click()");
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - calibratedY2) < 1e-8);
await pressArrow("ArrowUp");
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - (calibratedY2 - 1)) < 1e-8);
await pressArrow("ArrowDown");
await pressArrow("ArrowUp", { shift: true });
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - (calibratedY2 - 0.1)) < 1e-8);
await pressArrow("ArrowDown", { shift: true });
assert.ok(Math.abs(await evaluate("Number(document.querySelector('#calibration-pixel-position').value)") - calibratedY2) < 1e-8);
// Exercise the same ordinary one-click flow from the steep left branch. At
// browser scale this visually valid click can land a few natural pixels off
// the stroke center; it must still recover the complete green curve. Also
// emulate a stale advanced direction restored from an earlier attempt: a new
// target pick must start in automatic mode.
await evaluate("document.querySelector('#trace-orientation').value = 'vertical'");
await clickAtNaturalPoint("#pick-seed", 254, 147);
await waitForComputeIdle();
await waitFor("document.querySelectorAll('.data-point-row').length > 20");
assert.equal(await evaluate("document.querySelector('#trace-orientation').value"), "auto");
const firstTracePixelRange = await evaluate(`(() => {
  const titles = [...document.querySelectorAll('.data-point-row')].map((row) => row.title);
  const pixels = titles.map((title) => {
    const match = title.match(/pixel \\(([-+\\d.]+), ([-+\\d.]+)\\)/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  }).filter(Boolean);
  return {
    minimumX: Math.min(...pixels.map((point) => point.x)),
    maximumX: Math.max(...pixels.map((point) => point.x)),
  };
})()`);
assert.ok(firstTracePixelRange.minimumX <= 82, `green trace starts too late: ${JSON.stringify(firstTracePixelRange)}`);
assert.ok(firstTracePixelRange.maximumX >= 540, `green trace is truncated: ${JSON.stringify(firstTracePixelRange)}`);
assert.equal(await evaluate("document.querySelector('#add-guide').disabled"), false);
assert.equal(await evaluate("document.querySelector('#trace-refinement-tools').hidden"), false);
assert.equal(await evaluate("document.querySelector('#trace-output-options').hidden"), false);
assert.equal(await evaluate("document.querySelector('#save-series').hidden"), false);
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
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelectorAll('.data-point-row.guide-point').length"), 2);
assert.equal(await evaluate("document.querySelector('#review-assistant').classList.contains('waiting')"), false);
const initialReviewRegionCount = await evaluate("Number.parseInt(document.querySelector('#review-region-count').textContent, 10)");
if (initialReviewRegionCount > 0) {
  assert.equal(await evaluate("document.querySelector('#review-resolve').disabled"), false);
  await evaluate("document.querySelector('#review-resolve').click()");
  assert.equal(await evaluate("document.querySelector('#add-guide').classList.contains('button-accent')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.data-point-row.selected').length"), 1);
  assert.match(await evaluate("document.querySelector('#magnifier-coordinate').textContent"), /pixel:\s*\d+/);
  await evaluate("document.querySelector('#add-guide').click()");
}
const draggedGuideTitle = await evaluate("document.querySelectorAll('.data-point-row.guide-point')[1]?.title");
assert.ok(Math.abs(Number(draggedGuideTitle.match(/pixel \(([-+\d.]+)/)?.[1]) - 324) < 0.001,
  `guide drag must retain its subpixel coordinate: ${draggedGuideTitle}`);
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
await evaluate("document.querySelector('.data-point-row:not(.guide-point)').click()");
const selectedPointPixel = () => evaluate(`(() => {
  const title = document.querySelector('.data-point-row.selected')?.title ?? '';
  const match = title.match(/pixel \\(([-+\\d.]+), ([-+\\d.]+)\\)/);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
})()`);
const pointBeforeArrow = await selectedPointPixel();
await pressArrow("ArrowRight");
const pointAfterPixelArrow = await selectedPointPixel();
assert.ok(Math.abs(pointAfterPixelArrow.x - pointBeforeArrow.x - 1) < 1e-8);
await pressArrow("ArrowUp", { shift: true });
const pointAfterFineArrow = await selectedPointPixel();
assert.ok(Math.abs(pointAfterFineArrow.y - pointBeforeArrow.y + 0.1) < 1e-8);
await pressArrow("ArrowLeft");
await pressArrow("ArrowDown", { shift: true });

assert.equal(await evaluate("document.querySelector('#trace-corridor-mode').value"),'strict');
await evaluate("document.querySelector('#trace-corridor-mode').value='local'; document.querySelector('#trace-corridor-mode').dispatchEvent(new Event('change'))");
await waitForComputeIdle();
await evaluate("document.querySelector('#draw-trace-corridor').click()");
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('corridor-mode')"), true);
await paintGreenPeakCorridor();
await waitForComputeIdle();
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /涂画区段内约束/);
assert.equal(await evaluate("document.querySelector('#trace-error').hidden"), true,
  "painting a corridor that covers the curve must successfully retrace through the Worker");
assert.equal(await evaluate("document.querySelector('#clear-trace-corridor').disabled"), false);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);
await evaluate("document.querySelector('#draw-trace-corridor').click()");
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('corridor-mode')"), false);
await evaluate("document.querySelector('#erase-trace-corridor').click()");
const beforeInvalidPen = await evaluate(`[...document.querySelectorAll('.data-point-row')].map(row => row.title)`);
await dragNaturalPoint(298, 146, 302, 158);
await waitForComputeIdle();
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /涂画区段内约束/);
assert.equal(await evaluate("document.querySelector('#trace-error').hidden"), false);
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"), true);
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.data-point-row')].map(row => row.title)`), beforeInvalidPen,
  "a failed Pen retrace must not partially replace the previous output");
assert.equal(await evaluate("document.querySelector('#point-list').inert"), true);
assert.equal(await evaluate("document.querySelector('#point-list-stale').hidden"), false);
assert.equal(await evaluate("document.querySelector('#trace-error').parentElement.classList.contains('workspace')"), true);
assert.equal(await evaluate("document.documentElement.dataset.traceState"), 'stale');
assert.equal(await evaluate(`(() => {
  const warning = document.querySelector('#trace-error').getBoundingClientRect();
  const plot = document.querySelector('#canvas-scroller').getBoundingClientRect();
  return warning.top >= 0 && warning.bottom <= plot.top + 1;
})()`), true, 'failed tracing must be visible above the canvas, not below collapsed sidebar controls');
await evaluate("document.querySelector('#undo-action').click()");
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelector('#trace-error').hidden"), true);
assert.equal(await evaluate("document.querySelector('#point-list').inert"), false);
await evaluate("if (document.querySelector('#erase-trace-corridor').classList.contains('active')) document.querySelector('#erase-trace-corridor').click()");
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
const exportedOverlay = await evaluate(`new Promise((resolve, reject) => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  const timeout = setTimeout(() => reject(new Error('Overlay PNG export timed out')), 5000);
  URL.createObjectURL = (blob) => {
    (async () => {
      try {
        const bitmap = await createImageBitmap(blob);
        const sampleCanvas = document.createElement('canvas');
        sampleCanvas.width = bitmap.width;
        sampleCanvas.height = bitmap.height;
        const sampleContext = sampleCanvas.getContext('2d');
        sampleContext.drawImage(bitmap, 0, 0);
        const corner = [...sampleContext.getImageData(10, 10, 1, 1).data];
        clearTimeout(timeout);
        resolve({ type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height, corner });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      } finally {
        URL.createObjectURL = originalCreateObjectURL;
        URL.revokeObjectURL = originalRevokeObjectURL;
        HTMLAnchorElement.prototype.click = originalAnchorClick;
      }
    })();
    return 'blob:scidigitizer-overlay-smoke';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
  document.querySelector('#export-overlay').click();
})`);
assert.equal(exportedOverlay.type, "image/png");
assert.equal(exportedOverlay.width, 578);
assert.equal(exportedOverlay.height, 450);
assert.equal(exportedOverlay.corner[3], 255, "overlay export must include the opaque source image");
assert.ok(exportedOverlay.size > 10_000, `overlay PNG is unexpectedly small: ${exportedOverlay.size}`);
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
assert.equal(parsedProject.schemaVersion, 8);
assert.equal(parsedProject.extractor.version, "0.20.0-preview.3.21");
assert.equal("calibrationSuggestion" in parsedProject, false);
assert.deepEqual(parsedProject.calibrationReferenceCounts, { x: 2, y: 2 });
assert.equal(parsedProject.calibrationSnapEnabled, true);
assert.equal(parsedProject.activeCurve.calibration.version, 2);
assert.match(parsedProject.extractor.engine, /^parametric-orientation-adaptive-bilingual-occlusion-pattern-gap-ensemble-risk-ranked-review-/);
assert.equal(parsedProject.activeCurve.parameters.orientationMode, "auto");
assert.equal(parsedProject.activeCurve.parameters.resolvedOrientation, "horizontal");
assert.equal(parsedProject.calibrationAudit.x.valid, true);
assert.equal(parsedProject.calibrationAudit.y.valid, true);
assert.equal(parsedProject.activeCurve.calibration.y.value1, 7);
assert.equal(parsedProject.activeCurve.calibration.y.value2, 1);
assert.ok(Array.isArray(parsedProject.qualityReport[0].reviewRegions));
assert.ok("perspective" in parsedProject.preprocessing);
assert.ok(parsedProject.activeCurve.traceCorridorOperations.length > 0);
assert.equal(parsedProject.activeCurve.traceCorridorOperations.some((operation) => operation.mode === "erase"), false,
  "undoing the failed erasure must also restore the persisted Pen operations");
await clickAtNaturalPoint("#pick-seed", 276, 85);
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelector('#trace-assist-tools').open"), false);
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /未绘制/);
assert.equal(await evaluate("document.querySelector('#clear-trace-corridor').disabled"), true);
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

await evaluate("document.querySelector('#trace-corridor-mode').value='local'; document.querySelector('#trace-corridor-mode').dispatchEvent(new Event('change'))");
await waitForComputeIdle();
await evaluate("document.querySelector('#draw-trace-corridor').click()");
assert.equal(await evaluate("document.querySelector('#plot-canvas').classList.contains('corridor-mode')"), true);
await paintGreenPeakCorridor();
await waitForComputeIdle();
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /涂画区段内约束/);
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'dashed';
  delete select.dataset.autoDetected;
  delete select.dataset.autoConfidence;
  delete select.dataset.autoFallback;
})()`);
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
  corridorStatus: document.querySelector('#trace-corridor-status').textContent,
  corridorMode: document.querySelector('#plot-canvas').classList.contains('corridor-mode'),
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
assert.match(afterSave.corridorStatus, /未绘制/);
assert.equal(afterSave.corridorMode, false);
assert.equal(await evaluate("document.querySelector('#target-style').value"), "auto");
assert.equal(await evaluate("document.querySelector('#trace-assist-tools').open"), false);
assert.equal(await evaluate("document.querySelector('#color-suggestions').hidden"), false);
assert.equal(await evaluate(`[...document.querySelectorAll('.color-suggestion-chip span')]
  .some((swatch) => getComputedStyle(swatch).backgroundColor
    === getComputedStyle(document.querySelector('.series-color')).backgroundColor)`), false);

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
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /涂画区段内约束/);
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
const remoteSourceProject = JSON.stringify({
  ...parsedProject,
  source: { ...parsedProject.source, samplePath: "https://example.invalid/should-not-load.png" },
});
await evaluate(`(() => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File([${JSON.stringify(remoteSourceProject)}], 'remote-project.json', { type: 'application/json' }));
  const input = document.querySelector('#project-upload');
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor("document.querySelector('#toast').textContent.includes('示例图片路径不受支持')");
assert.equal(await evaluate("document.querySelector('#project-upload').value"), "");
const unsafeSeriesProject = structuredClone(parsedProject);
unsafeSeriesProject.series = [{
  ...structuredClone(parsedProject.activeCurve),
  id: '\"><img id="series-injection" src=x onerror="document.body.dataset.injected=1">',
  visible: true,
}];
await evaluate(`(() => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(new File([${JSON.stringify(JSON.stringify(unsafeSeriesProject))}], 'fig1-project.json', { type: 'application/json' }));
  const input = document.querySelector('#project-upload');
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await waitFor("document.querySelector('#trace-corridor-status').textContent.includes('涂画区段内约束') && document.querySelectorAll('.data-point-row').length === 100");
assert.match(await evaluate("document.querySelector('#trace-corridor-status').textContent"), /涂画区段内约束/);
assert.equal(await evaluate("document.querySelector('#series-injection') === null"), true);
assert.equal(await evaluate("document.body.dataset.injected ?? null"), null);
assert.match(await evaluate("document.querySelector('.series-item').dataset.seriesId"), /^series-restored-/);
assert.equal(await evaluate("document.querySelector('#project-upload').value"), "");
// Refreshing the ordinary URL is fresh by default, including on repeat visits.
// Automatic image/frame initialization must not replace the previous draft.
await waitFor("['草稿已保存', 'Draft saved'].includes(document.querySelector('#autosave-status').textContent)");
const previousSampleDraft = await evaluate(`(() => {
  const key = Object.keys(localStorage).find(key => key.startsWith('scidigitizer:draft:v1:578x450-'));
  return { key, value: localStorage.getItem(key) };
})()`);
assert.ok(previousSampleDraft.value);
for (let refresh = 0; refresh < 2; refresh += 1) {
  const previousTimeOrigin = await evaluate("performance.timeOrigin");
  await command("Page.reload");
  await waitFor(`performance.timeOrigin !== ${previousTimeOrigin} && document.querySelector('#restore-draft')?.hidden === false`);
  await waitFor("document.querySelector('#source-meta').textContent.includes('578 × 450')");
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(await evaluate(`({
    rows: document.querySelectorAll('.data-point-row').length,
    guides: document.querySelectorAll('.guide-point').length,
    series: document.querySelector('#metric-series').textContent,
    values: ['#x-value-1','#x-value-2','#y-value-1','#y-value-2','#x-label','#y-label','#series-label'].map(s=>document.querySelector(s).value),
    pointCount: document.querySelector('#trace-point-count').value,
    exportDisabled: document.querySelector('#export-csv').disabled,
    undoDisabled: document.querySelector('#undo-action').disabled,
  })`), { rows: 0, guides: 0, series: '0', values: ['', '', '', '', '', '', ''], pointCount: '100', exportDisabled: true, undoDisabled: true });
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(previousSampleDraft.key)})`), previousSampleDraft.value);
}
assert.equal(await evaluate("document.querySelector('#restore-draft').textContent"), '恢复上次草稿');
await evaluate("document.querySelector('#restore-draft').click()");
await waitFor("document.querySelectorAll('.data-point-row').length === 100");
assert.equal(await evaluate("document.querySelector('#restore-draft').hidden"), true);
assert.equal(await evaluate("document.querySelector('#autosave-status').textContent"), '已恢复草稿');
// Even an immediate refresh after editing must flush the pending save, but
// must still open clean. Recovery now refers to the newly edited draft.
const beforePendingRefresh = await evaluate("performance.timeOrigin");
await evaluate(`(() => {
  const input = document.querySelector('#x-label');
  input.value = 'pending-refresh-label';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  window.location.reload();
})()`);
await waitFor(`performance.timeOrigin !== ${beforePendingRefresh} && document.querySelector('#restore-draft')?.hidden === false`);
assert.equal(await evaluate("document.querySelector('#x-label').value"), '');
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 0);
await evaluate("document.querySelector('#restore-draft').click()");
await waitFor("document.querySelectorAll('.data-point-row').length === 100");
assert.equal(await evaluate("document.querySelector('#x-label').value"), 'pending-refresh-label');
await evaluate("document.querySelector('#restart-session').click()");
assert.equal(await evaluate("document.querySelector('#clear-draft-confirm').open"), true);
await evaluate("document.querySelector('#clear-draft-cancel').click()");
assert.equal(await evaluate("document.querySelector('#clear-draft-confirm').open"), false);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 100);
await evaluate("document.querySelector('#restart-session').click()");
const beforeFreshRestartTimeOrigin = await evaluate("performance.timeOrigin");
const beforeFreshRestartSource = await evaluate("document.querySelector('#source-meta').textContent");
await evaluate("document.querySelector('#clear-draft-apply').click()");
await waitFor("document.querySelector('#metric-series').textContent === '0' && document.querySelectorAll('.data-point-row').length === 0");
assert.equal(await evaluate("performance.timeOrigin"), beforeFreshRestartTimeOrigin);
assert.equal(await evaluate("document.querySelector('#source-meta').textContent"), beforeFreshRestartSource);
assert.equal(await evaluate("document.querySelector('#workspace-title').textContent"), "fig1.png");
assert.equal(await evaluate("location.search"), "");
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 0);
assert.equal(await evaluate("document.querySelector('#trace-refinement-tools').hidden"), true);
assert.notEqual(await evaluate("document.querySelector('#autosave-status').textContent"), "已恢复草稿");

const nonImagePaste = await evaluate(`(() => {
  const transfer = new DataTransfer();
  transfer.items.add('not an image', 'text/plain');
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: transfer });
  document.dispatchEvent(event);
  return { prevented: event.defaultPrevented, title: document.querySelector('#workspace-title').textContent };
})()`);
assert.equal(nonImagePaste.prevented, false);
assert.equal(nonImagePaste.title, "fig1.png");

assert.equal(await evaluate(`(async () => {
  const pastedCanvas = document.createElement('canvas');
  pastedCanvas.width = 120;
  pastedCanvas.height = 90;
  const pastedContext = pastedCanvas.getContext('2d');
  pastedContext.fillStyle = '#fff';
  pastedContext.fillRect(0, 0, pastedCanvas.width, pastedCanvas.height);
  pastedContext.strokeStyle = '#111';
  pastedContext.lineWidth = 2;
  pastedContext.strokeRect(10, 10, 100, 70);
  const blob = await new Promise((resolve) => pastedCanvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'clipboard-source.png', { type: 'image/png' }));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: transfer });
  document.dispatchEvent(event);
  return event.defaultPrevented;
})()`), true);
await waitFor("document.querySelector('#workspace-title').textContent === 'pasted-image.png'");
await waitFor("document.querySelector('#plot-status').textContent.includes('px')");

await evaluate(`(async () => {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('scidigitizer:draft:v1:')) localStorage.removeItem(key);
  }
  const markerCanvas = document.createElement('canvas');
  markerCanvas.width = 260;
  markerCanvas.height = 180;
  const markerContext = markerCanvas.getContext('2d');
  markerContext.fillStyle = '#fff';
  markerContext.fillRect(0, 0, markerCanvas.width, markerCanvas.height);
  markerContext.strokeStyle = '#111';
  markerContext.lineWidth = 2;
  markerContext.strokeRect(20, 15, 220, 145);
  markerContext.fillStyle = '#080808';
  for (let index = 0; index < 11; index += 1) {
    const x = 35 + index * 18;
    const y = 125 - index * 5 + Math.round(3 * Math.sin(index));
    markerContext.beginPath();
    markerContext.arc(x, y, 4, 0, Math.PI * 2);
    markerContext.fill();
  }
  const blob = await new Promise((resolve) => markerCanvas.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'marker-smoke.png', { type: 'image/png' }));
  const enter = new Event('dragenter', { bubbles: true, cancelable: true });
  Object.defineProperty(enter, 'dataTransfer', { value: transfer });
  document.dispatchEvent(enter);
  if (document.querySelector('#image-drop-overlay').hidden) throw new Error('drop overlay did not open');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: transfer });
  document.dispatchEvent(drop);
  if (!drop.defaultPrevented) throw new Error('image drop was not accepted');
  if (!document.querySelector('#image-drop-overlay').hidden) throw new Error('drop overlay did not close');
})()`);
await waitFor("document.querySelector('#workspace-title').textContent === 'marker-smoke.png'");
await waitFor("document.querySelector('#plot-status').textContent.includes('px')");
await evaluate(`(() => {
  const select = document.querySelector('#target-style');
  select.value = 'auto';
  select.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await clickAtNaturalPoint("#pick-seed", 89, 110);
await waitForComputeIdle();
await new Promise((resolve) => setTimeout(resolve, 750));
const automaticMarkerState = await evaluate(`({
  style: document.querySelector('#target-style').value,
  autoDetected: document.querySelector('#target-style').dataset.autoDetected ?? null,
  points: document.querySelectorAll('.data-point-row').length,
  seed: document.querySelector('#seed-status').textContent,
  plot: document.querySelector('#plot-status').textContent,
  toast: document.querySelector('#toast').textContent,
})`);
assert.equal(automaticMarkerState.style, "markers", JSON.stringify(automaticMarkerState));
assert.equal(automaticMarkerState.points, 11, JSON.stringify(automaticMarkerState));
assert.equal(await evaluate("document.querySelector('#target-style').dataset.autoDetected"), "markers");
assert.equal(await evaluate("document.querySelector('#trace-curve').disabled"), false);
assert.match(await evaluate("document.querySelector('#target-style-hint').textContent"), /一次点击识别重复 marker/);
const markerProject = JSON.parse(await evaluate(`(async () => {
  let exportedBlob = null;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return 'blob:scidigitizer-marker-project';
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
})()`));
assert.equal(markerProject.activeCurve.parameters.automaticMarkerSeries, true);
assert.ok(markerProject.activeCurve.parameters.automaticMarkerConfidence >= 0.78);
assert.equal(markerProject.activeCurve.anchors.length, 1);
await evaluate("document.querySelector('[data-language=\"en\"]').click()");
await waitFor("document.documentElement.lang === 'en'");
assert.match(await evaluate("document.querySelector('#target-style-hint').textContent"), /recognized from one click/);
const untranslatedMarkerEnglish = await untranslatedVisibleEnglish();
assert.deepEqual(untranslatedMarkerEnglish, [], `untranslated marker English UI: ${untranslatedMarkerEnglish.join(' | ')}`);

// A separate vertical fixture exercises the UI, Worker, output validation and
// export together. Repeated X coordinates are essential, not duplicate guides.
await evaluate(`(async () => {
  const c = document.createElement('canvas'); c.width = 300; c.height = 300;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,300,300);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
  ctx.strokeRect(10,10,280,280);
  ctx.beginPath(); ctx.moveTo(140,30); ctx.lineTo(140,270); ctx.stroke();
  const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'vertical-pen-smoke.png', {type:'image/png'}));
  const drop = new Event('drop', {bubbles:true,cancelable:true});
  Object.defineProperty(drop, 'dataTransfer', {value:transfer}); document.dispatchEvent(drop);
})()`);
await waitFor("document.querySelector('#workspace-title').textContent === 'vertical-pen-smoke.png'");
await waitForComputeIdle();
await evaluate(`(() => {
  document.querySelector('#x-value-1').value='0'; document.querySelector('#x-value-2').value='1';
  document.querySelector('#y-value-1').value='0'; document.querySelector('#y-value-2').value='1';
  document.querySelector('#calibration-snap').checked=false;
  document.querySelector('#x-scale').value='linear'; document.querySelector('#y-scale').value='linear';
})()`);
await clickAtNaturalPoint('#pick-x-1',10,290);
await clickAtNaturalPoint('#pick-x-2',290,290);
await clickAtNaturalPoint('#pick-y-1',10,290);
await clickAtNaturalPoint('#pick-y-2',10,10);
await clickAtNaturalPoint('#pick-seed',140,50);
await waitForComputeIdle();
await clickAtNaturalPoint('#add-guide',140,180);
await waitForComputeIdle();
await clickAtNaturalPoint('#add-guide',140,240);
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelectorAll('.guide-point').length"),3);
await evaluate("document.querySelector('#draw-trace-corridor').click()");
await dragNaturalPoint(140,30,140,270);
await waitForComputeIdle();
await evaluate(`(() => {
  const s=document.querySelector('#trace-corridor-mode'); s.value='strict'; s.dispatchEvent(new Event('change'));
})()`);
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelector('#trace-error').hidden"),true);
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"),false);
const verticalGuideRows = await evaluate(`[...document.querySelectorAll('.guide-point')].map(row => [...row.querySelectorAll('input')].map(input=>Number(input.value)))`);
await evaluate(`(() => {
  const input=document.querySelector('#trace-point-count'); input.value='150'; input.dispatchEvent(new Event('change'));
})()`);
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.guide-point')].map(row => [...row.querySelectorAll('input')].map(input=>Number(input.value)))`), verticalGuideRows);
await evaluate("document.querySelector('#export-density').value='200'");
const verticalCsv = await evaluate(`(async () => {
  let blob; const oldURL=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click;
  URL.createObjectURL=b=>{blob=b; return 'blob:vertical-test';}; HTMLAnchorElement.prototype.click=()=>{};
  try { document.querySelector('#export-csv').click(); return blob ? await blob.text() : null; }
  finally { URL.createObjectURL=oldURL; HTMLAnchorElement.prototype.click=oldClick; }
})()`);
assert.ok(verticalCsv, "vertical export should produce a file");
const verticalExportRows = verticalCsv.trim().split('\n').slice(2).map(line=>line.split(',').map(Number));
assert.equal(verticalExportRows.length,200);
for (const guide of verticalGuideRows) assert.ok(verticalExportRows.some(p => Math.hypot(p[0]-guide[0],p[1]-guide[1])<1e-7),
  `CSV density resampling dropped vertical guide ${guide}`);
assert.ok(verticalExportRows.every(p => Math.abs(p[0]-(140-10)/280)<0.005));
await evaluate("document.querySelector('#save-series').click(); document.querySelector('[data-action=\"edit\"]').click()");
assert.equal(await evaluate("document.querySelector('#trace-corridor-mode').value"),'strict');
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.guide-point')].map(row => [...row.querySelectorAll('input')].map(input=>Number(input.value)))`), verticalGuideRows);

// Old autosave snapshots have no traceStale/scope fields and do not pass through
// project-file import. They must also be validated, without deleting their data.
await waitFor("document.querySelector('#autosave-status').textContent === 'Draft saved'");
await evaluate(`(async () => {
  const key=Object.keys(localStorage).find(key => key.startsWith('scidigitizer:draft:v1:')
    && JSON.parse(localStorage.getItem(key)).snapshot.sourceFingerprint.startsWith('300x300-'));
  if (!key) throw new Error('vertical draft is missing');
  const stored=JSON.parse(localStorage.getItem(key));
  delete stored.snapshot.geometry.traceStale; delete stored.snapshot.geometry.traceError;
  delete stored.snapshot.controls['#trace-corridor-mode'];
  stored.snapshot.geometry.traceOrientation='parametric';
  stored.snapshot.geometry.series=[]; stored.snapshot.geometry.editingSeriesId=null;
  stored.snapshot.geometry.path.find(p=>!p.anchor).x=260;
  localStorage.setItem(key,JSON.stringify(stored));
  window.verticalDraftBeforeOpen = {key, value:localStorage.getItem(key)};
  const blob=await new Promise(resolve=>document.querySelector('#plot-image-canvas').toBlob(resolve,'image/png'));
  const transfer=new DataTransfer(); transfer.items.add(new File([blob],'vertical-pen-smoke.png',{type:'image/png'}));
  const drop=new Event('drop',{bubbles:true,cancelable:true});
  Object.defineProperty(drop,'dataTransfer',{value:transfer}); document.dispatchEvent(drop);
})()`);
await waitFor("document.querySelector('#restore-draft').hidden === false");
await new Promise(resolve => setTimeout(resolve, 650));
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"), 0);
assert.equal(await evaluate("document.querySelectorAll('.guide-point').length"), 0);
assert.equal(await evaluate("document.querySelector('#metric-series').textContent"), '0');
assert.equal(await evaluate("document.querySelector('#x-value-1').value"), '');
assert.equal(await evaluate("document.querySelector('#trace-point-count').value"), '100');
assert.equal(await evaluate("document.querySelector('#restore-draft').textContent"), 'Restore draft');
assert.equal(await evaluate("localStorage.getItem(window.verticalDraftBeforeOpen.key) === window.verticalDraftBeforeOpen.value"), true);
await evaluate("document.querySelector('#restore-draft').click()");
await waitFor("document.querySelector('#trace-error').hidden === false");
assert.equal(await evaluate("document.querySelector('#trace-corridor-mode').value"),'strict');
assert.equal(await evaluate("document.querySelector('#export-csv').disabled"),true);
assert.equal(await evaluate("document.querySelectorAll('.data-point-row').length"),150);
assert.equal(await evaluate("[...document.querySelectorAll('.data-point-row')].some(row=>row.title.includes('pixel (260,'))"),true);
await evaluate("document.querySelector('#retry-trace').click()");
await waitForComputeIdle();
assert.equal(await evaluate("document.querySelector('#trace-error').hidden"),true);
assert.deepEqual(await evaluate(`[...document.querySelectorAll('.guide-point')].map(row => [...row.querySelectorAll('input')].map(input=>Number(input.value)))`), verticalGuideRows);
assert.deepEqual(consoleErrors, []);

process.stdout.write(`${JSON.stringify({ beforeSave, afterSave, consoleErrors }, null, 2)}\n`);
socket.close();
