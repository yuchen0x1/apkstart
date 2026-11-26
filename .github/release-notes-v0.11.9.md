## 📢 版本概述

本次为开发仓库维护版本：清理误落在项目目录的 PowerShell 本机缓存和过期测试日志，并添加精确忽略规则。应用运行行为、用户配置和数据均无变化。

## 🔧 改进与优化

- **仓库清理**：忽略仓库根目录下的 `Microsoft/Windows/PowerShell/ModuleAnalysisCache`，避免本机工具缓存再次混入版本控制。

## 🔒 安全与兼容性

- 本版本没有应用功能、安全策略或运行时兼容性变化。
- 发布仍提供 Ed25519 签名的 `latest.json` 与旧客户端兼容的 `ApkStart-update.json` / `.sig`。启用自动检查的旧客户端可发现此版本；用户主动关闭自动检查的选择保持不变。

## 📦 下载与安装

| 文件名 | 平台 / 架构 | 说明 |
|---|---|---|
| `ApkStart-0.11.9-Setup.exe` | Windows x64 | 在线安装版，运行时按需下载或本地导入 |
| `ApkStart-v0.11.9-win64-portable.zip` | Windows x64 | 便携版，解压到可写目录运行 |
| `ApkStart-0.11.9-x86_64.AppImage` | Linux x86_64 | 便携版，首次启动按需下载运行时 |
| `ApkStart-0.11.9-amd64.deb` | Linux x86_64 | Debian / Ubuntu 安装包 |

- 首次安装：下载对应平台文件并按提示准备安卓运行时；主程序不包含 Android 系统镜像。
- 已安装用户：可通过“设置 → 软件更新”检查；同平台、同安装形态可直接覆盖升级。

## 🔄 升级与数据迁移

- **兼容性**：同平台、同安装形态直接覆盖升级，无需先卸载。
- **配置和数据**：不迁移、不删除应用、配置、系统镜像、AVD 或存档。
- **回退方式**：停止运行时后使用同平台、同安装形态的旧版程序包；Windows 自动更新保留既有失败回滚机制。

## 🧪 验证结果

- Windows 本地完整 `npm test`：通过；真实 GUI 窗口和第二用户会话等环境专属用例按测试条件跳过。
- `npm run readme:check`、发行说明生成和 `git diff --check`：通过。

---

**项目地址：** https://github.com/yuchen0x1/apkstart

**问题反馈：** https://github.com/yuchen0x1/apkstart/issues

**版本下载：** https://github.com/yuchen0x1/apkstart/releases/tag/v0.11.9
