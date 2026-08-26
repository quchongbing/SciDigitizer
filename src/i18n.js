const storageKey = "scidigitizer:language:v1";
const supportedLanguages = new Set(["zh", "en"]);
const defaultLanguage = "en";

const englishByChinese = new Map(Object.entries({
  "SciDigitizer — 面向科学论文曲线的本地半自动数值提取工具": "SciDigitizer — local-first curve digitization for scientific plots",
  "科学曲线提取工作台": "Scientific curve digitizer",
  "作者": "Created by",
  "本地处理 · 图片不会上传": "Local processing · images never leave your device",
  "语言": "Language",
  "提取控制面板": "Extraction controls",
  "选择图像": "Choose image",
  "使用内置示例，或打开本地截图": "Use the built-in example or open a local image",
  "内置示例": "Built-in example",
  "fig1 · 彩色多曲线": "fig1 · colored curves",
  "打开图片": "Open image",
  "载入项目": "Load project",
  "等待图像载入…": "Waiting for an image…",
  "方向与校直": "Orientation & alignment",
  "先旋转照片到水平/垂直，再框选绘图区。预览不会改变原图；应用后会重新生成工作图并清除已有提取几何。": "Align the photo before selecting the plot. Preview keeps the source intact; applying rotation rebuilds the working image and clears extracted geometry.",
  "↺ 左转 90°": "↺ 90° left",
  "↻ 右转 90°": "↻ 90° right",
  "恢复 0°": "Reset to 0°",
  "微调角度（拖动或精确输入）": "Fine angle (drag or type)",
  "直接输入 -45° 到 45° 的微调角度": "Enter a fine angle from -45° to 45°",
  "输入": "Angle",
  "当前总旋转": "Total rotation",
  "两点校水平": "Align horizontal (2 points)",
  "两点校垂直": "Align vertical (2 points)",
  "显示校直网格": "Show alignment grid",
  "导入后自动检查水平、垂直与透视畸变": "Checks alignment and perspective after import",
  "未旋转 · 可先导入图片再校直": "No rotation · import an image to align it",
  "取消预览": "Cancel preview",
  "应用旋转": "Apply rotation",
  "绘图区": "Plot area",
  "导入后自动选择最可信 panel，必要时再调整": "The most likely panel is selected automatically; adjust if needed",
  "自动建议": "Auto detect",
  "手动框选": "Select manually",
  "屏蔽图例/文字": "Mask legend/text",
  "撤销屏蔽": "Undo mask",
  "尚未框选": "No plot area selected",
  "坐标标定": "Axis calibration",
  "人工输入刻度值，并点击图中对应刻度": "Enter known values and click their ticks in the image",
  "X 轴": "X axis",
  "Y 轴": "Y axis",
  "X 轴类型": "X axis type",
  "Y 轴类型": "Y axis type",
  "端点值": "Tick value",
  "第三点值": "Third value",
  "X 第一个刻度值": "First X tick value",
  "X 第二个刻度值": "Second X tick value",
  "X 第三个刻度值": "Third X tick value",
  "Y 第一个刻度值": "First Y tick value",
  "Y 第二个刻度值": "Second Y tick value",
  "Y 第三个刻度值": "Third Y tick value",
  "点击刻度 1": "Click tick 1",
  "点击刻度 2": "Click tick 2",
  "点击刻度 3": "Click tick 3",
  "X 轴名称/单位，例如 k [Å⁻¹]": "X label/unit, e.g. k [Å⁻¹]",
  "Y 轴名称/单位，例如 Sii(k)": "Y label/unit, e.g. Sii(k)",
  "微调标定点": "Fine-tune calibration point",
  "像素位置": "Pixel position",
  "标定点减小 1 像素": "Move calibration point −1 pixel",
  "标定点减小 0.1 像素": "Move calibration point −0.1 pixel",
  "标定点增加 0.1 像素": "Move calibration point +0.1 pixel",
  "标定点增加 1 像素": "Move calibration point +1 pixel",
  "可拖动图中十字，或用方向键进行 0.1 px 微调。": "Drag the crosshair or use arrow keys for 0.1 px adjustments.",
  "选中后方向键移动 1 px，Shift+方向键微调 0.1 px。": "After selection, arrow keys move 1 px; Shift+arrow keys fine-tune by 0.1 px.",
  "需要 4 个刻度点": "Four calibration points required",
  "X：等待人工标定": "X: waiting for manual calibration",
  "Y：等待人工标定": "Y: waiting for manual calibration",
  "追踪曲线": "Trace curve",
  "点击目标后立即智能追踪，歧义处再补引导点": "Click the target to trace; add guide points only where ambiguous",
  "曲线名称，例如 DFT-MD / Ti = 6 eV": "Curve name, e.g. DFT-MD / Ti = 6 eV",
  "曲线名称（可选）": "Curve name (optional)",
  "例如 DFT-MD / Ti = 6 eV": "e.g. DFT-MD / Ti = 6 eV",
  "曲线类型": "Curve type",
  "仅在自动识别不合适时修改": "Change only when automatic detection is unsuitable",
  "在目标曲线的清晰位置点击一次": "Click once on a clear part of the target curve",
  "程序会自动取色并立即追踪；普通曲线通常不需要其他设置。": "The app samples the color and traces immediately; ordinary curves usually need no other setup.",
  "目标对象类型": "Target type",
  "自动 / 普通曲线": "Auto / standard curve",
  "连续细线 / 实线": "Continuous / solid line",
  "虚线（学习划线长度和间隔）": "Dashed line (learn dash pattern)",
  "点划线（长划线 + 短点）": "Dash-dot line",
  "点线（短点组成的曲线）": "Dotted line",
  "实验噪声线（保留局部波动）": "Noisy experimental line",
  "圆点 / marker 中心": "Marker centers",
  "选择目标曲线": "Pick target curve",
  "请在图中点击曲线": "Click the curve in the image",
  "重新选择目标": "Pick a different target",
  "添加引导点": "Add guide point",
  "结果需要修正？": "Need to correct the result?",
  "只在分叉、重叠或遮挡时使用": "Use only for branches, overlaps, or occlusions",
  "撤销引导点": "Undo guide",
  "撤销最后引导点": "Undo last guide",
  "框选遮挡 / 图例": "Mask occlusion / legend",
  "屏蔽遮挡/图例": "Mask occlusion/legend",
  "尚未选择曲线": "No curve selected",
  "同色曲线：在分叉前后分别加点。每个引导点都会锁定为追踪基准并进入数据采样；悬停后可直接拖动。": "For same-color branches, add guides before and after the split. Every guide is locked into tracing and sampling and can be dragged.",
  "同色曲线：在分叉前后分别加点。每个引导点都会锁定为追踪基准并进入数据采样；悬停后可直接拖动。遮挡处可按趋势放点。": "For same-color branches, add guides before and after the split. Every guide stays locked; add guides along the expected trend inside occlusions.",
  "普通曲线只需选择目标即可；分叉、重叠或遮挡时再添加引导点并打开可选辅助工具。": "For an ordinary curve, just pick the target. Add guides and open the optional assistance only for branches, overlaps, or occlusions.",
  "重叠 / 遮挡辅助（可选）": "Overlap / occlusion assistance (optional)",
  "普通曲线无需设置；只有自动追踪出现串线、重叠或遮挡时再打开。": "No setup is needed for ordinary curves. Open this only when automatic tracing switches branches, overlaps, or encounters occlusion.",
  "同色 / 遮挡强约束": "Same-color / occlusion constraint",
  "拒绝偏离引导走廊的同色分支；普通曲线无需开启": "Reject same-color branches outside the guide corridor; leave off for ordinary curves",
  "Pen 曲线走廊": "Pen curve corridor",
  "未绘制 · 全绘图区搜索": "Not drawn · search the full plot",
  "用有宽度的笔涂过目标曲线的大致区域；只约束画过的横向区段，重合处可隔离其他曲线。": "Paint a broad corridor around the target curve. Only painted horizontal sections are constrained, isolating other curves at overlaps.",
  "画走廊": "Draw corridor",
  "擦除": "Erase",
  "清除": "Clear",
  "Pen 宽度 / px": "Pen width / px",
  "颜色容差": "Color tolerance",
  "曲线数据点数量": "Curve data points",
  "输出点数量": "Output point count",
  "自动追踪生成，可继续增删修改": "Generated automatically; points remain editable",
  "点": "points",
  "高级追踪参数": "Advanced tracing",
  "数据点分布": "Point distribution",
  "几何自适应（推荐）": "Geometry-adaptive (recommended)",
  "X 等间距": "Uniform X spacing",
  "峰值自适应加密": "Peak-adaptive",
  "实验波动自适应": "Experimental-roughness adaptive",
  "推荐：按平滑后的屏幕弧长和转折自动分配；高斜率和急转弯处更密。": "Recommended: allocate by smoothed screen arc length and turns, with more points on steep or sharply turning segments.",
  "保持总点数不变，在几何加密基础上进一步提高峰顶及两侧密度。": "Keep the same point count while adding density around peaks on top of geometry-adaptive sampling.",
  "保持总点数不变，在几何加密基础上进一步保留偏离局部趋势的快速起伏。": "Keep the same point count while preserving rapid deviations from the local trend on top of geometry-adaptive sampling.",
  "保持总点数不变，严格沿 X 等间距分布。": "Keep the same point count with strictly uniform X spacing.",
  "峰中心相对密度": "Relative peak density",
  "峰值加密范围 / 图宽": "Peak region / plot width",
  "波动区相对密度": "Relative roughness density",
  "局部趋势窗口 / 图宽": "Local trend window / plot width",
  "路径精细化": "Path refinement",
  "线宽中心 + 多模型遮挡恢复": "Stroke center + occlusion recovery",
  "仅做线宽中心校正": "Stroke-center refinement only",
  "关闭（保留原始追踪）": "Off (keep raw trace)",
  "默认沿局部法线寻找抗锯齿像素带的亚像素中心；遮挡段自动比较直线、Hermite 与二次趋势并传播模型分歧。手工引导点始终固定；落在无目标像素处时自动启用局部强约束。": "Find the subpixel stroke center along the local normal. Occlusions compare linear, Hermite, and quadratic models and expose their disagreement. Manual guides stay fixed and automatically constrain adjacent segments when placed where no target pixels remain.",
  "每列最大跳跃 / px": "Maximum jump per column / px",
  "允许虚线间隔 / px": "Allowed dashed gap / px",
  "自动追踪": "Auto trace",
  "重新追踪": "Retrace",
  "重置当前曲线": "Reset current curve",
  "保存当前曲线 · 准备下一条": "Save curve · start the next",
  "尚未保存曲线": "No saved curves",
  "保存后数据点默认隐藏；提取下一条同色曲线时会自动避让已存轨迹。点“显示”可叠加查看，点“编辑”可载入右侧坐标表。CSV/TXT 会合并全部曲线。": "Saved points are hidden by default. Later same-color traces avoid saved paths. Use Show to overlay or Edit to load the coordinate table. CSV/TXT combines all curves.",
  "检查与导出": "Review & export",
  "导出数据及完整提取记录": "Export data and the full extraction record",
  "数据点": "Data points",
  "观测覆盖": "Observed coverage",
  "低置信度": "Low confidence",
  "已存曲线": "Saved curves",
  "X 范围": "X range",
  "Y 范围": "Y range",
  "等待曲线路径": "Waiting for a curve",
  "智能复核": "Smart review",
  "低置信度、遮挡推断或多模型分歧，建议人工检查": "Low confidence, occlusion inference, or model disagreement that merits inspection",
  "追踪后自动标出最需要检查的位置": "The most important review locations appear after tracing",
  "定位当前": "Locate current",
  "下一处": "Next region",
  "完成至少一条曲线后可导出数据": "Complete at least one curve before exporting data",
  "CSV / TXT 采样密度": "CSV / TXT sampling density",
  "使用每条曲线的数据点数量": "Use each curve's current point count",
  "100 点": "100 points",
  "200 点": "200 points",
  "500 点": "500 points",
  "1000 点": "1000 points",
  "导出 CSV": "Export CSV",
  "导出 TXT": "Export TXT",
  "保存项目": "Save project",
  "导出 Overlay PNG": "Export overlay PNG",
  "图像工作区": "Image workspace",
  "先框选单个 panel 的绘图区": "Select one panel's plot area first",
  "编辑历史": "Edit history",
  "撤销最近一次编辑（Ctrl+Z）": "Undo last edit (Ctrl+Z)",
  "重做最近一次编辑（Ctrl+Shift+Z）": "Redo last edit (Ctrl+Shift+Z)",
  "撤销": "Undo",
  "重做": "Redo",
  "自动保存待命": "Autosave ready",
  "重新开始": "Start fresh",
  "清除当前图片的自动保存草稿并重新开始": "Clear the autosaved draft for this image and start fresh",
  "清除草稿并重新开始？": "Clear the draft and start fresh?",
  "这会删除当前图片在此浏览器中的自动保存草稿，并清空绘图区、坐标标定和曲线数据。已经下载的项目、CSV 和图片文件不会受影响。": "This deletes the autosaved draft for the current image in this browser and clears the plot area, calibration, and curves. Downloaded projects, CSV files, and images are not affected.",
  "清除并重新开始": "Clear and start fresh",
  "草稿已清除": "Draft cleared",
  "无法清除当前草稿，请检查浏览器存储权限": "Could not clear the current draft; check browser storage permissions",
  "请确认应用文件完整，或重新打开图片": "check that the application files are complete, or open the image again",
  "适应": "Fit",
  "缩放": "Zoom",
  "待提取的科学图像": "Scientific plot to digitize",
  "正在载入样例…": "Loading sample…",
  "遮挡 / 图例屏蔽区": "Occlusion / legend mask",
  "圆圈即导出数据点（不连线）": "Circles are exported points (not connected)",
  "橙心虚线为遮挡推断点": "Orange dashed circles are inferred through occlusions",
  "引导点（可拖动）": "Guide point (draggable)",
  "引导点": "guide points",
  "观测": "observed",
  "画布已显示": "shown on canvas",
  "画布已隐藏": "hidden on canvas",
  "峰值加密": "peak-adaptive",
  "波动加密": "roughness-adaptive",
  "几何加密": "geometry-adaptive",
  "等间距": "uniform spacing",
  "显示": "Show",
  "隐藏": "Hide",
  "编辑": "Edit",
  "删除": "Delete",
  "目标曲线采样颜色": "Sampled target-curve color",
  "鼠标放大与数据点编辑器": "Magnifier and point editor",
  "鼠标位置放大窗口": "Mouse-position magnifier",
  "鼠标放大窗": "Magnifier",
  "将鼠标移入图像": "Move the pointer over the image",
  "引导菱形与数据圆圈同步显示 · 可回到图中拖动": "Guides and data points are shown here · drag them in the plot",
  "已选 · 方向键 1 px，Shift+方向键 0.1 px": "selected · arrow keys 1 px, Shift+arrow keys 0.1 px",
  "可编辑数据点坐标表": "Editable point coordinate table",
  "数据点坐标": "Point coordinates",
  "悬停行可定位图中圆圈": "Hover a row to locate its circle",
  "清空当前曲线的全部数据点": "Clear all points from the current curve",
  "清空": "Clear",
  "自动追踪后显示全部数据点": "All points appear after automatic tracing",
  "可直接修改坐标 · 上下箭头每次约移动 0.1 px · 左键拖动 · 右键删除最近点": "Edit coordinates · arrow buttons move about 0.1 px · drag points · right-click to delete the nearest",
  "选中后方向键移动 1 px · Shift+方向键微调 0.1 px · 左键拖动 · 右键删除最近点": "Select, then use arrow keys for 1 px or Shift+arrow keys for 0.1 px · drag · right-click to delete the nearest point",
  "上下箭头每次约移动 0.1 px": "Arrow buttons move about 0.1 px",
  "遮挡区已自动局部强约束": "occluded segment constrained automatically",
  "屏蔽区太小，请拖拽框住完整的遮挡、图例或文字": "The mask is too small; drag around the complete occlusion, legend, or label",
  "应用图片旋转？": "Apply image rotation?",
  "旋转会改变像素坐标系。当前绘图区、坐标标定、引导点和曲线数据需要清除，请确认后重新框选和校准。": "Rotation changes the pixel coordinate system. The plot area, calibration, guides, and curve data must be cleared; select and calibrate again afterward.",
  "取消": "Cancel",
  "继续应用": "Apply and continue",

  "可继续标定或调整追踪参数": "Continue calibration or adjust tracing settings",
  "左键空白处新增 · 拖动圆圈/菱形 · 右键删除附近最近的普通点": "Left-click empty space to add · drag circles/guides · right-click to delete the nearest regular point",
  "Pen 走廊需要从已框选的绘图区内开始": "Start the Pen corridor inside the selected plot area",
  "Pen 走廊已完全擦除；恢复全绘图区搜索": "The Pen corridor is fully erased; searching the full plot again",
  "下一个建议": "Next suggestion",
  "自动线型": "Auto line style",
  "连续细线": "Continuous line",
  "虚线指纹": "Dashed fingerprint",
  "点划线指纹": "Dash-dot fingerprint",
  "点线指纹": "Dotted fingerprint",
  "实验噪声线": "Noisy experimental line",
  "marker 中心": "Marker centers",
  "等待自动追踪": "Waiting for automatic tracing",
  "开始下一条曲线": "Start the next curve",
  "更新当前曲线 · 准备下一条": "Update curve · start the next",
  "路径覆盖、观测比例和边界检查均通过": "Coverage, observation ratio, and boundary checks passed",
  "还没有可评估的曲线路径": "No curve path is available for assessment",
  "分段标定中有一段过短，建议把第三点与相邻点拉开": "One piecewise calibration segment is too short; move the third point farther away",
  "当前编辑曲线没有数据点 · 可重新追踪，或重置以恢复已保存数据": "The curve being edited has no points · retrace it or reset to restore the saved data",
  "追踪后自动标出最需要检查的位置": "Important review locations appear after tracing",
  "未发现需要重点复核的局部区间；用户修正点和引导基准已自动排除": "No high-priority local region found; edited points and guides are excluded automatically",
  "遮挡推断": "Occlusion inference",
  "低置信度": "Low confidence",
  "同色候选歧义": "Ambiguous same-color candidates",
  "拟合不确定度较高": "High fitting uncertainty",
  "遮挡恢复模型分歧": "Occlusion-model disagreement",
  "疑似贴近坐标轴边界": "Possibly following an axis boundary",
  "自动追踪后显示全部数据点": "All points appear after automatic tracing",
  "当前编辑曲线已清空；可重新自动追踪，或重置当前曲线恢复已存版本": "The current curve is empty; retrace it or reset to restore its saved version",
  "当前没有正在编辑的曲线；点击已存曲线的“编辑”载入坐标": "No curve is being edited; click Edit on a saved curve to load its coordinates",
  "沿水平方向": "Horizontal direction",
  "沿垂直方向": "Vertical direction",
  "拖动蓝色十字或按 ←/→；每次 0.1 px，Shift 为 1 px。": "Drag the blue crosshair or press ←/→; 0.1 px per step, or 1 px with Shift.",
  "拖动紫色十字或按 ↑/↓；每次 0.1 px，Shift 为 1 px。": "Drag the purple crosshair or press ↑/↓; 0.1 px per step, or 1 px with Shift.",
  "方向键可上下左右移动蓝色十字；每次 1 px，Shift+方向键为 0.1 px。": "Use arrow keys to move the blue crosshair in any direction by 1 px; Shift+arrow moves 0.1 px.",
  "方向键可上下左右移动紫色十字；每次 1 px，Shift+方向键为 0.1 px。": "Use arrow keys to move the purple crosshair in any direction by 1 px; Shift+arrow moves 0.1 px.",
  "正在保存…": "Saving…",
  "草稿已保存": "Draft saved",
  "存储空间不足": "Not enough storage",
  "已恢复草稿": "Draft restored",
  "没有可撤销的操作": "Nothing to undo",
  "没有可重做的操作": "Nothing to redo",
  "图像": "Image",
  "原图": "source",
  "工作图": "working image",
  "原图方向": "Original orientation",
  "预览（尚未应用）": "Preview (not applied)",
  "已透视矫正": "Perspective corrected",
  "未发现需要自动旋转的可靠证据": "No reliable evidence that rotation is needed",
  "已自动消除可靠的梯形透视畸变": "Corrected a reliable trapezoidal perspective distortion",
  "疑似透视畸变但置信度不足，建议人工核对边框": "Possible perspective distortion with low confidence; inspect the frame manually",
  "绘图区边框未见明显透视畸变": "No clear perspective distortion found in the plot frame",
  "校直预览中": "Alignment preview",
  "未标定": "Not calibrated",
  "标定完成 · 可导出物理坐标": "Calibration complete · physical coordinates can be exported",
  "X：等待完整人工标定": "X: waiting for complete manual calibration",
  "Y：等待完整人工标定": "Y: waiting for complete manual calibration",
  "遮挡处可按趋势放点。": "Add guides along the expected trend inside occlusions.",
  "已自动选择最可信绘图区": "Selected the most likely plot area automatically",
  "文件保存失败，请检查目标目录权限": "Could not save the file. Check the destination folder permissions",
  "应用图片旋转会清除当前框选、标定和曲线数据，是否继续？": "Applying rotation clears the plot selection, calibration, and curve data. Continue?",
  "在图上从一个角拖到对角，框选单个 panel 的绘图区": "Drag between opposite corners to select one panel's plot area",
  "点击 X 轴的第一个已知刻度位置": "Click the first known X-axis tick",
  "点击 X 轴的第二个已知刻度位置": "Click the second known X-axis tick",
  "点击 X 轴分段映射的第三个已知刻度位置": "Click the third known X-axis tick for piecewise mapping",
  "点击 Y 轴的第一个已知刻度位置": "Click the first known Y-axis tick",
  "点击 Y 轴的第二个已知刻度位置": "Click the second known Y-axis tick",
  "点击 Y 轴分段映射的第三个已知刻度位置": "Click the third known Y-axis tick for piecewise mapping",
  "点击目标曲线的清晰位置以采样颜色；这会开始一条新的追踪路径": "Click a clear part of the target curve to sample its color and start a new trace",
  "点击目标曲线应经过的位置；遮挡处也可按趋势放置，右键菱形可删除": "Click where the curve should pass, including along an expected occluded trend; right-click a guide diamond to delete it",
  "拖拽框住遮挡、图例、文字或其他不应参与追踪的区域；框内将由引导点和两侧趋势恢复": "Drag around an occlusion, legend, label, or other area tracing should ignore; guides and the trends on both sides recover the masked interval",
  "按住左键沿目标曲线涂画；只在画过的横向区段内限制自动追踪": "Hold the left button and paint along the target curve; only painted horizontal sections constrain tracing",
  "按住左键擦除 Pen 走廊；完全擦空的横向区段会恢复普通搜索": "Hold the left button to erase the Pen corridor; fully erased horizontal sections return to normal search",
  "校水平：把十字中心对准同一条水平参考线，依次点击相距较远的 R1、R2": "Horizontal alignment: place the crosshair on one horizontal reference and click distant R1 and R2 points",
  "校垂直：把十字中心对准同一条垂直参考线，依次点击相距较远的 R1、R2": "Vertical alignment: place the crosshair on one vertical reference and click distant R1 and R2 points",
  "已准备下一条曲线；请点击目标曲线取色": "Ready for the next curve; click the target to sample its color",
  "Pen 走廊已清除；恢复全绘图区搜索": "Pen corridor cleared; searching the full plot again",
  "Pen 边界修正": "Pen boundary correction",
}));

