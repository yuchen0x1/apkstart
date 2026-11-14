# 上游对齐：v0.3.7 → v0.4.1

本分支在 v0.4.0 发布时还停在从上游 `RoutineMiku/apkstart` **v0.3.7** 分出来的状态。
上游之后又发了 v0.3.8 → v0.4.1 五个版本，这篇记录做了什么、怎么做、验证到什么程度。

**移植方式**：不做整树 `merge`（那会把本分支的安全加固、更新器、兼容性中心、UI 全部覆盖掉），
而是逐个提交按逻辑读差异、手工落进本分支的代码结构里。

---

## 一、逐条对照

| 上游提交 | 内容 | 本分支落点 | 状态 |
|---|---|---|---|
| `820fdf2` | 软件渲染默认退回 `swangle` 而非裸 `software`；可见窗口的 GPU 顺序改为 `host → swangle → software → swiftshader` | `src/core/doctor.js` `gpuCandidates()`；`planVariants()` 的 `preferSoftware` 改为优先 `swangle` | ✅ 已移植 |
| `f107076` | 虚拟机没网导致「点同意并继续后黑屏」：网络体检 + 拉起应用前等网络 + 修复网络 + 重置数据时的快照参数 | `emulator.checkNetwork()`、`engine.waitForNetwork()` / `repairNetwork()`、`installer.launch()`、`runtime:repairNetwork` / `runtime:checkNetwork` IPC、设置页「修复网络」 | ✅ 已移植（启动路径按 `ca635e5` 的结论**只等不重启**） |
| `7252414` | 「清理缓存」清不掉；新增「重置安卓数据」 | `engine.cleanup({includeSnapshots})`、`engine.resetAndroidData()`、`runtime:resetData` IPC、设置页按钮 + 二级确认 | ✅ 已移植 |
| `04448a0` | 横竖屏改成真正的手机/平板排版切换；AVD 打开方向传感器；`wm user-rotation` 锁 0 | `adb.setOrientation()`、`emulator` 的 AVD 配置（`hw.sensors.orientation/accelerometer=yes`）、`appwin.rotate()` 不再转画面 | ✅ 已移植 |
| `04448a0` | `leftovers.js` 增加废弃快照回收（`default_boot`、`*.stale-*`） | — | ⏭ 未移植：本分支没有 `leftovers.js`（「清理旧版本残留」走的是 `layers.prune`，已覆盖旧镜像/旧 AVD/锁文件） |
| `04448a0` | `SetWindowRgn` 裁剪标题栏溢出 | — | ❌ 有意**反向**：`928a477` 证明 region 会破坏命中测试，本分支不设 region |
| `ca635e5` | 「红果打不开」回归：启动路径不许冷启动；托盘单击开主界面；`HideStrayWindows` | `installer.launch()` 改为 `waitForNetwork(20s)`；`main.js` 托盘 `click`；`agent.ps1` `HideStrayWindows()`（收窄为只藏 Qt 工具窗/控制台） | ✅ 已移植 |
| `ca635e5` | `agent.ps1` 必须带 UTF-8 BOM（无 BOM 时 PowerShell 5.1 按 ANSI 读中文注释，`Add-Type` 编译失败） | BOM 本来就在；新增回归测试钉住 | ✅ 已有 + 加测试 |
| `928a477` | 嵌入 Z 序根治：挂到 `Chrome_RenderWidgetHostHWND` 之下；`EnsureReparent` 补挂；不设 region；旋转先 unmaximize、连续 6 轮收敛；嵌入后短暂置顶 | `agent.ps1`（`FindChromeRender` / `EnsureReparent` / `Embed` / `Fit` / `QuietSweep` / `Refresh`）、`appwin.sizeFor` / `rotate` / `setLandscape`、`main.js` 全屏切横屏 + 嵌入后 topmost | ✅ 已移植 |

---

## 二、与上游不完全一致的地方（以及为什么）

1. **`-snapshot` 参数**：上游在 `wipe` 分支只推 `-no-snapshot-load`。这样退出时保存会落到
   emulator 的默认名 `default_boot`，而下次启动按 `-snapshot apkstart` 找又找不到 ——
   等于白存一次，还得再冷启一遍。本分支改成 `-snapshot apkstart -no-snapshot-load`：
   不加载旧快照，保存仍落在 `apkstart`。测试 `启动参数带自动内存/核心/快照…` 覆盖。
2. **`preferSoftware` 仍然存在**：上游在 v0.4.x 里删掉了这个选项（直接 `planVariants(profile)`）。
   本分支保留它是因为嵌入窗口在 `host` 后端下确实出现过「失焦后交换链丢失 → 全窗黑」，
   但把首选从裸 `software` 换成 `swangle` —— 同样是软件渲染，不会丢交换链，
   又避开了裸 `software` 的 WebView 合成黑屏。测试
   `可见嵌入模式优先使用 swangle（软件渲染但 WebView 合成正常）` 覆盖。
