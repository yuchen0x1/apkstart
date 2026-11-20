# 正式发布历史与交付记录

更新：2026-11-21。已有 Release 通过 GitHub API 核验；候选不得计作正式发布。

## v0.9.2 · 候选，尚未发布

- 类型：PATCH；基线 `v0.9.1` / `accb6ca`。
- 内容：Windows 更新结果严格校验、独立备份、失败载荷保护、真实回滚通知与 BOM 兼容。
- 本地：Windows/Linux 全量回归、更新器 54 项、Electron 冒烟/fixture UI、Windows portable/NSIS 构建通过。详见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。
- 待完成：PR CI → 精确提交合并 main → 唯一 Tag → 原有签名工作流 → 四类资产与清单验证。
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
