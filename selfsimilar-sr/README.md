# 单图自相似超分辨率工具（selfsimilar-sr）

从**单幅输入图像自身的多尺度结构**寻找可迁移的细节，在显式代价与置信度约束下
重建更高分辨率结果。零第三方运行时依赖，仅使用 Node.js 内置模块（含 `zlib`），
工程可离线、确定性复现。

仓库同时附带一套**自相似放大评测素材**：全部由矢量/程序化场景生成，参照图与运行
输入隔离，测试/核验脚本可重建全部素材。

---

## 一、图形入口（文档要求列出的自相似放大图形入口）

```bash
cd selfsimilar-sr
node cli/server.js          # 默认 http://localhost:8123/
# 或：npm run gui
```

浏览器打开 **http://localhost:8123/**，进入「自相似图像恢复窗口」。所有控件都由
`engine/` 内核驱动，界面与命令行不是两套实现：

1. **载入图像与选择倍率**：从下拉框选择评测场景（或上传 PNG），选择 2×/3×/4×；
   “从评测资源载入输入”只读取 `assets/inputs/**` 的 LR 输入。
2. **参数**：块大小、步长、金字塔层数、置信阈值、亮度代价权重、旋转惩罚、尺度惩罚、
   反投影迭代、降质 σ。
3. **预览：放大细节与可信程度**：同一窗口切换
   **SR 重建 / 双三次基线 / SR−双三次差异 / 迁移区域 / 置信热图 / 投回输入尺度 /
   观测残差**，并显示输出尺寸、耗时、观测残差 RMS/峰值、平均置信度、细节迁移占比。
4. **候选块与匹配可信度**：在 SR 图上点击任意网格块，列出该块**实际参与匹配**的
   候选块，逐项显示 `SSD/像素`、亮度差、旋转代价、尺度代价、总代价、源位置，
   并按其真实置信度与阈值判定“允许迁移”还是“门控回退”。
5. **异常提示**：由 `engine/anomaly.js` 从本次重建的内部一致性计算得出
   （见下文），不是固定文案；点击异常卡片可跳到迁移视图定位。
6. **参数影响扫描**：同一输入多个置信阈值重跑，对比迁移占比、置信度、残差、异常数。

**失败反馈回自相似放大**：内核抛出的错误（未载入、参数越界、块位置不存在等）
通过 HTTP 返回并显示在状态栏；浏览器端不做任何图像计算。

### 隔离契约（执行器不能偷读清晰答案）

| 层 | 措施 |
|---|---|
| 文件系统 | 参照 `assets/references/**/HR.png` 与输入 `assets/inputs/**/LR.png` 分目录存放 |
| 内容封印 | `assets/ledger.json` 记录每张参照的像素摘要；`eval/run_eval.js` 对输入按**内容摘要**校验，命中参照即拒绝（退出码 3），改名无效 |
| HTTP | `serveAsset` 对 `assets/references/` 直接抛错；窗口只能载入 `assets/inputs/` |
| 进程边界 | 匹配内核只收到解码后的 LR；参照仅由 `eval/reference.js` 在重建完成后打开 |

`tools/verify.js` 会端到端复核以上四点。

**隔离范围说明**：隔离针对“资产路径与资产内容”。按交付要求，`scenes/defs/*.js` 与
`assets/scenes/*.json`（可编辑场景源）本身就在仓库里，任何人都能据此重新渲染参照；
因此这套机制防的是执行器**按路径约定偷读现成清晰答案**、以及把 `HR.png` 改名后
当作输入，而不是密码学意义上的保密。若要严格盲测，应只把 `assets/inputs/**` 与
`engine/` 交给执行方，由评测方单独持有 `scenes/`、`assets/references/` 与 `eval/`。

---

## 二、评测素材套件（`assets/`，全部可重建）

### 场景家族

| 场景 | 家族 | 内容 | 刻意安排的反例 |
|---|---|---|---|
| `facade` | 重复建筑纹理 | 重复窗格、阳台细杆、抹灰噪声 | 两个 decoy 窗格：高光镜像、竖梃移位、多一道细杆（只在参照分辨率存在） |
| `linechart` | 孤立细线 | 不规则横线、刻度梳、hairline 圆、孤立斜线 | 复制相邻周期会造出错误的规则线；中间短划在参照分辨率下有 1.2 px 断口；空白地面 |
| `signboard` | 伪文字图形 | 程序化字形带、边框、阴影 | 易把相似字形/终端错误搬移；decoy 字形多一个笔画 |
| `randomfield` | 无可借用细节的随机区域 | 带限噪声 + 稀疏斑点 | 统计自相似但无精确重复，正确行为是大面积回退 |
| `masonry` | 重复砖石/网格 | 砖缝、错缝、细高光 | 三块 decoy 砖：斜向斑纹反向并多一道细缺口（只在参照分辨率存在）；4× 下出现负增益与大量错误迁移 |

