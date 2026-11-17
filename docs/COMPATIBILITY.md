# 多系统兼容性说明

本文说明各系统的环境要求与验证状态。相关概念：

- **单元测试通过**：Node 断言覆盖目录、Provider、任务管理器、QEMU 参数、构建闸门；
- **下载测试通过**：能从官方 HTTPS 地址下载（需实际网络 + 用户主动触发）；
- **镜像校验通过**：SHA-256 与官方公布值一致；
- **虚拟机启动成功**：QEMU / Emulator 进程运行；
- **Android 系统真正启动成功**：`getprop sys.boot_completed = 1` 且 ADB 可用。

> 这五者不能混为一谈。ApkStart 只在 Android 真正就绪后才把系统标记为"运行中"。

## 平台要求

- Windows 10/11 x64；
- Intel VT-x 或 AMD-V（BIOS 开启）；
- WHPX（Windows Hypervisor Platform）硬件加速推荐；"启用或关闭 Windows 功能 → 虚拟机平台"；
- 建议 8 GB 内存、4 核 CPU；磁盘预留见下表。

## 各系统要求与验证状态

| 系统 | 架构 | 额外环境 | 磁盘需求 | 加速 | 单元测试 | 下载/校验 | Windows 真机启动 |
|---|---|---|---|---|---|---|---|
| Google Play / APIs / AOSP | x86_64 | 无（运行时自动部署） | 随运行时 | AEHD/WHPX | ✅ | 随运行时包 | 由现有引擎保证 |
| Android-x86 9.0-r2 | x86_64 | QEMU 运行时 | ISO ~921MiB + 磁盘 ≥24GB | WHPX 推荐 | ✅ | 官方 SHA-256 已录入 | ⚠️ 需用户 Windows 环境验证 |
| Bliss OS 16.9.7 | x86_64 | QEMU 运行时 + UEFI(OVMF) | ISO ~2.26GiB + 磁盘 ≥24GB | WHPX 推荐 | ✅ | 官方 .sha256 已录入 | ⚠️ 需用户 Windows 环境验证 |
| LineageOS | x86_64 | Linux 编译环境（自行构建 AVD 镜像） | 依构建产物 | WHPX/AEHD | ✅（真实状态） | ❌ 无预构建 | ⚠️ 依用户导入的镜像 |

## 已知限制（如实说明）

1. **LineageOS 无官方预构建模拟器镜像**，无法一键下载；只提供导入能力，不会伪造可下载资源。
   官方构建目标是 `sdk_phone_x86_64`，tag=`lineage`，普通手机 ROM 不可用。
2. **Bliss OS 官网已停止发布新 ISO**，"No current official ISO"；收录的是 SourceForge 归档快照，
   无 OTA/官方支持。官方 QEMU 文档本身标注为 work-in-progress，且说明 Bliss 14 在 Windows QEMU 上
   因缺软件渲染无法工作——归档版能否在特定机器启动需实测。
3. **Android-x86 / Bliss OS 首次安装**：官方安装器需在虚拟机窗口内交互完成（guided 模式）。
   Provider 以"虚拟磁盘被显著写入"作为安装成功证据，未检测到就明确提示，绝不假装已安装。
4. **ADB 前提**：这两个 ISO 系统默认可能未开启网络 ADB。若启动后等待就绪超时，
   需在 guest 内开启网络 ADB（端口 5555）后重试。超时会如实报告并保持"未运行"状态。
5. **图形/性能**：QEMU 不支持 Vulkan 与视频编解码加速；WHPX 不可用时降级 TCG 会非常慢，界面明确提示。
   不修改任何 Windows 安全设置。
6. **真机启动验证**：本环境无法代替用户在真实 Windows + VT-x/WHPX 机器上完成 GB 级镜像下载与
   图形界面启动验证；因此 `bootTested=false`，不做"已通过真机启动"的虚假声明。
