# ApkStart v0.6.4

修掉 v0.6.3 里一个「看起来有保护、其实没生效」的问题。

## 问题：装后核对永远读到空版本号

v0.6.3 给安装版更新加了四道保护，其中第三道是「装完读 `resources\app\package.json`
的 `version`，必须等于目标版本才算出成功」。实际跑下来它一直读到空值：

```
[03:16:47] after install: exe=250400768 ver=      ← 空
```

原因是 Windows PowerShell 5.1 的 `Get-Content` **默认按 ANSI(GBK) 解码**。
`package.json` 里的中文描述被解成乱码后连带把 JSON 结构弄坏（报「未终止的字符串」），
`version` 自然读不出来。

而核对逻辑对空值是宽容的（为了兼容没有 `package.json` 的旧包），于是这一道闸门退化成
**「只看 exe 在不在」** —— 哪怕装上了错误的版本也不会回滚。

用纯 ASCII 的 JSON 做单元测试完全测不出来，只有拿真实的 1.4GB 安装包在本机装一遍才会暴露。

## 修法

```diff
- Get-Content -Raw -LiteralPath $pkg | ConvertFrom-Json
+ [IO.File]::ReadAllText($pkg, [Text.Encoding]::UTF8) | ConvertFrom-Json
```

显式按 UTF-8 读；`catch` 里把失败原因写进 `update.log`，以后读不到能直接看到为什么。

测试也换成了真实形态：成功路径写入「UTF-8 无 BOM + 完整中文描述」的 `package.json`。
已确认这版测试**在旧实现下会失败、新实现下通过**。

## 真机验证

用发布出来的 `ApkStart-0.6.3-Setup.exe`（1,492,979,083 字节）在本机安装版上完整跑了一遍：

```
[03:18:21] installer: backup first
[03:18:22] backup ok=True
[03:18:22] run installer
[03:18:59] installer exit 0
[03:19:00] after install: exe=250400768 ver=0.6.3   ← 读到了
[03:19:00] relaunched
[03:19:00] updater done
```

备份实测 **0.6 秒 / 334MB**，正确跳过了 6.4GB 的 `resources\runtime`。

## 下载哪个

| 文件 | 说明 |
|---|---|
| `ApkStart-v0.6.4-win64-portable.zip` | 轻量便携版，运行时首次启动按需下载 |
| `ApkStart-0.6.4-Setup.exe` | 完整安装包，内置运行时，离线开箱即用 |
| `ApkStart-runtime-v0.6.4.zip` | 运行时整包（便携版下载源，一般不用手动下） |

## 升级

安装版直接覆盖安装，便携版替换目录即可。已装应用、存档、系统镜像都不受影响。

如果你还在 0.6.2 或更早：旧版的更新器没有备份保护，建议手动下载这一版装一次；
装好之后，以后每次自动更新都会先备份、装完核对、失败自动还原。

---

本项目仅支持 Windows 10/11 x64。