每个场景在 `scenes/defs/*.js` 中定义尺寸、种子、绘制指令与 `regions`
（区域名、类别、矩形、预期）。区域窗口都对准实际反例几何并按 12 的倍数取整，
因此 2/3/4× 下都能整块对齐。共 30 个区域：`facade` 6 个（两个 decoy 窗格）、
`linechart` 6 个（一个断口 decoy）、`masonry` 7 个（三块 decoy 砖）、
`signboard` 6 个（两个 decoy 字形）、`randomfield` 5 个（无可借用细节）。

### 生成与重建

```bash
npm run assets                      # = node tools/build_assets.js
node tools/build_assets.js --clean  # 清空生成目录后从场景定义重建全部素材
node tools/build_assets.js --scene facade --scale 2   # 只重建一个组合
```

生成物：

```
assets/
  references/<scene>/<scale>x/HR.png   清晰参照（评测专用，窗口不可见）
  inputs/<scene>/<scale>x/LR.png       唯一可交给执行器的输入
  recipes/<scene>_<scale>x.json        滤波/采样参数、尺寸、裁剪、内容摘要
  scenes/<scene>.json                  可编辑场景（解析后的绘制指令）
  scenes/<scene>.svg                   同场景的矢量导出（栅格噪声内嵌为 PNG）
  ledger.json                          参照内容摘要封印
  manifest.json                        处理清单（每个场景/倍率的输入、参照、
                                       recipe、退化参数、摘要，以及区域与可编辑文件）
```

**素材不依赖任何外部下载图片**：全部由 `scenes/lib/`（超采样矢量光栅器、
PRNG、程序化面板/字形/条纹/噪声）在本地按固定种子生成。

### 退化链（`recipes/*.json` 中保存的参数）

参照 → 高斯模糊（σ：2×=1.0，3×=1.15，4×=1.3，边缘 clamp）→
Catmull-Rom 双三次降采样（整数倍、像素中心对齐）。每个 recipe 同时记录
`referenceSize`、`inputSize`、`crop`、两种 SHA-256 与像素摘要。

### 尺度与裁剪关系检查

`tools/build_assets.js` 的 `checkScene` 与 `tools/verify.js` 会强制：

- 参照宽高必须能被 2/3/4 整除，否则拒绝生成；
- 每个区域矩形的 `x,y,w,h` 必须是对应倍率的整倍数（局部指标与块不会错位）；
- 建出的 LR 必须严格等于 `参照尺寸 / 倍率`，recipe 的 `crop` 必须覆盖整帧；
- 评分时若参照与 SR 网格不一致，`run_suite` 直接报错拒绝比较。

因此客观 PSNR/局部残差不会因半像素错位而被扭曲。

---

## 三、评测与差异图入口

```bash
npm run eval                          # = node eval/run_suite.js，全部场景×2/3/4
node eval/run_suite.js --scene masonry --scale 4
node eval/run_eval.js --scene facade --scale 2            # 单次隔离运行
node eval/run_eval.js assets/inputs/facade/2x/LR.png runs/manual --scale 2
```

- `eval/run_eval.js`：**输入-only 执行器**，拒绝任何按内容命中封印参照的文件，
  写出 `SR/bicubic/reprojected/residual/confidence/transfer` 六张图及
  `run.json`、`matches.json`（逐目标块候选与代价分解）。
- `eval/run_suite.js`：先跑执行器，**之后**才由 `eval/reference.js` 打开参照评分；
  每个区域额外写差异图到 `runs/eval/<scene>_<scale>x/diff/`：
  `*_sr.png`、`*_bicubic.png`、`*_ref.png`、`*_diff_sr.png`、`*_diff_bicubic.png`；
  汇总 `region_report.json`、`suite_report.{json,md}`。
