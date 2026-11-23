# 跨平台架构升级报告（第一批：宿主适配层）

> 日期 2026-11-23 · 基线 `0.10.7`（`98604ea`）· 本机 Windows 11 x64 / Node v26.13.1
> 本报告只陈述**实际完成并验证**的工作。未完成的平台明确标注，不以方案冒充交付。

## 1. 完成了哪些工作

### 1.1 全面审计（P0）
- 检查仓库结构（93 源文件 / 44,229 行；78 测试文件 / 24,012 行）、依赖、主进程/preload/渲染层、
  核心业务、运行时（adb/emulator/QEMU/镜像）、更新、备份、CI。
- 用可复现脚本量化平台耦合：`node tools/audit-metrics.js`
  - `process.platform` 81 处 / 23 文件；`powershell.exe` 16 处 / 7 文件；
  - `'win32'` 字面量 58 处 / 24 文件；`IS_WIN` 30 处（集中在 provision 17 / emulator 11）。
- 产出 `docs/CROSS_PLATFORM_AUDIT.md`（架构图、平台矩阵、模块依赖清单、改造难度、风险、可复用/需重构、顺序）。

### 1.2 开源研究（P0）
- 产出 `docs/OPEN_SOURCE_RESEARCH.md`；**许可证与星标全部经 `gh api` 实读**，非记忆。
- 覆盖：Android Emulator、scrcpy、Waydroid、redroid、UTM、QEMU/crosvm、Android-x86/Bliss、
  Electron/Tauri/Flutter/Neutralino、Docker 方案、shadcn/Radix/Mantine/Ant/MUI/Fluent/Tailwind/Lucide。
- **未复制任何第三方代码**；GPL/AGPL/NOASSERTION 一律只读。

### 1.3 宿主适配层与真实缺陷修复（P1 首批）
这是本批次的**核心代码交付**。发现并修复了三个真实缺陷（不是假设）：

1. **macOS 归档前缀拼错**：`HOST_TAG = ... : 'mac'` → Google 官方前缀是 `darwin`。
   原代码在 macOS 上永远匹配不到任何 emulator 归档。
2. **架构写死 `_x64`**：`${HOST_TAG}_x64` 过滤器导致 Apple Silicon 永远取不到
   `emulator-darwin_aarch64-N.zip`。
3. **镜像 ABI 写死 `x86_64`**：ARM64 宿主会下载 x86_64 镜像（指令集不兼容，装上也起不来）；
   emulator / sysimg / play 三处解析器都把 `x86_64` 写死。

外加两个衍生修复：
4. **macOS 加速被误标为 `kvm`**：`if (!IS_WIN)` 把 macOS 也当 Linux，会给用户一条
   在 macOS 上不存在的「加入 kvm 组」建议。现按宿主区分 `kvm` / `hvf`。
5. **`hypervisor()` 对 macOS 返回「非 Windows 平台」** → 现返回 HVF 机制说明。

## 2. 修改了哪些文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/core/host/profile.js` | 新增 | 纯函数：架构归一化、emulator 前缀表、platform-tools 目标、默认镜像 ABI、加速后端 |
| `src/core/host/index.js` | 新增 | `HostAdapter`：统一接口，能力取自声明表；`runtimeAcquirable()` 区分「可获取」与「已验证」 |
| `src/core/provision.js` | 修改 | 用 hostProfile 决定前缀/ABI；macOS 兜底 URL；macOS 加速分支；sysimg/play 解析器按 ABI 过滤 |
| `src/core/platform-capabilities.js` | 修改 | macOS `provision` 增 `acquirable: true`（事实），`level` 仍 `absent`，阻塞码保留 |
| `src/core/platform.js` | 修改 | `describe()` 增 `host` 事实块（惰性 require + 异常兜底） |
| `test/host-profile-test.js` | 新增 | 10 项离线回归，钉死上述修复与「不虚报」纪律 |
| `test/instance-runtime-readonly-test.js` | 修改 | 补 `./host/profile` 严格 stub 声明 |
| `test/runtime-data-safety-test.js` | 修改 | 同上 |
| `test/runtime-component-integrity-test.js` | 修改 | 同上 |
| `package.json` | 修改 | `test:safety` 纳入 `host-profile-test.js` |
| `tools/audit-metrics.js` | 新增 | 只读度量脚本 |
| `docs/CROSS_PLATFORM_AUDIT.md` | 新增 | 审计报告 |
| `docs/OPEN_SOURCE_RESEARCH.md` | 新增 | 开源研究 |
| `docs/ROADMAP.md` | 新增 | 路线图与验证台账 |
| `docs/PLATFORM_COMPATIBILITY.md` | 新增 | 平台兼容性 |
| `docs/SECURITY_AUDIT.md` | 新增 | 本轮安全审查 |
| `docs/FINAL_UPGRADE_REPORT.md` | 新增 | 本报告 |

## 3. 新增了哪些功能

- **宿主画像（Host Profile）**：一处回答「这个宿主对应哪份官方 emulator / platform-tools、
  默认用哪个 ABI 的镜像、加速走哪种机制」，纯函数、可离线测试。
