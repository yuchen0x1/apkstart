# Linux 实测验证报告（2026-11-18）

> 承接 `PLATFORM-LINUX.md`：那份文档承认「Linux / macOS 未实测」，本文是该承诺的兑现 ——
> 在真实 Linux 环境里把现有代码从头到尾跑一遍，确认地基是否如文档所判断，
> 并给出精确到文件的缺口清单。**所有结论都有实测记录，不再是读码推断。**

## 结论

**可行，且比文档预期更顺利。** 平台能力门禁（external 档）按设计工作，
23 个测试文件里 22 个直接全绿，Electron 冒烟 20/20，应用真实启动并完整渲染 UI。
「第一档 Linux 版」（独立窗口模式 + 自动运行时 + 打包）没有未知的硬阻塞，
剩余工作是文档预言的「纯机械工作」。

## 实测环境

| 项 | 值 |
|---|---|
| 宿主 | Windows 11 26300，AMD Ryzen 9 8945HX（32 核），64G 内存 |
| Linux | Ubuntu 26.04.1 LTS（WSL2，WSLg GUI，内核 6.18.33.2-microsoft-standard-WSL2） |
| Node | v22.22.1（apt），npm 9.2.0 |
| Electron | 45.3.2（Chromium 156.0.8078.100，内置 Node 24.22.2） |
| 项目副本 | `~/apkstart`（源码 tar，排除 node_modules/dist/build/runtime/site，263 文件） |
| 安装方式 | `npm install --force --registry=registry.npmmirror.com` + `ELECTRON_MIRROR=npmmirror` |

WSL2 里 `/dev/kvm` 存在且可用（嵌套虚拟化）—— 意味着**将来连「KVM 加速的模拟器真的跑起来」
都能在这台机器上验证**，不需要另找 Linux 裸机。

## 验证矩阵

| 验证项 | 结果 | 证据 |
|---|---|---|
| npm 依赖安装 | ⚠️→✅ | os 字段挡住（见缺口 #1），`--force` 后 312 包 4s 装完 |
| `@napi-rs/lzma` Linux 预编译 | ✅ | `lzma-linux-x64-gnu` 自动就位，无 ABI 问题 |
| 纯 Node 测试套件（23 个文件） | ✅ 22/23 | 仅 updater-test 3 项失败，全是夹具硬编码（见缺口 #5） |
| Electron 冒烟（`test:electron`） | ✅ 20/20 | preload 沙箱 / 131 IPC 接口 / 渲染无脚本错误 / 修复窗截图正常 |
| 应用真实启动 | ✅ | `app.log`: `platform linux support=external embed=false`，进程稳定 |
| UI 渲染（WSLg） | ✅ | 见 `docs/images/platform-linux-validation.png`：首启引导完整、无黑屏 |
| `platform.acceleration()` | ✅ | `{ kind:'kvm', ok:true, path:'/dev/kvm' }` 检测正确 |
| `doctor.hostInfo()` | ✅ | CPU/内存/核数/虚拟化检测全部正常返回 |
| `AdbClient.resolveAdb()` | ✅ | 命中 Linux 查找表首位 `~/Android/Sdk/platform-tools/adb` |
| AdbClient 连通 | ✅ | `version()` 1.0.41、`devices()` 空列表（无设备，正常） |
| dl.google.com 下载（Linux 内） | ✅ | platform-tools 8.63MB / 0.7s ≈ **13MB/s**，快路径在 WSL 同样成立 |

## 缺口清单（按优先级，全部实测确认）

| # | 缺口 | 位置 | 优先级 | 修法 |
|---|---|---|---|---|
| 1 | `"os": ["win32"]` 使 npm 在 Linux 直接 EBADPLATFORM 拒装 | `package.json` | **P0（一行）** | 改为 `["win32","linux"]` |
| 2 | 数据目录硬编码 Windows 约定：APPDATA 未设时落 `~/AppData/Roaming/apkstart` | `src/core/store.js:10` | **P1** | Linux 走 `~/.local/share/apkstart`（XDG），需一次迁移逻辑 |
| 3 | 约 130 处 `.exe` 硬编码（`adb.exe` / `qemu-img.exe` / `e2fsck.exe` / `resize2fs.exe`…） | `emulator.js`(27) `main.js`(41) `provision.js`(30) `adb.js`(35) `updater.js`(19) 等 | **P1（第一档主体）** | 统一走 `platform.exe()` + PATH 查找；`e2fsck/resize2fs` 在 Linux 直接用系统 e2fsprogs |
| 4 | provision 下载源只有 Windows 包（platform-tools/emulator/AEHD） | `src/core/provision.js:24-43` | **P1（第一档主体）** | 按 host-os 分叉：`platform-tools-latest-linux.zip`、`emulator-linux_x64`（解析 repository2-3.xml）、AEHD 跳过换 KVM |
| 5 | updater 测试夹具：`C:\Windows\System32\whoami.exe` 占位文件、`resources\runtime` 反斜杠断言 | `test/updater-test.js:305,394` | P2 | 占位文件改用 `process.execPath`；断言按 platform 分叉 |
| 6 | 文案写死「Windows 10/11 64-bit」等 | i18n 文案（首启引导/体检表） | P2 | 按平台出文案键 |
| 7 | 打包：无 Linux target、extraResources 是 Windows 运行时整包 | `electron-builder.yml` | P1（第一档） | 加 AppImage/deb target；Linux 不带运行时整包（走自动下载）+ `.desktop` |
| 8 | 窗口嵌入 | Win32 专有（设计如此） | 第二档 | X11 `XReparentWindow` 后端，独立工程；第一档维持 external 独立窗口 |

