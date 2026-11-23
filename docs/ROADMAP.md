# ApkStart 跨平台路线图

> 更新 2026-11-23（基线 `0.10.7`）。
> 状态词：**已完成** / **进行中** / **待实施** / **被阻塞** / **尚未验证**。
> 纪律：只有完成真实构建、安装、启动、关键功能测试的平台才算「已完成」。产物可得 ≠ 已验证。

## 状态总览

| 阶段 | 目标 | 状态 | 说明 |
| --- | --- | --- | --- |
| P0 | 全面审计 + 跨平台改造计划 | **已完成** | `docs/CROSS_PLATFORM_AUDIT.md`、`docs/OPEN_SOURCE_RESEARCH.md` |
| P1 | 抽离宿主适配层，保证 Windows/Linux 零回归 | **已完成（首批）** | `src/core/host/`；修正 macOS 前缀/ARM64 ABI；`npm test` 退出 0 |
| P1b | 宿主相关的其余分叉（process-owner darwin、provision 产物路径） | **进行中** | darwin 进程归属与 macOS 运行时目录布局 |
| P2 | macOS 技术验证与首个可运行版本 | **尚未验证** | 依赖真实 Mac（Intel + Apple Silicon） |
| P2b | macOS dmg + Developer ID 签名 + 公证 | **被阻塞** | 需合法开发者凭据（外部条件） |
| P3 | SteamOS / Steam Deck 适配 | **待实施** | 需真实 SteamOS 环境 |
| P4 | Linux ARM64 适配 | **待实施（有硬约束）** | Google 无 `emulator-linux_aarch64`，需另立容器路线 |
| P5 | NAS / Docker 无头服务端 | **待实施** | 设计已明确（见下） |
| P6 | 统一 Remote Agent 与 API | **待实施** | — |
| P7 | Web 远程管理控制台 | **待实施** | — |
| P8 | Android 远程管理客户端 | **待实施** | — |
| P9 | 全面 UI / 性能 / 安全 / 文档 | **进行中（持续性）** | 深浅色 token、性能与安全审计持续进行 |
| P10 | 自动化 CI/CD 与正式发布体系 | **已完成（Windows/Linux）/ 待扩展** | macOS/ARM64/Docker 构建未接入 |

## P0 — 审计与计划（已完成）

- [x] 检查仓库结构、依赖、主进程/preload/渲染层、核心业务、运行时、CI。
- [x] 量化平台耦合（`node tools/audit-metrics.js`：`process.platform` 81 处 / 23 文件）。
- [x] 生成 `docs/CROSS_PLATFORM_AUDIT.md`（架构图、平台支持、模块依赖、难度、风险、可复用/需重构、顺序）。
- [x] 生成 `docs/OPEN_SOURCE_RESEARCH.md`（许可证经 `gh api` 核实；未复制代码）。

## P1 — 宿主适配层（已完成首批）

- [x] 新增 `src/core/host/profile.js`：宿主→官方 emulator 归档前缀 / platform-tools 目标 / 默认镜像 ABI / 加速后端（纯函数）。
- [x] 新增 `src/core/host/index.js`：`HostAdapter`，能力全部取自 `platform-capabilities.js`，不另立判断。
- [x] 修复真实缺陷：macOS 前缀 `mac`→`darwin`；`_x64` 过滤器→按宿主前缀；镜像 ABI 按架构选择；macOS 加速不再误报 kvm。
- [x] `platform.describe()` 附带 `host` 事实块，诊断报告可见。
- [x] 新增 `test/host-profile-test.js`（10 项），并纳入 `npm run test:safety`。
- [x] 完整 `npm test` 退出码 0；Windows/Linux 既有行为零回归。

**P1 剩余（进行中）**：
- [ ] `process-owner.js` darwin 分支（`ps` / `lsof` 或 `libproc`）；当前 darwin 返回 null。
- [ ] `provision.js` 的 macOS 产物路径与安装动作（QEMU/dmg 布局）。
- [ ] 把「加速后端种类」与 `platform.acceleration()` 合并为单一探测入口。

## P2 — macOS（尚未验证 / 部分被阻塞）

**技术验证原型（尚未验证）**：
- [ ] Intel Mac：HVF + `x86_64` 镜像启动。
- [ ] Apple Silicon Mac：HVF + `arm64-v8a` 镜像启动（host 层已能正确选取 ABI）。
- [ ] APK 拖放/安装、应用库、Runtime 管理、ADB、文件共享、诊断（在真实 Mac 上）。

**分发（被阻塞，需外部条件）**：
- [ ] dmg 打包（electron-builder `mac` 目标）。
- [ ] Developer ID 签名 + 公证（需合法开发者账号与证书，不得伪造签名状态）。

