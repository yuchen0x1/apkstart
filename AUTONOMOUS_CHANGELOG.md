# 自主开发记录

## 2026-11-21 · A001 · 更新失败保护（候选 0.9.2）

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

### 交付状态

本段写入时：短路径修正完成本地 Windows 验收，尚待修正后精确提交的 PR CI、主分支合并和签名 Release 流水线。正式结果回填 [RELEASE_HISTORY.md](RELEASE_HISTORY.md)。未把 Issue #13、原生 Linux 桌面、真实设备升级或签名证书标记为已验证。

### 开源研究

通过 GitHub API 复核近期提交和许可证：electron-builder、Velopack（MIT）、scrcpy（Apache-2.0）、Waydroid（GPL-3.0）、原上游 ApkStart（MIT）。仅研究原则，未复制外部实现。

- electron-builder 的[自动更新文档](https://www.electron.build/docs/features/auto-update/)区分下载、校验、安装和关机会话风险；本轮沿用自有更新器，贯彻“验证失败不进入成功清理”，未盲升到新主版本。
- scrcpy 的[视频配置](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md)分别讨论编码器、编解码和性能选项，适合作为 Issue #13 分层诊断参考，不据此宣称已修复卡顿。
- [Waydroid](https://github.com/waydroid/waydroid)是 Linux 容器路线，与当前 Windows/Linux 模拟器路线不同；不为追求功能列表而搬入架构或忽略 GPL 义务。
