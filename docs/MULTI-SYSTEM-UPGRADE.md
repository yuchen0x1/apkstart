# 多系统升级实施与验收报告

本次升级：新增 LineageOS / Bliss OS / Android-x86 三系统的按需下载、一键安装与一键切换，
统一到 Provider 架构 + 远程目录 + 统一任务管理器，进度接入现有运行状态区域。

## 一、实际修改文件

**修改（13）**：`.github/workflows/ci.yml`、`CHANGELOG.md`、`README.md`、`build/pack.js`、
`docs/ARCHITECTURE.md`、`package.json`、`src/core/store.js`、`src/i18n/en-US.json`、
`src/main.js`、`src/preload.js`、`src/ui/app.js`、`src/ui/index.html`、`src/ui/style.css`。

**新增模块（核心）**：
- `src/core/system-catalog.js`：远程目录加载 / 缓存回退 / 内置索引 / 不伪造资源校验。
- `src/core/system-task-manager.js`：统一任务对象 / 状态机 / 暂停取消重试 / 持久化 / 去重锁。
- `src/core/system-manager.js`：统一切换 / 生命周期 / Android 就绪判定 / 备份恢复删除 / 空间统计。
- `src/core/system-providers/`：`base-provider`、`google-provider`(emulator-provider 覆盖)、
  `aosp-provider`(emulator-provider 覆盖)、`lineage-provider`、`bliss-provider`、
  `android-x86-provider`、`custom-provider`、`qemu-iso-provider`、`qemu-backend`、`index`。
- `system-catalog/catalog.json`（部署位置）与 `src/system-catalog/catalog.json`（随包内置索引）。

**新增测试（4）**：`test/system-catalog-test.js`、`test/system-providers-test.js`、
`test/system-task-manager-test.js`、`test/build-size-test.js`（已加入 `npm test` 链）。

**新增构建闸门**：`build/check-no-images.js`（pack.js 与 CI 均接入）。

**新增文档（4）**：`docs/SYSTEMS.md`、`docs/DOWNLOAD-MANAGER.md`、`docs/COMPATIBILITY.md`、本报告。

## 二、三系统接入情况

| 系统 | 后端 | 真实状态 | 预构建镜像 |
|---|---|---|---|
| Android-x86 9.0-r2 | QEMU | ✅ 可下载安装 | 官方 ISO + SHA-256 |
| Bliss OS 16.9.7 | QEMU | ⚠️ 官方归档快照，可下载安装 | 官方 ISO + .sha256 |
| LineageOS | Android Emulator | ⛔ 无预构建，导入能力 + 真实状态 | 官方不提供，未伪造 |

## 三、验证证据

### 自动化测试（Node 环境，`npm test` 全链 exit 0）
- 目录：9/9（加载/缓存回退/不伪造降级/真实数据）
- Provider：9/9（7 provider 契约/真实状态/独立目录/QEMU 参数）
- 任务管理器：11/11（状态机/去重/暂停取消重试/持久化）
- 构建闸门：8/8（ISO/大镜像拒绝，压缩镜像放行）
- 现有 19 项测试全部通过，未破坏原有功能。

### 端到端流水线（逻辑层）
状态流转实测：`waiting → preparing → downloading → verifying → installing → initializing → starting → completed`；
进度事件完整，阶段顺序正确，download 成功不冒充 install 成功，install 不冒充 Android 就绪。

### 实际下载验证（真实网络探针，未下载完整镜像）
可复现脚本：`node test/iso-source-probe.js [bliss-os|android-x86]`，用**项目自己的下载器**
（`download.head` / `openStream`，含代理与重定向）实连官方源，两个系统均 PASS：

| 系统 | HEAD | Range | Content-Length | ISO9660 魔数 @0x8001 | 目录 SHA-256 |
|---|---|---|---|---|---|
| Bliss OS 16.9.7 | 200 | 206 | 2429550592（与目录一致） | `CD001` | `17137711…f42e3751` |
| Android-x86 9.0-r2 | 200 | 206 | 965738496（与目录一致） | `CD001` | `f7eb8fc5…4604e` |

Bliss OS 的 SHA-256 另经官方 `.iso.sha256` 文件逐位复核，与目录记录完全一致。

**完整下载为何没做**：实测当前网络到 SourceForge 单源约 436 KB/s，其余官方镜像节点
（master / phoenixnap / netix / deac / nchc）约 50 KB/s。Bliss OS ISO 2.26 GB 按此速度需数小时，
在本次会话内不可行——按用户「实在不行就算了」的约定停止，不硬耗、不伪造"下载成功"。
完整下载 + 全文件 SHA-256 校验 + 真机启动由应用在有网络的用户机器上按需完成。

### 构建体积
`node build/check-no-images.js --self` 与 `--git` 均通过：源码/构建产物/git 仓库无 ISO 与大型系统镜像。

## 四、五类验证的边界（不混淆）

| 层级 | 状态 | 说明 |
|---|---|---|
| 单元测试 | ✅ 通过 | Node 断言覆盖目录/Provider/任务/流水线/构建闸门 |
| 下载测试 | ✅ 实测地址有效 | HEAD + Range 验证官方地址与大小/格式，未做完整 GB 下载 |
| 镜像校验 | ✅ 官方值已录入并复核 | Bliss .sha256 与 Android-x86 官方元数据一致 |
| 虚拟机启动 | ⚠️ 代码就绪，未真机验证 | q35/WHPX/virtio 参数经单测，真机需用户 Windows 环境 |
| Android 真正启动 | ⚠️ 未真机验证 | 已实现 sys.boot_completed 检查，需 GB 镜像 + WHPX 环境实测 |

## 五、尚未解决的问题（如实说明）

1. **LineageOS 无官方预构建模拟器镜像**：无法一键下载，只做导入能力；这是上游事实，非本项目缺陷。
2. **Bliss OS 官网停止发布新 ISO**：收录归档快照，无 OTA/支持，能否启动需实测。
3. **Windows 真机启动未验证**：本环境无法代替用户在真实 VT-x/WHPX 机器完成 GB 级下载与图形界面启动，
   因此 `bootTested=false`，不做"已通过真机启动"声明。
4. **首次安装默认引导式**：Android-x86/Bliss 官方安装器需用户在虚拟机窗口交互，
   Provider 以"磁盘被显著写入"为客观成功证据；`auto` 模式为实验性。
5. **ADB 前提**：ISO 系统默认可能未开网络 ADB，超时会如实报错，需在 guest 内开启 5555 端口。
6. **远程目录需合并到 main 后生效**：合并前代码自动回退内置索引/缓存，功能不受影响。
