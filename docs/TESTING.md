# 测试说明

本项目不依赖任何第三方测试框架：每个套件都是「一个可直接 `node` 跑起来的文件」，
使用内置 `node:test` 或极简断言，失败即非零退出码。这样 CI 与本地行为一致，也不需要为测试引入依赖。

## 全部套件

| 命令 | 文件 | 覆盖内容 | 需要什么 |
|------|------|----------|----------|
| `npm test` | — | 依次运行 `package.json` 中声明的全部 Node 套件 | Node ≥ 22.12 |
| `node --test test/store-integrity-test.js` | 持久化保护 | 类型边界、默认值隔离、设置读取缓存失效、损坏文件备份、权限与磁盘故障、原子保存 | 独立临时数据目录 |
| `npm run test:packaged` | 构建包关键源码与持久化 | 校验便携版/安装版展开目录的 store、目录、主进程与界面源码哈希及版本，再用各自内置 Node 执行隔离保存 | Windows，先运行 `npm run pack` 和 `npm run build:exe` |
| `node test/run-tests.js` | 解析与存储 | ZIP / AXML / ARSC / APK 解析、ICO、设置白名单、CHANGELOG 一致性 | 无 |
| `node test/engine-test.js` | 引擎链路 | QEMU 参数、AVD 配置、启动就绪判定、快照指纹、日志滚动、镜像校验 | 无 |
| `node test/auto-test.js` | 下载与安装 | 分块下载、换源、熔断、xapk 拆分、安装失败原因中文化、sharer 关键行为 | 无 |
| `node test/sync-test.js` | 共享目录同步 | 双向同步、内容变更（大小不变）、冲突副本、删除保护、中文名、stat 兜底 | 无 |
| `node test/updater-test.js` | 更新器 | 恶意 ZIP（穿越/兄弟目录/符号链接）、CRC 损坏、载荷校验、回滚脚本 | 无 |
| `node test/security-test.js` | IPC 边界 | 路径归属、页面来源、iframe 冒充、事件已销毁 | 无 |
| `node --test test/vc-redist-safety-test.js` | VC++ 修复启动 | 生产处理器接线、路径与 PowerShell 脚本分离、旧写法负对照 | 接线测试跨平台；真实 PowerShell 语义仅 Windows |
| `node test/compat-test.js` | 兼容性判定 | minSdk / targetSdk / ABI / GMS / 硬件 / 拆分 APK | 无 |
| `node test/backup-test.js` | 备份恢复 | 命名清洗、meta、数据能否导出、恢复命令构造 | 无 |
| `node test/system-catalog-test.js` | 系统目录 | 六小时过期边界、离线冷却、显式刷新、并发合并、缓存写盘失败回退、时钟回拨 | 独立临时目录与可控时钟，不访问网络 |

需要 Electron 的两项（用真实渲染进程，不是 jsdom）：

```powershell
npm run test:electron   # 沙箱 + preload 注入 + 首屏渲染 + 无脚本错误（9 项）
npm run test:app        # 真实主进程自检：IPC 通道是否真通（写出 SELFTEST_JSON）
```

需要真实设备/镜像的：

```powershell
npm run test:boot       # QEMU 引导（下载 61MB Alpine，不需要 Android 镜像）
npm run selftest        # 装好运行时后：安装 → 启动 → 截图 → 共享目录
```

## 设置和应用清单的数据保护

`store-integrity-test.js` 在加载 store 前将 `APPDATA` 与 `XDG_DATA_HOME` 指向专属临时目录，
不加载产品主进程、不连接模拟器、不读取真实用户配置。故障注入只作用于该测试进程内的 `fs` 方法。

- 不存在的文件正常使用默认值；权限或 I/O 错误向上传递，禁止以默认值覆盖读不到的原文件。
- JSON 语法或顶层结构损坏时，必须先成功改名为同目录的 `*.bak-<时间>-<随机值>`，再回退默认值。
  备份保留原始内容，不自动删除。应用清单顶层结构异常也遵循此规则；单条记录损坏时先复制完整原文，
  再原子保存健康记录，避免一条坏记录隐藏其它应用。备份或保存失败均报错；恢复前应先停止应用并检查副本。
- 设置只接受已声明的自有键与相同类型；无效分区/叶值忽略，合法的同级设置继续生效。
  旧键的兼容迁移、BOM、资源策略以及 `{ apps: [...] }` 文件格式保持不变。
