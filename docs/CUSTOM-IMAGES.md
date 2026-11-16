# 自定义 Android / MIUI 镜像适配层

ApkStart 默认只跑一套运行时：**Android 14 · Google Play · x86_64**。这个默认镜像不会被任何
自定义操作改写。本文说明在此基础上接入**自己的模拟器系统镜像**是怎么做的、为什么有些镜像
一定接不进来，以及出问题时该看哪里。

> 一句话结论：能接进来的是**模拟器系统镜像**（SDK `system-images` 那一套布局）；
> 手机刷机包、recovery、任何 arm64 固件都接不进来；**MIUI 没有 x86_64 模拟器镜像**，
> 所以它永远不会显示成「已接入」。

---

## 1. 设计边界

| 想做 | 支持 | 说明 |
| --- | --- | --- |
| 接入自建 AOSP / 第三方 **x86_64 模拟器**系统镜像 | ✅ | 需要 `system.img`、`vendor.img`、`kernel-ranchu`、`ramdisk.img` |
| 接入从 Android Studio `sdkmanager` 下下来的 `system-images` | ✅ | 直接指向 `.../android-34/<tag>/x86_64` 目录即可 |
| 把手机卡刷包 / 线刷包当模拟器镜像 | ❌ | 内核与分区布局都不对，见第 4 节 |
| 把 `recovery.img` 当系统镜像 | ❌ | recovery 没有安卓框架和桌面 |
| 把 arm64 / armeabi 系统镜像塞给 Windows 上的 QEMU | ❌ | Windows 只有 x86_64 的加速能力 |
| 接入 MIUI / HyperOS | ❌ | 小米没有发布过 x86_64 模拟器系统镜像 |
| 接入后不影响默认镜像与已装应用 | ✅ | 自定义镜像跑在独立 AVD 里，见第 6 节 |

**为什么不能「先塞进去试试」**：emulator 拿到不匹配的镜像不会报一句「镜像不对」，
它会黑屏、卡开机动画、或者掉进 recovery 循环。用户看到的只是「ApkStart 打不开应用」，
排查成本极高。所以适配层的策略是**入口就拒**，并且把原因写清楚。

---

## 2. 目录结构

推荐把镜像放成 SDK 的目录形状（这样 API / ABI / tag 都能自动识别）：

```
D:/images/aosp-34/
└── android-34/
    └── google_apis_playstore/
        └── x86_64/
            ├── system.img          必需，Android 系统分区
            ├── vendor.img          必需（Android 8 以上），厂商分区
            ├── kernel-ranchu       必需，emulator 的 ranchu 内核（ELF / gzip / bzImage）
            ├── ramdisk.img         必需，gzip / lz4 / cpio newc
            ├── userdata.img        可选，ApkStart 会自己创建数据分区
            └── apkstart-image.json 可选，清单（见第 3 节）
```

也可以直接指向 `x86_64` 这一层。**指向更上层也可以**：导入时会自动往下找到
真正含 `system.img` 的那一级（最多三层）。

`system.img` / `vendor.img` 支持 raw ext4、Android sparse（`simg2img` 的输入格式）、
qcow2、vmdk；`kernel-ranchu-64` 与 `kernel` 这两个文件名也会被识别。

---

## 3. 清单：`apkstart-image.json`

清单不是必需品（四件套齐全 + 目录形状正确就能自动推断），但只要出现了，就是**权威描述**：
里面写了 `checksums` 就一定校验，写了 `abi` 就和目录结构交叉验证。

```json
{
  "schema": 1,
  "id": "aosp-34-x86_64",
  "name": "AOSP 14 (x86_64)",
  "type": "emulator-system-image",
  "api": 34,
  "abi": "x86_64",
  "tag": "google_apis_playstore",
  "vendor": "自建",
  "source": {
    "kind": "local-dir",
    "path": "D:/images/aosp-34",
    "url": "",
    "license": "Apache-2.0",
    "note": "从 AOSP 源码自行编译"
  },
  "googleServices": { "gms": true, "playStore": true },
  "armTranslation": { "enabled": true, "engine": "libndk" },
  "files": {
    "system": "system.img",
    "vendor": "vendor.img",
    "kernel": "kernel-ranchu",
    "ramdisk": "ramdisk.img"
  },
  "checksums": {
    "system.img": "sha256:0000....",
    "kernel-ranchu": "sha1:0000...."
  },
  "qemu": { "machine": "ranchu", "minEmulator": "33.0.0" },
  "bootable": true
}
```

