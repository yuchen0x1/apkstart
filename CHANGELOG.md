# 更新日志（Changelog）

ApkStart 的版本变更记录。每个版本的完整发行说明见 GitHub Releases 对应页面；
应用内的「设置 → 软件更新」也会在发现新版本时展示该版本的更新日志。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

- （下一版本的内容在合并进 main 后记录于此）

## [0.3.7] — 在线自动更新 + 首次运行引导

### 新增
- **在线自动更新**：发现新版本 → 系统通知 → 后台自动下载 → 自动重启安装。
  正在使用的应用窗口不会被重启打断（等窗口关闭再装）；可在设置里关掉，退回只通知。
- 设置 → 软件更新：新增「自动更新」开关与「更新日志」入口；发现新版本时
  面板内直接展示该版本发布说明全文。
- 仓库新增 `CHANGELOG.md`（本文件）。

### 修复
- 首次部署下载极慢（#26）：运行时整包测速低于 0.5MB/s 直接改走官方分组件源
  （实测 3~20MB/s）；下载中途 30 秒平均低于 256KB/s 也会自动中断换源。
- 首次运行引导向导：选盘（推荐非系统盘）→ 下载源 → 一键部署，C 盘不再被默认塞满（#14/#10/#35）。

## [0.3.6] — 安全加固批次

### 修复（安全，4 项 P0）
- APK 包名白名单校验 + 本地路径净化 + adb 设备端 shell 转义：封死「双击恶意 APK
  任意写文件 / 设备端命令注入」（#2 P0-1）。
- 下载器：并行分块失败清理预分配文件；416 响应核对远端总长 + 比对末尾 4KB 内容，
  不再产出「大小正确、内容全零」的坏运行时（#2 P0-2）。
- emulator / 系统镜像下载接入官方索引 sha1 校验（#2 P0-3）。
- extractZip 条目名规范化，封死 zip-slip（#2 P0-4）。

### 修复（健壮性）
- settings.json 带 BOM / 损坏时不再静默重置全部配置，损坏文件保留 `.bak` 现场（#8）。
- 运行中点「启用」AEHD 先拦截，不再把驱动打成「待删除」半残状态（#8）。
- 索引下载加超时与 close 兜底，部署向导不再永久卡死（#2 P1-1）。
- settings:set 写入白名单；shell:open 只放行 http/https（#2 P1-4）。
- README 新增「配置要求」与迁盘指引（#30）。

## [0.3.5] — 大包与部署体验

- 2GB+ APK 可正常安装：解析改流式（不再整包进内存）、.apks/.xapk 流式解包、
  安装超时按包体放大（#21/#13）。
- ZIP64 支持：条目数超 65535 不再静默丢条目。
- 修复「卡在准备运行时 / 停在 99% 又重下镜像」：选源逐个报进度、镜像展开
  先写 `.part` 再原子改名、失败明确报错（#23/#26）。
- 修复「改了运行时数据目录还是下到旧目录」；便携版移动/升级后自动重新定位（#23）。
- 修复全新安装点图标只看到安卓桌面（组件名重复拼包名）。

## [0.3.4] / [0.3.3] — 双源与资源可控

- GitHub / Gitee 双源自动选优（并发问版本、逐源实测测速），Gitee 匿名限流自动熔断。
- Gitee 放整包（95MB），不再需要 part1/part2 手工拼接。
- 资源策略三档（省资源 / 均衡 / 流畅）+ 数据分区容量可调 + 磁盘满不再自动清数据。
- 修复「窗口代理误伤微信等 Qt 应用」（#17/#19/#27/#28 的根因）：窗口归属按进程路径判定。
- 修复下载器挂死、分块断点续传、镜像换盘不再清用户数据。

## [0.3.2] — 窗口彻底不外露

- GitHub 在线更新上线（检查 → 下载 → 自动替换重启）；轻量版运行时改走本项目 Release。
- qemu / netsimd 控制台黑窗彻底压制，模拟器主窗不单独露面。
- 更新助手改用普通子进程，修复被安全软件静默拦截导致更新卡住。

## [0.3.1] — 冷启动提速

- /data 分区自动初始化（ext4 + FBE），全新安装不再掉进 recovery 循环。
- 黑窗不再闪现；冷启动 ~22 秒、快照恢复 ~5 秒。

## [0.3.0] — 主界面收敛

- 主界面只留已安装应用，运行时与自检全部收进设置。

## [0.2.8] / [0.2.7] — 稳定性

- 快捷方式加固（桌面 + 开始菜单）、环境自检与磁盘守卫。
- 声音支持、可选安装位置、卸载清理进程、VC++ 兼容。

## [0.2.6] 及更早

- 鼠标映射（左键确认 / 右键返回 / 滚轮平滑滑动，前台限定）。
- 切换到 Google 官方 Android Emulator 运行时（下载提速 2400 倍）。
- ARM 兼容模式升级 Android 14（字节系应用可运行）、NSIS 单文件安装版、
  开箱即用打包、ARM 兼容性诊断与安装失败原因中文化。

[Unreleased]: https://github.com/RoutineMiku/apkstart/compare/v0.3.7...HEAD
[0.3.7]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.7
[0.3.6]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.6
[0.3.5]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.5
[0.3.4]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.4
[0.3.3]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.3
[0.3.2]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.2
[0.3.1]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.1
[0.3.0]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.3.0
[0.2.8]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.2.8
[0.2.7]: https://github.com/RoutineMiku/apkstart/releases/tag/v0.2.7
