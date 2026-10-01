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
  assert.equal(
    translateMessage("扫描图例 / 文字干扰", "en"),
    "Scan legend / text interference",
  );
  assert.equal(
    translateMessage("重叠 / 遮挡辅助（可选）", "en"),
    "Overlap / occlusion assistance (optional)",
  );
  assert.equal(translateMessage("清除并重新开始", "en"), "Clear and start fresh");
  assert.equal(translateMessage("可能的彩色曲线", "en"), "Possible coloured curves");
  assert.equal(
    translateMessage("已从一次点击识别重复 marker；请直接复核中心。只有附近存在同色点列时才需要补引导点。", "en"),
    "A repeated marker series was recognized from one click. Review the centers; add guides only if another same-color marker series is nearby.",
  );
  assert.equal(translateMessage("智能消歧", "en"), "Smart disambiguation");
  assert.equal(translateMessage("定位并确认分支", "en"), "Locate and confirm branch");
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
    translateMessage("已添加遮挡/干扰屏蔽区 2；框内像素不参与追踪，程序会在远端自动重连；若仍有歧义再添加引导点", "en"),
    "Added occlusion/interference mask 2; the app reconnects on the far side; add a guide only if ambiguity remains",
  );
  assert.equal(
    translateMessage("跨遮挡自动重连 1 段", "en"),
    "masked-gap reconnections: 1",
  );
  assert.equal(
    translateMessage("中心校正 42 点 / 遮挡恢复 0 点 / 虚线间隔 28 个推断点", "en"),
    "centered 42 points / recovered 0 occluded points / inferred 28 patterned-gap points",
  );
  assert.equal(
    translateMessage("识别到 11 个 marker 中心 · 柔性引导。已检测独立圆点及粘在线上的局部圆核", "en"),
    "Detected 11 marker centers with flexible guidance, including isolated markers and local marker cores attached to lines",
  );
  assert.equal(
    translateMessage("CSV/TXT 暂不可用：Curve 1 的 X 轴需要点击 2 个已知刻度位置；Curve 1 的 Y 轴需要点击 2 个已知刻度位置", "en"),
    "CSV/TXT unavailable: Curve 1: X axis needs 2 known tick positions; Curve 1: Y axis needs 2 known tick positions",
  );
  assert.equal(
    translateMessage("发现 2 个可能的图例或文字干扰区；请逐个复核后接受", "en"),
    "Found 2 possible legend or text regions; review before accepting",
  );
  assert.equal(
    translateMessage("候选 2 · 可信度 96%", "en"),
    "Candidate 2 · confidence 96%",
  );
  assert.equal(
    translateMessage("Pen 走廊已更新；当前约束 84 列，并已自动重新追踪", "en"),
    "Pen corridor updated; 84 columns constrained and the curve was retraced",
  );
  assert.equal(
    translateMessage("Pen 走廊约束 84 列 / 边界修正 7 点", "en"),
    "Pen corridor constrains 84 columns / 7 points corrected to the boundary",
  );
  const calibrationSummary = translateMessage(
    "X：3 个参考点 · 跨度 400 px（轴宽 80%） · 1 px ≈ 0.02 坐标单位 · 拟合 RMS 0.1 px · 中部约 ±0.01 坐标单位 · 基准跨度良好",
    "en",
  );
  assert.equal(/\p{Script=Han}/u.test(calibrationSummary), false);
  assert.match(calibrationSummary, /3 reference points/);
  assert.match(calibrationSummary, /fit RMS 0.1 px/);
});
