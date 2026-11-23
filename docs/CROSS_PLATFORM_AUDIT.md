# ApkStart 跨平台架构审计

> 版本基线：`0.10.7`（`98604ea`），审计日期 2026-11-23。
> 本文是**代码事实**记录，不是路线图承诺。凡未在本仓实测的平台，一律标注「未验证」。
> 度量命令：`node tools/audit-metrics.js`（只读，不改文件）。

## 0. 结论摘要

| 项目 | 现状 |
| --- | --- |
| 代码规模 | 源码 93 文件 / 44,229 行；测试 78 文件 / 24,012 行 |
| 真正受支持的平台 | Windows x64（`full`）、Linux x64（`external`，独立窗口 + 内置运行时） |
| 已声明未支持 | macOS（Intel / Apple Silicon）——`unsupported`，有结构化阻塞代码 |
| 平台判断的单一出处 | `src/core/platform-capabilities.js`（声明表）→ `src/core/platform.js`（读取） |
| 最大平台耦合点 | `provision.js`（17 处 `IS_WIN`）、`main.js`（25 处平台相关）、`process-owner.js`（进程归属，双后端） |
| 本次已修复的真实缺陷 | macOS 官方 emulator 归档前缀拼错（`mac` → 应为 `darwin`）；`_x64` 写死导致 Apple Silicon 永远取不到 arm64 运行时；ARM64 宿主默认镜像 ABI 错误 |

## 1. 当前架构

```
┌──────────────────────────────────────────────────────────────┐
│ 表现层  src/ui (原生 HTML/CSS/JS)，sandbox + contextIsolation │
├──────────────────────────────────────────────────────────────┤
│ 边界    src/preload.js（白名单桥接） · src/core/ipcguard.js    │
├──────────────────────────────────────────────────────────────┤
│ 编排    src/main.js（窗口/托盘/CLI/IPC/生命周期）              │
│         installer.js（APK 安装流水线）                         │
├──────────────────────────────────────────────────────────────┤
│ 域层    engine.js  adb.js  sharer.js  compat.js  backup.js    │
│         container.js  guest.js  instances.js  doctor.js       │
│         repair.js  provision.js  emulator.js  images.js       │
├──────────────────────────────────────────────────────────────┤
│ 平台    platform.js（能力读取）                                │
│         platform-capabilities.js（声明表：唯一判断依据）        │
│         host/profile.js（宿主→官方产物名/ABI）【本次新增】      │
│         host/index.js（HostAdapter）【本次新增】                │
├──────────────────────────────────────────────────────────────┤
│ 后端    Win32 代理（win/agent.ps1）│ KVM │ HVF（未实现）        │
│         QEMU 后端（system-providers/qemu-backend.js）          │
└──────────────────────────────────────────────────────────────┘
```

### 三条既有边界（务必保持）

1. **渲染层 → 主进程**：渲染进程无 Node 能力；`ipcguard.js` 校验消息来源。
2. **更新包 → 安装目录**：解压前 `safeEntryPath` + CRC + 载荷校验；失败回滚。
3. **本机文件 ↔ 设备文件**：一致性以 SHA-256 三方合并为唯一依据。

## 2. 平台支持情况（以代码与实测记录为准）