const dynamicPatterns = [
  [/无法载入 ([^；]+)；请确认应用文件完整，或重新打开图片/g, "Could not load $1; check that the application files are complete, or open the image again"],
  [/路径只覆盖绘图区宽度的 ([\d.]+)%；可增加虚线间隔或添加引导点/g, "The path covers only $1% of the plot width; increase the allowed gap or add guides"],
  [/只有 ([\d.]+)% 的点直接来自图像，插值比例偏高/g, "Only $1% of points are directly observed; the inferred fraction is high"],
  [/([\d.]+)% 的路径处于低置信度；重点核对圆点与原曲线的贴合/g, "$1% of the path has low confidence; inspect point-to-curve alignment"],
  [/([\d.]+)% 的列存在多个同色候选；黑白图或曲线族应重点核对引导点/g, "$1% of columns contain multiple same-color candidates; inspect guides in monochrome plots or curve families"],
  [/([\d.]+)% 的 marker 贴近绘图区边界；请确认这些实验点确实位于坐标轴上/g, "$1% of markers are near the plot boundary; confirm that they belong on the axis"],
  [/路径有 ([\d.]+)% 贴近上下边框，可能误追了坐标轴/g, "$1% of the path is near the top or bottom frame and may be following an axis"],
  [/最长连续插值 ([\d.]+) px；该区间的信息可能已被图例或遮挡破坏/g, "The longest inferred gap is $1 px; a legend or occlusion may have removed its evidence"],
  [/基准只覆盖坐标轴的 ([\d.]+)%，像素误差会被明显放大/g, "Calibration spans only $1% of the axis, strongly amplifying pixel error"],
  [/基准覆盖坐标轴的 ([\d.]+)%；建议选择距离更远的清晰刻度/g, "Calibration spans $1% of the axis; choose clearer ticks farther apart"],
  [/([XY]) 标定点未落在同一(?:水平|垂直)刻度线上（偏差 ([\d.]+) px）/g, "$1 calibration points are not aligned on one tick line (offset $2 px)"],
  [/待检查 (\d+)\/(\d+)/g, "Inspect $1/$2"],
  [/已(?:保存|更新)曲线“([^”]+)”；数据点已隐藏，可继续选择下一条曲线/g, "Saved curve “$1”; its points are hidden and the next curve can be selected"],
  [/([XY])：跨度 ([\d.]+) px（轴宽 ([\d.]+)%） · 1 px ≈ ([\d.]+) 坐标单位 · 基准跨度良好/g, "$1: span $2 px ($3% of axis) · 1 px ≈ $4 coordinate units · good reference span"],
  [/([XY])：跨度 ([\d.]+) px（轴宽 ([\d.]+)%） · 1 px 约 ×\/÷([\d.]+) · 基准跨度良好/g, "$1: span $2 px ($3% of axis) · 1 px ≈ ×/÷$4 · good reference span"],
  [/已新增数据点；当前共 (\d+) 点/g, "Added a data point; $1 points total"],
  [/已自动选择图框 (\d+)\/(\d+)；如不正确可切换建议/g, "Selected plot frame $1/$2 automatically; switch suggestions if needed"],
  [/已自动选择最可信绘图区；共发现 (\d+) 个候选/g, "Selected the most likely plot area automatically; found $1 candidates"],
  [/([XY]) 轴需要点击 (\d+) 个已知刻度位置/g, "$1 axis needs $2 known tick positions"],
  [/([XY]) 轴分段标定需要点击 (\d+) 个刻度位置/g, "$1 piecewise axis needs $2 tick positions"],
  [/([XY]) 轴刻度值必须是有效数字/g, "$1 axis tick values must be valid numbers"],
  [/([XY]) 轴的 (\d+) 个刻度位置不能重合/g, "$1 axis tick positions must not overlap"],
  [/([XY]) 轴的 (\d+) 个刻度值必须互不相同/g, "$1 axis tick values must be distinct"],
  [/([XY]) 轴的刻度值必须随像素位置保持单调，不能在第三点反向/g, "$1 axis values must remain monotonic with pixel position"],
  [/([XY]) 轴相邻刻度位置至少需要相距 ([\d.]+) px/g, "$1 axis adjacent ticks must be at least $2 px apart"],
  [/([XY]) 轴两个端点的刻度值不能相同/g, "$1 axis endpoint values must differ"],
  [/([XY]) 轴两个刻度位置至少需要相距 ([\d.]+) px/g, "$1 axis ticks must be at least $2 px apart"],
  [/([XY]) 轴为 Log10 时，两个刻度值都必须大于 0/g, "$1 Log10 axis values must both be positive"],
  [/(CSV|TXT) 已导出 (\d+) 条曲线；每条曲线占相邻的 X\/Y 两列/g, "$1 exported $2 curves; each curve uses adjacent X/Y columns"],
  [/可导出 (\d+) 条曲线的物理坐标/g, "Physical coordinates ready for $1 curves"],
  [/可导出 (\d+) 条曲线/g, "$1 curves ready to export"],
  [/已保存 (\d+) 条曲线/g, "Saved $1 curves"],
  [/中心校正 (\d+) 点/g, "centered $1 points"],
  [/多模型遮挡恢复 (\d+) 点/g, "recovered $1 occluded points"],
  [/(\d+) 个遮挡内引导点已自动局部强约束/g, "$1 guides inside occlusions automatically constrained adjacent segments"],
  [/已添加遮挡\/干扰屏蔽区 (\d+)；框内像素不参与追踪，将由引导点和两侧趋势恢复/g, "Added occlusion/interference mask $1; guides and trends on both sides recover the ignored pixels"],
  [/已约束 (\d+) 列 · 未画区段照常搜索/g, "$1 columns constrained · unpainted sections use normal search"],
  [/Pen 走廊约束 (\d+) 列/g, "Pen corridor constrains $1 columns"],
  [/边界修正 (\d+) 点/g, "$1 points corrected to the boundary"],
  [/Pen 走廊已更新；当前约束 (\d+) 列，并已自动重新追踪/g, "Pen corridor updated; $1 columns constrained and the curve was retraced"],
  [/Pen 走廊已更新；当前约束 (\d+) 列/g, "Pen corridor updated; $1 columns constrained"],
  [/已擦除部分 Pen 走廊；当前约束 (\d+) 列/g, "Part of the Pen corridor was erased; $1 columns remain constrained"],
  [/Pen 走廊已清除；恢复全绘图区搜索，并已自动重新追踪/g, "Pen corridor cleared; full-plot search restored and the curve was retraced"],
  [/其中 (\d+) 个直接来自图像/g, "$1 are directly observed in the image"],
  [/生成 (\d+) 个数据点/g, "generated $1 data points"],
  [/已避让 (\d+) 条同色已存曲线/g, "avoided $1 saved same-color curves"],
  [/(\d+) 个引导基准点/g, "$1 guide points"],
  [/(\d+) 个数据点/g, "$1 data points"],
  [/(\d+) 数据点/g, "$1 data points"],
  [/(\d+) 引导点/g, "$1 guide points"],
  [/(\d+) 个真实 marker/g, "$1 real markers"],
  [/(\d+) 个 marker 中心/g, "$1 marker centers"],
  [/(\d+) 条曲线/g, "$1 curves"],
  [/(\d+) 处/g, "$1 regions"],
  [/(\d+) 点/g, "$1 points"],
  [/第 (\d+) 点/g, "point $1"],
  [/第 (\d+) 个引导点/g, "guide point $1"],
  [/建议 (\d+)\/(\d+)/g, "suggestion $1/$2"],
  [/屏蔽区 (\d+)/g, "$1 masked regions"],
  [/当前 (\d+)\/(\d+)/g, "Current $1/$2"],
  [/质量 (\d+)\/100/g, "Quality $1/100"],
  [/最低质量分 (\d+)\/100/g, "lowest quality $1/100"],
  [/旋转 ([+\-\d.]+)°/g, "rotation $1°"],
  [/已应用 ([+\-\d.]+)°/g, "Applied $1°"],
  [/预览 ([+\-\d.]+)°/g, "Preview $1°"],
  [/方向偏差约 ([+\-\d.]+)°，在安全阈值内/g, "Estimated skew $1°, within the safe threshold"],
  [/点击刻度 (\d+)/g, "Click tick $1"],
];
const phraseTranslations = [...englishByChinese.entries()]
  .sort((left, right) => right[0].length - left[0].length);

