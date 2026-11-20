# 多系统支持（LineageOS / Bliss OS / Android-x86）

ApkStart 通过统一的 **Provider 架构** 支持多个 Android 系统。核心原则：

> **系统镜像绝不内置到主程序、GitHub 源码仓库或默认安装包。** 用户不选择就不下载，
> 不使用就不占磁盘，已下载就不重复下载。所有系统元数据来自远程目录，镜像本体按需下载。

## 系统接入现状（真实状态，不伪造）

| 系统 | 启动后端 | 来源 | 状态 | 预构建镜像 | 接入方式 |
|---|---|---|---|---|---|
| Google Play / Google APIs / 纯 AOSP | Android Emulator | 官方运行时包（随运行时部署） | ✅ 内置档位 | 随运行时 | 独立 AVD，切换不共用数据 |
| **Android-x86 9.0-r2** | QEMU (WHPX/TCG) | SourceForge 官方 | ✅ 可下载安装 | ✅ 官方 ISO + SHA-256 | 下载→校验→建盘→首次安装→从磁盘启动 |
| **Bliss OS 16.9.7** | QEMU (WHPX/TCG) | SourceForge 官方归档 | ⚠️ 归档快照 | ✅ 官方 ISO + .sha256 | 同上；官网已停止发新版，无 OTA/支持 |
| **LineageOS** | Android Emulator | 官方仅提供源码构建 | ⛔ 无预构建 | ❌ 官方不提供 | Provider + 目录 + 检测 + 导入；显示真实状态 |
| 自定义镜像 | Android Emulator | 用户导入 | ✅ 导入式 | 用户提供 | 复用现有 images.js，不破坏原功能 |

### 为什么 LineageOS 不能一键下载

LineageOS 官方 **不发布** 预构建的 Android Emulator 系统镜像。按官方 Wiki，只能是：

1. 在 Linux 上 `repo init .../android.git -b lineage-XX` 同步源码；
2. `breakfast sdk_phone_x86_64`（手机模拟器目标，tag=`lineage`，不是普通手机 ROM）；
3. `mka emu_img_zip`（LineageOS 21+）导出 `sdk-repo-linux-system-images.zip`；
4. 把里面的架构目录放进 AVD 的 `system-images/`。

因此 LineageOS Provider 的行为是：
- `getAvailability()` 返回 `available=false`，界面显示
  **「暂无可用的预构建镜像，请等待后续接入。」**；
- `getDownloadInfo()` 永远返回 `null`，**绝不伪造下载地址**；
- 提供「导入自建 AVD 镜像」能力：把用户在 Linux 上编译出的 AVD 系统镜像目录纳入管理，
  导入后复用 Windows 版 Android Emulator 启动。

> 未经启动验证的镜像不会被标记为"已支持"。普通手机 ROM 不能当作模拟器镜像。

### Bliss OS 为什么是归档快照

blissos.org 官方下载页明确写着 **"No current official ISO"**：新的构建树尚未发布新镜像，
旧 ISO 是 SourceForge 上的归档快照，不再获得更新或官方支持，也不会 OTA。
ApkStart 收录的是官方归档 `BlissOS16/Gapps/Generic/Bliss-v16.9.7-x86_64-OFFICIAL-gapps-20241011.iso`
（带官方 `.sha256`），并在 UI 标注「归档快照」。

## 真实数据来源（可核验）

| 系统 | 版本 | 文件大小 | SHA-256 | 来源 |
|---|---|---|---|---|
| Android-x86 | 9.0-r2 | 965738496 B (~921 MiB) | `f7eb8fc56f29ad5432335dc054183acf086c539f3990f0b6e9ff58bd6df4604e` | SourceForge 官方文件元数据 |
| Bliss OS | 16.9.7 (20241011) | 2429550592 B (~2.26 GiB) | `17137711fb42236640ac6fe4421fcb3bd15710065fcf75c20807c018f42e3751` | 官方 `.iso.sha256` 文件 |

远程目录：`https://raw.githubusercontent.com/yuchen0x1/apkstart/main/system-catalog/catalog.json`

## 存储位置

每个系统完全独立，禁止混用 userdata。`systems` 跟随当前运行时目录：Windows 默认在 `%APPDATA%\apkstart\runtime` 下，Linux 默认在 `${XDG_DATA_HOME:-~/.local/share}/apkstart/runtime` 下；自定义运行时目录时使用该目录的 `systems` 子目录。

```
%APPDATA%\apkstart\runtime\systems\
  lineageos\  { downloads, images, devices, userdata, snapshots, logs, manifest.json }
  bliss-os\   { downloads, images, disks, devices, userdata, snapshots, logs, manifest.json }
  android-x86\{ downloads, images, disks, devices, userdata, snapshots, logs, manifest.json }
  google-play\  google-apis\  aosp\  custom\
  _tasks.json       任务状态（断点/恢复）
  current.json      当前系统记录
```

下载缓存（`downloads/`）与已安装系统（`disks/`）分开：用户可以删除 ISO 缓存，
不会误删已装系统。

## 切换与安装

- **系统选择**：设置 → 安卓系统 → 「选择系统」卡片。卡片按真实状态显示版本/Android 基础/架构/大小/安装状态，
  按钮根据状态变化：未下载→「下载并安装」，已下载未安装→「安装系统」，已安装→「启动系统」，
  运行中→「正在运行」，无预构建→「查看原因」/「导入自建镜像」。
- **进度**：所有下载/校验/安装/启动进度显示在「设置 → 运行状态 → 系统任务」区域，真实速度与剩余时间。
- **切换**：`system-manager` 真实停旧启新——先停止当前虚拟设备，加载目标系统独立设备，
  用正确后端启动（emulator / qemu），并检查 ADB / `sys.boot_completed` 后才标记"运行中"。
  切换不会清空其它系统数据。
- **备份/恢复/删除**：系统详情面板提供；运行中和下载中的系统不允许删除。

## Windows QEMU 说明

Bliss OS / Android-x86 使用独立 QEMU 后端：q35 机器类型、WHPX 硬件加速（不可用时明确提示降级 TCG）、
virtio 磁盘/网卡、USB 平板+键盘、AC97 音频、OVMF(UEFI)（存在时）、ADB 端口转发 `hostfwd tcp:127.0.0.1:5555-:5555`。

- 未开硬件加速时纯软件模拟非常慢，界面会明确提示，不会默认悄悄使用且不告知。
- 不修改任何 Windows 安全设置。
- **虚拟机进程启动 ≠ Android 系统启动成功**：必须等 guest 内开启网络 ADB 且
  `getprop sys.boot_completed = 1` 才算就绪；超时会如实报告并保持"未运行"状态。
- 首次安装使用引导式（guided）：ISO 引导进官方安装器，用户在虚拟机窗口完成安装并正常关机，
  然后在任务行点击「确认安装完成」。Provider 检查虚拟机已退出后才接受明确确认；
  磁盘增长只表示开始写入，不会据此自动关机或标记已安装。后续启动仍须验证 Android 就绪。
- 无人值守 auto 尚未实现，选择后会明确拒绝，不会假装已经安装。