### 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | 建议 | `emulator-system-image` / `phone-rom` / `miui-rom` / `recovery-image`。省略时按 `emulator-system-image` 处理，但手机固件靠字节体检仍然会被拦下 |
| `api` | 是 | Android API 级别（21~99）；省略时从 `source.properties` / `package.xml` / 路径推断 |
| `abi` | 是 | **必须 `x86_64`**；`x86` 允许但会警告；`arm64-v8a` / `armeabi-v7a` 直接拒绝 |
| `tag` | 否 | 会落回 emulator 认识的 `tag.id`（`google_apis_playstore` / `google_apis` / `default`） |
| `googleServices` | 否 | `{ gms, playStore }`。`playStore:false` 时不会在 AVD 里打开 Play 商店标记 |
| `armTranslation` | 否 | `{ enabled, engine }`。**声明的是 x86_64 镜像里内置的转译层**（libndk / libhoudini），不是「加载 ARM 系统镜像」 |
| `files` | 否 | 文件名和默认不一样时用；相对路径按清单所在目录解析 |
| `checksums` | 建议 | `sha256:` / `sha1:` / `md5:`，格式不合法或长度不对的条目会被丢弃。声明了就必须匹配，否则拒绝导入 |
| `qemu.machine` | 否 | 只接受 `ranchu`（`goldfish` 为兼容保留） |
| `qemu.minEmulator` | 否 | 低于这个版本会给出警告（不阻断） |
| `bootable` | 否 | 显式 `false` = 作者声明不可启动，禁止启用 |

### 支持的 ABI

| ABI | 结果 | 原因 |
| --- | --- | --- |
| `x86_64` | 完整支持 | Windows 上 emulator 的原生目标 |
| `x86` | 允许 + 警告 | 能启动，但性能与兼容性都不如 x86_64，未经验证 |
| `arm64-v8a` / `armeabi-v7a` | 拒绝 | Windows 上 QEMU 没有 ARM 加速；`arm64` / `aarch64` 会被归一成 `arm64-v8a` |

---

## 4. 为什么手机 ROM 一定接不进来

不是「不让你试」，是物理上不成立：

1. **内核不对**。手机固件里内核和 ramdisk 打包成一个 `boot.img`（文件头是 `ANDROID!`），
   而 emulator 要的是独立的 `kernel-ranchu`（ELF/bzImage）+ 独立 `ramdisk.img`。
   手机内核里没有 goldfish/ranchu 的虚拟设备驱动，也没有模拟器的内核命令行。
2. **分区布局不对**。手机用动态分区（`super.img`）或带 `system.transfer.list` 的
   卡刷包（`system.new.dat.br`），模拟器的 `image.sysdir` 需要分开的 `system.img` / `vendor.img`。
3. **ABI 不对**。手机固件是 arm64，Windows 上的 emulator 只有 x86_64 目标。
   所谓「ARM 转译」是 x86_64 镜像**内部**的一层（libndk/libhoudini），
   不是把 ARM 系统镜像加载起来。
4. **MIUI / HyperOS 没有 x86_64 模拟器版本**。小米只发布 arm64 机型的卡刷包与线刷包。
   ApkStart 不会为了「看起来支持了」而把它标记成已接入 —— 那只会让用户以为成功，
   然后在黑屏里浪费时间。

会被点名拒绝的特征：`boot.img`、`recovery.img`、`system.new.dat`、`system.new.dat.br`、
`system.transfer.list`、只有 `super.img` 没有独立分区、目录名是 `arm64-v8a` 却只给了 x86 内核。

---

## 5. 导入流程

```
选来源（文件夹 / ZIP / 清单 JSON）
   ↓  provider.probe → provider.read  （ZIP 会先解到 runtime/_tmp/.staging-*）
清单归一化 + 目录推断（api / abi / tag）
   ↓
清单校验（类型 / ABI / API / 机器类型 / bootable）
   ↓
字节体检（system / vendor / kernel / ramdisk 逐个验文件头）
   ↓
ABI 交叉验证（清单说 x86_64、目录却是 arm64 → 拒绝）
   ↓
校验值（清单声明了才验，逐个流式哈希）
   ↓
写 custom-images/index.json 一条记录
```

关键点：**导入只是「加一条记录」**，不写 `settings.runtime.activeImageId`。
所以：

- 导入失败 → 当前镜像、默认镜像、AVD、已装应用全部原样；
- 导入成功但没启用 → 同上，只是多了一条记录。

启用（`activate`）是独立的一步，而且**启用前会重新体检一遍**：如果目录被移走、
文件被删了，启用会失败并保持当前镜像不变。

---

## 6. 数据安全：独立 AVD

自定义镜像跑在 **`apkstart-custom`** 这套 AVD 里，默认镜像继续用 `apkstart`。

这不是洁癖：模拟器发现 `image.sysdir` 变了会给旧 userdata 做 `-wipe-data`
（APEX 不兼容会引导循环）。共用一套 AVD 就等于「换镜像 = 已装应用全丢」。

因此：

