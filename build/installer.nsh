; ApkStart 自定义 NSIS 脚本
; 作用：卸载开始前，先结束可能仍在后台驻留的运行时进程，
; 否则它们会锁住安装目录里的文件，导致卸载不干净、第三方粉碎工具也删不掉。
;
; ApkStart 退出后仍可能留下 detached 的 qemu（为了下次秒开），
; 所以卸载环节必须自己兜底清一遍。
;
; 注意区分「用户主动卸载」和「覆盖安装（更新）」：后者绝不能动用户数据。
; electron-builder 在覆盖安装时会用 `--updated` 参数调用旧卸载器
; （app-builder-lib/templates/nsis/include/installUtil.nsh: always pass --updated flag）。

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; Before the legacy uninstaller removes resources/runtime, preserve the tree
; beside the previous installation on the same volume. Copying leaves the
; running installation usable if the user cancels the wizard.
!macro customInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
  ${AndIf} ${FileExists} "$R0\resources\runtime\emulator\emulator.exe"
    nsExec::ExecToLog '"$SYSDIR\robocopy.exe" "$R0\resources\runtime" "$R0.preserved-runtime" /E /XJ /R:1 /W:1'
    Pop $R1
    ${If} $R1 == "error"
    ${OrIf} $R1 >= 8
      MessageBox MB_ICONSTOP "无法完整保留旧版运行时。请关闭模拟器并检查剩余磁盘空间后重试。" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend

; 安装收尾：再兜一层桌面图标。
; electron-builder 的 createDesktopShortcut 走的是它自己的 CreateShortcuts 流程，
; 个别环境（桌面被 OneDrive 重定向、快捷方式被安全软件回滚）里会生成失败，
; 用户装完发现桌面上什么都没有。这里用 NSIS 原生的 CreateShortcut 再写一次：
; $DESKTOP 走 SHGetFolderPath，能正确跟随桌面的重定向路径；写成幂等操作，
; 和 electron-builder 的重复执行也只是覆盖同一个 .lnk。
!macro customInstall
  DetailPrint "正在创建桌面快捷方式…"
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — 在电脑上直接运行安卓应用"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — 在电脑上直接运行安卓应用"
!macroend

!macro customUnInstall
  ; 先删自己写的快捷方式入口（未安装 ApkStart 时也应无残留）
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  ; customUnInstall runs only after uninstall confirmation. Never kill by image name:
  ; other SDKs/AVDs/Qt applications may be using the same executable names.
  ${If} ${FileExists} "$INSTDIR\resources\app\build\stop-runtime.ps1"
    DetailPrint "正在结束已验证归属的 ApkStart 运行时…"
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\build\stop-runtime.ps1" -InstallDir "$INSTDIR" -DataDir "$APPDATA\apkstart"'
    Pop $R2
  ${EndIf}

  ; 删除 ApkStart 自己产生的数据：应用 APK、运行时镜像、AVD、快照、日志、
  ; 更新缓存、默认共享目录和用户在设置中指定的其它目录。脚本先读取 settings.json，
  ; 再删数据目录，因此从 Windows「应用和功能」卸载也不会留下几 GB 残留。
  ;
  ; **但覆盖安装（更新）时绝不能删**：electron-builder 更新时会先跑旧卸载器
  ; （带 --updated），如果这里照删不误，用户每升一次版本就会丢掉模拟器里装的应用、
  ; 聊天记录和设置，还得重新下 1.4GB 镜像 —— 0.6.12 → 0.6.13 的实测现场就是这样。
  ${GetParameters} $R0
  ${GetOptions} $R0 "--updated" $R1
  ${If} ${Errors}
    ${If} ${FileExists} "$INSTDIR\resources\app\build\uninstall-data.ps1"
      DetailPrint "正在清理 ApkStart 数据、应用和运行时…"
      nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\build\uninstall-data.ps1" -DataDir "$APPDATA\apkstart"'
    ${EndIf}
  ${Else}
    DetailPrint "检测到覆盖安装：保留用户数据（应用、设置与运行时镜像）"
  ${EndIf}
!macroend
