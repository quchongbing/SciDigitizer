import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeLanguage,
  translateMessage,
} from "../src/i18n.js";

test("language normalization keeps English as the safe default", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("zh"), "zh");
  assert.equal(normalizeLanguage("fr"), "en");
});

test("static interface labels translate to concise English", () => {
  assert.equal(translateMessage("选择图像", "en"), "Choose image");
  assert.equal(translateMessage("保存当前曲线 · 准备下一条", "en"), "Save curve · start the next");
  assert.equal(translateMessage("框选遮挡 / 图例", "en"), "Mask occlusion / legend");
  assert.equal(translateMessage("选择图像", "zh"), "选择图像");
});

test("dynamic trace summaries retain their numeric values in English", () => {
  assert.equal(
    translateMessage("RGB(0, 139, 0) · 连续细线 · 2 个引导基准点 · 100 个数据点", "en"),
    "RGB(0, 139, 0) · Continuous line · 2 guide points · 100 data points",
  );
  assert.equal(
    translateMessage("可导出 3 条曲线的物理坐标", "en"),
    "Physical coordinates ready for 3 curves",
  );
  assert.equal(translateMessage("待检查 1/2", "en"), "Inspect 1/2");
  assert.equal(
    translateMessage("CSV 已导出 2 条曲线；每条曲线占相邻的 X/Y 两列", "en"),
    "CSV exported 2 curves; each curve uses adjacent X/Y columns",
  );
  assert.equal(
    translateMessage("已添加遮挡/干扰屏蔽区 2；框内像素不参与追踪，将由引导点和两侧趋势恢复", "en"),
    "Added occlusion/interference mask 2; guides and trends on both sides recover the ignored pixels",
  );
  assert.equal(
    translateMessage("Pen 走廊已更新；当前约束 84 列，并已自动重新追踪", "en"),
    "Pen corridor updated; 84 columns constrained and the curve was retraced",
  );
  assert.equal(
    translateMessage("Pen 走廊约束 84 列 / 边界修正 7 点", "en"),
    "Pen corridor constrains 84 columns / 7 points corrected to the boundary",
  );
});
