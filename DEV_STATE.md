# SciDigitizer 开发状态

## 1. Current goal

当前版本 `0.20.0-preview.3.20`。保持普通曲线“一次点击即可完整提取”；引导点、Pen、遮挡框和二维路径仅作歧义场景的可选辅助。Priority 6 进入人工验收阶段，全面测试前不启动新功能阶段。

## 2. Verified completed work

- 人工标定支持 Linear、Log10、Piecewise、每轴 2–5 个参考点、刻度吸附、稳健拟合、残差/不确定度和每曲线独立标定。
- 追踪支持横向多候选、自动近垂直、发卡弯/闭环、显式二维自交/分支、patterned 线、marker、遮挡重连、Pen 和同色避让；引导点精确，推断点保留来源与不确定度。
- Worker/同步回退共用计算引擎；支持本地图片选择、拖放、粘贴、旋转校直、Undo/Redo、草稿、项目及 CSV/TXT/PNG 导出。
- `742a160` 修复二维屏蔽像素泄漏、重复遮挡框、近邻引导点丢失、碎片误报，以及异步撤销、项目导入和发布安全问题。
- `f28ac96` 将初始目标点吸附到局部线宽中心并恢复自动方向，修复陡峭绿色曲线误选纵向半支；手工引导点不自动吸附。

## 3. Key decisions and reasons

- 坐标轴由用户明确标定；自动化集中在提取和复核辅助。
- 普通曲线先走快速路径，证据不足才比较纵向/二维候选，防止高级能力破坏简单流程。
- 引导点为硬约束；无像素支撑处标为推断。证据不足时失败关闭，不把碎片报告为完整曲线。
- 数据保持本地；`file://`、HTTP/Pages 和桌面端共用核心逻辑，发布物保持不可变。

## 4. Core entry points and files

- `index.html`/`styles.css`：界面；`src/app.js`：状态、交互、标定、追踪编排、项目与导出。
- `src/core.js`：标定和普通追踪；`src/compute-engine.js`：模式选择；`src/parametric-trace.js`：二维拓扑与桥接；compute client/worker 负责后台与同步执行。
- `dist/app-file.js`：离线 bundle；`tests/`、accuracy benchmark、real/app smoke 为验证入口。

## 5. Validation performed and observed results

- 本轮 HEAD `f28ac96`；`main` 与本地 Gitea `origin/main` 同步。检查前工作区干净。
- `npm run check`：exit 0，语法及离线 bundle 一致性通过；`npm test`：130/130 通过。
- `npm run smoke:real`：exit 0；绿色陡坡近失点击覆盖 `x=77–546`、96/good；蓝线 79/review，红实线/虚线 50/poor、44/poor。
- 完整 benchmark 本轮未运行。已提交 `.3.19` baseline/report 含 30 个栅格、12 个二维夹具；普通 6 例一键 mean NRMSE `0.0008`、full-span 100%、wrong-branch 0；二维 mean coverage `99.96%`、mean RMSE `0.239 px`。这些不是 `.3.20` 本轮结果。
- 仓库无文档构建命令；本轮未做文档构建、同步或发布。

## 6. Known issues

- 同色干扰旁的 patterned 曲线仍可能需要多个引导点或 Pen；完全遮挡/不可区分分支不能唯一恢复。
- 真实示例无数值 ground truth；smoke 只能验证流程、跨度和内部质量，两条红色案例仍为 poor。
- `.3.20` benchmark、浏览器流程、桌面包和 release 校验未验证；本地忽略目录中的六个平台包仍为 `.3.19`。
- 用户提示 README 有未提交修改，但本轮 Git 与 README staged/unstaged diff 均为空；未保存的编辑器缓冲区未验证。README 本轮未修改。

## 7. Rejected or failed approaches

- 原始近失点击直接作 anchor、或继承旧强制纵向，会截断普通曲线；现改为初始局部吸附并重置 auto。
- Pen/严格引导不默认进入普通流程；无重复间隔或拓扑证据的碎片不无条件连接。

## 8. Next task

全面人工验收 `.3.20`：覆盖简单曲线点击偏移、近垂直、同色/重合/遮挡、Undo/项目恢复、标定和导出。发布前再跑 benchmark、HTTP/`file://` smoke、桌面构建与 `release:verify`，并使用新的不可变版本标签。