3. **`HideStrayWindows` 加了白名单**：上游版本用「类名不含 Qt/Chrome 就藏」的写法，
   但 Qt 的 LCD 本体类名正是 `QWindowIcon` / `subWin`（含 Qt），一旦匹配逻辑变化就可能
   把正在嵌入的画面藏掉（全黑 + 点击失效）。本分支显式只藏 `QWindowTool*` / 控制台类，
   并且跳过宿主窗口和已嵌入窗口本身。
4. **`HideStrayWindows` 限流 1 秒一次**：它要枚举全部顶层窗口并逐个查进程归属，
   跟着 120ms 的压制节奏跑纯属浪费；`HideToolWindows` 仍在 120ms 节奏上。
5. **新增诊断命令 `children`**：上游没有。移植后必须能验证「网页层是不是真的存在」——
   见下一节。

---

## 三、验证到什么程度（诚实标注）

### 已验证（本机实跑）

- `npm test`：**216 项全通过**（单元 14 / 引擎 32 / 应用 84 / 同步 26 / 更新器 16 /
  IPC 11 / 兼容性 22 / 备份 11）。
- `npx electron test/electron-smoke.js`：9 项全通过（Electron 45.3.2 / Chromium 156 /
  Node 24.22.2，preload 在 sandbox 下注入成功、暴露 88 个接口、渲染层拿不到 Node/process）。
- **窗口代理能编译并响应**：用生产代码路径（`WinAgent.ensure()` → `powershell -File agent.ps1`）
  启动，1.2 秒内拿到端口，`windows` / `children` / `boothide` / `park` 全部返回正常。
  这是 `Add-Type` 编译失败最直接的表现点，改完 C# 必须过这一关。
- **Electron 45 的窗口层级实测**（关键假设验证）：开一个与 ApkStart 应用窗口同类型的
  frameless `BrowserWindow`，用代理的 `children` 查它的直接子窗口：

  ```
  host=2755128
    Chrome_RenderWidgetHostHWND   vis=true  482x902   ← 网页层（我们要挂的父窗口）
    Intermediate D3D Window       vis=true  481x902   ← Chromium 合成面
  ```

  两个结论：① Chromium 156 仍然把网页层作为**子窗口**创建，`FindChromeRender` 找得到，
  嵌入不会静默退回老路；② `EnumChildWindows` 按 z 序从上到下枚举，网页层排在合成面之前，
  说明挂在它下面的子窗口不会被合成面盖住。

### 未验证（需要内置运行时 + 真机操作）

- **端到端嵌入画面**：本机没有部署 `build/runtime`（要 GB 级下载），所以没能重复上游
  「真实鼠标点『同意并继续』→ 进主页 → PrintWindow 确认铺满无黑边」那一套。
  Z 序修复的代码路径与结构假设已验证，但最终观感仍未在本机看过。
- **横竖屏排版切换的实际显示**：需要应用窗口 + 运行中虚拟机。
- **修复网络 / 重置安卓数据的真机流程**（会删数据，且要等 2~4 分钟开机）。
- **托盘单击、全屏=横屏**：需要真实桌面交互。

建议下一次发布前，用 `ApkStart-<ver>-Setup.exe`（内置运行时）跑一遍上面四项，
再决定是否把这一版标成「已实测」。

---

## 四、回归防线

新增的测试（`test/auto-test.js`）：

- `窗口代理脚本必须带 UTF-8 BOM`：丢 BOM → PowerShell 5.1 按 ANSI 读中文注释 →
  注释和下一行代码并成一行 → `Add-Type` 编译失败 → 窗口代理起不来。
- `嵌入窗口必须挂到网页层之下，且不能再设 window region`：源码级钉住
  `FindChromeRender` / `SetParent(emu, parent)` / `EnsureReparent` / 清空 region，
  并禁止 `CreateRectRgn(0, clipTop`（就是被 928a477 判定为病因的那行）。
- `拉起应用前只等待网络，绝不重启虚拟机`：钉住 `installer` 用 `waitForNetwork(20s)`
  且不出现 `ensureNetwork`，`waitForNetwork` 对 `device-offline` 有 45 秒宽限。
- `启动参数带自动内存/核心/快照…`（改写）：`wipe` 时必须 `-no-snapshot-load`
  且保存仍落到 `apkstart`，不能出现 ` -no-snapshot `。
- `可见嵌入模式优先使用 swangle…`（改写）：可见模式首选 `swangle`，最后一档仍是关加速兜底。
