# 正式发布历史与交付记录

更新：2026-11-21。已有 Release 通过 GitHub API 核验；候选不得计作正式发布。

## v0.9.2 · 候选，尚未发布

- 类型：PATCH；基线 `v0.9.1` / `accb6ca`。
- 内容：Windows 更新结果严格校验、独立备份、失败载荷保护、真实回滚通知与 BOM 兼容。
- 本地：首轮 Windows/Linux 全量回归、更新器 54 项、Electron 冒烟/fixture UI、Windows portable/NSIS 构建通过；CI 短路径修正后 Windows/Linux 冻结代码全量再次通过，Windows 更新器增至 56 项，真实执行新增 2 项短名场景；Linux 更新器为 42 项平台适用用例。详见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
- [PR #14](https://github.com/yuchen0x1/apkstart/pull/14)：首轮 `aecad3e` 的 CI `44791289048` 为 Windows Node 20/22 失败、Linux Node 22 通过；未合并或发布。已修复短名根路径偏移，待修正后精确提交重新通过全部门禁。
- 次轮 `d324019` / CI `44796259254`：短路径回归均通过，Linux 全量通过；Windows 因 ACL 夹具安全模块加载失败而为 55/1。已修复夹具的模块依赖及 DACL 恢复读回；依然未合并或发布失败提交。
- 待完成：最终修正后 PR CI → 精确提交合并 main → 唯一 Tag → 原有签名工作流 → 四类资产与清单验证。
- 尚无本轮正式发布成功声明；完成后回填精确提交、PR、工作流、Release URL 与资产核对结果。

## 已核验基线

| 版本 | Tag 提交 | API publishedAt（UTC） | 状态 |
| --- | --- | --- | --- |
| [v0.9.1](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.1) | `accb6ca` | 2026-11-20T17:48:33Z | 正式，四类程序包、更新 JSON、签名及 SHA256SUMS 共 7 项已上传 |
| [v0.9.0](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.0) | `f7e7cdf` | 2026-11-20T16:57:53Z | 正式；本轮未再次核算全部二进制摘要 |
| [v0.8.0](https://github.com/yuchen0x1/apkstart/releases/tag/v0.8.0) | `a3e3e4a` | 2026-11-19T17:33:54Z | 巡检初始正式版；资产清单已读取 |

CHANGELOG 使用本地发布日期，以上 publishedAt 保留 API UTC 原值，二者跨日并不表示版本日期被回退。既有版本不是本轮创建，不能认领为本轮交付。

## 不可省略的发布门禁

- 版本、锁文件和更新日志一致；Tag 必须对应 main 中的精确提交。
- Windows Node 20/22、Linux Node 22 验证及全部构建成功。
- 不覆盖用户改动，不强推、不改保护规则、不关闭失败测试。
- 发布环境只在构建完成后读取签名私钥，先创建草稿并核对全部资产，再公开。
- 发布后验证签名、公钥匹配、SHA-256、文件名/版本和四类资产；失败则如实记录，不能只创建空 Release。
