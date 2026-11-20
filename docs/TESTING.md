# 测试说明

本项目不依赖任何第三方测试框架：每个套件都是「一个可直接 `node` 跑起来的文件」，
使用内置 `node:test` 或极简断言，失败即非零退出码。这样 CI 与本地行为一致，也不需要为测试引入依赖。

## 全部套件

| 命令 | 文件 | 覆盖内容 | 需要什么 |
|------|------|----------|----------|
| `npm test` | — | 依次运行 `package.json` 中声明的全部 Node 套件 | Node ≥ 20 |
| `node --test test/store-integrity-test.js` | 持久化保护 | 类型边界、默认值隔离、损坏文件备份、权限与磁盘故障、原子保存 | 独立临时数据目录 |
| `node test/run-tests.js` | 解析与存储 | ZIP / AXML / ARSC / APK 解析、ICO、设置白名单、CHANGELOG 一致性 | 无 |
| `node test/engine-test.js` | 引擎链路 | QEMU 参数、AVD 配置、启动就绪判定、快照指纹、日志滚动、镜像校验 | 无 |
| `node test/auto-test.js` | 下载与安装 | 分块下载、换源、熔断、xapk 拆分、安装失败原因中文化、sharer 关键行为 | 无 |
| `node test/sync-test.js` | 共享目录同步 | 双向同步、内容变更（大小不变）、冲突副本、删除保护、中文名、stat 兜底 | 无 |
| `node test/updater-test.js` | 更新器 | 恶意 ZIP（穿越/兄弟目录/符号链接）、CRC 损坏、载荷校验、回滚脚本 | 无 |
| `node test/security-test.js` | IPC 边界 | 路径归属、页面来源、iframe 冒充、事件已销毁 | 无 |
| `node test/compat-test.js` | 兼容性判定 | minSdk / targetSdk / ABI / GMS / 硬件 / 拆分 APK | 无 |
| `node test/backup-test.js` | 备份恢复 | 命名清洗、meta、数据能否导出、恢复命令构造 | 无 |

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
  备份保留原始内容，不自动删除。应用清单结构异常也遵循此规则；恢复前应先停止应用并检查副本。
- 设置只接受已声明的自有键与相同类型；无效分区/叶值忽略，合法的同级设置继续生效。
  旧键的兼容迁移、BOM、资源策略以及 `{ apps: [...] }` 文件格式保持不变。
- 每次保存独占创建随机同目录暂存文件，以用户可读写权限写入，刷新并关闭句柄后再替换目标。
  写入、刷新、关闭或替换失败时保留旧目标并尝试清理本次暂存文件；不复用或删除已有 `.tmp` 文件。
- 这是单实例应用的原子文件替换，不提供跨进程事务、并发编辑合并或跨文件事务。
  文件刷新不等于所有文件系统和突然断电情况下的绝对持久性保证。

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
