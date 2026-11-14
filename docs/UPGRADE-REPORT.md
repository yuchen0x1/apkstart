# ApkStart 升级交付报告

> 版本基线：0.4.0（已发版 v0.4.0）· 报告时间：2026-11-14 · 定版发版：2026-11-15
> 环境：Windows 10.0.26300 x64 · Node 22.22.2 · Electron 45.3.2（Chromium 156 / Node 24.22.2）
> 所有结论均来自本机真实执行，未验证项在 E 节单独列出，不含推测。

---

## A. 原项目问题（审计结论）

按严重程度排序。全部来自读代码与真实运行，不含「看起来可能有问题」的猜测。

| # | 严重度 | 问题 | 位置 |
|---|--------|------|------|
| A1 | 严重 | 共享目录同步把「历史上从 Windows 推上去过」当成文件永久一致的证据。Android 侧后续修改（大小不变）**永远不会同步回来**，用户看到的是「安卓里改了，电脑上还是旧的」 | `src/core/sharer.js`（旧版 `prev.dir === 'up'` 分支） |
| A2 | 严重 | 同步冲突时直接覆盖，没有冲突副本，也不区分「谁改的」 | 同上 |
| A3 | 严重 | 更新器 ZIP 解压用 `startsWith` 判断目录归属，`C:\app-evil` 也以 `C:\app` 开头 → 可写到安装目录之外；未拒绝符号链接条目 | `src/core/updater.js` `_extract` |
| A4 | 高 | 更新包解压后不校验内容完整性（无 CRC 校验），下载损坏的包会被直接覆盖到安装目录，程序下次起不来 | `src/core/zip.js` + `updater.js` |
| A5 | 高 | 更新替换没有备份与回滚：拷贝到一半失败（杀软占用、磁盘满）会留下半新半旧的安装目录 | `updater.js` `apply` |
| A6 | 高 | Electron 33 已于 2025-04 结束安全支持，仍在使用；`sandbox: false` | `package.json` / `src/main.js` |
| A7 | 高 | 90+ 个 IPC 通道没有任何来源校验，渲染层被注入脚本即可读任意文件、装任意 APK | `src/main.js` |
| A8 | 中 | 共享目录远端列表只认一种 `stat` 输出格式，换 ROM 就解析失败 → 设备被当成空目录，两端再也同步不了 | `sharer.js` |
| A9 | 中 | 刚放进共享目录的新文件要空转一轮才同步（稳定性判据只按 mtime 粗筛） | `sharer.js` 扫描逻辑 |
| A10 | 中 | 项目元数据混着上游地址：下载器 User-Agent、CHANGELOG 对比链接、状态栏链接指向 `RoutineMiku/apkstart`，与「独立维护分支」的自述不一致 | 多处 |
| A11 | 低 | Electron 45 起 `console-message` 改为单参数事件对象，旧写法会在控制台持续告警 | `src/main.js` |

---

## B. 已完成修复

逐项对应 A 节。

### B1 共享目录双向同步重写（对应 A1、A2、A8、A9）

- **文件**：`src/core/sharer.js`（+685 −173）、`src/core/adb.js`（复用既有 `shellQuote`）
- **做法**：为每个文件维护三份 SHA-256 —— `baseHash`（上次达成一致的祖先）/ `localHash` /
  `remoteHash`，按三方合并判定：
  - 只有一侧变 → 把变的一侧传过去；
  - 两侧都变但哈希相同 → 记为已同步，不传输；
  - 两侧都变且不同 → **冲突**：本机版本保留，Android 版本落成
    `xxx (Android 冲突 2026-11-15 031500).ext`，两侧都不删；
  - 一侧删除、另一侧改过 → 不删任何东西，把被删的一侧恢复回来；
  - 一侧删除、另一侧没变 → 默认只提示；开启删除同步后移进 `.apkstart-trash/<时间戳>/`。
- 写入改「临时名 + `mv` 原子替换」；推送后对小文件回读哈希校验（防 adb 静默截断）。
- 远端列表同时兼容 `mtime|ctime|size|name` 与 `size|mtime|name` 两种 `stat` 输出。
- 新文件的稳定性判据改为「已同步过 + 毫秒内又被改写」才跳过，新文件第一轮就同步。
- **测试**：`test/sync-test.js` 26 个用例，含真机语义的假 adb（`test/lib/fake-adb.js`）。

### B2 更新器与 ZIP 安全加固（对应 A3、A4、A5）

- **文件**：`src/core/zip.js`、`src/core/updater.js`
- 新增 `safeEntryPath()`：拒绝 `../` 穿越、绝对路径、盘符、UNC、符号链接条目，用
  `path.resolve` + `path.relative` 做真实边界判断。