- 窗口内的「SR−双三次差异」视图是浏览器端仅用于显示的差分，不参与任何指标。
- **独立差异图入口**（不重跑重建，只补算局部残差图）：

  ```bash
  node eval/make_diff.js --scene masonry --scale 4      # 或 npm run diff -- --scene ... --scale ...
  ```

  读取已有 `runs/eval/<scene>_<scale>x/` 中的 `SR.png`、`bicubic.png`，在评分侧
  打开封印参照，为每个区域重写 `diff/*_{sr,bicubic,ref,diff_sr,diff_bicubic}.png`
  并打印每个区域的 PSNR 增益。若网格尺寸不一致会拒绝生成，避免错位比较。

报告**如实包含反例与负结果**：`psnrGain` 可为负，`srWorseThanBicubic`、
`wrongTransferBlocks`（迁移了细节且使该块变差）、`gatedBlocks`（门控回退）
全部写出，不筛选只挑改善明显的图。

当前一次完整运行（参数 `patchStride=6, shortlist=10, backProjectionIters=3,
pyramidLevels=3`）：

| scene | 2× 增益 | 3× 增益 | 4× 增益 | 错误迁移块（2/3/4×） |
|---|---|---|---|---|
| facade | +1.39 dB | +0.58 dB | +0.18 dB | 6 / 2 / 2 |
| linechart | +1.93 dB | +0.45 dB | +0.16 dB | 5 / 13 / 2 |
| signboard | +1.70 dB | +0.84 dB | +0.08 dB | 13 / 4 / 3 |
| randomfield | +0.55 dB | +0.15 dB | +0.05 dB | 0 / 0 / 1 |
| masonry | +1.55 dB | +0.78 dB | **−0.10 dB** | 30 / 0 / 38 |

细节见 `runs/eval/suite_report.md`。负增益与错误迁移块都保留。

---

## 四、核验脚本

```bash
npm run verify       # = node tools/verify.js
```

依次检查：

1. 全部场景通过尺度/裁剪关系检查；
2. 内存重渲染 + 重新降质，复现 ledger 中封印的参照与输入像素摘要（**重建确定性**）；
3. 每个 LR 严格为 `参照 / 倍率`，recipe 裁剪覆盖整帧，区域矩形倍率对齐；
4. 可编辑导出与场景一致：JSON 的 op 数/尺寸正确，SVG 为完整 XML，
   每个栅格 op 的补丁坐标等于其矩形边界，**且补丁像素与渲染结果逐像素相同**
   （按 8-bit 量化后比较，差值必须为 0）；
5. 把 HR 改名为中性名交给执行器，必须以退出码 3 拒绝且不写输出；
6. HTTP 窗口拒绝 `/assets/references/...`、正常提供 `/assets/inputs/...`；
7. 引擎确定性（两次运行逐像素相同）与“色度冻结在双三次基线”不变量。

输出为逐项 `ok/FAIL` 并在任何失败时以非零退出码结束。

---

## 五、算法与关键约束（`engine/`）

- `image.js`：图像容器、YCbCr 变换、Catmull-Rom 双三次重采样、高斯模糊、
  **已知降质模型** `degrade = 高斯模糊(σ) → 双三次降采样`。
- `match.js`：自相似匹配。候选只来自输入图及其按同一降质模型生成的下采样金字塔；
  积分图粗筛、短列表精排；目标块排除自身邻域，防止“自匹配”虚高置信度。
  每个候选带显式代价：`ssdPerPx`（去均值外观误差）、`brightnessDelta`、
  `rotationPenalty`（0/90/180/270°）、`scalePenalty`（金字塔层级），
  `cost = ssdPerPx + w·|Δ亮度| + 旋转惩罚 + 尺度惩罚`。
- `sr.js`：置信度由“最优/次优代价间隔 + 拟合质量 + 结构强度”组成。
  **低于阈值的目标块不注入任何细节，回退保守双三次**；注入高频经能量限幅。
  色度始终只做双三次上采样，反投影只更新亮度通道（色度冻结）。
- **观测残差检验**：重建图经同一降质模型投回输入尺度得到残差图、RMS、峰值；
  亮度域反投影把重建约束到观测一致。
- `anomaly.js`：从重建内部计算四类异常并给出严重度与实测值——
  `transfer-residual-conflict`（迁移区域投回后残差偏大）、
  `chroma-artifact`（SR 与基线色度差）、`low-similarity-fallback`（大面积门控）、
  `edge-energy-excess`（梯度能量异常高出基线）。**异常基于重建自身，不读取参照。**
- 置信度图与迁移掩码上采样后会被钳制回 `[0,1]`，保证“迁移占比”等比例值可信。

### 可编辑场景导出（`scenes/lib/svg.js`）