| 平台 | 级别 | 依据 | 限制 |
| --- | --- | --- | --- |
| Windows 10/11 x64 | `full` | 窗口嵌入（SetParent）、WHPX/AEHD、注册表集成、鼠标钩子 | — |
| Linux x86_64 | `external` | 内置运行时（官方源逐组件）、`/dev/kvm`、独立窗口 | 不支持窗口嵌入；Wayland 会话无 reparent 方案；见 `docs/PLATFORM-LINUX-VALIDATION.md` |
| macOS Intel | `unsupported` | 官方产物**存在**（`emulator-darwin_x64`），但本项目 dmg 打包/签名/公证/实测全缺 | 阻塞码 `NO_MAC_PACKAGING` / `NO_NOTARIZATION` / `NO_MAC_RUNTIME_VALIDATION` |
| macOS Apple Silicon | `unsupported` | 官方产物**存在**（`emulator-darwin_aarch64`），同上 | 同上 + 需 arm64-v8a 镜像（已在 host 层支持选择） |
| SteamOS / Steam Deck | 未声明 | 基于 Linux，但只读根分区、Flatpak、Gamescope 均未适配 | 需真实设备验证 |
| Linux ARM64 | 未声明 | **Google 从未发布 `emulator-linux_aarch64`**（已核实官方索引） | 无官方模拟器运行时，不能靠重打包获得 |

> **关键事实核对（2026-11-23 实际读取官方索引）**：`repository2-3.xml` 中 emulator 归档只有
> `emulator-windows_x64`、`emulator-linux_x64`、`emulator-darwin_x64`、`emulator-darwin_aarch64` 四种；
> platform-tools 只有 `win` / `linux` / `darwin` 三种 host-os。**没有** `emulator-linux_aarch64`。

## 3. 各模块平台依赖清单

| 模块 | 平台耦合 | 耦合内容 | 可复用性 |
| --- | --- | --- | --- |
| `provision.js` | **高**（17×`IS_WIN`） | 官方包名、可执行后缀、AEHD 驱动、平台工具库文件、QEMU 来源 | 中：核心下载/校验逻辑跨平台；包名与安装动作需分叉 |
| `main.js` | **高**（25 处） | 窗口嵌入、托盘、注册表启动项、UAC 提权、WHPX 功能开关 | 低：大量 Win32 特有交互 |
| `process-owner.js` | 高 | Windows 走 PowerShell 校验；Linux 走 `/proc` + pidfd | 高：已有双后端，仅缺 darwin 分支 |
| `emulator.js` | 中（11×`IS_WIN`） | qemu-img / e2fsck / resize2fs 来源（自带 vs 系统包） | 中 |
| `doctor.js` | 中 | 注册表读 BIOS 厂商、WHPX 诊断、短路径（8.3） | 中：诊断文本跨平台，部分探测 Win32 专有 |
| `adb.js` | 低 | 常见 adb 路径表（已按平台分叉，含 macOS） | 高 |
| `assoc.js` / `shortcut.js` / `windowctl.js` / `agent.js` | 全 Win32 | 注册表、.lnk、SetWindowPos、WH_MOUSE_LL | 低：这些**就是** Windows 实现，不应强移植 |
| `compat.js` | **无** | 纯逻辑（ABI/minSdk/feature 分析） | 100% 复用 |
| `zip.js` / `axml.js` / `arsc.js` / `apk.js` / `png.js` | **无** | 纯解析 | 100% 复用 |
| `host/profile.js`（新增） | **无** | 纯函数映射 | 100% 复用，可离线测试 |

## 4. 跨平台改造难度

| 能力 | 难度 | 说明 |
| --- | --- | --- |
| APK 解析 / 兼容性分析 / 存储 / 备份 | ★☆☆☆☆ | 已完全平台无关 |
| 运行时下载与校验（adb / emulator / 镜像） | ★★☆☆☆ | 本次已修好产物名与 ABI 选择；剩余是 macOS 产物落盘路径 |
| Linux x64 完整体验 | ★★☆☆☆ | 缺窗口嵌入；X11 reparent 自研后端可做，Wayland 无解 |
| macOS 运行时启动 | ★★★☆☆ | 产物可得 + HVF；缺 macOS 版 provision 路径与真机验证 |
| macOS 分发（dmg / 签名 / 公证） | ★★★★☆ | 需 Developer ID 证书与公证链路，非代码问题 |
| SteamOS（Gamescope / 只读根） | ★★★★☆ | 需 Flatpak 打包 + 输入适配 |
| Linux ARM64 | ★★★★★ | **无官方 emulator**；只能走 QEMU 自建或容器方案，另立技术路线 |
| 远程节点 / Web 控制台 / Android 客户端 | ★★★★☆ | 全新子系统，见 `docs/ROADMAP.md` |

