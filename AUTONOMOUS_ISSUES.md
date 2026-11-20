# 自主巡检未解决问题

更新：2026-11-21。状态均以本轮证据为准；不是全项目无缺陷声明。

## 发布门禁 · PR #14 Windows CI 短路径回归

- 首轮 CI `44791289048` 中 Windows Node 20/22 失败：短名备份根与长名子项混用，导致恢复权限预检映射错误。没有合并或发布该失败提交。
- 本地已修正根路径基准；专项 56/0（实际执行成功/回滚 2 项短名场景），Windows 全量再次退出 0，独立静态复核无新增阻塞。
- 状态：必须等待修正后精确提交的全部 PR CI 通过后才能解除发布阻塞，不能仅凭本机 Node 26 结果放行。

## P1 · 视频应用卡顿与音画不同步

- 来源：[Issue #13](https://github.com/yuchen0x1/apkstart/issues/13)。用户报告 0.8.0 / Windows 11 播放视频比 0.6.18 更卡，降低至 540p 仍不同步。
- 状态：已阅读完整报告，未在隔离设备上复现，不能确认根因或声明已修复。
- 下一步：建立独立 AVD/数据目录，记录实际 GPU 后端、硬件加速、宿主/客机占用、编解码和 ARM 转译能力；比较 0.6.18 与现版本，避免擅自重置用户数据或接管现有模拟器。

## P2 · UI 验证未进入流水线

- 证据：`package.json` 暴露 `test:ui`，但当前 CI/Release 不运行真实 Chromium fixture UI 回归。
- 本轮手动跑过候选版本的隔离 UI；这不消除后续提交的持续验证缺口。
- 下一步：评估 Windows runner 耗时与截图稳定性后接入，保留网络隔离及内存 IPC，不用产品主进程代替。

## P2 · Code Scanning 无分析记录

- 证据：GitHub Code Scanning API 返回 404 `no analysis found`。
- 状态：未运行的扫描，不是“0 告警”或“安全通过”。npm audit、Dependabot 与 Secret Scanning 各有独立范围，不可互相替代。
- 下一步：评估可用静态分析工具并建立可复现扫描，不能仅屏蔽告警。

## P2 · 六个依赖 PR 待审

- [#7](https://github.com/yuchen0x1/apkstart/pull/7) upload-artifact、[#8](https://github.com/yuchen0x1/apkstart/pull/8) download-artifact、[#9](https://github.com/yuchen0x1/apkstart/pull/9) checkout、[#10](https://github.com/yuchen0x1/apkstart/pull/10) dependency-review、[#11](https://github.com/yuchen0x1/apkstart/pull/11) setup-node、[#12](https://github.com/yuchen0x1/apkstart/pull/12) Electron patch。
- 状态：已阅读描述和 CI 状态；本轮不把多个 Actions 主版本升级与更新器故障修复混成一个发布。
- 下一步：刷新各 PR 的 head/main 与 Node/runner 要求，按独立批次验收。

## P2 · 会话结束时自动安装的剩余风险

- 外部安装器在系统关机期间可能被终止。此次修复保留恢复文件并严格核对结果，但不是事务式安装，也不声称可以抵抗断电。
- 下一步：研究关机信号与下次启动再安装，先增加隔离回归；不更换更新框架来掩盖风险。

## P3 · Windows 可信代码签名

- 构建日志确认没有配置 Authenticode 证书；当前 Release 使用独立签名更新清单，二者不是同一种验证。
- 下一步：在具备可信证书和安全密钥管理后单独接入；不伪造已签名结论。

## P4 · 文档陈旧

- `docs/TESTING.md` 仍写 `npm test` 为 8 套件，与当前脚本不一致；历史开发环境文档也需要明确归档属性。
- 已在状态文件写入本轮真实测试范围，但尚未全面整理历史文档。

## 不再作为本轮阻塞的旧基线问题

最初发现的进程名全局清理、自选/共享目录误删风险已随远程 `v0.9.0` 进入 `v0.9.1` 基线。本轮复核相关临时目录及 mock 归属测试通过；未重复“修复”或认领这些先前提交。
