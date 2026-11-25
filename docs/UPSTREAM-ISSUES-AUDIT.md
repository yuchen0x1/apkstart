# 上游 Issue 审计（RoutineMiku/apkstart）

> 核对时间：2026-11-23。审计对象是上游公开的 92 条开放 Issue；结论只表示当前仓库有代码证据，不能替代报告者机器上的真实验收。
>
> **已修**：当前代码有明确修复和回归覆盖。**本轮新修**：在 0.10.4 中新增。**部分**：有诊断、降级或安全兜底，但仍需要对应 APK、硬件或系统复验。**平台/功能边界**：不是当前 Windows/Linux x86_64 内置后端能承诺的功能。

## 2026-11-25 复核（v0.11.4）

本次通过 GitHub API 重新核对上游提交、发行、开放 Issue 与近期评论。上游共有 **100 条开放 Issue**（排除 PR）；相较 11 月 23 日最初审计的 92 条，新增 #133、#135、#136、#140、#143、#144、#145、#146，其中 #140 已在 11 月 24 日复核。以下时间均为北京时间。

- 上游 `main` 最新仍为 [`7e2c550`](https://github.com/RoutineMiku/apkstart/commit/7e2c5503b908c0a4d55283c85244a8e09b2725c7)，提交时间为 **2026-11-22 20:15**，内容为 Gitee 发行说明回填诊断。本次没有发现 11 月 24 日以后新增的主线提交。
- 最高功能版本仍为 [v0.6.4](https://github.com/RoutineMiku/apkstart/releases/tag/v0.6.4)。上游 `/releases/latest` 返回后补发的 v0.6.3，不能将其发布日期当作更高版本号。
- [PR #142 英文](https://github.com/RoutineMiku/apkstart/pull/142)、[PR #141 西语](https://github.com/RoutineMiku/apkstart/pull/141)、[PR #139 拆分包](https://github.com/RoutineMiku/apkstart/pull/139) 和 [PR #137 keymapEngine 作用域](https://github.com/RoutineMiku/apkstart/pull/137) 均尚未合并。本仓库已有语言入口和拆分包安装，但没有引入上游 `keymapEngine` 模块，因此不能把“不存在该引用链”表述为已移植其按键映射功能。

| 上游问题 | 当前核对结果 | 证据与验收边界 |
|---|---|---|
| [#146 APK 启动失败 / 0xC0000005](https://github.com/RoutineMiku/apkstart/issues/146) | **部分覆盖，未证明根治** | 11 月 24 日 22:11 创建，11 月 25 日 12:55 有 ADB `device offline` 新评论。`emulator.js` 有访问冲突熔断、Vulkan 崩溃降级；`engine.js` 有 ADB 启动自愈；`adb.js` 有安装传输重试。帖子缺少 APK、硬件资料和完整日志，不能承诺对应机器已修复。 |
| [#145 没有英文](https://github.com/RoutineMiku/apkstart/issues/145)、[#144 No English](https://github.com/RoutineMiku/apkstart/issues/144) | **入口与主要界面已覆盖** | `src/i18n/index.js`、设置语言下拉框和语言往返回归已存在；不代表所有核心诊断、手册和非英文词条都已完整翻译。 |
| [#143 无 Windows 安装包](https://github.com/RoutineMiku/apkstart/issues/143) | **上游分发问题，本仓库未复现** | 本次核对的正式 v0.11.3 Release 已包含 `ApkStart-0.11.3-Setup.exe` 与便携 ZIP。后续版本继续由 Release 工作流构建 Windows / Linux 资产。 |
| [#135 Vulkan 兼容](https://github.com/RoutineMiku/apkstart/issues/135) | **仍有能力差距** | host / lavapipe 选项及禁用 Vulkan 的崩溃回退不等于 Android 应用可用 Vulkan；尚无对应应用侧能力检测与真实 APK 验收。 |
| [#136 Gitee 无制品 / GitHub 下载慢](https://github.com/RoutineMiku/apkstart/issues/136) | **本仓库已有下载回退，实测速率未知** | 维护者说明 Gitee 制品受大小限制。本仓库 v0.11.3 已发布官方优先、失败或持续低速后切换 GH-Proxy 的机制；没有中国大陆真实吞吐测量。 |
| [#133 AMD 780M + Emulator 37.4.1 访问冲突](https://github.com/RoutineMiku/apkstart/issues/133) | **部分覆盖，待对应设备验证** | 已有同类诊断、降级和熔断，但未取得报告者环境的可复现日志，不能把止损当成驱动兼容性修复。 |

另外确认一个**旧功能差距**：上游 v0.6.4 的 Windows `UserGpuPreferences` 系统默认 / 核显 / 独显偏好尚未移植。当前 `host`、`swangle`、`software` 是渲染后端选择，不等于指定物理显卡。中 / 英 / 西 / 越 / 俄语言入口存在，缺失词条会回退英文，也不等于所有语言都已全量翻译。

本次定向回归覆盖自动启动逻辑、i18n 语言切换与词条往返；没有在 #133 / #146 报告者的设备、对应 APK 或 Vulkan 应用中完成端到端复验。没有替上游关闭这些未验收的问题。

## 2026-11-24 复核（v0.10.9）

| 上游问题 | 影响范围 | 本仓库是否存在 | 结论 |
|---|---|---|---|
| [#140 退出时自动关闭 Windows Terminal](https://github.com/RoutineMiku/apkstart/issues/140) | 进程 / 窗口生命周期 | 曾存在同源风险，已修 | 主进程没有 `taskkill` 或按名字 kill；本轮把更新脚本里「按 PID 强杀」改成启动时记录本程序的进程出生凭据、结束后只按该凭据终止，无法验证就跳过；`windowctl.ps1` 删除按 `emulator\|qemu` 进程名扫描窗口的兜底；`priority.ps1` 改为只作用于本实例进程树中通过归属验证的 PID。仍需在多用户会话、Windows Terminal / PowerShell / 其他 QEMU 并存的实机上复验。 |
| [#139 拆分包备份后自动重装](https://github.com/RoutineMiku/pull/139) | Split APK / APKS / XAPK | 已覆盖 | `installer.finishInstall()` 对 bundle 走 `installMultiple(bundle.files)`；启动时缓存缺失的自动补装同样按 `parseBundle` + `installMultiple`；备份侧按分片打包，恢复时以 `kind: apks` 交回安装器。 |
| [#94 音量设置改用 `cmd media_session volume`](https://github.com/RoutineMiku/pull/94) | Android 音量 | 已覆盖 | `android.js` 已改用 `cmd media_session volume`，带 `--get` 档位换算和音量键兜底。 |
| [#22 `qemu-img` 参数顺序](https://github.com/RoutineMiku/pull/22) | 运行时磁盘 | 已覆盖 | `emulator.js` 的 `_qemuImg` 使用 `qemu-img <op> -f raw …` 的正确顺序。 |
| [#91 并行下载未校验 Content-Range](https://github.com/RoutineMiku/issues/91) | 更新 / 镜像下载 | 已修 | `download.js` 校验 `Content-Range` 起点、终点、总长、`Content-Length`、strong ETag 与最终 URL 身份绑定；下载身份回归 29 项通过。 |
| [#98 便携版更新死循环](https://github.com/RoutineMiku/issues/98) | 在线更新 | 已修并加固 | 载荷与 Setup 校验、装前备份、装后核验、失败回滚与失败凭条已具备；本轮 `pending.json` 凭条改为**通过载荷前置校验之后**才写，校验失败不再留下「更新卡住」的假状态。 |
| 上游 `feat/pluggable-backend` 分支 | 架构 | 未移植 | 上游新分支与本仓库已有的引擎 / 运行时 / 分身适配层重叠，直接合并会覆盖独立实现；需要单独做接口对齐与迁移评估，不并入本轮补丁。 |

## 结论摘要

- 本轮完成四个仍能在本仓库落地的缺陷：Store 版只读运行时（#116）、跨进程嵌入被 `SetParent` 拒绝时的独立窗口兜底（#5）、嵌入窗口的 Android Home/Overview/Back 快捷键（#11）、启动窗口按主窗口显示器定位并提前隐藏主界面（#111）。
- 历史安全、路径、下载、DPI、窗口生命周期、方向和自动更新问题已有代码与测试覆盖，见下表；其中 #122、#127 这类宿主系统崩溃不能仅凭 ApkStart 日志归因。
- Linux GNOME 原生嵌入、macOS、Windows ARM64、Magisk、蓝牙等仍不属于本版本承诺范围；真实 Android 应用、混合 DPI、多显示器和商店沙箱仍需实际环境验收。

## 当前代码已修

| Issue | 当前结论与代码证据 |
|---|---|
| #2、#91 | APK 包名/路径净化、下载失败清理、`Content-Range`/摘要校验、ZIP-slip 防护和安全回归测试。|
| #3 | 启动闸门、兼容镜像和 `ensureAvd()` 使用同一套系统镜像口径。|
| #8、#46 | 数据分区按磁盘空间推导并就地核验；BOM/损坏配置保留恢复副本；userdata 与 ext4 初始化失败会中止启动。|
| #10、#14、#23、#35、#48 | 运行时目录、安卓数据目录可分别迁移；便携包会重新定位，不把只读包路径当作可写 AVD。|
| #19、#27、#28 | 原生代理按可执行文件、运行时目录和 AVD 身份限定作用域，不隐藏微信、UU 等无关 Qt 窗口。|
| #21、#70 | APK/分包安装采用流式读取与落盘，不把大包整体读入内存。|
| #26、#66、#67、#80 | 运行时下载支持分块、断点、测速换源、进度日志和失败后原子落盘。|
| #30、#77 | README、设置和诊断报告说明 CPU、内存、磁盘、加速和运行时占用。|
| #32、#33、#34 | 鼠标映射、Win32 Z 序、右键返回和平滑滚轮链路已修；仍需真实设备验证具体应用输入。|
| #36、#37 | ARM 兼容镜像、ABI 检查和缺少原生库的安装前提示已接入。|
| #40、#49、#99 | 窗口代理声明 PerMonitorV2，矩形使用物理像素并持续贴合；非 100% 缩放的完整鼠标验收仍需真人操作。|
| #41、#81 | 按 APK 方向选择 LCD 冷启动；方向不符时询问是否重启，不静默清除应用数据。视频流畅度仍取决于 GPU/客机。|
| #42 | 关窗先 `park()` 再销毁宿主；检测到无头运行时会冷重启并重新拉起应用。|
| #45、#52、#53、#60、#73 | 启动失败会记录本轮尝试、模拟器日志、加速状态和可执行修复建议，不再静默重试到无限循环。|
| #56、#61 | 区分 TCG/WHPX/GPU 参数和真实退出码；访问冲突重复出现时熔断，不继续启动更多实例。|
| #98、#125 | 便携更新校验载荷、备份、回滚和重启凭证；未确认恢复时不自动重启，避免更新死循环。|
| #100、#131 | 已有中英文 i18n 入口和语言设置；缺少词条回落中文，不宣称全量英语或越南语。|
| #102、#110 | 多开、脚本和实例隔离已有实现；分身共享运行时只读，独立 AVD、应用缓存和 ADB 服务。|
| #104 | 卸载与运行时/AVD 路径说明区分组件和用户数据，避免把大目录误认为已自动迁移。|
| #105、#106 | 摄像头、串口按后端能力表暴露；默认关闭/拒绝不支持的后端，不伪造可用。|
| #114 | 可请求客机显示模式并读回活动模式；文案明确刷新率不是应用 FPS。|
| #124 | 支持代理 URL、系统代理和镜像前缀，并在设置中显示实际来源。|

## 0.10.4 本轮新修

### #116：Windows Store 只读运行时

Store 包位于 `WindowsApps` 时，不能把包内 `runtime.dir` 当成可写目录。启动时现在先做真实写探针；只读包会按内容指纹复制到用户数据目录的 `runtime-store/<fingerprint>`，复制完成并重新核验 emulator、ADB 和系统镜像后才写入 `settings.runtime.dir`。磁盘空间不足、复制中断或包不完整都不会写入半成品，也不会覆盖用户已经选择的可写运行时。

### #5：SetParent 拒绝时的可用窗口

原生代理明确返回 `set-parent-failed`、`embed-parent-mismatch` 等拒绝原因时，应用窗口会尝试把模拟器恢复为独立窗口；独立窗口脱离失败则继续保留启动遮罩，不谎报已就绪。原始拒绝与脱离结果会保留在 `lastEmbedError` 和日志中。`emu=0` 等“没有找到窗口”仍走无头运行时恢复，不会误判为永久独立模式。

### #11：嵌入窗口快捷键

应用窗口现在支持 `Ctrl+H`（Android Home）、`Ctrl+O`（Overview/最近任务）和 `Ctrl+B`（Back），通过白名单 IPC 调用 ADB keyevent 3、187、4。快捷键只在宿主 shell 获得键盘焦点时生效；真实嵌入窗口焦点和特定游戏的快捷键冲突仍需复验。

### #111：启动窗口定位稳定化

打开应用窗口时，主界面可见就使用主界面所在显示器的工作区，否则使用光标所在显示器；主界面在应用窗口创建后立即隐藏，不再等待窗口代理完成才隐藏，减少启动时“左一下、右一下”的跳动。多显示器混合 DPI 的最终体验仍需对应硬件验收。

## 部分缓解或需要真实环境

- **#6、#15、#20、#29、#31**：诊断会区分无加速、GPU/窗口渲染冲突和超时，并提供 WHPX/AEHD/软件后端建议；没有报告者的 CPU、显卡和驱动，不能保证开机成功。
- **#7、#13、#16、#25、#65、#69、#81、#83、#90、#107**：安装、红果/抖音/番茄等特定 APK 的兼容性只能按 ABI、权限、网络和应用自身服务逐一验收；本仓库不把“能安装”写成“能正常使用”。
- **#47、#57、#62、#74、#79、#86**：项目本质仍使用 Android Emulator；运行时、镜像、网络和权限会占用磁盘与资源，README 已补充来源、权限和卸载说明。
- **#54、#55、#58、#82、#87、#89**：语言需求仍是持续补齐词条的功能项；当前中英文入口可用，西语/越南语/俄语不承诺全量覆盖。
- **#66、#77**：运行时和系统镜像体积无法消除，只能通过独立目录、清理入口、按需镜像和磁盘提示控制。
- **#98、#122**：更新回滚和 Electron/Chromium 启动边界已有防护；Windows 11 特定构建的 `STATUS_BREAKPOINT` 需要系统事件日志和最小复现，不能只靠应用层代码确认。
- **#127**：QEMU 退出码与蓝屏转储分别记录；蓝屏涉及第三方内核驱动、显卡或系统，未取得可复现转储前不归因于 ApkStart。
- **#114**：客机显示模式“请求成功”不等于应用实际 60/120 FPS，帧率仍需客机和应用测量。

## 平台或功能边界

- **#24、#88**：Linux x86_64 支持下载和独立窗口；Linux GNOME/Wayland 原生嵌入依赖不同窗口系统，当前不承诺。
- **#112**：macOS 不在当前打包目标和运行时支持矩阵中。
- **#126**：Windows ARM64 没有本版本的构建、签名和运行时资产，不能宣称支持。
- **#128**：Magisk/root 需要可刷写的客机镜像和启动链路，当前不内置、不自动安装。
- **#129**：蓝牙透传需要宿主驱动、客机协议和应用验收，当前能力表标记为不支持。
- **#85**：完整运行时可随发行包或从 Release 导入；轻量包默认按需下载，不能把运行时 ZIP 随意解压覆盖正在使用的 AVD。

## 验证边界

Node 回归覆盖上述新增模块、IPC 白名单、快捷键通道、窗口回退和路径安全。尚未在本机完成的项目包括：真实 Microsoft Store 沙箱运行、完整运行时大包复制与空间不足、混合 DPI 多显示器真人操作、真实 APK 长时间视频/游戏、Linux GNOME/Wayland、macOS、Windows ARM64、Magisk、蓝牙、蓝屏转储归因、安装升级和签名资产。发布说明会保留这些边界，不把测试夹具或本地构建当作正式 Release 证据。
