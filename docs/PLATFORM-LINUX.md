# Linux / 非 Windows 支持（upstream issue #24）

结论先说：**窗口嵌入是 Win32 专有的，这一版把它从「隐式失败」变成了「明确的降级」，
真正的 Linux 嵌入后端还没写**。下面写清楚哪些地方绑死了 Windows、这一版做了什么、
以及要补什么才能算「支持 Linux」。

## 1. 为什么不是「把判断改一下」就行

嵌入不是调一个 API，而是一整套只有 Windows 才有的东西：

| 能力 | 依赖 | 代码位置 |
|---|---|---|
| 把模拟器的 Qt 窗口挂到我们的窗口下面 | `SetParent` / `WS_CHILD` / `SetWindowLong` / `SetWindowPos` | `src/core/win/agent.ps1`（`Embed` / `Fit`） |
| 窗口尺寸跟随、Z 序维护、遮挡压制 | `EnumWindows` / `GetWindowRect` / `ClientToScreen` / 进程归属判定 | `src/core/win/agent.ps1`（`QuietSweep` / `IsOurs`） |
| 和代理的高频通信（<2ms 往返） | 常驻 `powershell.exe` + 本机回环 TCP | `src/core/agent.js` |
| 高 DPI 下的坐标一致 | `SetProcessDpiAwarenessContext(PerMonitorV2)` | `src/core/win/agent.ps1`（`Serve`） |
| 窗口改名 / 换图标 | `SetWindowText` / `WM_SETICON` | `src/core/win/windowctl.ps1` |
| 全局鼠标键位（右键返回、滚轮、侧键） | `WH_MOUSE_LL` 低级钩子 | `src/core/win/agent.ps1` |

Linux 上没有对应物：

- **X11** 可以用 `XReparentWindow` 做到接近的效果（这是 `xdotool` / `wmctrl` 那一路），
  但需要自己处理窗口管理器干预（很多 WM 会把 `OverrideRedirect` 的窗口重新挂回根窗口）、
  合成器下的黑屏、以及 XWayland 里 X11 客户端之间的跨进程 reparent 限制。
- **Wayland** 对客户端**根本不开放**「把别的进程的窗口挂到我这儿」——协议层面就没有这个能力。
  要做只能走 `wlr-layer-shell` / `xdg-desktop-portal` 的屏幕采集 + 自己渲染，代价是
  每一帧都要过一遍 GPU 拷贝，跟「原生 60fps + 原生鼠标」完全不是一回事。

所以 Linux 的嵌入不是「换个 API」，而是一个独立后端（X11 + 采集兜底），
本机没有 Linux 环境，写出来也无法验证 —— 与其发一个「看起来支持了」的版本，不如：
**先把能力边界做成显式的，让应用在非 Windows 上不装死、不黑屏、给出可照做的下一步。**

## 2. 这一版做了什么

新增 `src/core/platform.js`，把散落各处的 `process.platform === 'win32'` 收成一处能力表：

| 能力 | Windows | Linux | macOS |
|---|---|---|---|
| `canEmbed` 窗口嵌入 | ✅ | ❌（独立窗口） | ❌ |
| `canProvision` 内置运行时下载/驱动 | ✅ | ❌（用 Android Studio 的 SDK） | ❌ |
| `canIntegrateShell` 快捷方式 / .apk 关联 | ✅ | ❌ | ❌ |
| `canHookMouse` 全局鼠标键位 | ✅ | ❌ | ❌ |

配套改动：

1. **`appwin.embed()` 先看能力**：不支持时立刻返回并置 `external`，不再走 4 次重试
   （以前每次都要等一条 6 秒的 TCP 超时，用户看到的是「卡很久 → 黑屏 → 没有任何提示」）。
2. **应用窗口写明去哪看画面**：外部窗口模式下不再显示黑屏，而是显示一段说明
   （"安卓画面在模拟器自己的窗口里 + 怎么接已有运行时"）。
3. **`engine.boot()` 提前拦**：非 Windows 且不是 `attach` 模式时，直接抛
   「内置运行时只支持 Windows，请用连接已有运行时」，而不是在下载/解压/装驱动里
   各失败一次。
4. **启动时提示一次**：`supportLevel() !== 'full'` 时弹一个说明框，并把
   `platform <os> support=<level>` 写进 `app.log`。
5. **adb 查找表按平台分叉**：非 Windows 走 `~/Android/Sdk/platform-tools/adb`、
   `/usr/local/bin/adb`、`/usr/bin/adb` 等（以前这张表全是 `.exe`，永远落空）。
6. **快捷方式 / `.apk` 关联 / 安装后补齐**：非 Windows 一律 no-op（返回空数组），
   托盘里那一项直接不显示，`assoc.registerAssociation()` 返回「不支持」而不是去调
   `powershell.exe`。
7. **诊断报告带上 `platform.describe()`**：平台、架构、支持级别、加速方式
   （Linux 会检查 `/dev/kvm` 并给出加组提示）。

## 3. 现在在 Linux 上能做到哪一步

可以：

- 启动 ApkStart（Electron 45 在 Linux 上正常）；
- 用 `engine.mode = attach` 连接**你自己起来**的模拟器 / 真机（`adb` 在 PATH 或
  `~/Android/Sdk/platform-tools/adb`）；
- 装 APK、启动、卸载、文件同步、截图、音量/旋转这些走 adb 的功能；
- 安卓画面出现在模拟器自己的窗口里（不是嵌进 ApkStart 窗口）。

不能：

- 窗口嵌入（没有 Win32 也没写 X11 后端）；
- 内置运行时一键部署（只有 Windows 的 emulator/AEHD 分发）；
- 全局鼠标键位、快捷方式、`.apk` 双击安装。

## 4. 真要支持 Linux，还差什么（按顺序）

1. **`provision` 的平台化**：`paths()` 里写死了 `emulator.exe` / `adb.exe` /
   `qemu-system-x86_64.exe` / `qemu-img.exe`，SDK 下载要按 `repository2-3.xml` 里的
   `host-os="linux"` 取包；AVD home 用 `~/.android/avd`。这一层做完，`attach` 之外
   的「自动部署」才谈得上。
2. **加速检测**：`doctor` 的 WHPX/AEHD 那套换成 `/dev/kvm`（已给出 `acceleration()`）。
3. **X11 嵌入后端**：实现 `XReparentWindow` + `XConfigureWindow` 的本地扩展（C 或
   通过 `xdotool`），并在 WM 把窗口抢回去时重试；Wayland 下自动判定为「不支持嵌入」。
4. **采集兜底**：Wayland 只能 `xdg-desktop-portal` + PipeWire 采集，此时应当
   明确告诉用户「这是镜像，不是嵌入」，且鼠标要反向注入（`uinput` 或 `input tap`）。
5. **打包**：AppImage / deb，`electron-builder` 目标、`.desktop` 文件。

第 1、2 步是纯机械工作，第 3、4 步是真正的平台开发。**没有 Linux 机器时，
这三步都不该写成「已支持」**。

## 5. 验证状态

- Windows 上：`npm test` 全绿、`electron-smoke` 通过 —— 说明能力表改造没有改变
  Windows 行为（`canEmbed` 仍为 `true`，嵌入路径一行没动）。
- Linux / macOS：**未实测**。这一版保证的是「不会装死、不会黑屏、说清楚为什么」，
  不保证「能刷视频」。
