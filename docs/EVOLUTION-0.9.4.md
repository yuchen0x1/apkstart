# ApkStart 0.9.4 升级与验收记录

## 1. 本轮升级概况

- 项目：ApkStart，面向 Windows / Linux x64 的 Android 应用桌面运行器，许可证 MIT。
- 代码基线：默认分支 `main` 的 `9932103e77bf5b89b5539970f50d6ca34eea5319`。基线包版本为 `0.9.3`；开始验收时公开的最新 Release 仍为 `v0.9.2`，不能把版本文件等同于公开发行。
- 本轮版本：`0.9.4`，向后兼容的修复与交互改进。
- 日期：2026-11-21（本地时间）。
- 目标：修复真实可复现的目录缓存和运行库修复问题，减少隐藏界面的重复读取，明确启动与创建快捷方式的操作边界，补充任务状态播报。
- 数据兼容：没有数据库迁移、公开 IPC 名称变更、配置格式变更或运行时依赖新增。原工作区已有修改保留，本轮在独立 detached 工作树中完成，不新建命名开发分支。

### 实现能力与边界盘点

| 模块 | 已有实现 | 本轮处置 / 限制 |
| --- | --- | --- |
| 桌面外壳 | Electron 45、原生 JavaScript、深浅主题、中英文、键盘焦点管理 | 延续既有界面，不引入框架或全面重绘 |
| 应用安装 | APK / APKS / XAPK 解析、兼容性检查、拆分包安装、导出及备份 | 保持现有格式和安装链路 |
| 运行时 | 按需部署 Android Emulator / QEMU、校验下载、运行实例归属与操作租约 | 不触碰真实用户模拟器；Linux 无 Windows 嵌入窗口能力 |
| 应用窗口 | Windows 嵌入 / 独立应用窗口、输入桥接、桌面快捷方式 | 启动与快捷方式分离；没有移除显式快捷方式命令 |
| 系统管理 | 远程系统目录、磁盘 / 内置回退、任务进度、运行状态 | 修复新鲜度、离线重试、并发刷新和可见界面轮询 |
| 数据 | JSON 设置和应用清单、同目录原子替换、损坏备份 | 此能力属于继承的 0.9.3 基线，不冒充本轮新实现 |
| 文件同步 | 哈希识别、双向同步、冲突副本、删除保护、路径归属边界 | 延续安全边界；不放宽 Windows 短路径校验 |
| IPC 安全 | 页面角色、来源与参数校验，沙箱 preload | 本轮只修复 VC++ 修复操作的 PowerShell 路径边界 |
| 更新分发 | Windows 安装版 / 便携版、Linux AppImage / deb，签名更新清单 | Linux deb 走系统包处理器是已有设计，不当成缺陷改写 |
| 自动化 | Node 测试、真实 Chromium 夹具 UI、矩阵 CI、分平台构建 | 夹具 UI 与真实 Android 端到端验收明确区分 |

## 2. 新增功能

1. **任务状态可感知性**：系统任务提供 `polite` 状态区域，仅在阶段或错误发生有意义变化时更新，不把每个百分比变动变成播报。
2. **可恢复的离线目录读取**：普通读取在失败后的一分钟内复用已有结果；冷却到期后的下一次读取会重试，用户主动刷新始终可以立即重试。
3. **可复现的安全回归**：生产处理器接线测试与真实 PowerShell 录制负对照纳入 `test:safety`、`test:security` 和完整测试入口。

## 3. Bug 修复

