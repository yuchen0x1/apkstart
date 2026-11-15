# 应用兼容性实测记录（2026-11-15）

本文件只记录**真实跑过**的结果，未执行的项明确标注，不做推测。

## 1. 测试环境

| 项目 | 实际情况 |
|---|---|
| 主机 CPU | AMD Ryzen 9 8945HX（16 核） |
| 主机 GPU | NVIDIA RTX 5060 Laptop + AMD Radeon 610M（混合显卡） |
| 虚拟化 | WHPX 可用（`emulator -accel-check` → `WHPX(10.0.26300) is installed and usable`） |
| Android 运行时 | Android Studio Emulator 37.2.13，AVD `LinuxDo_API35` |
| Android 版本 | Android 15（API 35），`google_apis_playstore` x86_64 |
| ABI | `x86_64,arm64-v8a`，`ro.dalvik.vm.native.bridge = libndk_translation.so`（ARM64 转译可用） |
| 内存 / 分辨率 | 4 GB / 1080×1920 @420dpi |
| 渲染 | `-gpu swiftshader_indirect`（软件 GL，`Android Emulator OpenGL ES Translator (Google SwiftShader)`） |
| 网络 | 模拟器 NAT，可正常访问外网（视频流可加载） |

> 说明：本次未使用 ApkStart 自带运行时——工作区 `engine/` 目录只有 README，内置 QEMU 与系统镜像尚未部署。
> 测试走的是同一套 ADB 接口 + 同一 ABI/转译栈，能验证「应用能不能在这个安卓环境里跑」，
> 但不等于 ApkStart 界面级（窗口托管）的端到端验证。

## 2. 被测安装包

| 应用 | 包名 | 版本 | 大小 | ABI | minSdk / targetSdk |
|---|---|---|---|---|---|
| 抖音 | `com.ss.android.ugc.aweme` | 41.1.0 (410101) | 349 MB | arm64-v8a | 23 / 34 |
| 快手 | `com.smile.gifmaker` | 14.10.20.51230 | 182 MB | arm64-v8a | 21 / 30 |
| 快手极速版 | `com.kuaishou.nebula` | 14.10.20.12063 | 114 MB | arm64-v8a | — |

安装方式：`adb install -r -g`（三个包均 `Success`，无 `INSTALL_FAILED_NO_MATCHING_ABIS`，
说明 `libndk_translation` 对 arm64-only 包生效）。

## 3. 结果汇总

| 应用 | 安装 | 启动 | 视频播放 | 刷视频（上滑切换） | 结论 |
|---|---|---|---|---|---|
| 抖音 41.1.0 | ✅ | ✅ 首个 Activity 5.5 s，冷启动到首帧 6.6 s | ✅ 实测像素级在动 | ✅ 连续切换 4 条不同视频 | **可用**（有性能代价） |
| 快手 14.10.20 | ✅ | ❌ 报「快手异常提醒」后进程崩溃 | — | — | **不兼容** |
| 快手极速版 14.10.20 | ✅ | ❌ 同上（`kwai_dlfcn` CHECK failed） | — | — | **不兼容** |

### 3.1 抖音：确实在播放，不是静态封面

用 `screencap` 原始帧缓冲逐像素比对（视频区域 y 15%~78%、x 0~88%，阈值 24）：

| 采样 | 帧间画面变化率 |
|---|---|
| 首轮（初次安装后） | 89.8%（2 s）、49.9%（2 s） |
| 干净实例（`-wipe-data` 后重装） | 26.7%（2 s）、19.2%（2 s） |
| 上滑切换后 | 26.2%（2 s） |

如果是暂停/静态封面，该值会是 0.0%。测试中切换 GPU 模式后确实出现过 0.0%（见 4.1），
重置实例后恢复，可反证该方法能区分「在播」与「卡住」。

交互验证（截图见 `C:\Users\lenmo\apk-test\`）：

- 首次启动弹「个人信息保护指引」→ 点「同意」进入推荐流；
- 推荐流视频、右侧点赞/评论/收藏数据、底部弹幕、评论区浮层均正常渲染；
- 上滑依次切到 `@yani`、萌宠、`@直男财经` 等不同视频，切换后自动播放；
- 冷启动后会弹一次登录页（可直接关闭，不影响继续浏览）。

### 3.2 性能代价（软件 GL + ARM 转译）

| 指标 | 实测 |
|---|---|
| 进程 CPU | 约 258%（4 核 400% 上限） |
| 内存 PSS | 1.18 ~ 1.44 GB |
| UI 帧统计 | `Total frames 169`，`Janky 66.27%` |
| 首个 Activity 启动 | 5.5 s |

结论：能刷，但不流畅；主要瓶颈是 SwiftShader 软件渲染 + ARM→x86 转译，不是应用本身。

### 3.3 快手：转译层结构性不兼容

现象：

1. 启动进入 `com.kwai.framework.arsc.backup.ui.ArscBackupActivity`，弹「快手异常提醒：检测到资源出现异常…」；
2. 点「优化」后进程直接死亡（`Process com.smile.gifmaker has died: fg TOP`）；
3. 干净实例（`-wipe-data`）重装后 100% 复现；快手极速版同样复现。

日志证据：

```
E kwai_dlfcn: CHECK failed at .../kwai_linker/kwai_dlfcn.cpp (line: 103)
              - <dlopen>: data.info_.dlpi_addr > 0: No such file or directory
E kwai_dlfcn: CHECK failed at .../kwai_dlfcn.cpp (line: 118)
              - <dlsym>: handle: No such file or directory
E .smile.gifmaker: No implementation found for void
   com.kuaishou.aegon.Aegon.nativeSetEnableMTMultiEngine(boolean)
