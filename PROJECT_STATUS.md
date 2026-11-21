# v0.9.2 历史项目状态

本页仅保留 v0.9.2 交付时的核验记录，不代表当前版本。当前版本见 [README](README.md)，历史发布见 [RELEASE_HISTORY.md](RELEASE_HISTORY.md)。

## v0.9.2 交付批次

- 基线：已发布的 `v0.9.1`（`accb6ca`）。巡检期间主分支前进，更新器补丁已重放到该基线，不重复纳入先前 UI/运行时加固提交。
- 正式版本：[`v0.9.2`](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.2)（PATCH），Windows 安装版更新失败处理和恢复文件保护。
- 实施分支：`fix/windows-updater-rollback`；交付记录分支：`docs/v0.9.2-delivery-record`。使用独立 Git worktree，未覆盖原工作区改动。
- 状态：[PR #14](https://github.com/yuchen0x1/apkstart/pull/14) 最终 head `a34ccb9` 的三平台 CI 与依赖审查全通过后 squash 合并。Tag 指向 main 提交 `6c1b6a288e1b1e821bd2a93fd53b8d74d9cc1369`，[Release 流水线 44798205362](https://github.com/yuchen0x1/apkstart/actions/runs/44798205362) 全部成功，正式资产已下载并核验。前两轮失败及修复过程保留在自主开发记录，不将失败结果计为通过。

## 架构与交付

- Electron 主进程：`src/main.js`；白名单桥接：`src/preload.js`；原生 HTML/CSS/JS 界面：`src/ui/`。
- 运行时、安装、更新、下载、备份与多系统提供器：`src/core/`。
- `build/pack.js` 构建 Windows 便携版；electron-builder 构建 NSIS、Linux AppImage/deb。
- `release.yml` 验证 Windows Node 20/22、Linux Node 22，检查版本与主分支归属，构建四类资产，再签署清单、核对草稿资产后公开。

## 本地验收（0.9.2）

| 检查 | 结果与限制 |
| --- | --- |
| Windows `npm test` | 短路径修正后重测退出 0；Node 26.13.1；更新器专项 56 通过、0 失败，含 2 项真实 8.3 成功/回滚场景 |
| Linux `npm test` | 短路径修正后冻结树 `f621aaa` 在 WSL Ubuntu / Node 22.22.1 重测，独立网络 namespace、仅 loopback；退出 0，更新器 42/0；Windows 专属用例明确跳过 |
| Electron 冒烟 | 20 通过、0 失败；fixture IPC，不加载产品主进程 |
| `test:ui` | 退出 0；406 次渲染/状态采样，无汇总脚本错误、无名称缺失及常规窗口溢出；不是 406 个独立页面或完整无障碍认证 |
| Windows 便携版 | 构建及 160 MiB 体积门禁通过，约 142.96 MiB |
| Windows NSIS | 构建成功；首次下载超时，改用已安装的同版本 Electron runtime 后成功，未运行真实安装 |
| 依赖审计 | npm 官方源：0 条已知漏洞；镜像源不支持 audit 接口，未把该错误当作安全通过 |
| 一致性 | package/lock/README/更新日志一致；语法及 `git diff --check` 通过 |

Windows 的 ensure 空环境用例因宿主 5554/5556 已被真实实例占用而跳过，未终止它们；隔离 Linux 执行了相应用例。外部 APK 夹具未提供；Linux 不执行 Windows PowerShell/卸载器用例。真实设备升级、UAC、断电和杀软环境未实测。CI 的 Windows Node 20/22 验收不可由本机 Node 26 代替。

## 最终交付核验

- [最终 PR CI 44797597010](https://github.com/yuchen0x1/apkstart/actions/runs/44797597010)：Windows Node 20/22、Linux Node 22 全通过；[依赖审查 44797596942](https://github.com/yuchen0x1/apkstart/actions/runs/44797596942) 通过。合并后的 main CI 与 Tag 的 Release 验证再次通过。
- 正式公开时间：`2026-11-20T19:05:44Z`（GitHub API UTC；本地为 2026-11-21），非草稿、非预发行。
- 7 项资产均逐文件下载至独立空目录；本地大小/SHA-256 与 GitHub 一致，4 个程序资产与 Ed25519 签名清单一致；SHA256SUMS 精确覆盖四项，发行说明隐藏清单与 JSON/sig 资产字节一致。
- Windows portable 内部 package、deb 控制字段及内部 package、AppImage 内部 package、NSIS PE 版本资源均为 `0.9.2`。只用数据读取器检查，没有运行下载资产；不将元数据验证等同于真实安装测试。
- 便携 ZIP 正式大小 `149,909,919` 字节（约 142.97 MiB），160 MiB 门禁通过。完整资产表见发布历史。
- 按 Tag 源码重建的本地包静态暴露复测：113 文件，原始启发式分数 69/C，0 新增、0 加重；主程序过大及 Android 画像仍未检查，限制见安全记录。
- 原工作区交付阶段出现 4 个修改文件和 1 个新增测试，均不属于本轮；未暂存、覆盖或同步该工作区。原有每小时自动任务继续保持暂停。

## 后续重点

1. [Issue #13](https://github.com/yuchen0x1/apkstart/issues/13)：视频卡顿与音画不同步，尚未复现、未宣称修复。
2. 审查六个 Dependabot PR 的兼容性，尤其 Actions 大版本，不能只因旧 CI 为绿便盲合并。
3. Code Scanning API 返回无分析记录，不能写成扫描通过；UI fixture 尚未纳入 CI。
4. 已有每小时自动任务当前暂停；本轮未更改其开关或新建重复任务。

待办、未解决问题和审计依据分别见 [AUTONOMOUS_TASKS.md](AUTONOMOUS_TASKS.md)、[AUTONOMOUS_ISSUES.md](AUTONOMOUS_ISSUES.md)、[SECURITY_AUDIT.md](SECURITY_AUDIT.md)。