- 切换镜像不会碰默认 AVD 的应用、存档与快照；
- 「恢复默认镜像」只是把指针清空，切回去立刻就是原来那套数据；
- 清理逻辑（`layers.js`）把两套 AVD 都列为受保护，不会当成「非活动 AVD」回收；
- 「移除镜像」只删**我们自己解出来的 ZIP 副本**（`runtime/custom-images/<id>`），
  用户自己的源目录永远不删。

---

## 7. 可插拔 provider

来源适配器在 `src/core/images.js` 的 `PROVIDERS` 里，接口很简单：

```js
{
  id: 'local-dir',                        // 唯一标识
  label: '本地文件夹',                     // 界面/日志里的名字
  probe(path) -> boolean,                 // 这个来源归我吗？
  read(path, ctx) -> {                    // 交出「目录 + 可选清单」
    dir,                                  // 镜像目录（可以是上层目录，会被自动下钻）
    manifestPath?,                        // 可选：清单文件绝对路径
    managed: boolean,                     // true = 副本归我们管（移除时删），false = 引用用户目录
    stagingDir?,                          // 可选：临时目录根（用于失败时整体清理）
    prepare?() -> Promise<{dir, managed}> // 可选：异步准备（解压）
  }
}
```

内置三个：`manifest-json`、`local-dir`、`local-zip`。新增一种来源（例如 HTTP 直链、
内网共享盘）只需 `register(provider)`，导入流程一行都不用改：

```js
const { ImageStore } = require('./src/core/images');
store.register({
  id: 'http-zip',
  label: '下载地址',
  probe: (p) => /^https?:\/\//i.test(p),
  read: async (p, ctx) => { /* 下载到 ctx.stagingRoot，再返回 { dir, managed: true, stagingDir } */ },
});
```

后续的清单校验、字节体检、校验值、索引写入、失败回滚全部复用。

---

## 8. 界面与诊断

- **设置 → 高级参数 → 自定义安卓镜像（实验性）**：显示当前镜像、镜像来源、
  已导入列表；不可用的镜像在下拉里标「（不可用）」，**选中它即可看到**
  下方「为什么这个镜像不可用」给出的具体原因，同时「启用选中的镜像」按钮变灰
  （移除、打开目录仍然可用，方便清掉或去修文件）。
- **修复窗口的体检表**：使用自定义镜像时会多出「镜像来源」一行；
  镜像不可用时多出「镜像不可用」一行（标红）。
- **开机失败的错误信息**：会附加「当前使用的是自定义镜像 X，可在设置里恢复默认镜像」，
  并且 `last-failure.json` 里记下了这次用的镜像 id / 目录，重启后仍能回答
  「是不是我换的镜像害的」。

### 常见失败原因对照

| 提示 | 含义 | 怎么办 |
| --- | --- | --- |
| 缺少 `kernel-ranchu` | 目录里没有内核 | 换成模拟器系统镜像；手机 `boot.img` 不能代替 |
| 这是手机的 `boot.img` | 文件头是 `ANDROID!` | 拿错了，换成 SDK system-images |
| 只有 `super.img` | 动态分区超级镜像 | 先拆成 `system.img` / `vendor.img` |
| `system.new.dat` | 手机卡刷包 | 先转换并重新打包成原始镜像 |
| ABI 是 `arm64-v8a` | ARM 系统镜像 | Windows 上跑不了，换 x86_64 |
| 清单声明 ABI 是 x86_64，但目录是 arm64-v8a | 清单和内容不一致 | 别改清单糊弄，检查镜像本身 |
| 校验值不匹配 | 文件损坏或被替换 | 重新导出镜像，或修正清单里的哈希 |
| 镜像目录已不存在 | 目录被移动/删除 | 重新导入，或恢复默认镜像 |

---

## 9. 测试

```bash
node test/image-adapter-test.js     # 39 项：清单 / 字节体检 / 导入 / 启用 / 恢复 / 清理接线
npm test                            # 全量（含上面这项）
```

测试用 `ftruncate` 造「够大的稀疏夹具文件」，所以既能验真实体积门槛，
又不会真的写几百 MB 到磁盘。覆盖的核心断言：

- 手机固件、`boot.img`、`new.dat`、`super.img`、arm64 全部被拒，且原因具体；
- MIUI 拒绝原因里必须出现「MIUI」和「没有 x86_64」；
- 导入失败时 `settings.runtime.activeImageId` 与索引都不变；
- 启用后删掉 `system.img` → `active()` 返回 `ok:false` + 原因，运行时回落默认镜像；
- 移除记录不删用户源目录，ZIP 副本才删；
- `apkstart-custom.avd` 不会被清理逻辑回收；
- 默认镜像常量仍然是 `{ api: '34', tag: 'google_apis_playstore', abi: 'x86_64' }`。
