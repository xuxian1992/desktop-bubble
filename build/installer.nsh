; 桌面气泡助手 · NSIS 自定义片段

!macro customInit
  ; 安装前先关掉正在跑的实例，否则文件被占用会导致安装失败
  nsExec::ExecToLog 'taskkill /IM "桌面气泡助手.exe" /F'
  Sleep 900
!macroend

; ⚠️ 卸载钩子必须用 customUnInstall，**不能用 customRemoveFiles**。
;
; electron-builder 的模板是这样组织的：
;
;   !ifmacrodef customRemoveFiles
;     !insertmacro customRemoveFiles
;   !else
;     SetOutPath $TEMP
;     RMDir /r $INSTDIR          ← 内置删除
;   !endif
;
; 也就是说一旦定义 customRemoveFiles，就会**接管**删除责任、把内置逻辑整个跳过。
; 上一版就是这么写的，只做了 taskkill + 清理 dsh，从没删过文件 ——
; 结果实测卸载后残留 376.4 MB / 79 个文件。
;
; customUnInstall 则是纯「插入」：跑完它，内置的 RMDir /r $INSTDIR 照常执行。
!macro customUnInstall
  nsExec::ExecToLog 'taskkill /IM "桌面气泡助手.exe" /F'
  Sleep 900
  ; 撤销对 dsh 的集成（清 profile 标记块 + AGENTS.md + 自启项）。
  ; 这一步必须在删文件之前做 —— 脚本就在 $INSTDIR 里。
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-cleanup.ps1"'
  Sleep 300
!macroend
