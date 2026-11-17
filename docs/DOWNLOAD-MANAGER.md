# 系统下载管理器

多系统的下载/校验/安装/启动由 `src/core/system-task-manager.js` 统一管理，进度接入 ApkStart 现有的运行状态区域。

## 复用已有下载器（不重复造轮子）

底层复用 `src/core/download.js`，它已经具备：

- `downloadMulti(urls, dest, opt)`：多源测速、带宽叠加、块级断点续传、低速换源；
- SHA-256 校验（`sha256File` / `expectSha256`）；
- 进度回调 `{ got, total, percent, speed, eta }`（400ms 节流）；
- `AbortSignal` 取消、`proxy.js` 代理支持、重定向与网络错误处理。

任务管理器在其之上加了：统一任务对象、状态机、暂停/继续/取消/重试、磁盘空间预检、
任务持久化与异常恢复、同一系统去重锁。

## 任务对象字段

```
taskId · systemId · systemVersion · status · progress
downloadedBytes · totalBytes · speed · eta · currentStep
startedAt · updatedAt · error · retryCount · steps[]
```

状态：`waiting → preparing → downloading → verifying → installing → initializing → starting → completed`；
旁路状态：`failed` / `paused` / `cancelled`。

任务类型：`system-catalog` / `system-download` / `system-verify` / `system-extract` /
`system-install` / `system-initialize` / `system-start` / `system-stop` /
`system-update` / `system-backup` / `system-restore`。

## 下载前检查

1. 系统是否已安装（读 manifest）；
2. 本地是否已有完整 ISO（文件大小 + manifest 标记）；
3. 镜像版本是否与目录一致；
4. 是否有未完成任务（去重锁，同一系统不允许并发）；
5. 磁盘剩余空间（`doctor.freeDiskMB` + 需求预估 + 1GB 缓冲）；
6. 下载地址是否有效（必须 HTTPS，来源合法）；
7. 架构是否兼容（x86_64）；
8. 下载源身份（官方/授权镜像）；
9. 是否已有对应虚拟设备（qcow2 存在则复用）。

## 断点 / 暂停 / 取消 / 重试

- **暂停**：`AbortSignal.abort()` 中止当前连接，块级断点写在 `<iso>.chunks.json`；
- **继续**：以同一目标再次调用 `downloadMulti`，自动补齐未完成块；
- **取消**：中止 + 标记 `cancelled`，**不删除已安装系统**；
- **校验失败**：删除损坏文件（避免毒丸断点），下次重新下载；
- **重试**：失败/暂停任务可重试，有次数上限（默认 3）。

## 任务持久化与异常恢复

任务状态写在 `%APPDATA%\apkstart\runtime\systems\_tasks.json`（tmp + rename 原子写）。
阶段状态变化即落盘，高频进度不落盘。下次启动：

- 已完成/失败/取消的任务保留原状态；
- 未终结任务恢复为 `paused`（可续传），并占用该系统活跃锁，避免重复下载；
- 检查 ISO 完整性、虚拟磁盘、manifest，发现损坏提示修复。

## 进度事件

主进程通过 `system:task` 事件推送任务 JSON 到渲染层（preload 白名单），
UI 在「设置 → 运行状态 → 系统任务」实时显示：系统名称、版本、当前操作、下载进度、
速度、已下载/总大小、剩余时间、任务阶段、状态，以及暂停/继续/取消/重试/日志/打开目录按钮。

日志通过 `system:log` 事件推送，显示在系统详情面板。