let currentLanguage = defaultLanguage;
const textNodeState = new WeakMap();
const attributeState = new WeakMap();
let observer = null;

function storedLanguage() {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return supportedLanguages.has(stored) ? stored : defaultLanguage;
  } catch {
    return defaultLanguage;
  }
}

export function normalizeLanguage(language) {
  return supportedLanguages.has(language) ? language : defaultLanguage;
}

export function getLanguage() {
  return currentLanguage;
}

export function translateMessage(value, language = currentLanguage) {
  const source = String(value ?? "");
  if (normalizeLanguage(language) === "zh" || !source) return source;
  const exact = englishByChinese.get(source);
  if (exact) return exact;
  let translated = source;
  for (const [pattern, replacement] of dynamicPatterns) translated = translated.replace(pattern, replacement);
  for (const [chinese, english] of phraseTranslations) {
    if (chinese.length < 2 || !translated.includes(chinese)) continue;
    translated = translated.replaceAll(chinese, english);
  }
  return translated;
}

function localizedText(source) {
  const leading = source.match(/^\s*/)?.[0] ?? "";
  const trailing = source.match(/\s*$/)?.[0] ?? "";
  const end = trailing.length ? source.length - trailing.length : source.length;
  if (end <= leading.length) return source;
  const content = source.slice(leading.length, end);
  if (!content) return source;
  return `${leading}${translateMessage(content)}${trailing}`;
}