## 5. 技术风险

1. **假支持风险**：把「Google 发布了 macOS 产物」当成「ApkStart 支持 macOS」。本次已在声明表中用
   `acquirable: true` 与 `level: absent` 分开表达，并加测试守住。
2. **ARM64 误导**：ARM64 Linux 上的 x86_64 镜像起不来是指令集问题，不是性能问题；UI 与文档必须明说。
3. **平台判断扩散**：`process.platform` 仍出现在 23 个文件中（81 处）。新增判断必须先进声明表，不允许再散写。
4. **Wayland**：跨进程 reparent 在协议层不可行，不能承诺「X11 方案覆盖 GNOME」。
5. **测试替身脆弱**：`provision.js` 被 5 个 safety 测试用严格 stub 加载，新增依赖需同步声明（本次已补 `./host/profile`）。

## 6. 可复用模块

- 全量可复用：`zip` `axml` `arsc` `apk` `apk-bundle` `png` `compat` `atomic-json` `version` `store`（路径已抽象）。
- 高复用：`adb` `download` `runtime-integrity` `images` `backup` `sharer` `automation` `instance-context`。
- 新增可复用：`host/profile`（纯函数）、`host/index`（HostAdapter）。

## 7. 必须重构的模块

- `provision.js`：继续把「宿主相关」的包名/路径/加速种类迁到 `host/`（本次已完成包名、ABI、加速种类）。
- `process-owner.js`：新增 darwin 分支（`ps`/`lsof` 或 `libproc`），目前 darwin 返回 null。
- `main.js`：把 Win32 专有交互（提权、功能开关、托盘菜单）收敛为「平台能力 → 执行器」两段。

## 8. 推荐实施顺序（与 ROADMAP 对齐）

1. **P1（已开始）**：抽离宿主适配层，修正 macOS/ARM64 的真实产物名与 ABI 选择，保证 Windows/Linux 零回归。
2. **P1**：`process-owner` darwin 分支 + macOS provision 产物路径（runtime 目录布局）。
3. **P2**：macOS 技术验证（HVF 启动 + arm64-v8a 镜像），先出可运行原型，再谈分发。
4. **P2**：macOS dmg + 签名 + 公证（依赖开发者凭据，属外部条件）。
5. **P3+**：SteamOS → Linux ARM64（先做能力探测与明确提示，再谈实现）→ 无头服务端/Web/客户端。

## 9. 本次审计实际改动（可回滚）

| 文件 | 改动 |
| --- | --- |
| `src/core/host/profile.js` | 新增：宿主→官方产物名 / 默认镜像 ABI / 加速后端（纯函数） |
| `src/core/host/index.js` | 新增：`HostAdapter`，能力一律取自声明表 |
| `src/core/provision.js` | 修正 macOS 前缀 `mac`→`darwin`；`_x64` 过滤器改为按宿主前缀；镜像 ABI 按架构选择；macOS 加速分支不再误报 kvm |
| `src/core/platform-capabilities.js` | macOS `provision` 增加 `acquirable: true`（事实），`level` 仍为 `absent` |
| `src/core/platform.js` | `describe()` 附带 `host` 事实块 |
| `test/host-profile-test.js` | 新增 10 项离线回归，钉死上述修复 |
| `test/{instance-runtime-readonly,runtime-data-safety,runtime-component-integrity}-test.js` | 补 `./host/profile` 严格 stub 声明 |
| `tools/audit-metrics.js` | 新增：可复现的度量脚本 |

**未改动**：Windows/Linux 既有行为路径（窗口嵌入、运行时部署、更新、备份）——完整 `npm test` 退出码 0。