- `assets/scenes/<name>.json` 是解析后的绘制指令列表（唯一的可编辑真源）；
- `assets/scenes/<name>.svg` 用原生 SVG 图元导出矢量部分；
- 纯栅格填充（`uniqueField` / `grain`）按各自矩形导出的**不透明 PNG 补丁**，
  坐标等于该 op 的边界，像素与渲染结果逐像素一致，并按绘制顺序插入；
  这样补丁与后续矢量叠加顺序正确，也不依赖渲染器的图像 alpha 支持；
- 背景渐变导出为原生 `<linearGradient>`；
- `tools/verify.js` 会检查补丁坐标与像素、以及 JSON 与场景解析结果一致。

注意：SVG 的最终像素效果取决于打开它的渲染器（浏览器/矢量编辑器支持渐变与
`fill-opacity`，ImageMagick 内置渲染器不支持）。**仓库内的可编辑真源是 JSON**，
PNG 参照由生成器据此重绘，不依赖任何某个渲染器的输出。
- `png.js`：自带 PNG 解码/编码（5 种过滤器、CRC、zlib），逐行自适应过滤，
  输出可被标准解码器（浏览器、ImageMagick）正确读取。

### 该方法不能保证恢复唯一原图

单个低分辨率观测对应许多合法的高分辨率图像。自相似迁移是**约束下的估计**：
观测残差小只说明重建与降质模型一致，**不代表等于真实原图**。缺乏自相似的区域
会被置信度门控判为不可信而回退，系统不会复制相似纹理去编造不存在的文字或边缘。
`masonry` 4× 的负增益正是这种失败被如实暴露的例子。

---

## 六、命令行仅辅助自相似放大

命令行**不是**图形窗口的替代入口，只用于批处理、复现与内核调试：

```bash
node cli/run_sr.js assets/inputs/facade/2x/LR.png runs/demo --scale 2 \
  --set confidenceThreshold=0.6 --set patchStride=4
node cli/sweep.js tests/inputs/unique_LR.png runs/sweep_unique 2
```

CLI 输出与窗口使用**同一内核、同一参数**；它不会加载参照，也不能绕过
`eval/run_eval.js` 的封印校验。**日常查看放大细节、候选块与置信度请使用第一节的图形入口。**

---

## 七、测试场景（`tests/`）

`make_test_images.js` 用固定种子生成 256px 参考图，并按同一降质模型生成 128px 输入：

| 场景 | 特征 | 实测（2×，默认参数） |
|---|---|---|
| `panes` 重复窗格 | 大量重复子结构 | 迁移 97%，PSNR 较双三次 **+3.93 dB** |
| `thinlines` 细线/类文字笔画 | 1–2px 结构，降采样丢失 | 迁移 76%，PSNR **+2.27 dB** |
| `texture` 随机中性纹理 | 统计自相似但无精确重复 | 迁移 52%，PSNR 仅 +0.52 dB，以回退为主 |
| `unique` 缺乏自相似 | 平滑渐变+唯一物体 | 大面积回退，PSNR +1.14 dB |

`tests/` 保留为早期小样本回归；正式评测请用 `assets/` 套件。

## 八、复现性

- 管线内不使用随机数；同输入同参数逐像素一致（`tools/verify.js` 验证最大像素差 0）。
- 每次运行写出 `run.json`（全部参数、Node 版本、诊断）与 `matches.json`
  （逐目标块候选索引与完整代价分解）。
- `node tools/build_assets.js --clean` 从场景定义重建全部参照、输入、recipe、
  可编辑场景与封印，摘要与先前一致。

## 九、工程结构

```
engine/        自相似内核：图像/重采样、PNG 编解码、匹配器、超分管线、异常检测
scenes/        场景定义 defs/ 与光栅化/导出库 lib/（可编辑素材源）
tools/         build_assets.js（素材生成）、verify.js（核验）
eval/          隔离执行器 run_eval.js、评测脚本 run_suite/reference/common、
               差异图入口 make_diff.js（仅评分侧打开参照）
assets/        生成物：references/（参照）、inputs/（运行输入）、recipes/、
               scenes/（可编辑 JSON/SVG）、ledger.json、manifest.json
cli/server.js  图形恢复窗口服务器（内核驱动控件、失败反馈、隔离资产服务）
cli/run_sr.js  单次重建 CLI（辅助；含匹配索引与运行清单）
cli/sweep.js   参数影响扫描
web/           浏览器界面（只渲染内核返回的结果）
tests/         早期小样本测试图生成、评价、一键复现
runs/          实际运行产物与 suite_report
```
