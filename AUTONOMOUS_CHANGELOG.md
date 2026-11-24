# 自主开发记录

## 2026-11-24 · A003 · Windows 进程归属与更新器安全边界（v0.10.9）

### 发现与范围

按上游 [#140](https://github.com/RoutineMiku/apkstart/issues/140)（退出时误关 Windows Terminal）的同源思路复查本仓库的「宽泛进程操作」入口，定位到三处真实风险：

1. `src/core/updater.js` 的升级脚本在等待 60 秒后执行 `Stop-Process -Id <pid> -Force`，只按 PID 终止；等待期内 PID 被系统复用时可能误杀无关程序。
2. `src/core/win/windowctl.ps1` 在没有 PID 时按 `ProcessName -match 'emulator|qemu'` 枚举窗口，会改到其他用户的模拟器窗口（当前主进程只调用 `refreshShell()`，但脚本本身是可复用入口）。
3. `src/core/win/priority.ps1` 按 `Name -match qemu|emulator` 且 `CommandLine -like "*<Avd>*"` 扫描并改优先级，同名 AVD 的其他实例会被一起改动。

同时保留并加固了工作区里已有的「空配置读取 `gh auth token`」改动：增加结果 TTL 缓存（含负结果）与 token 形状校验。

### 实际改动

- `src/core/updater.js`：升级脚本启动时先用 `process-owner.ps1 -Action Inspect` 记录本程序的出生凭据（真实镜像路径 + 出生时间 + 命令行），超时后只允许 `-Action Terminate -Expected <凭据>` 终止同一进程，身份不可验证时跳过强杀并写日志；`pending.json` 凭条改为通过载荷前置校验之后才写。
- `src/core/win/process-owner.ps1` / `src/core/process-owner.js`：新增 `Tree` 动作与 `getProcessTree()`，返回一个已验证进程的后代身份，供调用方逐个复核归属。
- `src/core/win/priority.ps1` / `src/core/emulator.js`：优先级脚本只接受调用方给的 PID 列表，删除镜像名、AVD 名和命令行子串扫描；`setPriority()` 先取本实例进程树，再用 `ownsProcess()` 过滤，验证不过就不调用脚本。
- `src/core/win/windowctl.ps1` / `src/core/windowctl.js`：删除按进程名扫描窗口的兜底；没有正整数 PID 时直接拒绝。
- `src/core/sources.js`：`gh auth token` 结果缓存 1 小时（含失败），只接受 `ghp_/gho_/ghu_/ghs_/ghr_/github_pat_` 形状的 token；手动 `runtime.githubToken` 仍然即时优先。
- `test/auto-test.js` / `test/updater-test.js`：新增更新脚本不得出现 `Stop-Process -Id`、必须先取证再按凭据终止、窗口控制拒绝无 PID、优先级脚本无枚举兜底、空 / 非法 PID 列表 `CHANGED=0`、`gh` 负结果缓存与非法提示文本拒绝等回归。
- 版本与文档：`package.json` / `package-lock.json`、`CHANGELOG.md`、`README.md` 同步到 `0.10.9`，`docs/UPSTREAM-ISSUES-AUDIT.md` 增加 2026-11-24 复核表。

### 验收边界

- 本地全量 `npm test` 通过；`node --test` 批次 359 项（358 通过 / 1 按执行策略跳过 / 0 失败），自动回归 121 项、更新器 53 项、下载身份 29 项、拆分包备份 19 项、备份恢复 11 项。
- 本机 PowerShell 执行策略为 `Restricted`，更新器的隔离脚本夹具按既有策略跳过，没有为测试改写系统策略。
- 未在真实 Android 客机、多用户 Windows 会话或其他模拟器 / Windows Terminal 并存的场景做端到端验收；进程归属结论以对应环境复测为准。

## 2026-11-23 · A002 · 设置缓存与 v0.10.5 正式发布

### 交付证据

- `main` 提交 `11cbaf2b78fa25702b07fba2ff736eae334a8329` 已标注 `v0.10.5`，发布时与远程 `main` 一致；随后仅追加本证据文档提交 `01418448ae88bd0dcb01a2c22f2e581067d1c3c9`，Tag 未移动。
- Release 流水线 `45097567562` 的版本核验、Windows Node 20/22、Linux Node 22、双平台 UI、Windows portable/NSIS、Linux AppImage/deb、签名清单和公开步骤全部成功。
- Release 已于 `2026-11-23T02:04:43Z` 正式公开。7 项资产已独立下载，大小、SHA-256、Ed25519 签名清单、`SHA256SUMS` 与正文隐藏清单全部核对一致。

### 验收边界

- 未运行任何下载的安装程序，未把资产完整性核对写成安装、升级或回滚成功。
- 真实 Android 客机/GPU、长时间视频流、断电恢复、混合 DPI、多实例压力、Authenticode 和签名发布者身份仍未验收；下一阶段需在对应环境中单独记录。

## 2026-11-21 · A001 · 更新失败保护（v0.9.2 已发布）

### 发现与范围

巡检起点为 `v0.8.0`，原工作区有广泛未提交加固与 UI 改动。本轮单独建立 `fix/windows-updater-rollback`。工作期间远程发布 `v0.9.0`、`v0.9.1`，因此将本轮补丁迁到 `accb6ca` 后重新执行验收，而非重复提交原工作区改动。

原安装更新脚本只记录安装器退出码；版本读取失败变成空字符串时仍可判为成功，进而清除恢复文件。失败记录依赖 PowerShell 默认 UTF-8 BOM，主进程直接 JSON.parse 时又可能吞掉通知。

### 实际改动

- `src/core/updater.js`：完整备份结果与旧版元数据检查、独立恢复目录、退出码与版本联合校验、可核验回滚、失败保护清理。
- `src/main.js`：兼容 BOM 的失败标记读取；按实际恢复状态通知；消费记录后清理旧凭条。
- `test/updater-test.js`：真实 Windows PowerShell + 临时目录和替代进程调用，不运行安装器、不操作宿主模拟器；增加失败记录无法落盘及通知消费者用例。
- 版本、发行说明、README 生成段落与网站版本字段同步至候选 `0.9.2`；未新增运行时依赖或重写 UI。

### 本地证据

- Windows 全量 `npm test`、Linux Node 22 隔离网络全量 `npm test`：退出 0。
- 更新器专项：Windows 54 通过、0 失败；Linux 跳过 PowerShell 执行，仅统计实际平台用例。
- Electron 冒烟：20 通过；UI fixture 回归：退出 0，406 次状态采样，无汇总脚本错误/无名称字段/常规窗口溢出。
- Windows portable + NSIS 构建成功；portable 约 143 MiB，160 MiB 门禁通过（最终字节数以正式签名发行资产为准）。
- npm 官方源 audit：0 已知漏洞；git diff/syntax/version checks 通过。
- 独立复核：首轮建议补充标记写入失败和 BOM 通知覆盖，已实施。迁移后复核又发现只读安装目录恢复权限及自动重试备份膨胀两个阻塞；已增加文件/目录及安装父目录的可写重建预检、UAC 取消处理、持久化自动重试限制与对应真实函数/PowerShell/临时 ACL 回归。最终独立静态复核确认本轮范围内无剩余阻塞。

### 故障与恢复

- npm 镜像源 audit 返回接口不支持：改用官方 registry，未修改锁定依赖或关闭审计。
- 旧基线 Windows 全量测试因固定 5556 端口已被真实模拟器占用而失败：未停止真实实例。新主分支已包含动态端口修复，迁移后全量通过。
- 首次 NSIS 构建下载 Electron 超时：使用已安装、相同版本的 Electron runtime 重试后成功；没有重复安装软件或发布半成品。
- 夹具 UI 的注入故障日志属于预期负向用例；截图暂时失败仅重试截图本身。

### CI 短路径回归与修正

- [PR #14](https://github.com/yuchen0x1/apkstart/pull/14) 首轮 head `aecad3e` 的 [CI 44791289048](https://github.com/yuchen0x1/apkstart/actions/runs/44791289048)：Windows Node 20/22 均失败，Linux Node 22 通过；失败时未合并或发布。
- 原因：备份根使用 `RUNNER~1` 等 8.3 短名，而 PowerShell `Get-ChildItem.FullName` 返回长名。直接截取 `$bak.Length` 得到了错误相对路径，恢复写权限预检错误中止。
- 修正：通过同一文件系统提供程序 `Get-Item.FullName` 解析备份根，再用于文件和目录相对路径；不为掩盖错误而创建映射目录，也不放宽恢复权限。
- 新增 2 项真实 8.3 成功安装及安装根被删除后的恢复场景。PowerShell 实际枚举文件、空目录并断言新偏移正确、旧偏移错误；CI 不支持短名时失败，非 CI 明确跳过且不计通过。短名辅助函数用 Base64 传回 UTF-8 路径，避免 PowerShell 5.1 代码页损坏中文。
- 首次新增夹具因 cmd 引号处理返回无效路径而失败（54/1）；已修正，没有把管道掩盖的退出码 0 当作通过。修正后专项 56/0，两项短路径均实际执行；Windows 全量再次退出 0。
- 独立静态复核指出并确认修复测试编码、失配未断言两项缺口；最终本轮范围未见新增阻塞。静态复核不代替远端 Node 20/22 CI。
- 冻结树 `f621aaa6c2b39ca69b8e487dbbf97c79fc94d013` 导出到独立 Linux 目录，`npm ci` 后在只有 loopback 的网络 namespace 完成全量回归、退出 0（更新器 42/0，Windows 专属用例跳过）。Windows 沙箱冒烟再次 20/0，no-images 与 README 一致性门禁通过。后续只回填文档证据，代码与该冻结树一致。

### CI ACL 夹具兼容性

- 次轮 head `d324019` 的 [CI 44796259254](https://github.com/yuchen0x1/apkstart/actions/runs/44796259254)：两个 Windows job 的短路径成功/回滚均通过，但更新器仍为 55/1；Linux 全量通过。唯一失败是 ACL 夹具的 `Get-Acl/Set-Acl` 无法加载 `Microsoft.PowerShell.Security`，拒绝规则未施加，不能把该用例跳过或当作产品权限检查通过。
- 仅调整测试：使用固定 Windows PowerShell 5.1 的 .NET Framework `DirectoryInfo` ACL API，避免模块搜索路径影响；夹具 setup 失败即停止。实际尝试在父目录建子目录，必须得到拒绝才继续运行生成脚本。
- 独立复核又指出，原样传回未修改的 ACL 对象不会写入恢复。已改为保存原 DACL 的 SDDL、在 finally 中显式载入并写回、重新读取精确比较，Node 同时断言“拒绝生效”和“原权限恢复”两个标记。所有操作仅限本次临时夹具根目录，未放宽产品权限判断。
- 包含 DACL 显式恢复及读回断言的最终 Windows 全量再次退出 0，更新器 56/0；独立只读复核确认两项标记可以区分预期更新失败与夹具恢复失败。产品源码保持 `d324019` 不变，继续等待新 head 的远端完整验收。

### 交付状态

- 最终 head `a34ccb94cd05146055aedba7a81a7602178c8745` 的 [CI 44797597010](https://github.com/yuchen0x1/apkstart/actions/runs/44797597010) 与依赖审查全通过，才合并 [PR #14](https://github.com/yuchen0x1/apkstart/pull/14)。Squash 提交 `6c1b6a288e1b1e821bd2a93fd53b8d74d9cc1369` 与验收 head 文件树完全一致；未绕过保护、未强推。
- `v0.9.2` Tag 固定到该 main 提交；[Release 44798205362](https://github.com/yuchen0x1/apkstart/actions/runs/44798205362) 的版本归属、Windows Node 20/22、Linux Node 22、四类构建、草稿校验、签名和公开全部成功。正式 API 发布时间 `2026-11-20T19:05:44Z`。
- 逐项下载全部 7 项正式资产，每个文件放独立新空目录；本地摘要和大小等于 GitHub 元数据，四个程序包等于签名清单，使用随客户端公钥验证 Ed25519，JSON/sig 与发行说明隐藏清单逐字节一致。验收脚本经独立复核，补上清单重复/额外项和 SHA256SUMS 重复/漏项拒绝。
- Portable ZIP 内部 package、deb 控制/内部 package、AppImage 内部 package 均为 0.9.2；NSIS PE ProductVersion/FileVersion 均为 0.9.2。仅用 ZipFile、dpkg-deb/tarfile、unsquashfs 和 PE 元数据读取，不执行下载程序。
- Tag 源码本地重打包、no-images 与静态暴露复测通过：113 文件，原始启发式 69/C，0 新增/0 加重，4 个原信号不变；主程序过大和 Android 画像仍未检查，未把限制或信息性信号伪装成安全认证。
- 原工作区在交付阶段出现 4 个修改和 1 个新增测试，本轮未暂存、覆盖或同步它们；每小时自动化仍保持暂停。六份交付记录通过单独文档分支回填，不移动已公开的版本 Tag，也不为文档单独制造新版本。

正式资产表及摘要见 [RELEASE_HISTORY.md](RELEASE_HISTORY.md)。Issue #13、原生 Linux 桌面、真实设备升级、断电/杀软和 Authenticode 证书仍未验证或完成。

### 开源研究

通过 GitHub API 复核近期提交和许可证：electron-builder、Velopack（MIT）、scrcpy（Apache-2.0）、Waydroid（GPL-3.0）、原上游 ApkStart（MIT）。仅研究原则，未复制外部实现。

- electron-builder 的[自动更新文档](https://www.electron.build/docs/features/auto-update/)区分下载、校验、安装和关机会话风险；本轮沿用自有更新器，贯彻“验证失败不进入成功清理”，未盲升到新主版本。
- scrcpy 的[视频配置](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md)分别讨论编码器、编解码和性能选项，适合作为 Issue #13 分层诊断参考，不据此宣称已修复卡顿。
- [Waydroid](https://github.com/waydroid/waydroid)是 Linux 容器路线，与当前 Windows/Linux 模拟器路线不同；不为追求功能列表而搬入架构或忽略 GPL 义务。
