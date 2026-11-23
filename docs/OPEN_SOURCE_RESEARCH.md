# 开源项目研究与借鉴

> 调研日期 2026-11-23。许可证与星标经 `gh api repos/<owner>/<repo>` 实际读取（非记忆）。
> **纪律**：本文只记录「设计与架构思想」，**未复制任何第三方代码**。
> 凡 GPL / AGPL / NOASSERTION 项目，一律只作技术阅读，不引入其源码。

## 1. Android 虚拟化与模拟器

### 1.1 Android Emulator（Google 官方）
- 地址：https://developer.android.com/studio/run/emulator （发行物通过 SDK 索引分发）
- 许可证：专有（Android SDK License）；发行物可下载，源码不可用
- 值得借鉴：
  - **加速后端抽象**：Windows→WHPX/AEHD（`aehd` 驱动）、Linux→KVM、macOS→Hypervisor.framework（HVF）。四种加速实现共用同一套「`-accel-check` → 选后端 → 启动日志确认 operational」证据链。
  - **架构匹配的镜像**：Apple Silicon 必须用 `arm64-v8a`，Intel 用 `x86_64`；这是指令集差异，不是性能差异。
  - **quickboot 快照 + 常驻实例**，是「打开应用几乎零等待」的关键。
- ApkStart 现状与差距：
  - 已复用其运行时与 `-accel-check`；已有「检测可用 **且** 日志出现 operational」才认定为真的判定。
  - 本次之前：把 macOS 包名前缀拼成 `mac`（应为 `darwin`）、架构写死 `_x64`，永远取不到正确发行物。**本次已修**。
  - 仍缺：macOS 的 provision 产物落盘路径（属本项目未实现，不是上游问题）。
- 可落地：把「加速后端种类」与「镜像 ABI」做成宿主画像（本次 `src/core/host/profile.js` 已做）。

### 1.2 scrcpy — `Genymobile/scrcpy`
- 地址：https://github.com/Genymobile/scrcpy ；许可证 **Apache-2.0**；155k★
- 值得借鉴：
  - 纯 adb 通道 + 设备端 server 推送，**不依赖 root、不装驱动**，与 ApkStart「adb 为唯一操作面」一致。
  - 视频编解码与窗口渲染彻底解耦，低延迟手写控制协议。
- ApkStart 差距：现在是「嵌入模拟器窗口」，不是「抓流渲染」。若未来要做「Linux 无窗口嵌入时仍能显示画面」「Web 控制台实时画面」，scrcpy 架构最值得借鉴。
- 可落地（Apache-2.0，可合规借鉴）：远程管理 / Web 控制台的实时画面优先走 scrcpy 通道（adb forward + H.264），而非自研抓帧。

### 1.3 Waydroid — `waydroid/waydroid`
- 地址：https://github.com/waydroid/waydroid ；许可证 **GPL-3.0**；12.5k★
- 值得借鉴：**容器式**（LXC + binder）在 Linux 上跑完整 Android，共享宿主内核，启动远快于全虚拟化。
- ApkStart 差距：ApkStart 是 QEMU 全系统虚拟化，Linux 内核/zygote/system_server 必须整包引导；`docs/ARCHITECTURE.md` 已说明无法只加载某 App 需要的系统服务。
- 边界：**GPL-3.0**，不复制代码进 MIT 项目。
- 可落地：作为 Linux 上「低配 / 无 KVM」的**可选后端**方向调研（独立进程，不静态链接其代码）。

### 1.4 redroid — `remote-android/redroid-doc`
- 地址：https://github.com/remote-android/redroid-doc ；仓库为文档（未声明 SPDX）；7.2k★
- 值得借鉴：**多架构 + GPU 加速**的云端 Android 容器，原生支持 `linux/arm64`。
- 价值：这是 **Linux ARM64 上绕开「无官方 emulator」** 最现实的路线之一（容器而非模拟器）。
- 边界：未声明 SPDX，只读文档与思想，不引源码；容器方案合规需单独评估。

### 1.5 UTM — `utmapp/UTM`
- 地址：https://github.com/utmapp/UTM ；许可证 **Apache-2.0**；37k★
- 值得借鉴：macOS/iOS 上的 **QEMU 封装**，用 Hypervisor.framework（HVF）加速，同时提供「完整系统模拟」与「原生虚拟化」两种模式。
- 对 ApkStart 的意义：证明 **macOS + HVF + QEMU** 是成熟可行组合；Apple Silicon 用 arm64 镜像、Intel 用 x86_64，与本次 host 层的架构选择一致。
- 可落地：macOS 技术验证阶段参考其 HVF 参数组织方式（只借鉴参数设计，不复制实现）。

### 1.6 QEMU / crosvm
- QEMU：https://gitlab.com/qemu-project/qemu ；许可证 **GPL-2.0**
- crosvm：ChromeOS 的 Rust 虚拟机监控器
- 值得借鉴：设备模型（virtio）、快照、多后端加速抽象。`system-providers/qemu-backend.js` 已走 q35/virtio 路线。
- 边界：QEMU 是 **GPL-2.0**；ApkStart 只**调用**其可执行文件（独立进程），不链接其代码——这已是现状。

### 1.7 Android-x86 / Bliss OS
- Android-x86：https://www.android-x86.org/ ；Bliss OS：https://blissos.org/
- 值得借鉴：x86 桌面化的完整系统镜像生态；`qemu-iso-provider` 已支持这两类。
- 边界：GPL 系系统镜像，作为「下载的数据」使用，不并入源码仓库。

## 2. 跨平台桌面框架