> **现状诚实说明**：Google 官方**确实**发布了 macOS emulator（`darwin_x64` / `darwin_aarch64`）与 platform-tools（`darwin`），架构匹配的镜像也在索引里。所以「产物可获取」为真；但本项目**尚未**在真实 Mac 上实测，也没有 dmg/签名/公证链路，故平台整体仍标记 `unsupported`。

## P3 — SteamOS / Steam Deck（待实施）

- [ ] 真实 SteamOS 环境验证（Desktop Mode 与 Game Mode）。
- [ ] Flatpak 打包（只读根分区限制）。
- [ ] Gamescope/Game Mode 启动入口、全屏、手柄与触屏。
- [ ] 明确「哪些功能仅 Desktop Mode 可用」。

## P4 — Linux ARM64（待实施，有硬约束）

**事实**：Google 官方索引里**没有** `emulator-linux_aarch64`。不能靠重新打包 ApkStart 获得。
- [ ] 先做**能力探测与明确提示**（不做静默失败）。
- [ ] 评估容器路线（参考 redroid / Waydroid 思想；均不引入其代码）或 QEMU 自建。
- [ ] APK ABI 兼容性检测（ARM64 宿主 + x86 应用需转译或说明不可行）。
- [ ] 若最终无可行路线，文档明确「不支持并给出替代方案」。

## P5 — NAS / Docker（待实施）

- [ ] `Dockerfile` / `docker-compose.yml` / `.env.example`。
- [ ] 无头实例（`emulator -no-window` + adb 通道）。
- [ ] 健康检查区分「容器起来了」与「Android 虚拟化正常」。
- [ ] 默认安全：不 `privileged`、不 host 网络、不挂 Docker socket；`/dev/kvm` 显式 `--device`。
- [ ] 安装/更新/卸载/诊断脚本 + 部署文档。

## P6–P8 — 远程能力（待实施）

- [ ] Remote Agent：节点注册/状态/任务/APK 安装/实例启停/日志/资源/文件传输/认证。
- [ ] Web 控制台：登录、节点/实例管理、APK 上传与安装、监控、实时日志、截图、备份（实时画面优先 scrcpy 通道）。
- [ ] Android 客户端：远程管理（非本地跑虚拟机），与 Web 共享 API 与权限体系。
- [ ] 通信必须认证 + 授权 + 加密 + 审计日志。

## P9 — UI / 性能 / 安全 / 文档（持续进行中）

- [ ] 深色/浅色**分别设计**（`src/ui/tokens.css` token 化，非简单反色）。
- [ ] 统一图标规范（Lucide 线性风格）。
- [ ] 性能：启动/扫描/安装/下载/开机耗时、内存/磁盘/GPU、子进程与句柄泄漏。
- [ ] 安全：路径穿越、命令注入、本地/远程 API、上传限制、密钥管理、依赖漏洞（见 `docs/SECURITY_AUDIT.md`）。

## P10 — CI/CD（Windows/Linux 已完成，其余待扩展）

- [x] Windows x64：单元测试（Node 20/22）+ 便携版 + NSIS。
- [x] Linux x64：单元测试 + AppImage/deb。
- [x] UI fixture 已纳入 CI（`ui.yml` 被 `ci.yml` / `release.yml` 复用）。
- [ ] macOS Intel / Apple Silicon 构建（需 macOS runner + 签名凭据）。
- [ ] Linux ARM64 构建（受 P4 硬约束）。
- [ ] Docker 镜像构建与发布。

## 验证状态台账（不虚构）

| 平台 | 构建 | 安装 | 启动 | 关键功能 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Windows x64 | ✅ 实测（本仓 CI + 本地） | ✅ 便携/NSIS 构建 | ✅ | ✅ | **已完成** |
| Linux x64 | ✅ 实测（CI Ubuntu） | ✅ AppImage/deb 构建 | ⚠️ 见 `PLATFORM-LINUX-VALIDATION.md` | ⚠️ | **external** |
| macOS Intel | ❌ | ❌ | ❌ | ❌ | **尚未验证** |
| macOS ARM64 | ❌ | ❌ | ❌ | ❌ | **尚未验证** |
| SteamOS | ❌ | ❌ | ❌ | ❌ | **待实施** |
| Linux ARM64 | ❌ | ❌ | ❌ | ❌ | **待实施（硬约束）** |
| NAS/Docker | ❌ | ❌ | ❌ | ❌ | **待实施** |

> 本机是 Windows；Linux/macOS/SteamOS/ARM64 的真实硬件验证必须在对应环境进行，不能由 Windows 上的夹具替代。
