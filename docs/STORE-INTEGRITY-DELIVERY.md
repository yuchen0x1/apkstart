# ApkStart：设置与应用清单持久化保护交付记录

## 1. 本轮升级概况

- 项目：ApkStart，MIT，Windows / Linux 的本地 Android 应用运行器。
- 已发布基线：`v0.9.2` / `6c1b6a288e1b1e821bd2a93fd53b8d74d9cc1369`。
- 本轮核心提交：`5b09ea7bab674efaf53b6788df407a20330cfc67`。
- 时间：2026-11-21（本机日期；测试日志 UTC 为 2026-11-20）。
- 目标：先修复真实可复现的配置崩溃与持久化数据保护缺口，不把尚未确认归属的其它会话修改混入发布。
- 原工作区保留：`fix/audit-safety-and-runtime-regressions` 上的大量未提交修改未被本轮覆盖、提交或清理。
- 隔离执行：从已发布主线建立 detached worktree，不创建新的长期开发分支。
- 版本：此核心提交不重复使用 `v0.9.2` 发版；新的正式版本、Tag 与发布结果以最终核验为准。

### 项目能力与实际架构

| 层次 | 实际实现与能力 | 边界 |
|---|---|---|
| 桌面主进程 | `src/main.js` 编排安装、窗口、托盘、设置与 IPC | 存在体量较大的主进程编排文件，不能视为全面解耦 |
| 界面 | 原生 JavaScript / HTML / CSS，双主题、设置分类、向导、搜索、应用入口 | UI 隔离夹具不等于真实 Android 运行 |
| 安全桥 | `preload.js`、`ipcguard.js`，隔离渲染进程与 Node 能力 | 其它工作区尚未提交的角色细分不属于本轮 |
| APK 与应用 | ZIP / AXML / ARSC 解析，安装、兼容性判定、桌面快捷方式、应用窗口 | ABI、Play 依赖、转译和反模拟限制仍存在 |
| Android 运行时 | Android Emulator / QEMU，按需部署，AVD、镜像与系统 Provider 管理 | Linux 原生会话和 Windows 窗口嵌入需分别验收 |
| 文件与数据 | JSON 设置/应用清单，文件共享同步、备份恢复、镜像导入 | 没有关系数据库；本轮不是跨进程或跨文件事务系统 |
| 更新发布 | 严格安装结果核对、失败恢复；GitHub Actions 构建 Windows/Linux，签名更新清单 | 更新元数据签名不等于 Windows Authenticode 代码签名 |
| 技术栈 | Electron 45、Node ≥20、electron-builder、`@napi-rs/lzma` | 本轮没有新增第三方依赖 |

本记录来自核心代码、测试和构建链路走读，不声称已经逐字审计全部代码、证明所有平台完全安全。

## 2. 新增功能

- 损坏设置或应用清单顶层结构的唯一恢复副本：`*.bak-<时间>-<随机值>`。
- 混合损坏应用清单的健康记录恢复：先备份完整原文，再原子保存健康记录；保留健康记录的开放式元数据。
- `npm run test:packaged`：核对两个 Windows 构建目录中的模块哈希与版本，并用各自内置 Node 执行隔离配置保存。

这些是可靠性能力，不是新的 Android 后端、插件系统或界面重设计。

## 3. Bug 修复

| 问题 | 原因 | 修复及验证 |
|---|---|---|
| `engine:null` 等设置可导致启动读取崩溃 | 合并函数允许整个设置分区变成非对象 | 已声明自有键和类型过滤；合法同级值保留 |
| 未保存的读取结果影响后续默认值 | 浅复制保留嵌套对象/数组引用 | 每次读取隔离对象与数组；补丁不共享调用者数组 |
| 读不到原配置后可能写回默认值 | 所有读取错误均被当成首次使用 | 只有 ENOENT 正常回退；权限/I/O 错误向上传递 |
| 损坏备份失败仍继续写入 | 备份错误被吞掉 | 备份成功才允许回退；失败保留原文件并报错 |
| 固定暂存名可能碰撞或误写链接目标 | 非独占写入 `settings.json.tmp` | 随机同目录文件，`wx` 独占创建，0600 权限，写入/刷新/关闭后替换 |
| `apps.json=null` 或坏记录使清单不可用 | 仅检查数组外形，直接访问字段 | 顶层校验与混合记录恢复；备份/写入故障回归 |
| 白名单包含原型继承键 | 使用 `k in base` | 使用 `Object.hasOwn`，拒绝未知或继承键 |

