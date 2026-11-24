# Pluggable Backend 接口化技术方案（P2 · 技术方案，本轮不实施）

> 结论先行：本轮**只形成方案，不做重构**。理由：v0.11.0 已在 emulator/doctor/updater/window/agent 的
> 进程安全与窗口安全面做了大量改动，接口化会放大回归风险；且上游 `feat/pluggable-backend`
> 分支（tip `53946f1`）只是 v0.4.x 时代的早期概念，其内容已全部包含在上游 main 中，没有可借鉴
> 的独立实现。本方案的每一个接口都映射到当前真实存在的模块，供后续版本按阶段落地。

## 1. 上游研究结论

- `RoutineMiku/apkstart` 的 `feat/pluggable-backend`（`53946f1`）是 `upstream/main`（`7e2c550`）的祖先提交，
  `git log upstream/main..upstream/feat/pluggable-backend` 为空——**分支上没有任何未合并的独立工作**。
- 上游 `src/core/` 只有 `adb.js`、`engine.js` 等少数模块，"可插拔后端"停留在目录命名层面。
- 因此接口设计必须以本项目 v0.10.9 之后的实际分层为准，不照搬上游。

## 2. 现状盘点（真实模块 → 职责）

| 现有模块 | 当前职责 | 接口归属 |
| --- | --- | --- |
| `emulator.js` + `provision.js` + `doctor.js` | 官方 Android Emulator 引擎：选档、降级重试、部署、加速探测 | RuntimeProvider + RuntimeLifecycle |
| `process-owner.js` / `win/*.ps1` / `agent.js` | 进程身份验证、终止、窗口代理 | RuntimeLifecycle（终止钩子） |
| `adb.js` + `instance-adb.js` + `guest.js` | 设备通道、端口对、serial、guest 探针 | RuntimeDevice |
| `installer.js` + `apk.js` + `apk-bundle.js` | APK/分片安装与解析 | RuntimeInstaller |
| `backup.js` + `userdata.js` + `file-migration.js` | 备份、恢复、数据迁移 | RuntimeBackup |
| `sources.js` + `download.js` + `proxy.js` | 双源下载、镜像排序、代理 | RuntimeNetwork |
| `display.js` + `lcd.js` + `gpu.js` + `windowctl.js` + `appwin.js` | 显示、分辨率、GPU 探测、窗口形态 | RuntimeDisplay |
| `doctor.js`(诊断段) + `repair.js` + `report.js` + `logfile.js` + `runtime-integrity.js` | 诊断、修复、报告、日志、完整性 | RuntimeDiagnostics |
| `system-catalog.js` + `system-manager.js` + `instances.js` + `instance-context.js` | 系统 Provider 目录、多实例 | （已是 Provider 雏形，接口化从它开始） |

## 3. 接口定义（草案，全部为"提取"而非"发明"）

每个接口只提取当前代码已经存在的行为，签名以 JSDoc 形式落到 `src/core/runtime-api.js`
（新增单一类型定义文件，不改变任何运行时逻辑）：

1. `RuntimeProvider`
   - `id` / `label` / `capabilities()`（来自 `platform-capabilities.js` 的探测结果形态）
   - `ensureProvisioned(settings)` ← `provision.js:ensure*`
   - `chooseProfile(opts)` ← `doctor.js:autoProfile`（入参已含 `gpuInfo`）
2. `RuntimeLifecycle`
   - `start(opts)` / `stop(opts)` ← `emulator.js:start/stop`
   - `planVariants()` ← 降级重试序列
   - `terminateVerified(identity)` ← `process-owner.js:terminateOwnedProcess`（**必须保持身份验证为终止的唯一路径**）
3. `RuntimeDevice`
   - `bootProbe(serial)` / `waitBoot()` ← `bench-runtime.js` 的 `probe`、`emulator.js` 的 `waitDevice`
   - `portPair(adbPort)` ← `doctor.js:freePortPair` + `instance-adb.js`
4. `RuntimeInstaller`
   - `install(serial, apkRef)` ← `installer.js`（含 `.xapk` 分片：`apk-bundle.js`）
5. `RuntimeBackup`
   - `backup(scope)` / `restore(scope)` ← `backup.js`、`userdata.js`
6. `RuntimeNetwork`
   - `candidates(asset)` / `download(asset, dest)` ← `sources.js`、`download.js`
   - 约束：官方签名清单 `digest` 不可被镜像元数据覆盖（v0.11.0 已落实）。
7. `RuntimeDisplay`
   - `gpuProbe()` ← `gpu.js:probe`（只读、10 分钟缓存、伪显卡/远程会话分类）
   - `presentWindow(identity)` ← `windowctl.js`（**必须携带进程身份凭据，fail closed**）
8. `RuntimeDiagnostics`
   - `diagnoseAttempt(log)` / `repair(kind)` ← `doctor.js`、`repair.js`
   - 约束：每轮诊断只使用本轮日志（v0.10.10 已落实的隔离语义）。

## 4. 分阶段迁移

- **阶段 1（低成本，可随任意版本）**：新增 `src/core/runtime-api.js` 纯 JSDoc 类型 + 单元测试校验
  `emulator.js` 导出面满足接口；不改任何行为。
- **阶段 2（中成本）**：把 `system-catalog.js` 的内置系统 Provider 改为实现 `RuntimeProvider` 的第一个
  适配器；`instances.js` 通过接口调用而非直接引用 `emulator.js` 内部字段。
- **阶段 3（高成本，仅在有第二个真实后端需求时）**：抽出第二个 Provider（如 Android-x86 直跑、
  远程 ADB 设备）后才真正解耦 `doctor.js` 与 `emulator.js` 的共享选档逻辑。

## 5. 风险与不做的事

- 不为了接口而接口：`terminateOwnedProcess` / `windowctl` 的身份验证语义、`sources` 的签名清单
  优先级是安全边界，接口化时必须原样保留并在测试中锁死。
- 不迁移 `win/*.ps1` 的实现细节到抽象层：平台脚本保持薄、可审计、纯 ASCII。
- 上游该分支无增量，未来若上游重启该方向，按上游 diff 重新评估后再合并（沿用 #117–#120 的
  "逐条评估、证据说话"流程）。
