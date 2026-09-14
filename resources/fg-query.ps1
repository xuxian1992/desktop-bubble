# 查询前台窗口：hwnd | 标题 | x,y,w,h
# 用途：让气泡截图时只抓「用户真正在看的那块」，从而不把自己拍进去。
#
# ⚠️ 必须强制 UTF-8 输出：Windows PowerShell 默认按控制台 OEM 代码页（中文机器是 GBK）输出，
#    Node 按 UTF-8 读就会把中文窗口标题读成乱码。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FGQ {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static string Query() {
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    RECT r;
    GetWindowRect(h, out r);
    return h.ToInt64().ToString() + "|" + sb.ToString() + "|" + r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T);
  }
}
'@
[FGQ]::Query()