最初新增 10 项测试在未修复基线上得到 **1 通过 / 9 失败**；修复并补齐故障注入后得到 **17 通过 / 0 失败**。
测试不接触用户真实配置、模拟器或已安装应用。

## 4. 性能与架构优化

- 保持 `settings.json` 与 `{ apps: [...] }` 格式，不引入数据库和大依赖。
- 同目录原子替换，减少半写配置暴露窗口；刷新文件后才替换目标。
- 保存路径增加文件刷新，可能增加磁盘写延迟；**未宣称性能变快**，也未进行对照性能基准。
- 不保证跨进程并发编辑合并、跨文件事务、目录刷新及所有断电情况下的绝对持久性。
- 严格类型过滤会忽略不合法类型或未声明的旧/未来键；不对高级参数的所有枚举值和数值范围作完整校验。

## 5. UI/UX 验证

- 本轮没有改动界面样式或重做页面。
- 实际 Electron/Chromium 冒烟测试 **20 项通过**。
- 隔离 UI 回归记录 **406 次渲染/状态采样**，不是 406 个页面或人工验收截图。
- 检查涵盖键盘焦点、模态层、搜索空态、加载/错误/重试、双主题与可测纯色文字对比度。
- 测试中预期的 IPC 失败注入会输出错误行，不代表未捕获页面脚本错误。
- 本机截图来自真实 Chromium 渲染，但应用列表和 Android 能力由 fixture 提供；不是运行 Android 应用的证明。
- 本轮未测试屏幕阅读器、物理多显示器 DPI、真实 Android 启动/安装与 Linux 原生桌面会话。

## 6. 开源项目研究

只读核对六个真实仓库的许可证和相关源码/文档。GPL 项目只作为行为与架构参考，没有复制源码、文案或素材；MIT / Apache 项目也没有直接搬运代码。