- `pipeTo` 流式解压加 CRC32 与声明大小校验（`opts.verify`）。
- 下载后核对大小 → 计算 SHA-256 → 落 `.sha256` 邻接文件 → 解压 → 校验载荷
  （必须有主程序与 `resources`，套了一层目录会自动摊平）。
- 替换前把将被覆盖的文件备份到 `updates/backup-<version>`；拷贝 12 次重试仍失败则回滚并 `exit 1`。
- **测试**：`test/updater-test.js` 16 个用例，用真实字节流构造恶意 ZIP（穿越、兄弟目录、
  符号链接、CRC 损坏），不是「假装失败」的桩。

### B3 Electron 升级与安全加固（对应 A6、A7、A11）

- **版本**：33.4.11 → **45.3.2**（当前受支持的是 43/44/45，45 是其中最新稳定版）。
- **沙箱**：主窗口与 `appwin.js` 的应用窗口都改为 `sandbox: true`；preload 只依赖
  `contextBridge` / `ipcRenderer` / `webUtils`，沙箱下 81 个接口全部可用（真实渲染进程验证）。
- **IPC 来源校验**：新增 `src/core/ipcguard.js`，在注册前把 `ipcMain.handle` 统一包一层，
  只接受「主框架 + 页面在 `src/` 内」的调用；`checkEvent` 拒绝 iframe、页面被导航到外部站点、
  `../` 逃逸、同级 `xxx-evil` 目录。11 个用例覆盖。
- `console-message` 改用新的事件对象；`app:confirm` 新增 `danger` 选项（危险操作默认焦点在「取消」）。
- **原生模块**：`@napi-rs/lzma`（N-API，ABI 稳定）在 Electron 45 下加载正常（实测 `NATIVE_OK`）。

### B4 元数据与工程规范（对应 A10）

- `package.json`：`homepage` / `repository` / `bugs` 指向 `yuchen0x1/apkstart`，
  `author` 改为当前维护者，新增 `contributors` 保留原作者署名；MIT 许可证与 LICENSE 未改动。
- 下载器 User-Agent、CHANGELOG 对比与版本链接、状态栏链接、`app.js` 的 CHANGELOG 跳转
  统一到本仓库；关于页保留「原项目 RoutineMiku/apkstart」署名。
- 安装包版权信息改为 `Copyright © 2026 ApkStart contributors · 原项目 © RoutineMiku (MIT)`。
- 历史推广稿（`docs/promo/`）保持原样 —— 那是原作者的历史材料，改掉反而造成署名错误。

---

## C. 已完成的新功能

### C1 安装前兼容性检查（`src/core/compat.js` + UI）

- 解析 `AndroidManifest.xml` 新增字段：`permissions`、`features`、`usesLibraries`、
  `isSplit` / `splitName`、`debuggable`。
- 判定四档：**完全兼容 / 基本兼容 / 可能有问题 / 暂不支持**，每条结论都带具体理由：
  - `minSdk` 超过运行时 → 暂不支持；
  - `targetSdk < 23` → 提示 Android 14 的安装限制（程序会带
    `--bypass-low-target-sdk-block` 绕过）；
  - ABI：`x86_64` 直接可跑；只有 ARM 库且有转译层 → 基本兼容并说明闪退风险；
    只有 ARM 库且无转译层 → 暂不支持；只有 32 位 x86 → 可能有问题；
  - 依赖 `com.google.android.gms` 且运行时未内置 → 基本兼容（登录/支付不可用）；
  - 必需硬件（摄像头/GPS/蓝牙/NFC/传感器…）→ 基本兼容并列出具体缺哪个；
  - 拆分 APK 分片 → 可能有问题（提示装完整包）。
- 界面：安装前调用；判定为「可能有问题 / 暂不支持」时弹确认框（默认焦点在「取消」），
  用户取消则整体跳过并给出「已跳过 N 个安装」的回执；「基本兼容」用琥珀色提示条说明风险。
- **测试**：`test/compat-test.js` 19 个用例，全部用真实合成 APK（真实 AXML 清单）驱动。

### C2 导出与备份（`src/core/backup.js` + 右键菜单）

- **导出 APK**：把安装时留存的 `app.apk` 复制到用户选定位置。
- **备份应用**：生成 `<应用名>-<版本>-<时间戳>/`，含 `app.apk`、`meta.json`，
  应用可 `run-as` 时额外导出 `data.tar`；否则写 `data-skip.txt` 说明原因。
  空 tar（只有 1024 字节结束块）视为失败，不冒充成功。