- 每次保存独占创建随机同目录暂存文件，以用户可读写权限写入，刷新并关闭句柄后再替换目标。
  写入、刷新、关闭或替换失败时保留旧目标并尝试清理本次暂存文件；不复用或删除已有 `.tmp` 文件。
- 这是单实例应用的原子文件替换，不提供跨进程事务、并发编辑合并或跨文件事务。
  文件刷新不等于所有文件系统和突然断电情况下的绝对持久性保证。

## 系统目录的新鲜度与离线读取

`system-catalog-test.js` 注入可控时钟和远程读取函数，不真实等待六小时，也不连接外网：

- 最近成功的内存目录在六小时边界失效，`cacheInfo()` 同样按当前时间报告新鲜度。
- 远程失败后保留最后成功目录；没有可用缓存才回退内置索引，保留真实错误与过期标记。
- 失败后的一分钟内，普通读取复用离线结果；冷却到期后的下一次读取重试。显式刷新不受冷却限制。
- 同一时刻的普通读取与显式刷新共用一个在途请求；时钟回拨不会使未来时间戳永久保鲜或无限延长冷却。
- 磁盘缓存不可写时仍保留成功的内存目录，不会在随后离线时丢掉它。磁盘元数据和返回结果使用同一缓存时间。

这些用例验证请求次数、数据保留和时间边界，不是公网速度或真实运行时性能基准。

## 系统界面生命周期回归

`npm run test:ui` 使用真实 Electron / Chromium 和内存 IPC 夹具，不加载产品主进程、不操作真实 Android。新增回归覆盖：

- 真实指针的 click / click / dblclick 序列不创建快捷方式，显式菜单命令保留；Linux 能力夹具先关闭菜单，避免遮挡卡片命中点。
- 相关设置隐藏时不发周期快照，重新打开立即刷新；暂停轮询不等于取消在途读取。
- 在途旧快照期间取消任务，必须再读取操作后的状态，不把 `awaiting_confirmation` 残留当成已取消。
- 慢快照期间的自动轮询不得不断追加读取，让操作忙碌锁永远不释放；显式刷新仍排队执行。
- 阶段 / 新错误触发播报，百分比更新保持安静；中英文切换后无需新任务事件即可更新已有播报。

在 Windows 上指定 `UI_AUDIT_PLATFORM=linux` 只是能力夹具，不等于原生 Linux。原生 Linux 需要 Linux Node、Linux Electron 和可用显示服务单独执行。结果中的 screen probes 是渲染检查样本，不是不同页面数量；DOM 语义断言也不等于真人读屏器验收。

## VC++ 修复路径的命令与数据边界

`vc-redist-safety-test.js` 从生产源码提取受限范围内的构造器和处理器，单独验证真正传入 `spawn` 的命令、参数及环境变量。跨平台接线测试不创建子进程。

Windows 用例启动真实 PowerShell，但用本地录制函数替代 `Start-Process`；不启动安装器、不请求 UAC、不连接运行时。包含 `$()`、反引号、引号、空格和中文的路径作为数据传递：旧写法负对照只能在本次临时目录写入标记，新写法必须逐字保留路径、保留静默参数及 `RunAs`/等待语义，且不得产生注入标记。缺失录制文件会失败；非 Windows 或确实缺少 PowerShell 时仅该语义用例显式跳过。

这是用户可控本地路径进入修复操作时的命令注入回归，不是远程攻击或绕过管理员授权的演示。

## 测试夹具

- `test/lib/make-apk.js`：用真实字节拼出一个**合法的**二进制 AXML 清单 + 最小 ZIP。
  可传 `minSdk / targetSdk / abis / permissions / requiredFeatures / usesLibraries /
  split / debuggable`，因此兼容性规则与清单解析都有真实输入，而不是 mock。
- `test/lib/fake-adb.js`：在临时目录上模拟设备端 `find/stat/sha256sum/mv/ls`，
  让同步逻辑可以端到端跑（含「设备不支持 stat」「没有 sha256sum」这类降级路径）。
- `test/lib/zip-writer.js`：构造任意条目名的 ZIP，用于生成恶意包。

## 约定

- **不为了让测试通过而改断言**。如果实现行为确实变了，先问「新行为对用户是否更好」，
  再改用例，并在 CHANGELOG 里说明。
- 新增能力必须带用例；涉及安全边界的必须带「攻击视角」的用例（★ 标记）。
- 无法在本机验证的（真机、多 DPI、签名等）在 `docs/UPGRADE-REPORT.md` 的 E3 节登记，
  不要写成「已通过」。