| 参考项目 | 核对版本与许可证 | 与本项目的对比及可吸收方向 |
|---|---|---|
| [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart/tree/a4d4a23cdd20d8943703ae172a0c8734ca23b097) | `a4d4a23c`，[MIT](https://github.com/RoutineMiku/apkstart/blob/a4d4a23cdd20d8943703ae172a0c8734ca23b097/LICENSE) | 同源 Electron 管理器；对比本地 JSON、后端注册与恢复策略。不能把上游新结构误认为当前 fork 已具备 |
| [waydroid/waydroid](https://github.com/waydroid/waydroid/tree/a1a1936a7ed74e1537deeb3420302997869d8a4d) | `a1a1936a`，[GPLv3](https://github.com/waydroid/waydroid/blob/a1a1936a7ed74e1537deeb3420302997869d8a4d/LICENSE) | Linux 容器与用户会话分离、桌面入口生命周期；不是 Windows/QEMU 的直接替代 |
| [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/tree/c939183a7cdca4599cee337e60bc0e147b6c9828) | `c939183a`，[Apache-2.0](https://github.com/Genymobile/scrcpy/blob/c939183a7cdca4599cee337e60bc0e147b6c9828/LICENSE) | 明确视频/音频/控制生命周期、虚拟显示关闭策略；不是自带 Android 系统的模拟器 |
| [ImranR98/Obtainium](https://github.com/ImranR98/Obtainium/tree/35c3e7fea4f341a716eca4bb3fc625319ce965ab) | `35c3e7fe`，[GPLv3](https://github.com/ImranR98/Obtainium/blob/35c3e7fea4f341a716eca4bb3fc625319ce965ab/LICENSE.txt) | 来源适配、签名身份校验、迁移/损坏记录隔离、无凭证配置导出；本轮采用独立实现的数据保护思路 |
| [alesimula/wsa_pacman](https://github.com/alesimula/wsa_pacman/tree/d516117efdc6be98f97d599d4be89d10803a420c) | `d516117e`，[GPLv3](https://github.com/alesimula/wsa_pacman/blob/d516117efdc6be98f97d599d4be89d10803a420c/LICENSE) | 安装前身份、版本、权限、升级/降级提示值得借鉴；不把 WSA 作为新的部署依赖 |
| [yume-chan/ya-webadb](https://github.com/yume-chan/ya-webadb/tree/a62aacc210897b2f1bc3fb2270b94ec033b45575) | `a62aacc2`，[MIT](https://github.com/yume-chan/ya-webadb/blob/a62aacc210897b2f1bc3fb2270b94ec033b45575/LICENSE)，另有 ADB Apache 通知 | 传输、设备授权、凭证与渲染背压分离；不为小改造引入整套协议实现 |

### 维度对比

| 维度 | 当前 ApkStart | 参考思路 | 后续方向 |
|---|---|---|---|
| 功能完整度 | 管理 Android 运行时、安装和桌面入口 | WSA PacMan 安装预览 | 更明确的签名/权限/降级确认 |
| UI/UX | 双主题、向导、分类设置、原生窗口承载 | scrcpy 明确窗口生命周期 | 区分关闭窗口、停止应用、停止运行时 |
| 性能 | 原生模拟器窗口，已有资源档位 | scrcpy 可配置显示成本、Tango 背压 | 先测量再决定；没有跨项目速度/RAM实测结论 |
| 架构 | 主进程编排 + core 模块 + Provider | Waydroid 服务/会话边界 | 收敛生命周期与能力契约，而非大重写 |
| 数据/安全 | 本地 JSON、备份、签名更新元数据 | Obtainium 损坏隔离与来源身份 | 本轮持久化修复；后续配置导出排除秘密 |
| 扩展性 | 既有系统 Provider 与镜像清单 | 编译期适配器、独立传输包 | 复用现有边界，不加任意代码插件 |

## 7. 测试结果

| 检查 | 实际结果 |
|---|---|
| 隔离 `npm ci` | 成功；安装警告如实保留，未更换锁文件 |
| v0.9.2 基线 `npm test` | 退出码 0 |
| 修复后 `npm test` | 全链路退出码 0，最终核心提交后重新执行通过 |
| 新持久化回归 | Node 26.13.1：17/17；最低主版本 Node 20.20.2：17/17 |
| Electron 冒烟 | 20 通过 / 0 失败 |
| UI 回归 | 406 次采样；汇总无未捕获脚本错误、未命名表单或已测窗口越界 |
| Windows 便携构建 | 成功，最终核心提交后重建 |
| Windows NSIS 构建 | 成功，最终核心提交后重建；没有代码签名证书 |
| 两类构建目录模块验收 | 2/2；源码哈希、版本、内置 Node 隔离保存均通过 |
| `git diff --check` | 通过 |
| 生产依赖 npm audit | 官方 registry 返回 0 个已知漏洞；不等于整个软件无漏洞 |
| audit 首次失败 | 本机 npmmirror 不实现审计接口，返回 404；改用官方 registry 后成功，未修改机器配置 |

### 未执行或不能据此声称通过的项目

- Linux 本地构建、Linux 原生 GUI、KVM 与文件权限验收：本机为 Windows；需 CI / 对应环境。
- 用户真实 Android 的安装、启动、共享、备份恢复：为保护已有模拟器，没有运行可能接管它的产品主进程自检。
- NSIS 交互安装、真实已安装旧版升级、杀软/文件锁环境和卸载：只构建与检查展开包，未改变本机正式安装。
- 系统断电、跨进程竞争与全部文件系统语义：不在本轮自动化保证内。
- 原测试发现不到外部 APK 夹具时的可选真实 APK 项目会跳过；合成 APK 链路仍运行。

### 发布产物暴露面复核

1. **总览**：对自己的 Windows 展开构建执行只读 electron 画像扫描。扫描器原始分数不作为项目安全评级：本项目本来就是 MIT 开源，启发式误报与扫描上限必须人工解释。
2. **发现清单**：构建日志明确未配置 Authenticode 证书；源码明文随包是既有设计。扫描器报告的 PDB 项主要是依赖 DLL 的 PDB 基名，不能写成泄漏本机源码路径；对 `d3dcompiler_47.dll` 的 `BSJB` 字符串命中也不足以证明它是自家 .NET 程序。
3. **证据与修复**：`electron-builder` 输出 `no code signing certificate configured`；`electron-builder.yml` 为 `asar:false`，代理脚本需要真实路径。签名与 ASAR/fuse 调整应作为独立兼容性工程，不为“防逆向”擅自破坏 PowerShell 窗口代理。
4. **客户端无法解决的问题**：不应把长期授权凭证或计费判定寄托于混淆。扫描未发现此类自有商业授权机制；用户自填更新 token 的安全保管仍需专门评估。未做运行时秘密采集或服务端审计。
5. **修复顺序**：继续优先数据保护与安装来源验证，其次研究发布者代码签名和最小 Electron 能力；不为开源项目引入没有实际收益的混淆。扫描跳过大型 `ApkStart.exe`（约250MB）及 Android 画像，因此未检查不等于无问题。

## 8. Git 操作结果

- 远程已核验：`github.com/yuchen0x1/apkstart`，默认分支 `main`。
- 本轮核心提交：`5b09ea7bab674efaf53b6788df407a20330cfc67`，父提交为已发布 v0.9.2。
- 未改动原工作区，也未把其它会话的 runtime/IPC/UI 修复归为本轮成果。
- main 整合、远程推送和最终 SHA 在实际完成后核验，不在此预写成功。

## 9. 版本发布结果

- 不复用已发布 `v0.9.2` Tag。
- 本机 `0.9.2` 名称的构建仅用于新提交的构建验证，**不是重新发布旧版，不得上传覆盖旧资产**。
- 新版需要唯一版本号、相应 README/CHANGELOG、测试、平台构建与更新元数据签名。
- 目前没有把本轮产物冒充新的正式 Release；正式发布状态以 GitHub 查询与交付答复为准。

## 10. 下一轮自主升级计划

| 优先级 | 问题与下一步 | 涉及位置/验收 |
|---|---|---|
| P0 | 多会话整合时保留 v0.9.2 的严格更新校验和恢复保护，不把较旧工作区覆盖主线 | updater 与更新器回归、真实升级恢复验收 |
| P0 | 现有运行时安全候选需独立验证归属、进程所有权、取消/退出与数据保护后再整合 | 原工作区 runtime/IPC/provider 测试；不混入本轮 |
| P1 | 非破坏性恢复优先，明确应用数据清除授权 | installer/engine 与恢复入口；真实负向测试 |
| P1 | 只含配置不含秘密的版本化导出/导入预览 | store/UI/import tests；不包含 token、私钥、镜像和私有应用数据 |
| P1 | 对高级设置补充枚举/范围校验及清晰错误，而不是只做类型校验 | store/main/UI，维持旧值兼容 |
| P2 | 独立修正陈旧的在线/整包构建文档及站点版本一致性 | README/DEV-ENV/site；发布文档测试 |
| P2 | 正确 SemVer 优先级：正式版高于同号预发布版，忽略 build metadata | version.js / sources / updater；以规范和签名版本约束为依据 |
| P2 | 发布者代码签名、ASAR/fuse 兼容性验证、原生 Linux 验收 | build/release；证书与费用事项需单独授权 |

本轮没有宣称项目已经“全面进化完成”。后续以可验证、可回退的升级单元继续，不绕过发布和数据安全门槛。