- **从备份恢复**：重装 APK；若备份含 `data.tar` 且目标应用仍可 `run-as`，
  则 `push` 到 `/data/local/tmp` → `cat … | run-as <pkg> tar -xf -` 解包 → 清理临时文件。
- **测试**：`test/backup-test.js` 11 个用例（命名清洗、meta 完整性、两条数据分支、恢复命令构造）。

### C3 自检与验收工具

- `APKSTART_SELFTEST=1`：启动后自动体检主窗口（preload 注入、`app:info` / `settings:get`
  真实 IPC、页面渲染、脚本错误），输出 `SELFTEST_JSON` 并退出；打包版无控制台时同时落
  `%TEMP%\apkstart-selftest.json`。
- `npm run test:electron`（`test/electron-smoke.js`）：真实 Chromium 里验证沙箱、
  接口数量、`webUtils` 可用性、`require`/`process` 不可见、首屏渲染、无脚本错误。
- `npm run test:app`：用真实主进程跑 C3 的自检。

---

## D. 依赖与架构升级

| 项 | 变化 | 影响 |
|----|------|------|
| Electron | `^33.4.11` → `^45.3.2` | Chromium 130 → 156、Node 20 → 24；`console-message` 签名变化已适配 |
| 渲染进程安全 | `sandbox: false` → `true` | preload 仍可用（只依赖 electron 内置模块）；已实测 81 个接口 |
| IPC | 无校验 → 统一来源校验 | 90+ 通道零改动接入，新增 `ipcguard.js` |
| 新模块 | `compat.js`、`backup.js`、`ipcguard.js` | 均为纯逻辑模块，不引入新依赖 |
| 测试 | 3 套 → 8 套（新增 sync/updater/security/compat/backup + Electron 冒烟） | `npm test` 210 用例，约 6 秒 |
| 依赖 | 未新增运行时依赖 | `@napi-rs/lzma` 版本不变，Electron 45 下正常 |

**架构影响**：主进程新增「IPC 边界」层（注册前包装，不改各 handler 签名）；
渲染层新增「安装前检查」环节（在 `installFiles` 之前，不改变原安装流水线）；
共享目录同步从「状态机式方向判断」改为「三份哈希的三方合并」，状态文件结构向后兼容
（旧的 `dir/size/lmtime` 记录会被迁移成 `localHash`/`baseHash`，有专门用例）。

---

## E. 测试报告

### E1 已通过（本机真实执行）

| 套件 | 命令 | 结果 |
|------|------|------|
| 解析与存储 | `node test/run-tests.js` | 14 通过 / 0 失败 |
| 引擎链路（QEMU 参数、快照、日志滚动、xapk…） | `node test/engine-test.js` | 32 通过 / 0 失败 |
| 下载器与安装可读性 | `node test/auto-test.js` | 81 通过 / 0 失败 |
| 共享目录同步 | `node test/sync-test.js` | 26 通过 / 0 失败 |
| 更新器与恶意 ZIP | `node test/updater-test.js` | 16 通过 / 0 失败 |
| IPC 来源校验 | `node test/security-test.js` | 11 通过 / 0 失败 |
| 兼容性判定 | `node test/compat-test.js` | 19 通过 / 0 失败 |
| 备份与恢复 | `node test/backup-test.js` | 11 通过 / 0 失败 |
| **合计** | `npm test` | **210 通过 / 0 失败** |

其中带 ★ 的用例是为本次修复专门写的回归（例如「Windows 上传过的文件在 Android 改（大小不变）
必须同步回来」「前缀相同的兄弟目录不能绕过路径校验」「恶意 ZIP 符号链接条目被拒绝」
「两侧同时修改必须保留两份」）。

### E2 Electron 真实运行验证

```
npm run test:electron  → Electron 45.3.2 · Chromium 156.0.8078.100 · Node 24.22.2
  ✓ preload 在 sandbox 下执行成功
  ✓ window.apkstart 已注入（81 个方法）
  ✓ 拖拽取路径接口可用（webUtils 在沙箱里仍可用）
  ✓ 渲染层拿不到 Node / process
  ✓ 页面已渲染出内容、无未捕获脚本错误
  9 通过 / 0 失败
```

```
APKSTART_SELFTEST=1 <packaged ApkStart.exe>  →  packaged:true
  ✓ preload 注入   ✓ IPC app:info 可用   ✓ IPC settings:get 可用
  ✓ 页面已渲染      ✓ 无未处理脚本错误   ok: true
```

### E3 未验证 / 受环境限制（如实标注）