function localizeTextNode(node) {
  if (node.parentElement?.closest("[data-i18n-skip]")) return;
  const current = node.nodeValue ?? "";
  let state = textNodeState.get(node);
  if (!state || current !== state.localized) state = { source: current, localized: current };
  const localized = currentLanguage === "en" ? localizedText(state.source) : state.source;
  state.localized = localized;
  textNodeState.set(node, state);
  if (current !== localized) node.nodeValue = localized;
}

function localizeAttribute(element, attribute) {
  if (element.closest?.("[data-i18n-skip]")) return;
  const current = element.getAttribute(attribute);
  if (current === null) return;
  let states = attributeState.get(element);
  if (!states) {
    states = new Map();
    attributeState.set(element, states);
  }
  let state = states.get(attribute);
  if (!state || current !== state.localized) state = { source: current, localized: current };
  const localized = currentLanguage === "en" ? translateMessage(state.source) : state.source;
  state.localized = localized;
  states.set(attribute, state);
  if (current !== localized) element.setAttribute(attribute, localized);
}

function localizeTree(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE) {
    for (const attribute of ["aria-label", "placeholder", "title", "content"]) {
      localizeAttribute(root, attribute);
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node);
    else {
      for (const attribute of ["aria-label", "placeholder", "title", "content"]) {
        localizeAttribute(node, attribute);
      }
    }
    node = walker.nextNode();
  }
}

function syncLanguageControls() {
  document.documentElement.lang = currentLanguage === "en" ? "en" : "zh-CN";
  for (const button of document.querySelectorAll("[data-language]")) {
    const active = button.dataset.language === currentLanguage;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

export function refreshTranslations(root = document) {
  localizeTree(root);
  syncLanguageControls();
}

export function setLanguage(language) {
  const normalized = normalizeLanguage(language);
  if (normalized === currentLanguage) return false;
  currentLanguage = normalized;
  try {
    window.localStorage.setItem(storageKey, normalized);
  } catch {
    // Language selection remains active even when local storage is unavailable.
  }
  refreshTranslations(document);
  window.dispatchEvent(new CustomEvent("languagechange", { detail: { language: normalized } }));
  return true;
}

export function initializeI18n() {
  currentLanguage = storedLanguage();
  refreshTranslations(document);
  if (!observer) {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") localizeTextNode(mutation.target);
        if (mutation.type === "attributes") localizeAttribute(mutation.target, mutation.attributeName);
        for (const node of mutation.addedNodes ?? []) localizeTree(node);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "placeholder", "title", "content"],
    });
  }
  return currentLanguage;
}
