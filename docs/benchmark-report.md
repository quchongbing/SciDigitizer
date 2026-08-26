# SciDigitizer 0.12.0 回归报告

## 目的

回归基准回答两个问题：自动框图是否稳定，以及每条曲线需要多少个人工锚点才能得到可用路径。它不是对真实论文图物理量误差的替代。

## 数据

`tools/generate_synthetic.py` 使用固定种子 `20260719` 生成 30 张 Matplotlib 栅格图，共 72 条 ground-truth 曲线。覆盖：

- 1–5 条系列；
- damped、gaussian、logistic、oscillation、power、sigmoid_peak 六个函数族；
- linear/log X/Y 轴；
- solid、dashed、dotted、dash-dot 和 marker；
- 网格、图内 legend、Gaussian blur 和 JPEG 压缩。

生成图写入被 git 忽略的 `benchmarks/generated/`。`tools/synthetic-node-benchmark.mjs` 直接解码 PNG 并调用与网页相同的核心函数。

## 协议

种子位置从可见曲线像素中选择，以模拟用户在清晰线芯点击，而不是点击虚线空白。目标颜色仍由截图采样；ground truth 颜色只用于基准选择一个可见种子，未传给追踪器。

- 1 anchor：一个颜色种子；
- 2 anchors：颜色种子 + 一个远端引导点；
- 4 anchors：颜色种子 + 三个分布在曲线范围内的引导点。

像素 NRMSE 为纵向像素 RMSE 除以 plot 高度；路径未覆盖完整横向范围时另加覆盖惩罚。`fullSpanRate` 要求至少覆盖 ground-truth 横向范围的 95%。连续路径在评分前使用与网页默认设置相同的法线中心校正和可靠点局部三次拟合；marker 不做连续线拟合。

## 结果

自动 panel bbox 的平均 IoU 为 `1.000`。

| 锚点 | 平均 NRMSE | 中位 NRMSE | 完整覆盖 | NRMSE ≤ 2% |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.0413 | 0.0068 | 0.875 | 0.736 |
| 2 | 0.0236 | 0.0061 | 0.958 | 0.792 |
| 4 | 0.0181 | 0.0062 | 1.000 | 0.819 |

中位误差远低于均值，说明误差主要由少量 legend、密集相交曲线和相近颜色失败拉高。与未做路径精细化的 0.10.0 基线相比，三组锚点配置的平均 NRMSE 均降低约 0.0005，NRMSE ≤ 2% 的比例均提高约 1.4 个百分点。引导点显著改善平均误差与完整覆盖，但四锚点也不能消除图像本身不可辨识的重合。界面因此保留屏蔽区、低置信度 Overlay 和项目质量报告。

## 复现

```bash
npm run benchmark:generate
npm run benchmark
```

机器可读的本轮结果保存在 `benchmarks/baseline.json`。核心单元测试另覆盖标定、抗锯齿取色、厚线亚像素中心、稳健遮挡拟合、相近颜色、solid/dashed 追踪、同色短/长虚线与点划线指纹、实验噪声线、波动自适应采样、marker 中心、屏蔽区、全局引导、重采样、质量告警和 panel 检测。
