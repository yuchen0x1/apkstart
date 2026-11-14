# 测试说明

本项目不依赖任何第三方测试框架：每个套件都是「一个可直接 `node` 跑起来的文件」，
自带极简断言，失败即非零退出码。这样 CI 与本地行为一致，也不需要为测试引入依赖。

## 全部套件

| 命令 | 文件 | 覆盖内容 | 需要什么 |
|------|------|----------|----------|
| `npm test` | — | 依次跑下面 8 个套件 | Node ≥ 20 |
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
