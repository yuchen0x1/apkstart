# 上游 issue 逐条核对（RoutineMiku/apkstart，共 36 条）

> 核对时间：2026-11-15 · 基线：本仓库 `main`（0.4.0 + 上游 v0.4.1 对齐，发版 0.5.0）
> 上游 issue 列表：<https://github.com/RoutineMiku/apkstart/issues>
> 结论标记：**已修** = 本仓库有明确代码落点；**部分** = 缓解/有兜底但没根治；
> **未修** = 明确没做；**非代码** = 环境/信息不足/与代码无关。

## 0. 一句话结论

上游一共 38 条 issue（编号到 #42，缺 9/12/18/22）：**26 条已修、7 条部分缓解、4 条未修、
1 条非代码（信息不足）**。

三条是 0.4.x 才暴露、上游也还没修的（#42 关窗销毁模拟器窗口、#40 高 DPI 画面放大 + 点击偏位、
#39 首帧事件丢失导致「点了没反应」），本轮已修并加了源码级回归断言。
最难的 **#41（横屏应用铺不满）** 也修了：模拟器窗口比例开机锁死，三条运行时改法全实测失败，
唯一可行的是「按应用方向选 LCD 冷启动」，代价是一次重启（本机实测 33 秒）。

## 1. 总表

| # | 问题 | 结论 | 依据 / 落点 |
|---|---|---|---|
| 1 | 完整版只有 `.001` 分卷 | **已消除** | 现在只发单个 `portable.zip` + `Setup.exe`，不再有分卷（`.github/workflows/release.yml`） |
| 2 | 安全审查 4×P0 + 6×P1 + 3×P2 | **已修** | 见 §2.1；残余 3 处下载未签名，见 §5 |
| 3 | `sysImgOk` 与 `ensureAvd()` 口径不一致 → 永远「镜像未就绪」 | **已修** | `emulator.js` `start()` 用 `imageChoice()` 同时认 AOSP/Play 兼容镜像 |
| 4 | 能否调安装路径（closed） | **已支持** | 运行时目录 + 安卓数据目录都可在设置里改 |
| 5 | 跨进程 `SetParent` 被 DPI 上下文不一致拦截 | **部分** | 已有「跟随模式」兜底（`_follow`）；本轮声明 PerMonitorV2 降低不一致概率 |
| 6 | 安卓引导失败（诊断报告） | **部分** | 环境无加速；emulator stdout 已落盘，无加速时给出可照做的结论 |
| 7 | 装完无声音、只能拖动、一直跳 CMD 并重启虚拟机 | **已修** | 点击=#34；CMD 黑框=`HideConsoleWindows`；无声音=音频默认开启；重启=启动重试收敛 |
| 8 | dataPartition 硬编码 16G / BOM 重置配置 / 运行中点启用搞坏 AEHD | **已修** | 三条全修，见 §2.2 |
| 10 | 镜像默认装 C 盘，希望可选路径 | **已支持** | 同 #4 |
| 11 | 桌面快捷方式打开黑屏、快捷键不生效 | **部分** | 黑屏属嵌入链路（#34/#40/#42 已修）；Ctrl+H 等模拟器快捷键在网页层焦点下本来就不通 |
| 13 | 超过 2GB 装不了 | **已修** | 同 #21 |
| 14 | C 盘被撑爆，希望整目录迁移 | **已修** | 数据分区默认 4G（原 16G）+ 快照按需 + 目录可迁移 |
| 15 | 开机未完成（截图） | **非代码** | 无日志，无法定位；同类问题的诊断已改善（见 #20） |
| 16 | 红果短剧 5 分钟且卡住 | **已修** | 网络体检 + 拉起前等网络（不重启）+ 命名快照 |
| 17 | 顶掉微信窗口（无正文） | **已修** | 同 #19，进程归属校验 |
| 19 | 窗口代理把所有 Qt 程序当模拟器隐藏 | **已修** | `IsOurs()` 按可执行文件路径限定作用域 + `HideToolWindows` 校验归属 + 无模拟器进程时跳过扫描 |
| 20 | 无法开机（诊断报告） | **部分** | 环境无加速；0.5.0 起结论不再是 UNKNOWN，直接点名 WHPX/AEHD |
| 21 | 装不了 2GB 以上安装包 | **已修** | `apk.js` 改文件版 ZIP 读取器 + 流式落盘，无 2GB 上限 |
| 23 | portable 设定运行时目录无效，仍往 AppData 下 | **已修** | `provision.paths()` 以 `runtime.dir` 为根；镜像目录优先取运行时目录内那份 |
| 24 | 希望支持 Linux | **未修** | 架构绑定 Windows 窗口代理（Win32 + PowerShell），不是一行开关能改 |
| 25 | 问道 APK 无法启动 | **未定** | 报错只有 `attempts: []`，需该 APK 才能判定；大概率走 ARM 转译 |
| 26 | 安装太慢，卡在「准备运行时」 | **部分** | 运行时整包改 8 线程分块下载（GitHub 单连接限速）；未做端到端计时 |
| 27 | 运行本软件杀掉 UU 远程窗口 | **已修** | 同 #19；`HideStrayWindows` 另有白名单，绝不碰 `QWindowIcon`/`subWin` |
| 28 | 微信一直被切前台/被杀 | **已修** | 同 #19 |
| 29 | 带窗口模式无法开机，headless 正常（约 55s exit -1） | **未修** | 是 emulator + 该机 GPU/驱动组合的问题；可见模式已首选 `swangle` 可能绕过，未验证 |
| 30 | 需要写明运行配置要求 | **已修** | README「配置要求」表（系统/CPU/内存/磁盘/GPU） |
| 31 | Intel 250K 核显安装报错 | **部分** | GPU 候选 host→swangle→software→swiftshader；无加速时诊断直接给 WHPX/AEHD 的处置办法 |
| 32 | 安装完成后无法识别鼠标 | **已修** | 与 #34 同因（`HWND_TOP` 写成 1 = `HWND_BOTTOM`） |
| 33 | 鼠标时灵时不灵 + 音量调节报错 + 启动慢 | **部分** | 鼠标=#34 已修；音量已改 `cmd media_session`（Android 11+ 无 `media` 工具）；启动慢靠快照/预热缓解 |
| 34 | `HWND_TOP` 写成 1 导致点击全丢 | **已修** | `agent.ps1` 常量改为 0，`QuietSweep` 里按 `GW_HWNDPREV` 兜底抬升 |
| 35 | 装完 C 盘红了 | **已修** | 同 #14 |
| 36 | 安装时提示没有 ARM 转译层 | **已修** | `adb.js` 检测到后自动切到内置翻译层的兼容镜像并重试 |
| 37 | 打开显示缺少设备原生库 | **已修** | 同 #36；另在安装前用 `compat.js` 预判 ABI 并给出结论 |
| 38 | 希望加英语 | **未修** | 无 i18n 框架，属功能需求不是缺陷 |
| 39 | ready-to-show 永不触发，进程驻留无窗口 | **本轮已修** | 3 秒兜底 `show()`（主窗口 + 应用窗口） |
| 40 | 125% 缩放画面放大 1.28 倍 + 点击偏左上 | **本轮已修** | 代理进程声明 PerMonitorV2，坐标按物理像素 1:1 |
| 41 | 横屏应用铺不满窗口 | **已修（0.5.0）** | 按 `screenOrientation` 选 LCD 冷启动；运行中方向不符时询问是否重启，见 §3.3 |
| 42 | 关窗后模拟器窗口被销毁，再开报 `emu=0` 全黑 | **本轮已修** | `close` 事件先 `preventDefault`，走 `park()` 后再销毁宿主 |

