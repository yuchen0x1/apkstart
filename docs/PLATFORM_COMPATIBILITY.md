# 平台兼容性与验收状态

> 日期 2026-11-23，基线 `0.10.7`。
> 原则：未在真实环境验证的项一律标「未验证」，不用夹具冒充真机。
> 本机环境：Windows 11 x64，Node v26.13.1，npm 11.20.0。

## 1. 本批次的验收范围

本批次是跨平台架构升级的第一批（宿主适配层），不是全平台交付。
因此验收重点是：

1. Windows / Linux 原有功能零回归；
2. 新增宿主层离线可验证；
3. 对 macOS / ARM64 的结论只依据官方事实，不声称已完成。

## 2. 自动化测试结果（本机实测）

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 完整单元/集成测试 | `npm test` | 退出码 0，所有子套件 fail 0 |
| 宿主画像回归（新增） | `node test/host-profile-test.js` | 10 通过，0 失败 |
| 平台能力声明 | `node test/platform-capabilities-test.js` | 15 通过，0 失败 |
| 引擎/运行时 | `node test/engine-test.js` | 38 通过，0 失败 |
| 只读边界 + 严格 stub（含新增依赖） | `node --test`（5 套件） | 184 通过，0 失败 |
| 依赖漏洞 | `npm audit --registry=https://registry.npmjs.org` | 0 漏洞（全等级 0） |

> 测试全部为离线/夹具或本机真实 Node 执行；未在 Linux/macOS/SteamOS/ARM64 实机运行。

## 3. 平台验证矩阵

| 平台 | 构建 | 安装 | 启动 Android | 关键功能 | 结论 |
| --- | --- | --- | --- | --- | --- |
| Windows 10/11 x64 | 已 CI（Node 20/22）+ 本地便携/NSIS | 构建成功 | 既有实测 | 通过 | 正式支持（full） |
| Linux x86_64 | 已 CI（Ubuntu / Node 22） | AppImage/deb 构建 | 见 PLATFORM-LINUX-VALIDATION.md | 独立窗口 | external（受限支持） |
| macOS Intel | 未配置 | 未验证 | 未验证 | 未验证 | 尚未验证 |
| macOS Apple Silicon | 未配置 | 未验证 | 未验证 | 未验证 | 尚未验证 |
| SteamOS / Steam Deck | 未验证 | 未验证 | 未验证 | 未验证 | 未验证 |
| Linux ARM64 | 未验证 | 未验证 | 无官方运行时 | 未验证 | 未验证（有硬约束） |
| NAS / Docker | 未验证 | 未验证 | 未验证 | 未验证 | 未实施 |

## 4. 未验证事项与环境限制（必须如实记录）

- macOS 全部实测项：需 Intel Mac 与 Apple Silicon Mac 各一台；本机无 macOS。
- Linux 桌面实测：CI 只跑单元测试，不跑真实图形会话与 KVM 开机。
- SteamOS：需真实 Steam Deck 或等价 SteamOS 环境。
- Linux ARM64：需真实 ARM64 设备；且 Google 无 `emulator-linux_aarch64`（已核实官方索引），
  所以即使有设备也不能用「官方 emulator」路线。
- Docker：未构建镜像，未验证 KVM/GPU 透传。
- GPU / 长时间视频 / 音画同步：见 Issue #13 状态（代码级缓解已验证，真实流未验收）。
- 真机升级 / UAC / 断电 / 杀软：未实测。

## 5. 「官方产物可得」的核实记录（非猜测）

2026-11-23 实际读取 `https://dl.google.com/android/repository/repository2-3.xml`：

```
emulator-darwin_aarch64-16916650.zip
emulator-darwin_aarch64-16970787.zip
emulator-darwin_x64-16916650.zip
emulator-darwin_x64-16970787.zip
emulator-linux_x64-16916650.zip
emulator-linux_x64-16970787.zip
emulator-windows_x64-16916650.zip
emulator-windows_x64-16970787.zip
```

platform-tools host-os 只有：`darwin` / `linux` / `win`。
系统镜像索引（google_apis / google_apis_playstore / android）均含 `android-34;…;arm64-v8a`。

结论：
- macOS（Intel / ARM64）的官方运行时**确实存在** → `HostAdapter.runtimeAcquirable() === true`。
- 但**产物可得 ≠ 本项目的 macOS 打包/签名/公证/实测已完成**，故平台整体仍 `unsupported`。
- Linux ARM64 **没有**官方 emulator → `emulatorArchivePrefix('linux','arm64') === ''`（测试已钉死）。

## 6. 如何自行复核

```bash
# 1) 能力声明与宿主画像（离线，无需网络）
node --test test/platform-capabilities-test.js test/host-profile-test.js

# 2) 看当前机器的宿主事实
node -e "console.log(require('./src/core/platform').describe().host)"

# 3) 度量平台耦合点
node tools/audit-metrics.js

# 4) 完整回归
npm test
```

## 7. 声明

本文件中的「通过」均对应**本机实际执行**的命令与退出码；「未验证」即为未验证，
不使用模拟结果代替真实硬件测试，也不把构建成功写成安装/启动成功。