| 框架 | 仓库 | 许可证 | 星标 | 借鉴点 |
| --- | --- | --- | --- | --- |
| Electron | `electron/electron` | **MIT** | 124k | ApkStart 现用；主进程/preload/renderer 三层边界成熟 |
| Tauri | `tauri-apps/tauri` | **Apache-2.0** | 113k | Rust 后端 + WebView，体积更小；但会重写全部 Node 逻辑 |
| Flutter Desktop | `flutter/flutter` | **BSD-3-Clause** | 181k | 自绘 UI，跨平台一致；不适合「嵌入原生窗口」需求 |
| Neutralino | `neutralinojs/neutralinojs` | NOASSERTION | 8.7k | 极轻量；生态与原生能力弱于 Electron |

**决策（记录理由）**：**继续用 Electron**。
- 理由：ApkStart 的核心价值是「嵌入模拟器原生窗口 + 常驻 PowerShell 代理 + 子进程管理」，这些是 Node 主进程强项；Tauri（Rust）/ Flutter 迁移等于重写，且**不解决** macOS 签名公证问题。
- 不采用 Tauri 不是因为它不好，而是**迁移收益小于成本**（本项目 44k 行 src + 24k 行测试）。

## 3. 容器与服务端

| 项目 | 仓库 | 许可证 | 借鉴点 |
| --- | --- | --- | --- |
| android-emulator-container-scripts | `google/android-emulator-container-scripts` | **Apache-2.0** | 官方「容器里跑 emulator」脚本：KVM 设备透传、`-no-window` + web 显示 |
| redroid | `remote-android/redroid-doc` | 未声明 | 多架构容器 Android |
| RustDesk | `rustdesk/rustdesk` | **AGPL-3.0** | 远程桌面架构（信令/中继/加密）；AGPL，只读 |

**可落地（NAS/Docker 阶段）**：
- 参考 Google 官方容器脚本的 **KVM/GPU 设备要求**来写 `Dockerfile` 与部署文档（Apache-2.0 可借鉴）。
- 无头实例 = `emulator -no-window` + adb 通道；「容器启动成功 ≠ Android 虚拟化正常」必须在文档与健康检查里区分。
- 默认安全：不 `privileged`、不 host 网络、不挂 Docker socket（`/dev/kvm` 用 `--device` 显式透传）。

## 4. UI 设计系统

| 组件库 | 仓库 | 许可证 | 星标 | 与本项目匹配度 |
| --- | --- | --- | --- | --- |
| shadcn/ui | `shadcn-ui/ui` | **MIT** | 128k | 高：复制即用的组件源码，无运行时锁定 |
| Radix Primitives | `radix-ui/primitives` | **MIT** | 19.5k | 高：无样式 + 无障碍，可配任意视觉 |
| Mantine | `mantinedev/mantine` | **MIT** | 32k | 中：完整组件库，但需 React |
| Ant Design | `ant-design/ant-design` | **MIT** | 100k | 中：企业风，视觉偏重 |
| Fluent UI | `microsoft/fluentui` | NOASSERTION | 20k | 低：许可证不明确，规避 |
| Material UI | `mui/material-ui` | **MIT** | 99k | 中：Material 风格 |
| Tailwind CSS | `tailwindlabs/tailwindcss` | **MIT** | 98k | 高：design token 友好 |
| Lucide Icons | `lucide-icons/lucide` | **ISC**（GitHub 显示 NOASSERTION，实为 ISC） | 26k | 高：2000+ 一致线性图标 |

**决策**：**不引入 React 组件库**。
- 理由：当前 UI 是原生 HTML/CSS/JS（`src/ui/app.js` 约 219k 字节），引入 React 等于重写渲染层，与「不允许因 UI 重构导致原功能消失」冲突。
- 借鉴方式（均 MIT/ISC，合规）：
  - **Token 化**：把颜色/间距/字号/圆角抽成 CSS 变量（`src/ui/tokens.css` 已有雏形），深色/浅色**分别设计**而非简单反色。
  - 借鉴 shadcn/ui 的「组件即源码、可改可控」理念与 Radix 的无障碍模式（焦点管理、ARIA）。
  - 图标采用 Lucide 的线性风格规范（自绘 SVG 或 ISC 授权图标）。

## 5. 与同类项目的差距与可落地功能

| 差距 | 现状 | 可落地 |
| --- | --- | --- |
| macOS 支持 | `unsupported`，产物可获取但打包/签名/公证缺失 | 先出 HVF 启动原型 → 再谈 dmg/公证（需开发者凭据） |
| Linux 窗口嵌入 | `external`，独立窗口 | X11 reparent 自研后端（可行）；Wayland 明确说明不可行 |
| Linux ARM64 | 无官方 emulator | 走 redroid/QEMU 容器路线，或明确「不支持并给出替代方案」 |
| 远程管理 | 无 | scrcpy 画面通道 + 认证 API + Web 控制台 |
| UI 一致性 | 原生 CSS，token 零散 | Token 化 + 深浅色分别设计 + Lucide 图标规范 |

## 6. 许可证红线（本项目 MIT）

- **可借鉴设计并可能合规引用**：MIT（Electron / shadcn / Radix / Tailwind / Ant / MUI / Mantine）、Apache-2.0（scrcpy / UTM / Tauri / android-emulator-container-scripts）、BSD（Flutter / v86）、ISC（Lucide）。
- **只读不引码**：GPL-2.0（QEMU）、GPL-3.0（Waydroid / Anbox / RustDesk / NewPipe）。
- **规避**：NOASSERTION 且无法确认的（Fluent UI、Neutralino、`qemu/qemu` 镜像）——不引入源码。
- 系统镜像（Android-x86 / Bliss / redroid 镜像）作为**下载的数据**使用，不并入源码仓库。

> 再次声明：本文所有条目均为**阅读与研究结论**，未将第三方代码复制进 ApkStart。