## 2. 本轮之前就已修好的（有代码证据）

### 2.1 issue #2 的安全审查

| 编号 | 结论 | 落点 |
|---|---|---|
| P0-1 APK 包名未校验 → 任意路径写入 + 设备端命令注入 | 已修 | `apk.js` `PKG_RE` 白名单，非法包名直接拒绝安装 |
| P0-2 并行下载失败留预分配文件，416 被当「已完成」 | 已修 | `download.js` 失败即删残骸；416 必须核对 `probeTotal`；完成后再验哈希 |
| P0-3 运行时下载无完整性校验 | 已修（8 处中 5 处） | `provision.js` 从 SDK 索引解析 `<checksum>`，emulator/系统镜像/Play 镜像都传 `expectSha1` |
| P0-4 `extractZip()` zip-slip | 已修 | `zip.js` 逐条校验条目名（`..`、绝对路径、盘符、UNC、符号链接），`updater` 另用 `path.resolve + path.relative` 做真实边界比较 |
| P1-1 `_fetchText()` 永不 settle | 已修 | 加了超时 + 上限 + `close` 兜底，`destroy()` 后一定 settle |
| P1-3 取消 .apk 关联无条件清空系统默认值 | 已修 | `assoc.js` 只有当前仍指向自己时才动，并优先恢复备份的 ProgId |
| P1-4 `settings:set` 无字段白名单 | 已修 | 按默认设置声明的键收敛 + 下载地址校验 |
| P1-5 / P1-6 / P2-1/2/3 | 已修 | 测试夹具（`make-apk.js`）、CI 断言、README 文案、QEMU 残留清理 |