| 项 | 状态 | 原因 |
|----|------|------|
| 真实 Android 设备上的**数据备份/恢复**（`run-as tar` 两条链路） | **未在真机验证** | 本机运行时存在，但验证需先确认目标应用 debuggable、并写入其私有目录；只做了命令构造层面的测试 |
| ARM 转译层实际运行 ARM-only 应用 | **本次未重新验证** | 项目 README 记录维护者已在真机验证（红果免费短剧可播放）；本次升级没有改动该链路，但也没有重跑 |
| 自动更新「下载 → 解压 → 替换 → 重启」全链路 | **未验证** | 需要一个真实的新版本 Release；本次只验证了解压/校验/回滚脚本生成与恶意包拒绝 |
| NSIS 安装 / 卸载 / 覆盖安装 | **未验证** | 本机只完成构建，未执行安装（避免污染当前环境） |
| 多显示器、不同 DPI（125%/150%/200%）、非管理员账户、中文用户名/安装路径 | **未验证** | 单机单环境；同步测试覆盖了中文与特殊字符**文件名** |
| Windows 10（非 11）、AMD/Intel 不同 GPU | **未验证** | 本机环境为 Windows 10.0.26300 + 单显卡 |
| 长时间运行（数小时）内存/句柄增长 | **未验证** | 需要专门的浸泡测试 |
| `npm run test:boot`（真实 QEMU 引导） | **未执行** | 需下载 61MB Alpine 镜像；本次改动不涉及引导参数 |

---

## F. 发布准备情况

| 项 | 结论 | 说明 |
|----|------|------|
| 能否成功构建 | ✅ 能 | `npx electron-builder --win nsis` 与 `--win portable` 均成功，产物：`dist/release/ApkStart-0.4.0-Setup.exe`、`dist/release/ApkStart 0.4.0.exe`（0.3.9 阶段实测 115 MB / 109 MB）；v0.4.0 的正式安装包由 tag 触发的 Actions 构建 |
| 打包产物能否运行 | ✅ 能 | `win-unpacked/ApkStart.exe` 以 `packaged:true` 启动，自检全绿（preload/IPC/渲染） |
| 安装 / 卸载 | ⚠️ 未执行 | 构建通过但未在本机安装；`installer.nsh` 未改动 |
| Portable | ✅ 已产出 | 与安装版同源构建，未做首次运行实测 |
| 自动更新 | ⚠️ 未端到端验证 | 更新源已指向本仓库；`latest.yml` 与 `.blockmap` 已生成；解压/校验/回滚逻辑有 16 个用例 |
| 完整运行时装包 | ⚠️ 本次未组装 | 打包时 `build/runtime` 只有占位文件。真实发布需先跑 `npm run runtime`（会下载 emulator + platform-tools + API 34 镜像，数 GB），再打包 |
| 代码签名 | ❌ 无证书 | 安装包未签名（构建日志已明确 `signing is skipped`），首次运行可能触发 SmartScreen 提示 |
| 阻止发布的硬问题 | 无 | 上述「未验证」项属于环境限制，不是已知缺陷 |

**结论**：代码层面可发布；正式发版前建议先在真机跑一遍「安装 → 首次引导 → 装一个 APK →
启动 → 共享目录双向改文件」的冒烟，并组装完整运行时。

---

## G. 后续优化建议（按优先级）

1. **发布方签名**：给更新包加 Ed25519/minisign 签名并用内置公钥验签。当前 SHA-256 只能证明
   「下载内容一致」，证明不了「出自维护者」——这是更新链路最后一块短板。
2. **备份的真机验收**：在真实运行时上跑通 debuggable 应用的数据备份/恢复，并把结果补进
   `test/backup-test.js` 的注释（标明已验证设备与 Android 版本）。
3. **浸泡测试**：连续运行 4~8 小时 + 反复开关应用，采样 `process.memoryUsage()` 与句柄数，
   把「资源持续增长」变成可断言的指标。
4. **UI 分页化**：当前是「单页应用网格 + 设置弹层」。若要落地仪表盘/兼容性中心/备份中心等
   独立页面，建议在现有 IPC 之上做视图层重构（数据接口已经齐了），而不是新造一套状态。
5. **多运行时**：现有 `engine.js` 已按「单 AVD + 单镜像」设计，做多环境需要先把
   AVD 名、数据目录、快照目录参数化。建议在真正有第二份可用镜像时再动，否则只是界面假功能。
6. **同步性能**：目前每轮都对远端变化文件重算哈希（已按 `key` 缓存）。文件数上千时
   建议改成「先按 key 批量筛，再分批算哈希」，并用统计信息展示本轮耗时。