| 问题 | 原因 | 修复与回归 |
| --- | --- | --- |
| 内存目录可在整个进程期间一直显示新鲜 | 六小时 TTL 常量没有参与内存命中判定 | 每次读取及 `cacheInfo()` 按缓存时间检查边界；覆盖未来时间戳和时钟回拨 |
| 离线列表反复触发网络读取 | 过期结果没有短期失败冷却 | 一分钟普通读取冷却；显式刷新绕过；重复读不延长冷却 |
| 缓存磁盘不可写后丢失最近目录 | 网络失败优先重新读取磁盘 / 内置数据 | 优先保留最近成功的内存目录；真实文件 / 目录冲突验证失败路径，保留已有文件 |
| 刷新竞态 / 失败后无法正确重试 | 新鲜内存返回和在途读取缺少统一次序 | 在途刷新优先，共享一个请求；成功清除旧错误，失败释放在途状态 |
| VC++ 修复路径进入 PowerShell 脚本 | 可配置目录被插入双引号脚本，路径中的 `$()` 可被求值 | 固定脚本通过环境变量读取路径；保留原参数、管理员授权与等待行为 |
| 双击应用卡片附带创建快捷方式 | `dblclick` 监听额外执行快捷方式操作 | 删除隐式动作，保留单击启动和显式菜单命令 |
| 设置关闭时仍周期获取系统快照 | 初始化与定时器无条件执行目录、任务和状态读取 | 只在相关设置可见时轮询，打开面板即时刷新，事件推送继续有效 |
| 取消后还显示待确认状态 | 已有快照在途时，操作后的刷新被提前返回丢弃 | 合并在途读取，显式操作追加一次新快照；延迟快照回归验证最终为 cancelled |
| 慢读取导致操作一直忙碌 | 自动轮询可不断向追加刷新队列添加下一轮 | 在途时跳过自动 tick，保留显式刷新排队；受控延迟回归验证等待者最终释放 |
| 语言切换后已有播报仍是英文 | 播报直接写入译文，未重新呈现已有任务 | 语言变更时重新呈现最后播报，测试在新事件前立即核对语言 |

VC++ 问题的威胁边界是**本地受控路径 + 用户主动修复操作**，不是远程代码执行，也不是静默提权。`RunAs` 仍需要操作系统授权。

## 4. 性能与架构优化

- 没有引入新的网络层、状态框架或运行时依赖。目录仍用现有 `SystemCatalog`，仅加入可注入时钟、统一新鲜度判定与重试时间。
- 并发普通 / 强制刷新复用同一个在途请求；普通读取不会绕过已经开始的主动刷新而返回旧内存。
- 确定性测试证明：离线冷却窗口内连续二十次读取只触发一次远程尝试；并发读取共享一次请求。它们是调用次数断言，不是公网延迟、CPU 或启动速度基准。
- 设置隐藏时定时器可以保留，但不再发出对应快照 IPC；这不等于取消此前已经发出的请求。
- 内存目录无需磁盘缓存写入成功即可继续使用。写盘仍是已有的尽力缓存语义，没有把目录缓存伪装成事务存储。

## 5. UI/UX 优化

- 保留既有主题、布局、应用卡片、菜单和系统任务视觉结构。
- 快捷方式只通过明确命令创建，避免快速双击造成用户未选择的桌面文件。
- Runtime / Android 设置打开后及时读取；离开相关设置后暂停无意义的周期快照。
- 状态区域面向辅助技术提供重要变化，不重复宣读进度。测试只验证 DOM 和事件语义，不声称完成真人读屏器验收。
- UI 验证使用真实 Electron 渲染器和内存 IPC 夹具，不是 jsdom，也不连接真实模拟器。夹具画面必须标明为夹具，不能冒充真实 Android 运行截图。

## 6. 开源项目研究

研究包含官方仓库 README、许可证、相关源码和提交快照。以下是观测时的固定 SHA，而非对未来维护状态或性能作保证。没有复制对比项目源码，没有引入其框架依赖。

