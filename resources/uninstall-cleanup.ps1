# 卸载清理：只撤销「桌面气泡助手」自己写进 dsh 的东西，**绝不碰用户其它内容**。
#
# ── 上一版的严重 bug（已修，留作教训）────────────────────────────
#  · 用 Get-Content -Raw 读 UTF-8 文件（PowerShell 5.1 默认按 GBK 解），
#    再用 Set-Content -Encoding utf8 写回 —— **把整个文件的中文永久变成乱码**，
#    连用户 tuoyan MCP 的路径 E:\推演画布项目\... 都被毁掉。
#  · 还「只要文件里出现『桌面气泡助手』就删掉整个 AGENTS.md」——
#    会连带毁掉用户自己写给模型的规则。
#
# ── 现在的铁律 ──────────────────────────────────────────────
#  1. 读写一律显式指定 UTF-8
#  2. 只删「自己那一段」，用标记界定范围
#  3. **内容没变就不写文件**（不碰用户文件）
#  4. 不确定的一律跳过，宁可留残留也不误删

$ErrorActionPreference = 'SilentlyContinue'

# 自己的工作目录挪出安装目录，否则卸载器的 RMDir /r $INSTDIR 会静默失败
Set-Location $env:TEMP

$UTF8 = New-Object System.Text.UTF8Encoding($false)

# ── 1) dsh profile 叠加层：只摘掉气泡的条目 ──────────────────
$patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
if (Test-Path $patch) {
  $lines = [System.IO.File]::ReadAllLines($patch, [System.Text.Encoding]::UTF8)
  $out = New-Object System.Collections.Generic.List[string]
  $skipMode = $null   # $null | 'marked' | 'legacy'
  $changed = $false

  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]

    # 我们自己的标记块：BEGIN 行
    if ($line -match '^#\s*=+\s*桌面气泡助手（自动生成') { $skipMode = 'marked'; $changed = $true; continue }
    # 旧格式：只以注释行开头，没有 END（M4 时期手工写的）
    if ($line -match '^#\s*=+\s*桌面气泡助手') { $skipMode = 'legacy'; $changed = $true; continue }

    if ($skipMode -eq 'marked') {
      if ($line -match '桌面气泡助手\s*·\s*结束') { $skipMode = $null }
      continue
    }

    if ($skipMode -eq 'legacy') {
      # 旧块没有结束标记：只在「接下来的条目确实属于气泡」时才继续跳，
      # 一旦遇到与气泡无关的顶层条目就立刻停 —— 宁可留着，也不能误删用户的配置。
      if ($line.Trim() -eq '') { continue }
      $peekEnd = [Math]::Min($i + 4, $lines.Count - 1)
      $peek = ($lines[$i..$peekEnd] -join "`n")
      if (($line -match '^-\s*insert:') -and ($peek -match 'bubble-context|mcp-bubble|serverName:\s*bubble')) {
        $i++
        while ($i -lt $lines.Count -and $lines[$i] -notmatch '^-\s' -and $lines[$i].Trim() -ne '') { $i++ }
        $i--
        continue
      }
      $skipMode = $null   # 不是气泡的，停止跳过并正常保留这一行
    }

    $out.Add($line)
  }

  if ($changed) {
    # 收尾：去掉连续空行
    $text = ($out -join "`r`n")
    $text = [regex]::Replace($text, '(\r?\n){3,}', "`r`n`r`n")
    [System.IO.File]::WriteAllText($patch, $text, $UTF8)
  }
}

# ── 2) AGENTS.md：只摘掉我们那一段标记块 ────────────────────
$agents = Join-Path $env:USERPROFILE '.dsh\AGENTS.md'
if (Test-Path $agents) {
  $c = [System.IO.File]::ReadAllText($agents, [System.Text.Encoding]::UTF8)
  $b = $c.IndexOf('<!-- ==== 桌面气泡助手 · 开始 ==== -->')
  $e = $c.IndexOf('<!-- ==== 桌面气泡助手 · 结束 ==== -->')
  if ($b -ge 0 -and $e -gt $b) {
    $c2 = ($c.Substring(0, $b) + $c.Substring($e + '<!-- ==== 桌面气泡助手 · 结束 ==== -->'.Length))
    $c2 = [regex]::Replace($c2, '(\r?\n){3,}', "`r`n`r`n")
    if ($c2.Trim()) { [System.IO.File]::WriteAllText($agents, $c2, $UTF8) }
    else { Remove-Item -LiteralPath $agents -Force }   # 摘完确实空了才删
  }
  # 没有标记 = 不是我们写的 → 一个字都不动
}

# ── 3) 开机自启项 ─────────────────────────────────────────
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $run -Name '桌面气泡助手' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $run -Name 'desktop-bubble' -ErrorAction SilentlyContinue

exit 0