F .smile.gifmaker: runtime.cc:708] Runtime aborting...
   at com.kuaishou.weapon.p0.jni.Engine.eopq(Native method)
```

原因：快手自带的自定义链接器（`libgodzilla.so` / `kwai_linker`）直接依赖 bionic 的
`dlpi_addr` 等内部结构，在 `libndk_translation` 转译环境下这些值不可用，`CHECK` 直接 abort，
随后安全 SDK（`com.kuaishou.weapon`）在初始化时把整个进程带崩。

这不是安装包损坏、也不是权限或网络问题；换安装渠道（应用宝 / 官方包）不会改变结果。
在当前「x86_64 主机 + ARM 转译」链路上，快手属于**不可修复的应用侧问题**。

## 4. 运行时配置的两个坑（对 ApkStart 有直接参考价值）

### 4.1 `-gpu host` 在混合显卡笔记本上会把视频打黑

同一台机器换 `-gpu host`（NVIDIA RTX 5060，`OpenGL ES 3.1 (4.5.0 NVIDIA 610.62)`）后：

- 抖音 UI 正常，但视频区域纯黑；
- `EGL_emulation: app_time_stats avg=14533ms`、`avg=22974ms`（单帧十几秒）；
- 出现 `抖音 isn't responding` ANR。

切回 `-gpu swiftshader_indirect` 后恢复。说明「有独显就一定更快」不成立，
混合显卡 + 模拟器 GL 转译很容易踩坑。

### 4.2 热切换 GPU 模式会把视频管线卡死

从 `host` 切回 `swiftshader` 后，抖音 UI 正常、解码器也创建了
（`MediaCodec: [c2.goldfish.h264.decoder] setting surface generation`），
但 SurfaceView 图层始终没有新帧（`SurfaceFlinger --latency` 全 0），画面停在首帧。
`adb reboot` 无效，`-wipe-data` 重建实例后恢复。

对 ApkStart 的启示：运行时的 GPU 模式变更必须伴随实例重建/清理，不能只改启动参数。

## 5. 未验证项

以下明确**没有**测，不作为结论：

- ApkStart 界面级安装 / 窗口托管（内置运行时未部署，`engine/` 为空）；
- 声音（模拟器以 `-no-audio` 启动）；
- 登录后的完整体验（直播、私信、发布、1080p 以上画质）；
- 快手在 ARM64 真机 / ARM64 Windows 主机上的表现（本机无法验证）；
- 长时间（>1 小时）连续刷视频的稳定性与内存增长；
- 其他应用（B 站、小红书、微信等）。

## 6. 对项目的建议

1. **兼容性中心**：对「arm64-only 包 + 设备处于 ARM 转译」的组合，除现有 ABI 提示外，
   增加一条固定风险说明——带强安全加固/自定义链接器的应用可能启动即崩溃（快手为已知案例）。
2. **运行时默认值**：混合显卡笔记本默认用软件渲染（swiftshader）更稳；提供 GPU 模式切换，
   但切换后强制重建实例。
3. **已知不兼容清单**：已在 `src/core/compat.js` 落地 `KNOWN_TRANSLATION_BROKEN`
   （当前：`com.smile.gifmaker`、`com.kuaishou.nebula`）。只有在「APK 无本机原生库 + 必须走转译」
   时才命中，判为「暂不支持」并给出崩溃原因；将来出了 x86_64 原生库会自动失效。
   测试见 `test/compat-test.js` 的三条用例。


---

## 7. ApkStart 自带运行时端到端实测（2026-11-15 第二轮）

环境：ApkStart 开发版（Electron 45.3.2 + 窗口嵌入）+ 自带 runtime
（emulator 37.x / AVD `apkstart` / API 34 google_apis_playstore x86_64，
libndk_translation，720x1280，`-gpu swangle`）。经 `runtime:repairNetwork`
wipe 后首次开机联网正常（wlan0 10.0.2.16），快照已存。

| 应用 | 版本 | ABI | 安装 | 启动 | 结论 |
|---|---|---|---|---|---|
| 抖音 | 41.1.0 | arm64-v8a | ✅ | ✅ 隐私弹窗→同意→推荐流播放，帧间像素变化 20.1% | **可用** |
| 哔哩哔哩 | 9.19.0 | arm64-v8a | ✅ | ✅ 访客模式→For You 推荐流封面/播放量/UP 主全加载 | **可用** |
| 微信 | 8.0.80 | arm64-v8a | ✅ | ❌ `libowl.so` SIGSEGV（System.load 阶段，tombstone_04） | **不兼容**（已入黑名单） |
| 快手 | 14.10.20 | arm64-v8a | ✅ | ❌ 安全 SDK + 自定义链接器崩溃（上轮实测） | **不兼容**（已入黑名单） |

本轮同时修复并验证：

1. **图标不显示**：抖音/微信/B 站的 launcher 图标全为矢量（adaptive-icon + vector），
   新增 vector→SVG 转换 + 双层合成，卡片显示真实图标（抖音黑底音符实测截图确认）。
2. **切前台黑屏**：最小化再切回，模拟器窗口停在 `agent.hide()` 状态；
   加 `_embedded` 跟踪 + show/focus 兜底 `agent.show()`，实测画面恢复。
3. **虚拟机网络失联**：wlan0 NO-CARRIER 不关联（快照/异常退出后常见），
   走内置 `repairNetwork`（wipe + 冷启动）恢复，与引擎注释的已知结论一致。

安装方式：ApkStart UI 全流程（CDP 驱动 `apk:install` / `app:launch`）。