### 2.2 issue #8 的三条

- **dataPartition 16G**：`emulator.js` 改为 `disk.dataPartition.size=${dataMB}M`，默认 4096，
  按剩余空间与设置推导；`ensureDataPartition()` 就地扩容并核对 ext4 真实大小。
- **settings.json 带 BOM 静默重置**：`store.js` 读取时 `text.replace(/^\uFEFF/, '')`。
- **运行中点「启用」把 AEHD 打成待删除**：`main.js` 的 `provision:enableAccel` 先判
  `runtime.vmRunning`，明确让用户先停运行时。
- 附带：emulator 的 stdout/stderr 现在落 `logs/emulator.log`，`FATAL | Not enough space` 这类
  原因不会再被吞掉（#8 的建议 2）。

## 3. 本轮新修的三条（0.4.x 回归）

### 3.1 #42 关窗销毁模拟器窗口

**根因**：`appwin.js` 的 `win.on('close')` 只置了 `_closing = true`，没走 `close()` 里那条
「先 `agent.park()` 摘窗口、再销毁宿主」的路径。宿主销毁时 Windows 连带销毁嵌入的 Qt 子窗口，
qemu 还活着但句柄没了 → 之后任何应用都 `embed failed: emu=0`、全黑，只能重启 ApkStart。

**改法**：`close` 事件里 `preventDefault()` 后转给 `close({ keepApp: false })`；
`_selfClose` 放行自身收尾、`_closing` 放行「park 未回来时用户又点关闭」。

### 3.2 #40 高 DPI 画面放大 + 点击偏位

**根因**：`appwin._rect()` 传的是**物理像素**（已乘 1.25），但窗口代理是 `powershell.exe`，
默认 DPI 不感知 —— `SetWindowPos(738, 1293)` 被系统再乘一次 1.25，子窗口实际 922×1616，
比宿主大 28%，右/下被裁；点击按 1:1 送给 Qt，于是整体偏左上。

**改法**：`agent.ps1` 的 `Serve()` 最前面声明 `SetProcessDpiAwarenessContext(-4)`
（PerMonitorV2，与 Electron 宿主一致），老系统退回 `SetProcessDPIAware()`。
100% 缩放不受影响，125%/150% 下坐标恢复 1:1。

### 3.3 #39 首帧事件丢失 =「点了没反应」

`ready-to-show` 在部分显卡/虚拟显示器组合下永远不回来（#39 的环境有三块显示适配器 + VBS）。
主窗口和应用窗口都加了 3 秒兜底：仍未显示就直接 `show()` 并写一行 `force-show fallback fired`，
不再让用户对着「双击没反应」猜。

> 我们已在 0.4.0 升到 Electron 45（Chromium 156），这条的触发概率比 #39 报的 Electron 33 低，
> 但兜底成本几乎为零，就一起加上了。

## 4. 本轮补修

### #41 横屏应用铺不满 —— 0.5.0 已修

**为什么只能按方向冷启动**：窗口宽高比由 `hw.lcd.width/height` 在开机时决定。
三条「运行时改」的路都实测过，全都不行：

| 办法 | 实测结果 |
|---|---|
| `wm size 1280x720` | 只改 Android 逻辑分辨率，Qt 窗口仍是竖的（强设 1280×720 会立刻弹回 405×720） |
| `adb emu rotate` | 窗口 532×961 → 931×561，但 `dumpsys display` 里 `rotation` 仍是 0：只转窗口，安卓排版没变，画面整屏横躺 |
| `adb emu resize-display` | 只认内置预设档（1080×2340 / 1768×2208 / 1920×1200），自定义尺寸报 `wrong size index`，切预设直接 `KO: Failed to resize display` |
| `hw.lcd` 改横屏冷启动 | ✅ 窗口 978×587、`wm size` 1920×1080、安卓按横屏排版 —— 铺满 |

**0.5.0 的做法**：

1. `apk.js` 解析清单里的 `android:screenOrientation`（整数枚举与字符串都认），归一成
   `landscape` / `portrait` / 空；启动 Activity 优先，其次 `<application>`。没写就**不猜** ——
   猜错会把所有竖屏应用变成两侧黑边，比「横屏游戏不铺满」严重得多。
2. `lcd.js` 只放纯决策：`desiredOrientation()`（用户强制 > 清单 > 不干预）、
   `needsRestart()`、`orientBox()`，单测覆盖。
