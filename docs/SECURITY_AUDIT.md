# 安全审查（跨平台架构升级批次）

> 日期 2026-11-23，基线 `0.10.7`。
> 本文只覆盖**本轮改动面**与跨平台扩展引入的新攻击面。
> 历史完整审查见根目录 `SECURITY_AUDIT.md`（2026-11-21，更新器与发布信任）。
> 这是防御性静态复核 + 隔离回归，不是渗透测试，也不是安全认证。

## 1. 本轮改动面

| 文件 | 性质 | 安全影响 |
| --- | --- | --- |
| `src/core/host/profile.js` | 新增，**纯函数零依赖** | 无 I/O、无子进程、无网络 → 无攻击面 |
| `src/core/host/index.js` | 新增，`HostAdapter` | 只读 `os.homedir()`；能力取自声明表，不引入新输入 |
| `src/core/provision.js` | 修改 | 只改变**选择哪份官方产物**与**默认镜像 ABI**，未新增下载源 |
| `src/core/platform-capabilities.js` | 修改 | 新增 `acquirable: true` 元数据字段，不参与门禁判断 |
| `src/core/platform.js` | 修改 | `describe()` 增加 `host` 事实块（惰性 require，异常兜底 null） |
| `tools/audit-metrics.js` | 新增 | 只读度量脚本，不写文件 |

## 2. 逐项核查

### 2.1 供应链 / 下载源

- **未新增任何下载源**。`provision.js` 仍只使用 Google 官方索引（`dl.google.com`）与既有的
  QEMU/AEHD 固定清单；`host/profile.js` 只生成**文件名前缀**，不生成 URL。
- 校验链未改动：`runtime-integrity.js` 仍要求组件携带发布方固定摘要
  （`resolveAdbComponent` 从官方索引绑定 SHA-1；QEMU 固定 SHA-512 记录）。
- `host/profile.js` 的 `EMULATOR_PREFIX` 表是纯字符串常量，不含任何可被设置/镜像/Renderer 注入的值。
- **依赖审计**：`npm audit --registry=https://registry.npmjs.org` → `{"total":0}`（info/low/moderate/high/critical 全 0）。
  未通过镜像源 404 冒充通过。

### 2.2 路径处理

- `HostAdapter.describe()` 读取 `os.homedir()` 仅用于**展示** AVD 默认路径，不参与写入决策。
- `provision.js` 的路径拼接仍走既有 `paths()`，未新增用户可控路径输入。
- 严格 stub 测试（`instance-runtime-readonly-test.js` 等）仍要求
  `assertPrivateInstancePath` 生效：新增 `./host/profile` 依赖已显式声明为纯函数模块，
  不绕过实例边界（该模块无 `fs` 访问）。

### 2.3 命令执行

- 本轮**未新增**任何 `execFile` / `spawn` 调用点。
- `provision.js` 加速探测分支改为按宿主区分 `kind`（`kvm` / `hvf`），
  但仍调用既有 `run(exe, ['-accel-check'])`，参数为常量数组，无字符串拼接。

### 2.4 假支持与误导性声明

- 这是本轮最关键的**安全相关正确性**问题：把「官方产物存在」写成「平台已支持」会诱导用户
  安装后在黑屏/无法启动中丢数据。
- 处理：声明表 macOS `provision` 增 `acquirable: true`（事实），但 `level` 仍是 `absent`，
  `blockers` 保留三条阻塞码；`platformSupportLevel('darwin')` 仍为 `unsupported`。
- `test/host-profile-test.js` 断言 `mac.supportLevel() === 'unsupported'` 且
  `describe()` 不含 `verified` 字段，防止未来被抬成「已验证」。

### 2.5 日志敏感信息

- 新增日志仅一行平台事实（已存在于 `main.js` 的 `platform ... support=...`），
  本轮 `describe().host` 字段不含用户名之外的绝对路径（`avdHomeDefault` 使用 `os.homedir()`
  ——与既有 `avdHomeDefault()` 行为一致，诊断报告中用户本可看到自己的 home 路径，未见新增暴露面）。

## 3. 遗留风险（未在本轮解决，如实列出）

| 风险 | 级别 | 状态 |
| --- | --- | --- |
| Windows Authenticode 未配置（仅清单 Ed25519 签名） | P3 | 历史遗留，需要可信证书 |
| Code Scanning 无分析记录 | P2 | 未运行 ≠ 通过；待接入真实静态分析 |
| 关机中断非事务式安装 | P2 | 历史遗留 |
| macOS 公证链路缺失 | — | 属功能缺失，非漏洞；但在补齐前不得发布 macOS 包 |
| Linux ARM64 无官方运行时 | — | 属能力缺失；不得用 x64 包冒充 |

## 4. 客户端不可解决的边界

长期私钥/服务凭证一旦分发到客户端即可被读取，不能靠字符串加密或混淆解决。
本项目客户端只保存**公钥**（`src/core/release-public.pem`）与校验逻辑。
未来远程管理/Web 控制台的认证凭据必须由用户输入并加密存储，**不得**内置到客户端。

## 5. 复测命令

```bash
# 依赖漏洞（必须用官方源，镜像源不支持 audit）
npm audit --registry=https://registry.npmjs.org

# 平台能力声明 + 宿主画像回归
node --test test/platform-capabilities-test.js test/host-profile-test.js

# 只读边界 / 严格 stub 回归
node --test test/instance-runtime-readonly-test.js test/runtime-data-safety-test.js \
             test/runtime-component-integrity-test.js test/snapshot-partition-safety-test.js
```

## 6. 结论

- 本轮改动**未新增**下载源、命令执行点、用户可控路径或网络入口。
- 最重要的修正是**消除误导性平台声明**（产物可得 ≠ 已支持），并用测试守住。
- 依赖审计 0 漏洞；未把未运行的扫描写成通过。
- 本轮不是「项目整体安全」的证明，历史遗留项见第 3 节。