- **HostAdapter 接口**：`exeSuffix()/exe()/emulatorArchivePrefix()/platformToolsTarget()/
  sysimgAbi()/accelerationBackend()/capability()/supportLevel()/blockers()/runtimeAcquirable()/describe()`。
- **按架构选择系统镜像**：ARM64 宿主自动选 `arm64-v8a`（含兜底 URL 一起换），x64 宿主维持 `x86_64`。
- **诊断可见的宿主事实**：`platform.describe().host` 直接给出产物名/ABI/加速种类/可获得性。
- **可复现度量**：`tools/audit-metrics.js`。

## 4. 修复了哪些 Bug

见第 1.3 节 5 条，均有对应测试：
- `test/host-profile-test.js`：前缀、ABI、Linux ARM64 无产物、不虚报、provision 契约。
- `test/engine-test.js`：既有 38 项在修改后仍 0 失败。

## 5. 重构了哪些模块

- `provision.js`：把「宿主相关」从散落的 `IS_WIN`/`_x64` 判断收敛到 `host/profile.js`。
  这是「平台判断单一出处」原则在运行时的落地（此前只有 `platform.js` 做能力门禁，
  产物名仍散写）。
- `platform.js`：能力门禁不变，仅增加事实暴露。

## 6. 新增了哪些平台

**没有新增已支持平台。** 本批次是架构基础，不是平台交付。
诚实结论：
- macOS：官方产物可得（本次修正了取错产物的 bug），但**未实测、无打包/签名/公证** → 仍 `unsupported`。
- Linux ARM64：**Google 无官方 emulator** → 不能靠重打包支持。

## 7. 哪些平台已真实验证

| 平台 | 验证程度 |
| --- | --- |
| Windows x64 | 单元/集成测试退出码 0（本机实跑）；既有功能路径未回归 |
| Linux x64 | 仅 CI 单元测试（Ubuntu）；**未在本机做桌面实测** |
| macOS / SteamOS / ARM64 / Docker | **未验证** |

## 8. 哪些平台仍存在限制

- **macOS**：需真实 Mac 验证 HVF 启动；需 Developer ID 证书做签名公证（外部凭据，不得伪造）。
- **Linux x64**：无窗口嵌入（Wayland 无解，X11 待自研后端）。
- **Linux ARM64**：无官方模拟器运行时。
- **SteamOS**：只读根/Flatpak/Gamescope 未适配。
- **Docker/Web/Android 客户端**：未实施。

## 9. 自动化测试结果（本机实测）

```
npm test                                            → 退出码 0（所有子套件 fail 0）
node test/host-profile-test.js                      → 10 passed, 0 failed
node test/platform-capabilities-test.js             → 15 passed, 0 failed
node test/engine-test.js                            → 38 通过，0 失败
node --test (instance-runtime-readonly / runtime-data-safety /
             runtime-component-integrity / snapshot-partition-safety /
             instance-adb)                          → 184 pass, 0 fail
npm audit --registry=https://registry.npmjs.org     → total 0（全等级 0）
```

## 10. 构建结果

- 本批次未改变打包配置（`electron-builder.yml` 未改）。
- 既有 Windows 便携版/NSIS 与 Linux AppImage/deb 构建路径不受影响。
- **未执行**新的安装包构建与真实安装（避免把构建成功写成安装成功）。

## 11. Release 地址

本批次**尚未发布**。发布需经过：
1. 分支 → PR → CI（Windows Node 20/22、Linux、UI fixture）全绿；
2. 版本号与 CHANGELOG/README 同步（`npm run readme:sync`）；
3. 打 tag 触发 `release.yml`，签署清单并在草稿核对后公开。

历史 Release：见 <https://github.com/yuchen0x1/apkstart/releases>。

## 12. 下一阶段升级计划

| 顺序 | 任务 | 依赖/边界 |
| --- | --- | --- |
| 1 | `process-owner.js` darwin 分支 | 需 macOS 环境验证 `ps`/`lsof` 方案 |
| 2 | macOS 运行时产物路径 + HVF 启动原型 | 需真实 Mac（Intel + ARM64 各一） |
| 3 | macOS dmg + 签名 + 公证 | **需开发者凭据（被阻塞）** |
| 4 | Linux X11 窗口嵌入后端 | 需 X11 环境；Wayland 明确不支持 |
| 5 | NAS/Docker 无头服务端 | 参考 Google 容器脚本；默认安全配置 |
| 6 | Remote Agent + Web 控制台 + Android 客户端 | 实时画面优先 scrcpy 通道 |

完整状态见 `docs/ROADMAP.md`。

## 13. 纪律声明

- 本批次的「通过」全部对应本机实际执行的命令与退出码。
- 未在真实 Linux/macOS/SteamOS/ARM64 硬件上验证的功能，均标「未验证」。
- 没有引入未验证依赖；没有新增下载源或命令执行点。
- 没有用空函数/假数据冒充功能；没有把模拟结果写成真实运行结果。