3. `emulator.start({ lcdOrientation })` 用 `doctor.orientLcd()` 把 LCD 转 90°，
   `ensureAvd()` 写进 `hw.lcd`；快照 key 里带 `WxH@dpi`，方向一变旧快照自动作废
   （只清快照，**不动 userdata**，已装应用与存档都在）。
4. 运行时已经在跑、方向又对不上：弹一次窗问「重启并切换 / 保持当前」，可勾「记住」。
   拒绝就用 `appWin.applyBox()` 把窗口收回当前 LCD 的比例，跟旧版本表现一致；
   选过「记住」的写进应用记录的 `lcdPref`，以后不再问。
5. 横屏 LCD 下窗口比例跟着 LCD 走（`sizeFor` 不再交换宽高），`rotate()` 直接 no-op，
   开机后补一次 `wm size reset`，清掉旧版本留下的 1280×720 覆盖。

**代价（如实写）**：方向切换 = 一次冷启动，本机实测 33 秒（WHPX 可用时）。
同方向的应用之间切换不受影响，仍然是快照秒开。

### #20 / #6 / #15 / #31 的「UNKNOWN」

这五份诊断报告都是同一类：机器上 WHPX 与 AEHD 都不可用，日志里没有可匹配的关键字，
最后只剩一句「UNKNOWN · 已自动尝试多组参数」。0.5.0 起，全部组合失败且 `accelOk=false` 时
直接给出 `ACCEL` 结论，点名「勾选虚拟机平台」或「安装 AEHD 驱动」两条具体动作。

## 5. 仍然没修的

- **#24 Linux**：窗口嵌入依赖 Win32 + PowerShell 代理，不是端口问题。
- **#38 英语**：需要 i18n 框架，属功能需求。
- **#29 带窗口模式无法开机**：该机 headless 正常、带窗口 vCPU 不启动，是 emulator 与
  该机 GPU/驱动组合的问题。我们把可见模式的首选后端从裸 `software` 换成 `swangle`
  （同样是软件渲染但 WebGL/合成正常），**可能**绕过，但没有那台机器，未验证。
- **#11 里的模拟器快捷键**（Ctrl+H 等）：模拟器窗口被嵌进宿主后键盘焦点在网页层，
  emulator 自己的快捷键收不到。要支持得在 shell 里做一层按键转发，属新功能，未做。

## 6. 剩余风险（不是 issue，但也是「没修」）

运行时组件的下载仍有 3 处没有强校验（拿不到稳定的官方哈希）：

| 组件 | 现状 | 风险 |
|---|---|---|
| platform-tools | `platform-tools-latest-windows.zip` 是滚动地址，Google 不发布哈希 | 只有 https + 体积下限 |
| AEHD 驱动 | 兜底地址是 GitHub release | 同上 |
| QEMU | SourceForge 上的 NSIS 安装器，版本随解析结果变 | 同上 |

系统镜像与 emulator 本体已按 SDK 索引里的 `sha1` 校验（这才是有稳定索引的那两个）。
这三处如果要收紧，只能内置一份哈希清单并随版本更新 —— 需要有人定期维护，暂不做。

## 7. 验证方式

- `npm test`：**219 项全通过**（单元 14 / 引擎 32 / 应用 87 / 同步 26 / 更新器 16 / IPC 11 /
  兼容性 22 / 备份 11）。新增两项：源码级断言钉住 #39/#40/#42 的接线，
  以及 #41 的方向决策（清单解析 / 用户强制 / 窗口比例）。
- `electron-smoke`：9 项通过（Electron 45.3.2 / Chromium 156）。
- 窗口代理用**生产路径**实跑：`new WinAgent().ensure()` 1.1 秒起来，
  `windows` / `children` 命令正常 —— 说明加了 DPI 声明后 C# 仍能编译、协议没坏。
- #41 的机理在真模拟器上验证过（Android 15 / emulator 37.2.13）：
  `emu rotate` 只改窗口（931×561）但 `rotation` 仍为 0；`resize-display` 直接 KO；
  改 `hw.lcd=1920x1080` 冷启动后窗口 978×587、`wm size` 1920×1080 —— 三条对照都有记录。

**没验证到的**：真实鼠标在 125% 缩放下点「手机号登录」（#40 的验收动作）、
× 关窗后立刻重开（#42 的验收动作）、以及 ApkStart 自己走完「装横屏游戏 → 弹窗 → 重启 →
铺满」这条链路（需要部署 `build/runtime` 并装真实 APK）。代码路径与上游 issue 里的实测结论
一致，但**没有在我这台机器上跑通完整 UI 流程**，发版说明里不要写成「已实测」。
