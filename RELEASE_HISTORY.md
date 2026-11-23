# 正式发布历史与交付记录

更新：2026-11-23。仅记录已核验的正式发布与实际证据；候选、失败运行不计作发布成功。

## v0.10.5 · 已正式发布并核验

- [正式 Release](https://github.com/yuchen0x1/apkstart/releases/tag/v0.10.5)：GitHub API 显示 `published_at = 2026-11-23T02:04:43Z`，`isDraft = false`、`isPrerelease = false`。
- 类型：PATCH；Tag 为带注释 Tag `f89d0fe7f431e9d5d3240fdedbda61417e62ad23`，目标提交 `11cbaf2b78fa25702b07fba2ff736eae334a8329`，发布时与远程 `main` 一致；随后仅追加本证据文档提交 `01418448ae88bd0dcb01a2c22f2e581067d1c3c9`，Tag 未移动。
- [Release 流水线 45097567562](https://github.com/yuchen0x1/apkstart/actions/runs/45097567562)：版本核验、Windows Node 20/22、Linux Node 22、双平台 Electron UI、Windows portable/NSIS、Linux AppImage/deb、清单签名、草稿核对和正式发布全部成功。
- 本版落地设置读取缓存和生态研究记录；实现边界与测试证据见 [CHANGELOG](CHANGELOG.md) 和 [生态研究](docs/ECOSYSTEM-RESEARCH-0.10.5.md)。

### 正式资产逐项核对

以下 7 项资产已从正式 Release 下载到独立临时目录。本地大小与 GitHub API 元数据一致；四项程序资产与更新清单、`SHA256SUMS` 逐项一致；更新清单使用客户端公钥 `src/core/release-public.pem` 验证 Ed25519 签名。Release 正文中的隐藏清单与下载的 JSON/签名文件逐字节一致。

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ApkStart-v0.10.5-win64-portable.zip` | 149997404 | `9367ac6b8d8c72dde70fcd6a2f88f230dab8168bcd6c1bb1161d8347b2c999c5` |
| `ApkStart-0.10.5-Setup.exe` | 121381632 | `bf77a20a9374cdec60a7ca8e9cc7254ffa46e6105f4d1ec5a5f7c599794fc34f` |
| `ApkStart-0.10.5-x86_64.AppImage` | 135180314 | `7671a4b2ccbf975b79195a34c8eaccd7e98342e7574eb0f4e1815699ae1d9353` |
| `ApkStart-0.10.5-amd64.deb` | 109244360 | `653d601aa16a8de21c36f51b66127735ad65ca166e4bade286ec9fb69d46bd4d` |
| `ApkStart-update.json` | 628 | `063204cbaaaabcf874d220c0aea0c3bdfecfd0f5267451a79fd4389cb5175339` |
| `ApkStart-update.json.sig` | 64 | `ea3023a602c9d1d1b8776ca7ca1876644c21995b6a5f02ef09eac1b508e3ba69` |
| `SHA256SUMS` | 384 | `e95fdd42a1ca0906cf72fbb76b3c914ff24e685194890b8c902a470889bc9f41` |

- 未执行任何下载的安装程序或真实升级；上述结果证明发布资产完整性和清单签名，不证明安装、升级、回滚或设备运行成功。
- 安装包仍未配置 Authenticode 证书；真实 Android 客机/GPU、长时间视频流、断电恢复、混合 DPI、多实例压力和签名发布者身份仍需对应环境验收。

## v0.10.4 · 已正式发布并核验

- [正式 Release](https://github.com/yuchen0x1/apkstart/releases/tag/v0.10.4)：非草稿、非预发行，GitHub API `published_at = 2026-11-23T01:25:25Z`。
- 类型：PATCH；发布源码提交 `c03aeec87bba63ee4b06cbac062285d97a968a2b`，发布时 `v0.10.4` Tag 与 `main` 同一提交；随后仅追加本记录文档提交 `fa0f959b9e901e8c06994e95e91231079694999f`，未移动 Tag。
- [Release 流水线 45093871022](https://github.com/yuchen0x1/apkstart/actions/runs/45093871022) 与 [main CI 45093854604](https://github.com/yuchen0x1/apkstart/actions/runs/45093854604)：版本核验、Windows Node 20/22、Linux Node 22、双平台 Electron UI、Windows portable/NSIS、Linux AppImage/deb、清单签名、草稿核对和正式发布全部成功。
- 上游开放 Issue 审计覆盖当前 92 项；本版落地修复 [#116](https://github.com/RoutineMiku/apkstart/issues/116)（Microsoft Store 只读运行时暂存）、[#5](https://github.com/RoutineMiku/apkstart/issues/5)（SetParent 拒绝后的独立窗口回退）、[#11](https://github.com/RoutineMiku/apkstart/issues/11)（嵌入窗口 Home/Overview/Back 快捷键）和 [#111](https://github.com/RoutineMiku/apkstart/issues/111)（多显示器启动跳动）。其余平台、硬件、真实 APK/设备和蓝屏归因边界未冒充为已修复，详见 [上游问题审计](docs/UPSTREAM-ISSUES-AUDIT.md)。

### 正式资产逐项核对

以下信息来自正式 Release API；7 项资产已下载至独立临时目录。本地验证了更新清单 Ed25519 签名、公钥 `src/core/release-public.pem`、四项程序资产与 `SHA256SUMS` 的逐项一致性，并与 GitHub API 返回的字节数、`sha256:` digest 和 `uploaded` 状态一致。未执行任何安装程序或真实升级。

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ApkStart-v0.10.4-win64-portable.zip` | 149997185 | `a905b03ba217f6a766aebdeb1cd5a2447f02e5d42ddd829d8863045abbae98b0` |
| `ApkStart-0.10.4-Setup.exe` | 121381077 | `9f0261cccf4fe6d59926edd745f4b23c8e120bfe975c8ff557aca3c7456c11bb` |
| `ApkStart-0.10.4-x86_64.AppImage` | 135180341 | `11ad55b1384371eb0364276ae572a3775df1c4c975bd316539b6d328606068d2` |
| `ApkStart-0.10.4-amd64.deb` | 109068196 | `df07b6d74cc39ebe954fb1d5bf2fdec6e93449b27e50d5bf490a00d3856351c2` |
| `ApkStart-update.json` | 628 | `2f7b1cd22a17715037fc1fe66f782777101d06d131b1760b86e35ac3efc49705` |
| `ApkStart-update.json.sig` | 64 | `88aeba61e3091ce6b243ba8ed33b6de9f47db765531f5049eb87bbbe5c91619e` |
| `SHA256SUMS` | 384 | `9e858aea911d1a0b73d1695fcb1c696bc2548c7c387faeb5591ac388f67c1961` |

- 本地 `npm test`、`npm run pack`、`npm run build:exe` 和 `npm run test:packaged` 均通过；PowerShell 原生窗口行为夹具因本机执行策略跳过，CI 的 Windows/Linux 测试与 UI 夹具均成功。
- 安装包未配置 Authenticode 证书；真实 Microsoft Store 沙箱、完整运行时复制、混合 DPI 多显示器、真实 APK 快捷键焦点、安装升级/回滚和签名发布者身份仍未在本轮宣称验收。

## v0.10.3 · 已正式发布并核验

- [正式 Release](https://github.com/yuchen0x1/apkstart/releases/tag/v0.10.3)：非草稿、非预发行，GitHub API `published_at = 2026-11-23T00:40:23Z`。
- 类型：PATCH；源码提交 `f413d5b820d8768fc605206efd19c17ac8680424`，`v0.10.3` Tag 与 `main` 同一提交。
- [Release 流水线 45089589127](https://github.com/yuchen0x1/apkstart/actions/runs/45089589127)：版本核验、Windows Node 20/22、Linux Node 22、双平台 Electron UI、Windows portable/NSIS、Linux AppImage/deb、清单签名与草稿核对全部成功。
- 议题 [#18](https://github.com/yuchen0x1/apkstart/issues/18)（Windows 私有 ADB listen spec）和 [#13](https://github.com/yuchen0x1/apkstart/issues/13)（视频渲染卡顿）已回复修复并关闭；#13 的真实 Android 视频流帧率和音画同步仍需报告者机器复验。

### 正式资产逐项核对

以下信息来自正式 Release API；下载的更新清单、签名和 `SHA256SUMS` 已在本地用 `src/core/release-public.pem` 验签，并确认清单内四项程序资产与 `SHA256SUMS` 逐项一致。未执行任何安装程序或真实升级。

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ApkStart-v0.10.3-win64-portable.zip` | 149993676 | `d0be85ab18090a0e8af5ccd9f4981349284479206407bb3c044eabdb4df94bac` |
| `ApkStart-0.10.3-Setup.exe` | 121377969 | `ae1420198e24a487c940000bdd666094876c833fb4cb45f41d8a0e70a3e5a03c` |
| `ApkStart-0.10.3-x86_64.AppImage` | 135176270 | `ba783d306db88461f1c6e4935695e32223376be4066e91b8e15e1fd6d763e233` |
| `ApkStart-0.10.3-amd64.deb` | 109071932 | `214c1211e525104be1161de04bcf4e0680c9baab0821cb0284fcda78ed6ae893` |
| `ApkStart-update.json` | 628 | `f739aa99f219ff6936be6520013fe991301587f2a3e88721a2854e2ec01d854d` |
| `ApkStart-update.json.sig` | 64 | `631df36a32a55234428a0cf92132ec1d6f62c3550cd61300000dc170ec18ed3e` |
| `SHA256SUMS` | 384 | `35acc0674cb9fa8d797ee27715519a8888d1425b58c3ecdaae8276aa3cf63674` |

- 本地 `npm test` 通过；现有 PowerShell 原生窗口夹具因本机执行策略被跳过，CI 的 UI 与跨平台测试均成功。真实 Android 客机、视频流、安装升级、回滚和 Authenticode 签名未在本轮宣称已验收。

## v0.9.2 · 已正式发布并核验

- [正式 Release](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.2)：非草稿、非预发行，GitHub API `published_at = 2026-11-20T19:05:44Z`。
- 类型：PATCH；基线 `v0.9.1` / `accb6ca`。
- 内容：Windows 更新结果严格校验、独立备份、恢复权限预检、失败载荷保护、持久化自动重试限制、真实回滚通知及 BOM 兼容。
- [PR #14](https://github.com/yuchen0x1/apkstart/pull/14) 最终验收 head：`a34ccb94cd05146055aedba7a81a7602178c8745`。Windows Node 20/22、Linux Node 22 的 [CI 44797597010](https://github.com/yuchen0x1/apkstart/actions/runs/44797597010) 与[依赖审查 44797596942](https://github.com/yuchen0x1/apkstart/actions/runs/44797596942) 全通过后合并。
- main 的 squash/Tag 源码提交：`6c1b6a288e1b1e821bd2a93fd53b8d74d9cc1369`。与验收 head 文件树完全相同；唯一 `v0.9.2` Tag 的 peeled commit 与之相符。
- [Release 流水线 44798205362](https://github.com/yuchen0x1/apkstart/actions/runs/44798205362)：版本/主分支归属、Windows Node 20/22、Linux Node 22、portable/NSIS/AppImage/deb、清单签名、草稿核对和公开全部成功。[合并后 main CI 44798028579](https://github.com/yuchen0x1/apkstart/actions/runs/44798028579) 也通过。
- 本地：Windows 全量再次退出 0（更新器 56/0，含实际短名成功/恢复与 ACL 拒绝/恢复读回）；Linux 冻结代码树全量退出 0（更新器 42/0，Windows 专属执行跳过）；Electron 冒烟 20/0。fixture UI 与真实运行环境的边界见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。

### 正式资产逐项核对

以下 7 项均从正式 Release 逐文件下载至独立新空目录，本地大小与 SHA-256 均等于 GitHub REST 元数据。未执行任何下载程序。

| 资产 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `ApkStart-v0.9.2-win64-portable.zip` | 149909919 | `bf8b3cdb2acd28f654ba429e66b5f6b750caef568ee48f81c7d296ca64776daa` |
| `ApkStart-0.9.2-Setup.exe` | 121207451 | `13e57fbb2f2cd7fab3a4627c624d0b41e011122838482935ba5077797e1d310d` |
| `ApkStart-0.9.2-x86_64.AppImage` | 134937664 | `8abf1c8ad88b35146be8a73b0eceebc0ce8eee8c274a27ba7c2f3e2238c3b457` |
| `ApkStart-0.9.2-amd64.deb` | 109041956 | `02bc07217ee14e32892e1fa837e4982e533975df24fd976548b01c70a6f89d80` |
| `ApkStart-update.json` | 623 | `7b4fe26204966f1cbaa5bcbb2010616a0a8be6130ae39b7883a0798b3b9f0238` |
| `ApkStart-update.json.sig` | 64 | `40f35fdc57f79fd156e2e2c271df67ed15bb8202e93a1e84eddc54dc819d3f22` |
| `SHA256SUMS` | 380 | `361921469b59511e7ea143a5478814fc048bd031203d9c5eb3a19f56aedb6f2a` |

- 四个程序包的大小/摘要与 Ed25519 签名清单精确匹配，验签使用客户端随附公钥 `src/core/release-public.pem`。
- 下载的 JSON/原始签名与发行说明隐藏清单逐字节一致；签名清单精确包含四个唯一程序资产，SHA256SUMS 也精确覆盖四项，拒绝重复/额外/漏项。
- Portable ZIP 内部 `resources/app/package.json` 为 `apkstart@0.9.2`。
- deb 的 Package/Version 为 `apkstart` / `0.9.2`，并从数据 tar 流读取内部 package 版本 0.9.2；AppImage 只用 `unsquashfs -cat` 读取内部 package，版本 0.9.2（SquashFS offset 188392）。
- NSIS 只读取 PE 资源，ProductVersion/FileVersion 均为 `0.9.2`。这不是实际安装成功证明，也不是 Authenticode 签名。
- Portable 正式 ZIP 约 142.97 MiB，160 MiB 门禁通过。后续文档回填不移动 Tag，不重新发布或重复打包该版本。

### 失败运行没有被掩盖

- 首轮 `aecad3e` / CI `44791289048`：Windows Node 20/22 失败、Linux 通过。备份根短名与子项长名混用，修正提供程序解析后的根路径并增加实际 8.3 成功/回滚回归。
- 次轮 `d324019` / CI `44796259254`：短路径回归均通过，Windows 更新器 55/1，Linux 全量通过。唯一失败是 ACL 夹具模块加载；改用 .NET Framework ACL API，并加入拒绝生效和原 DACL 恢复读回断言。
- 两个失败 head 均未直接合并或发布；等待最终 head 全绿后才合并。细节见 [AUTONOMOUS_CHANGELOG.md](AUTONOMOUS_CHANGELOG.md)。

## 已核验基线

| 版本 | Tag 提交 | API publishedAt（UTC） | 状态 |
| --- | --- | --- | --- |
| [v0.9.1](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.1) | `accb6ca` | 2026-11-20T17:48:33Z | 正式，四类程序包、更新 JSON、签名及 SHA256SUMS 共 7 项已上传 |
| [v0.9.0](https://github.com/yuchen0x1/apkstart/releases/tag/v0.9.0) | `f7e7cdf` | 2026-11-20T16:57:53Z | 正式；本轮未再次核算全部二进制摘要 |
| [v0.8.0](https://github.com/yuchen0x1/apkstart/releases/tag/v0.8.0) | `a3e3e4a` | 2026-11-19T17:33:54Z | 巡检初始正式版；资产清单已读取 |

CHANGELOG 使用本地发布日期，以上 publishedAt 保留 API UTC 原值，二者跨日不表示版本日期被回退。既有版本不是本轮创建，不能认领为本轮交付。

## 不可省略的发布门禁

- 版本、锁文件和更新日志一致；Tag 必须对应 main 中的精确提交。
- Windows Node 20/22、Linux Node 22 验证及全部构建成功。
- 不覆盖用户改动，不强推、不改保护规则、不关闭失败测试。
- 发布环境只在构建完成后读取签名私钥，先创建草稿并核对全部资产，再公开。
- 发布后验证签名、公钥匹配、SHA-256、文件名/版本和四类资产；失败则如实记录，不能只创建空 Release。