## 实测方法备忘（可复现）

1. `wsl --install -d Ubuntu --no-launch`（WSLg 自带 GUI）；
2. `-u root` 免 OOBE 建 `dev` 用户 + `sudo` NOPASSWD；
3. apt 装 `nodejs npm`（22.22.1）+ Electron GUI 库（libgtk-3-0t64 等 13 个）；
4. 源码 tar 进 `~/apkstart`（排除 Windows 侧 node_modules），npmmirror 安装；
5. Electron 二进制若未就位：`cd node_modules/electron && node install.js`（--force 安装的副作用）；
6. `node test/*.js` 逐个跑（不串 `&&`，每个文件都有结论）；
7. `node test/run-electron.js smoke`（WSLg 下 `DISPLAY=:0`）；
8. 真实启动 + `xdotool search --name ApkStart` + `import -window <id>` 截图取证。

工具链备注：wsl.exe 的 stdout 是 UTF-16（Git Bash 里要 `tr -d '\0'`）；MSYS2 会把
以 `/` 开头的参数转成 Git 安装路径（`/mnt/c/...` 要包在 `bash -c '...'` 内）；
WSL NAT 模式下 Windows 的 Clash(127.0.0.1:7890) 不可达，国内下载走 npmmirror /
dl.google.com 直连即可，无需代理。

## 第一档落地后复测（同日，v0.7.0 开发过程）

上表缺口 #1~#4、#7 全部落地后的复测结果：

| 验证项 | 结果 |
|---|---|
| 应用内自动部署（下载 → 部署 → checkEnv） | ✅ 81 秒全通（adb + emulator 37.4.1 + Play x86_64 镜像） |
| 下载速度 | ✅ 8 连接并行实测峰值 **70MB/s**（dl.google.com，WSL2） |
| KVM 硬加速检测 | ✅ `{"ok":true,"kind":"kvm"}`（dev 加入 kvm 组后） |
| Android 真机开机 | ✅ 第 1 次尝试 7 分钟超时（嵌套 KVM + GMS 首次 dexopt 慢），**第 2 次尝试 31 秒就绪**；Wi-Fi 自愈正常 |
| APK 安装 | ✅ 谷歌拼音输入法 `install -r -t -g` Streamed Install Success，196 个系统包 |
| 测试套件 | ✅ Linux 全绿（23 文件，updater/auto/engine 夹具与断言已平台化） |
| Windows 回归 | ✅ `npm test` 全绿（exit 0） |
| Linux 打包 | ✅ AppImage 135MB + deb 108MB，electron-builder 26 一次通过 |

复测抓出的新问题与处置：

1. **Chromium 沙箱在 Ubuntu 24.04+ 起不来**：无特权 user namespace 被 AppArmor
   限制（AppImage 的 squashfs 是 nosuid 挂载，setuid 的 chrome-sandbox 也无用），
   GPU 进程 FATAL「GPU process isn't usable. Goodbye.」。处置：启动前 `unshare -Ur`
   探测 userns 能力，不可用则降级 `--no-sandbox` 并写日志（主流 Electron AppImage
   的同款做法）。
2. **emulator 缺系统库**：libpulse.so.0 等。处置：`installEmulator` 失败时 `ldd`
   点名并映射成 apt 包名给用户。
3. **首次开机 7 分钟超时**：嵌套 KVM + GMS 首次 dexopt 比阈值慢，引擎自动换参
   重试兜住了（第 2 次 31 秒）。真实裸机 Linux 通常更快，暂不调阈值，观察用户反馈。
4. **electron-builder 配置**：`linux.desktop` 自定义键在 eb 26 的 schema 不合，
   .desktop 由 productName/description 自动生成 + `desktopName` 字段即可。