| 官方仓库 / 快照 | 许可证 | 研究内容 | 吸收或暂缓 |
| --- | --- | --- | --- |
| [RoutineMiku/apkstart](https://github.com/RoutineMiku/apkstart/tree/a4d4a23cdd20d8943703ae172a0c8734ca23b097) | [MIT](https://github.com/RoutineMiku/apkstart/blob/a4d4a23cdd20d8943703ae172a0c8734ca23b097/LICENSE) | 同源窗口、输入钩子、安装与真实路径打包 | 保留产品定位和窗口生命周期；不照搬较弱的沙箱配置 |
| [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy/tree/c939183a7cdca4599cee337e60bc0e147b6c9828) | [Apache-2.0](https://github.com/Genymobile/scrcpy/blob/c939183a7cdca4599cee337e60bc0e147b6c9828/LICENSE) | 虚拟显示、文件推送工作线程、interrupt / join / destroy | 资源归属和有界退出思路；不是模拟器替代，也没有宣称比它更快 |
| [waydroid/waydroid](https://github.com/waydroid/waydroid/tree/a1a1936a7ed74e1537deeb3420302997869d8a4d) | [GPL-3.0](https://github.com/waydroid/waydroid/blob/a1a1936a7ed74e1537deeb3420302997869d8a4d/LICENSE) | Linux 容器、D-Bus、应用 / 会话 / 容器边界、多窗口 | 学习职责隔离，不把 GPL 实现复制或翻译进 MIT 项目 |
| [alesimula/wsa_pacman](https://github.com/alesimula/wsa_pacman/tree/d516117efdc6be98f97d599d4be89d10803a420c) | [GPL-3.0](https://github.com/alesimula/wsa_pacman/blob/d516117efdc6be98f97d599d4be89d10803a420c/LICENSE) | Flutter 安装预览、包信息 / 权限、安装升级降级、可选快捷方式 | 显式操作和预览信息；不复制 GPL 源码；预览关闭不等于取消已开始安装 |
| [electron/fiddle](https://github.com/electron/fiddle/tree/9c1d4367c87a64835ac0d363e46e6710be497edf) | [MIT](https://github.com/electron/fiddle/blob/9c1d4367c87a64835ac0d363e46e6710be497edf/LICENSE.md) | 每窗口 IPC、状态合并、AbortController、错误去重播报 | 生命周期绑定、重要状态通知与去重；阶段播报是本项目的选择，不冒称上游同样实现 |
| [electron/fuses](https://github.com/electron/fuses/tree/b467db1fa173af855818ed4a2e34fbb86997674f) | [MIT](https://github.com/electron/fuses/blob/b467db1fa173af855818ed4a2e34fbb86997674f/LICENSE) | 构建期功能开关、版本化配置与写入前校验 | 暂缓启用：当前 `asar:false`、原生脚本真实路径和内置 Node 测试必须先迁移 |

### 具体源码依据

- scrcpy：[file_pusher.c](https://github.com/Genymobile/scrcpy/blob/c939183a7cdca4599cee337e60bc0e147b6c9828/app/src/file_pusher.c)、[server.c](https://github.com/Genymobile/scrcpy/blob/c939183a7cdca4599cee337e60bc0e147b6c9828/app/src/server.c)、[virtual-display.md](https://github.com/Genymobile/scrcpy/blob/c939183a7cdca4599cee337e60bc0e147b6c9828/doc/virtual-display.md)。
- Waydroid：[app_manager.py](https://github.com/waydroid/waydroid/blob/a1a1936a7ed74e1537deeb3420302997869d8a4d/tools/actions/app_manager.py)、[session_manager.py](https://github.com/waydroid/waydroid/blob/a1a1936a7ed74e1537deeb3420302997869d8a4d/tools/actions/session_manager.py)。
- WSA PacMan：[apk_installer.dart](https://github.com/alesimula/wsa_pacman/blob/d516117efdc6be98f97d599d4be89d10803a420c/lib/apk_installer.dart)。
- Electron Fiddle：[ipc.ts](https://github.com/electron/fiddle/blob/9c1d4367c87a64835ac0d363e46e6710be497edf/packages/app/src/main/ipc.ts)、[state-hub.ts](https://github.com/electron/fiddle/blob/9c1d4367c87a64835ac0d363e46e6710be497edf/packages/app/src/main/state-hub.ts)、[RunStatus.tsx](https://github.com/electron/fiddle/blob/9c1d4367c87a64835ac0d363e46e6710be497edf/packages/app/src/renderer/features/run/RunStatus.tsx)。
- PowerShell：[Start-Process 官方参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1)。固定 `-FilePath` 表达式读取路径数据，不凭空替换成不存在的同名参数。

### 对比与路线

| 维度 | ApkStart 现状 | 参考方向 | 决策 |
| --- | --- | --- | --- |
| 功能 | 安装、独立窗口、系统部署、备份同步已具备 | scrcpy 虚拟显示；WSA PacMan 预览 | 先修可靠性，后续扩展安装预检，不重写模拟器 |
| UI/UX | 有主题与键盘操作，存在隐式双击副作用 | WSA PacMan 显式快捷方式；Fiddle 状态反馈 | 本轮修复显式操作和状态播报 |
| 性能 | 系统快照有隐藏轮询，目录 TTL 未生效 | Fiddle 生命周期 / 合并；scrcpy 惰性工作 | 本轮减少可证实的冗余调用，不宣传未经测量的速度 |
| 架构 | 主进程负责路径、IPC、运行实例与持久化 | Waydroid 职责分层 | 局部保持模块边界，后续渐进拆分主进程 |
| 安全 | 已有角色 IPC、签名更新清单、路径保护 | Fuses 构建时约束 | 本轮先修可复现命令注入；打包迁移后再配置 fuses |
| 扩展性 | 多系统 provider 与能力区分 | Waydroid 会话管理；scrcpy 显示生命周期 | 多系统应用路由需完整产品和回归设计，暂不直接放开 |

## 7. 测试结果

### 当前已验证

- Windows 完整 `npm test`：通过，包含新 VC++ 安全回归；曾被加强后的两个测试失败拦住，修正跨 VM 断言及录制环境后重跑通过，没有删除断言或跳过失败项。
- 目录回归：17/17，通过；其中真实缓存路径文件冲突、失败清理、并发刷新及时间边界已纳入永久测试。
- Windows VC++ 回归：2/2，通过；其他平台保留生产接线测试，仅真实 PowerShell 语义显式跳过。
- `npm run readme:check`、发布说明一致性、`git diff --check`：通过。
- 官方 npm registry 依赖审计：最终复查退出码 0，报告零已知漏洞；镜像 registry 的审计接口不支持，已换官方接口验证。依赖审计不等于源码或供应链的完整安全证明。
- 独立只读复核：目录与 VC++ 增量未发现阻断项；复核者重新运行 17 项目录和 2 项 VC++ 用例，并验证实际 `system:catalogRefresh` IPC 调用 `load({ force: true })`，不是仅在测试中能强制刷新。未验证真实安装器或 UAC。

### 最终制品验收

最终冻结源码的 Windows / Linux UI、构建、打包持久化、制品大小及 SHA-256 结果在正式构建完成后补充；此前 0.9.3 基线构建只能证明构建链可用，不能作为 0.9.4 制品。

### 未执行 / 不可冒称通过

- 未启动产品主进程，未通过 ADB 操作或接管真实 Android 实例，不执行真实安装、备份恢复或运行时停机。Windows 全量测试中，旧引擎套件只读探测到宿主模拟器端口占用，已跳过可能接管实例的 `ensure` 用例；Linux 验收使用隔离网络命名空间，避免接触宿主实例。
- 可选真实 APK 文件未提供，因此旧套件的外部 APK 夹具组跳过；合成二进制 AXML / ZIP / APK 解析回归仍执行，不能把两者混称为真机安装测试。
- 未验证物理 Windows / Linux Android 硬件加速、所有 GPU / DPI、真实更新回滚、真实 UAC 安装和真人读屏器。
- WSL 原生 Linux Electron 与 Linux 能力夹具要分别标明，不能把 Windows 上的 Linux 能力配置称为原生 Linux 测试。
- 没有项目发布者 Authenticode 证书；更新清单的 Ed25519 签名不等于 Windows 可执行文件签名。

### 产物暴露面复核

#### 一、总览

对自有 Windows 便携目录执行只读 `exposure_scan.py --profile electron`，并与升级前基线比较。首次 0.9.4 候选扫描为 115 个文件、6 个已检查原生二进制、70 个 web 文件，启发式 69/C；这个相对排序不是安全认证。主程序约 250 MB，超过扫描器限制而跳过，Android 检查也未执行，不能声称已完整审计可执行文件。

#### 二、发现清单

| 扫描编号 | 机器分级 | 人工判断 / 证据 |
| --- | --- | --- |
| PE-PDB | 高 | 第三方 DLL 的 RSDS 只含 `dxcompiler.dll.pdb`、`ffmpeg.dll.pdb` 等基名，不是项目私有源码目录或用户名泄漏 |
| PE-SIGN | 高 | 已扫 DLL 缺少 Authenticode 证书目录；项目也没有发布者证书，不虚构签名 |
| WEB-UNMINIFIED | 中 | 发布的 MIT JavaScript 有意可读，不把开源本身当漏洞，不为评分盲目混淆 |
| PE-CFG | 低 | `resources/app/build/vendor/opengl32sw.dll` 未置 CFG 标志；这是第三方软件渲染库，不通过手工改标志假装修复 |
| IO-BIG | 提示 | 主 `ApkStart.exe` 超过扫描器体积限制，明确记录覆盖缺口 |

#### 三、逐项证据与修复

- PDB 项的样本是基名，并未证明私有构建路径泄漏；不移除上游二进制的正常调试标识来制造通过。
- 发布者身份需要实际证书和签名流程；现有 Ed25519 更新清单只能提供该更新通道的签名验证，不替代 Windows 文件签名。
- Electron `asar:false` 是现有真实路径脚本的打包约束。后续要迁移 `asarUnpack`、验证双打包链，再配置兼容 fuses；当前不能直接开启 `OnlyLoadAppFromAsar`。关闭 `RunAsNode` 前也必须替换依赖内置 Node 的打包持久化测试，不能删掉门禁。
- 第三方软件渲染库的防护标志应通过可信上游升级或可复现重建处理，并覆盖兼容性；本轮未改写它。

#### 四、客户端无法解决的问题

MIT 源码和客户端算法本来公开，不是需要保护的秘密。长期服务端私钥、付费授权最终判断、服务端权限不能靠 JS 混淆或客户端加密获得安全性；如果未来引入此类能力，应把权威判断放服务端。发行私钥不得进入客户端，客户端保留验证公钥即可。本轮没有声称扫描器能证明不存在任何秘密泄漏。

#### 五、修复顺序

先修可复现的命令 / 路径边界，再完善发行身份和打包完整性，最后按真实收益安排第三方库升级；不以混淆、手改 PE 标志或跳过大文件扫描充当修复。本轮扫描编号没有新增结论，但既有签名与覆盖限制仍保留。

## 8. Git 操作结果

- 默认主分支：经远程核验为 `main`。
- 原工作区及其他会话工作树：保持不动，不 reset、不 clean、不覆盖已有未提交工作。
- 本轮提交、主分支推送及远程 CI：以完成后的精确 SHA 和核验记录为准；未推送之前不记作完成。
- `0.9.3` 的提交与发行归另一会话所有，不把其 Windows 短路径夹具修复或数据保护实现计为本轮新成果。

## 9. 版本发布结果

- 准备版本：`0.9.4`。
- 预期制品：Windows NSIS、Windows 便携 ZIP、Linux AppImage、Linux deb，以及既有流水线生成并验证的校验和 / 签名更新清单。
- Tag / Release：尚未创建；不会用推 Tag 或手动触发发布流水线绕过精确提交确认。
- 正式发布前必须核验仓库、版本、精确目标 SHA、标题、正式 / 预发布状态、说明和全部制品。版本文件与 CHANGELOG 标题本身不代表已公开发布。

## 10. 下一轮自主升级计划

| 优先级 | 问题 / 机会 | 完成条件 |
| --- | --- | --- |
| P1 | 项目发行身份与打包完整性仍可加强 | 获得合适签名条件；先验证双打包链、原生脚本、RunAsNode 测试迁移，再启用兼容 fuses |
| P1 | 多系统任务及应用目标必须继续保持强归属 | 设计明确的运行目标选择、离线目标提示及路由回归，不绕过现有安全拒绝 |
| P2 | 安装预检与差异说明 | 展示已有 / 待装版本、权限及 ABI，保留用户确认和失败原因，补真实包夹具 |
| P2 | 系统快照推送和前端订阅生命周期 | 以调用次数和可见状态为验收指标，处理迟到快照，不把定时器暂停假装成请求取消 |
| P2 | Linux 端真实设备矩阵 | 授权独立测试环境后覆盖 KVM、图形驱动、AppImage / deb 安装与升级，不占用真实用户实例 |
| P3 | 继续拆分庞大主进程 | 每次迁移一个职责，保留 IPC 权限、回滚和端到端夹具；不为拆分而重写 |

本轮没有发现或宣称能靠混淆解决客户端秘密问题。MIT 源码可读是产品的公开属性，不是漏洞；客户端不得持有长期服务端私钥。发行签名密钥应保留在受控发布环境，客户端只需验证公钥。
