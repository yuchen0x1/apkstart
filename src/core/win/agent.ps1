# ApkStart window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an ApkStart BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }
    // 宿主侧黑屏检测：PrintWindow 抓一帧，只统计画面中央区域，避开 Qt 自带的灰边。
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER
    {
        public int biSize; public int biWidth; public int biHeight;
        public short biPlanes; public short biBitCount; public int biCompression;
        public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public int biClrUsed; public int biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader; public int bmiColors;
    }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll", SetLastError = true)] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // 裁剪嵌入窗口的可见区域：把压到标题栏上的那条外框去掉
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    // 黑屏检测用的 GDI 调用（0.6.7 曾随跟随模式一起删掉，导致嵌入黑屏无人发现）
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int hh);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BITMAPINFO bi, uint usage);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    // DPI 感知：JS 侧传的是物理像素（appwin 已乘过 scale）。powershell.exe 默认
    // DPI 不感知会把坐标再乘一次缩放（125% 下画面放大、右/下被裁、点击偏左上，
    // 上游 #40），且跨 DPI 上下文 SetParent 更容易被拒（#5）。
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr h, IntPtr update, IntPtr region, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;
    const uint RDW_INVALIDATE = 0x0001;
    const uint RDW_UPDATENOW = 0x0100;
    const uint RDW_ALLCHILDREN = 0x0080;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _chromeRender = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // 嵌入后检测到宿主画黑帧时会 detach 成独立窗口；此标志让常驻压制循环
    // 不要把用户正在看的这个独立窗口又藏掉。下一次 embed / park 时清掉。
    static volatile bool _standalone = false;
    // 常驻压制：默认一开机就开，把模拟器主窗 + 工具栏 + 控制台黑窗压住。
    // 与「embed 完成就关掉」的旧逻辑不同，它是**常驻**的 —— sweep 会跳过已经嵌进
    // 我们窗口的那一个窗口，其余一律藏起来（含 ApkStart 退出后回到桌面的那个黑窗）。
    static volatile bool _quiet = true;
    static volatile bool _perfMode = false;
    static long _bootHideSweep = 0;
    // 兜底超时：万一 embed 没来（用户只是打开了 ApkStart 没点应用），
    // 不能让 120ms 一轮的扫描永远跑下去白烧 CPU。每次真藏到窗口就续期。
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // 断线后的「守卫」截止时间（TickCount）。见 Serve() 里 sock == null 的分支。
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "ApkStart conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    sealed class OwnershipCache
    {
        public long Started, CheckedAt;
        public string Exe;
        public bool Ours;
    }
    static readonly System.Collections.Generic.Dictionary<uint, OwnershipCache> _oursCache = new System.Collections.Generic.Dictionary<uint, OwnershipCache>();
    // Supplying avdDir enables fail-closed instance isolation, even if the directory is
    // not provisioned yet. Omitted avdDir retains the old single-instance protocol.
    static bool _scopeAvdRequired = false;
    static string _scopeAvdInput = "", _scopeAvd = "", _scopeAvdName = "";
    // PID of the ApkStart main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder name, uint size, uint flags);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

    static string RealPath(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || !System.IO.Path.IsPathRooted(name)) return "";
        IntPtr h = CreateFileW(name, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (h == new IntPtr(-1)) return "";
        try
        {
            StringBuilder b = new StringBuilder(32768);
            uint n = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
            if (n == 0 || n >= b.Capacity) return "";
            string p = b.ToString();
            if (p.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) p = @"\\" + p.Substring(8);
            else if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) p = p.Substring(4);
            return p.TrimEnd('\\').ToLowerInvariant();
        }
        catch { return ""; }
        finally { CloseHandle(h); }
    }

    static string NarrowDirectory(string name)
    {
        string d = RealPath(name);
        if (d.Length == 0 || !System.IO.Directory.Exists(d)) return "";
        string root = System.IO.Path.GetPathRoot(d).TrimEnd('\\');
        if (string.Equals(d, root, StringComparison.OrdinalIgnoreCase)) return "";
        string leaf = System.IO.Path.GetFileName(d);
        if (System.Text.RegularExpressions.Regex.IsMatch(leaf, @"^(users|home|root|usr|bin|sbin|opt|var|tmp|windows|program files( \(x86\))?|programdata|appdata|desktop|downloads|documents)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return "";
        foreach (string key in new string[] { "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "ProgramData", "SystemRoot", "TEMP", "TMP" })
        {
            string env = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrEmpty(env) && d == RealPath(env)) return "";
        }
        return d;
    }

    static string EmulatorScope(string name)
    {
        string d = NarrowDirectory(name);
        if (d.Length == 0) return "";
        string exe = RealPath(System.IO.Path.Combine(d, "emulator.exe"));
        if (exe.Length == 0 || System.IO.Path.GetDirectoryName(exe) != d || !System.IO.Directory.Exists(System.IO.Path.Combine(d, "qemu"))) return "";
        return d + "\\";
    }

    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = NarrowDirectory(piece.Trim());
            if (d.Length == 0) continue;
            string scope = EmulatorScope(d);
            if (scope.Length == 0) scope = EmulatorScope(System.IO.Path.Combine(d, "emulator"));
            if (scope.Length > 0 && !_scopeDirs.Contains(scope)) _scopeDirs.Add(scope);
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static void SetAvdScope(string avd, string name, bool supplied)
    {
        _scopeAvdRequired = supplied;
        _scopeAvdInput = supplied ? (avd ?? "") : "";
        _scopeAvd = supplied ? NarrowDirectory(_scopeAvdInput) : "";
        _scopeAvdName = name ?? "";
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static string[] Arguments(string command)
    {
        if (string.IsNullOrWhiteSpace(command)) return new string[0];
        int count;
        IntPtr argv = CommandLineToArgvW(command, out count);
        if (argv == IntPtr.Zero) return new string[0];
        try
        {
            string[] args = new string[count];
            for (int i = 0; i < count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
            return args;
        }
        finally { LocalFree(argv); }
    }

    static bool MatchesAvd(string exe, string[] args, string avd, string avdName)
    {
        if (avd.Length == 0 || args.Length == 0 || RealPath(args[0]) != exe) return false;
        int data = 0, hw = 0, names = 0;
        string hardware = RealPath(System.IO.Path.Combine(avd, "hardware-qemu.ini"));
        for (int i = 1; i < args.Length; i++)
        {
            string arg = args[i];
            if (arg == "-datadir" || arg == "-android-hw" || arg == "-avd")
            {
                if (++i >= args.Length) return false;
                string value = args[i];
                if (arg == "-avd")
                {
                    if (avdName.Length > 0 && value != avdName) return false;
                    names++;
                }
                else if (arg == "-datadir")
                {
                    if (RealPath(value) != avd) return false;
                    data++;
                }
                else
                {
                    if (hardware.Length == 0 || RealPath(value) != hardware) return false;
                    hw++;
                }
            }
            else if (arg.StartsWith("@", StringComparison.Ordinal))
            {
                if (avdName.Length > 0 && arg.Substring(1) != avdName) return false;
                names++;
            }
        }
        // Names alone are never identity. In isolated mode require an exact canonical
        // datadir or hardware-qemu.ini path; no environment/home or same-EXE fallback.
        return hw > 0 || (data > 0 && (names > 0 || avdName.Length == 0));
    }

    static bool ReadAvdIdentity(uint pid, long started, string exe)
    {
        try
        {
            // Load the inbox Framework WMI assembly only for a validated emulator candidate.
            // Reflection keeps this embedded source compilable with Add-Type's default refs.
            var assembly = System.Reflection.Assembly.Load("System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a");
            Type queryType = assembly.GetType("System.Management.ManagementObjectSearcher", true);
            object query = Activator.CreateInstance(queryType, new object[] {
                "SELECT CommandLine, CreationDate FROM Win32_Process WHERE ProcessId=" + pid.ToString(CultureInfo.InvariantCulture) });
            using ((IDisposable)query)
            {
                object options = queryType.GetProperty("Options").GetValue(query, null);
                options.GetType().GetProperty("Timeout").SetValue(options, TimeSpan.FromSeconds(2), null);
                object rows = queryType.GetMethod("Get", Type.EmptyTypes).Invoke(query, null);
                using ((IDisposable)rows)
                {
                    foreach (object row in (System.Collections.IEnumerable)rows)
                    {
                        using ((IDisposable)row)
                        {
                            var item = row.GetType().GetProperty("Item", new Type[] { typeof(string) });
                            string command = item.GetValue(row, new object[] { "CommandLine" }) as string;
                            string created = item.GetValue(row, new object[] { "CreationDate" }) as string;
                            if (string.IsNullOrEmpty(command) || string.IsNullOrEmpty(created)) return false;
                            Type dates = assembly.GetType("System.Management.ManagementDateTimeConverter", true);
                            DateTime birthDate = (DateTime)dates.GetMethod("ToDateTime").Invoke(null, new object[] { created });
                            long birth = birthDate.ToUniversalTime().ToFileTimeUtc();
                            // WMI timestamps have microsecond precision, process creation is 100ns.
                            if (Math.Abs((decimal)birth - started) >= 10) return false;
                            return MatchesAvd(exe, Arguments(command), _scopeAvd, _scopeAvdName);
                        }
                    }
                }
            }
        }
        catch { }
        return false;
    }

    static bool CandidateOwned(uint pid, string file, long started)
    {
        if (pid == 0 || started <= 0 || _scopeDirs.Count == 0) return false;
        string name = System.IO.Path.GetFileName(file);
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^(emulator|emulator-check|qemu-system-(x86_64|i386|aarch64|armel)|netsimd)\.exe$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return false;
        bool inScope = false;
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (file.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { inScope = true; break; }
        if (!inScope) return false;
        if (!_scopeAvdRequired) return true;
        // AVD provisioning can happen after the initial scope command. Until it exists,
        // deny all; once it exists resolve its final path rather than trusting a prefix.
        if (_scopeAvd.Length == 0) _scopeAvd = NarrowDirectory(_scopeAvdInput);
        if (_scopeAvd.Length == 0) return false;
        long now = NowMs();
        lock (_oursCache)
        {
            OwnershipCache cached;
            if (_oursCache.TryGetValue(pid, out cached) && cached.Started == started && cached.Exe == file
                && (cached.Ours || now - cached.CheckedAt < 2000)) return cached.Ours;
        }
        // WMI is queried only AFTER executable/path validation, never for arbitrary Qt apps.
        bool ours = ReadAvdIdentity(pid, started, file);
        lock (_oursCache)
        {
            _oursCache[pid] = new OwnershipCache { Started = started, CheckedAt = now, Exe = file, Ours = ours };
        }
        return ours;
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                long started = p.StartTime.ToUniversalTime().ToFileTimeUtc();
                string file = RealPath(p.MainModule.FileName);
                bool ours = CandidateOwned(pid, file, started);
                if (!ours && IsRuntimeChild(file)) ours = IsOwnedAncestor(pid, started);
                // The original process must still be alive after WMI; a recycled PID may
                // not reuse an old positive result (cache keys include fresh birth + exe).
                return ours && !p.HasExited;
            }
        }
        catch { return false; }
    }

    static bool IsRuntimeChild(string file)
    {
        string name = System.IO.Path.GetFileName(file);
        if (!System.Text.RegularExpressions.Regex.IsMatch(name,
            @"^(qemu-system-(x86_64|i386|aarch64|armel)|netsimd)\.exe$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return false;
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (file.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) return true;
        return false;
    }

    static bool IsOwnedAncestor(uint pid, long childStarted)
    {
        uint parent = ParentOf(pid);
        for (int i = 0; i < 8 && parent != 0; i++)
        {
            try
            {
                using (Process p = Process.GetProcessById((int)parent))
                {
                    long started = p.StartTime.ToUniversalTime().ToFileTimeUtc();
                    // A recycled parent PID points at a process born AFTER the
                    // child. It cannot be that child's creator, no matter how
                    // well its exe/AVD arguments match another instance.
                    if (started > childStarted) { parent = ParentOf(parent); continue; }
                    string file = RealPath(p.MainModule.FileName);
                    if (CandidateOwned(parent, file, started)) return true;
                }
            }
            catch { }
            parent = ParentOf(parent);
        }
        return false;
    }

    static bool IsOurWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd)) return false;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return IsOurs(pid);
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        // Window titles are arbitrary text, never process ownership evidence.
        return IsOurs(pid) || ConsoleOwnedByUs(pid);
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // 注意：模拟器开机阶段（以及被常驻压制藏起来之后）这个窗口是**不可见**的，
    // 所以这里不能再按 IsWindowVisible 过滤 —— 否则永远找不到可嵌入的窗口，
    // 用户看到的是一个全黑的应用窗口。改为「标题是 Android Emulator 就认，
    // 可见的大窗口优先」。工具栏 / 提示窗（QWindowTool）尺寸太小，被面积阈值挡掉。
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0;
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // 工具栏 / 提示窗不是画面窗口
            // 可见的大窗口优先，其次才是隐藏的
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // 诊断用：列出顶层窗口（类别 / 标题 / pid / 尺寸 / 是否可见）。
    // 用于验证「打开软件只看到软件界面」——模拟器主窗、netsim 控制台都必须不在其中。
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // 隐藏窗口太多（系统里有成百上千个），只看跟模拟器/Qt 有关的
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // 开机阶段：把 qemu / emulator 的黑色控制台窗口藏起来，避免「命令窗口」闪现。
    // 它们是 console 子系统进程，Node 的 windowsHide 覆盖不到子进程，只能靠 Win32 周期压住。
    //
    // 关键坑：Windows 10 以后控制台窗口真正属于 conhost.exe，GetWindowThreadProcessId
    // 拿到的是 conhost 的 pid，不是 emulator 的 pid —— 老实现按 pid 白名单匹配，
    // 于是这些黑窗一个都藏不住（"点了没反应，先弹个 cmd 黑框"就是这么来的）。
    // 现在改成「pid 命中 或 窗口标题命中（标题就是被启动的 exe 路径）」，两条路任一生效即隐藏。
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // 先扫一遍有哪些控制台窗口；一个都没有就别去枚举进程（GetProcessesByName 不便宜）
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // 老实现还有一条「标题里含 emulator / qemu / netsim 就算我们的」，
        // 那会把用户自己开的终端（标题是某个路径，比如 D://Android//emulator）也一起藏掉。
        // 现在只认两种证据：conhost 的父进程链能走到我们运行时目录里，
        // 或者标题里出现我们运行时目录的绝对路径（Windows 会把镜像路径当控制台标题）。
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) ShowWindow(h, 0);
        }
    }

    // 诊断用：列出当前「可见」的控制台窗口（黑窗）及其归属，供 tools 里的验证脚本使用。
    // ours=true 表示这就是 emulator/qemu 的控制台窗口。
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // 兜底：把「我们的运行时进程」创建的任何**多余的顶层可见窗口**都藏起来。
    // 除了模拟器主窗口（要嵌进宿主）之外，emulator / qemu / netsimd / adb 都可能
    // 弹出一些一闪而过的东西（Qt 提示框、崩溃对话框、音量条、日志窗…）。
    // 以前只按类名逐个点名，漏一个就闪一次；这里改成按「进程属于我们的运行时目录」
    // 判断，覆盖面更全。宿主窗口和模拟器窗口本身不在这个范围，绝不会误伤。
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // 只藏明确的弹窗类：Qt 提示窗 / 对话框 / 控制台。
            // 绝不碰 QWindowIcon / subWin —— 那是正在嵌入的 LCD，藏掉就全黑且点击失效。
            // 黑屏兜底摘出来的独立窗口也是这一类：正在给用户看，必须放过。
            if (_standalone && cls.IndexOf("QWindowIcon", StringComparison.Ordinal) >= 0) return true;
            bool safe = cls.IndexOf("QWindowTool", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("Qt", StringComparison.Ordinal) < 0 && cls.IndexOf("Chrome", StringComparison.Ordinal) < 0;
            if (!safe) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // 常驻压制扫描：只要模拟器窗口还不是「我们某个窗口的子窗口」，就把它藏起来。
    // 这样无论模拟器是在开机、预热，还是 ApkStart 已经退出（窗口被系统重新挂到桌面，
    // 恢复成顶层窗口），用户都不会看到那个叫 "Android Emulator - apkstart5554" 的黑窗。
    // 同时把工具栏（QWindowTool）与所有控制台窗口（qemu / netsimd / emulator）压住。

    // ---- fork 附加的诊断能力（上游没有，保留给「无头运行时」检测与排查） ----

    // 真·父窗口：GetParent 对 WS_POPUP 返回的是 owner 而不是父窗口，
    // 判断「是否真的嵌进宿主」必须用 GA_PARENT(1)。
    static IntPtr RealParent(IntPtr h)
    {
        return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, 1);
    }

    // 模拟器的画面窗口是否还存在（隐藏 / 已嵌入都算）。
    // qemu 活着但 Qt 窗口没了时每次 embed 都会失败（embed failed: emu=0），
    // 用户看到的是永久黑窗。ListWindows 只看可见窗口，会把「刚被我们压住」误判
    // 成「窗口没了」，所以这里走 FindEmulator（认隐藏窗口 + 校验进程归属）。
    static bool EmuAlive()
    {
        if (_scopeDirs.Count == 0) return true;   // 作用域未建立时不能下结论
        if (IsOurWindow(_emu)) return true;
        return FindEmulator() != IntPtr.Zero;
    }

    // 失焦/遮挡后让 Qt 子窗口重新参与合成：只做无激活重排 + 立即重绘，
    // 不抢焦点、不发输入，避免 DWM/Qt 交换链留下一块黑帧。
    static void Refresh()
    {
        if (!IsOurWindow(_emu) || !ValidHost()) return;
        IntPtr rp = RealParent(_emu);
        bool embedded = _host != IntPtr.Zero && (rp == _host || rp == _chromeRender);
        if (!embedded) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
        RedrawWindow(_emu, IntPtr.Zero, IntPtr.Zero,
            RDW_INVALIDATE | RDW_UPDATENOW | RDW_ALLCHILDREN);
    }

    /**
     * 采样模拟器窗口当前画面的平均亮度（-1 = 抓不到，不要据此下结论）。
     * SetParent 成功、尺寸也对，但 Qt/GL 渲染表面死掉时窗口就是一片黑；
     * 只有抓像素才能发现。实测黑帧 mean≈27，正常画面 mean≈84~130。
     * 只取中央 76%：四周的灰色内边距会把纯黑抬高，导致漏判。
     */
    static int MeanBrightness(IntPtr hwnd)
    {
        if (!IsOurWindow(hwnd)) return -1;
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return -1;
        int w = r.R - r.L, h = r.B - r.T;
        if (w <= 8 || h <= 8) return -1;
        IntPtr screen = GetDC(IntPtr.Zero);
        IntPtr mem = CreateCompatibleDC(screen);
        IntPtr bmp = CreateCompatibleBitmap(screen, w, h);
        IntPtr old = SelectObject(mem, bmp);
        int mean = -1;
        try
        {
            if (PrintWindow(hwnd, mem, 2))
            {
                BITMAPINFO bi = new BITMAPINFO();
                bi.bmiHeader.biSize = 40;
                bi.bmiHeader.biWidth = w;
                bi.bmiHeader.biHeight = -h;   // 负数 = 自上而下，省一次翻转
                bi.bmiHeader.biPlanes = 1;
                bi.bmiHeader.biBitCount = 32;
                bi.bmiHeader.biCompression = 0;
                byte[] bits = new byte[w * h * 4];
                if (GetDIBits(mem, bmp, 0, (uint)h, bits, ref bi, 0) > 0)
                {
                    long sum = 0; int n = 0;
                    int y0 = (int)(h * 0.12), y1 = (int)(h * 0.88);
                    int x0 = (int)(w * 0.12) * 4, x1 = (int)(w * 0.88) * 4;
                    int stride = w * 4;
                    for (int yy = y0; yy < y1; yy += 2)
                    {
                        int off = yy * stride;
                        for (int xx = x0; xx < x1; xx += 512) { sum += bits[off + xx]; n++; }
                    }
                    if (n > 0) mean = (int)(sum / n);
                }
            }
        }
        catch { mean = -1; }
        finally
        {
            SelectObject(mem, old);
            DeleteObject(bmp);
            DeleteDC(mem);
            ReleaseDC(IntPtr.Zero, screen);
        }
        return mean;
    }

    // 列出宿主窗口的直接子窗口（诊断用）：确认 Chrome_RenderWidgetHostHWND 是否存在。
    static string ListChildren(long hostHwnd)
    {
        IntPtr h = hostHwnd != 0 ? new IntPtr(hostHwnd) : _host;
        if (h == IntPtr.Zero)
        {
            IntPtr foundHost = IntPtr.Zero;
            EnumWindows(delegate(IntPtr w, IntPtr p)
            {
                if (ClassOf(w).IndexOf("Chrome_WidgetWin", StringComparison.Ordinal) < 0) return true;
                uint pid;
                GetWindowThreadProcessId(w, out pid);
                if (_appPid != 0 && pid != _appPid) return true;
                foundHost = w;
                return false;
            }, IntPtr.Zero);
            h = foundHost;
        }
        var sb = new StringBuilder();
        if (h != IntPtr.Zero)
        {
            EnumChildWindows(h, delegate(IntPtr c, IntPtr p)
            {
                RECT r;
                GetWindowRect(c, out r);
                if (sb.Length > 0) sb.Append(",");
                sb.Append("{\"hwnd\":").Append(c.ToInt64())
                  .Append(",\"cls\":").Append(JsonStr(ClassOf(c)))
                  .Append(",\"vis\":").Append(IsWindowVisible(c) ? "true" : "false")
                  .Append(",\"w\":").Append(r.R - r.L)
                  .Append(",\"h\":").Append(r.B - r.T)
                  .Append("}");
                return true;
            }, IntPtr.Zero);
        }
        return "\"host\":" + h.ToInt64() + ",\"list\":[" + sb + "]";
    }

    static void QuietSweep()
    {
        // 只重放最近一次 JS 确认的物理像素矩形。不能用固定 38px 标题栏覆盖
        // Electron 按所在显示器 DPI 算出的矩形；网页层晚创建时 Fit 会验证并补挂。
        if (_emu != IntPtr.Zero && _host != IntPtr.Zero && _hasFitRect)
            Fit(_fitX, _fitY, _fitW, _fitH, false, 0);
        IntPtr ep = _emu != IntPtr.Zero ? GetParent(_emu) : IntPtr.Zero;
        bool embedded = IsOurWindow(_emu) && ValidHost() && ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        IntPtr e = embedded ? _emu : FindEmulator();
        // 黑屏兜底摘出来的独立窗口是用户正在看的画面，绝不能再压掉
        if (!embedded && !_standalone && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach

    // 找宿主窗口里的 Chromium 渲染子窗口。
    // Electron 的网页层（Chrome_RenderWidgetHostHWND）和模拟器窗口如果都是宿主的
    // 直接子窗口，它们就是「兄弟」，而 Electron 会持续把网页层抬到最前 ——
    // 于是网页层那块黑底盖住安卓画面、鼠标也全被它吃掉（用户看到的「黑边 /
    // 未填满 / 点击失效 / 点不动同意」全是这个）。
    // 把模拟器挂成网页层的**子窗口**后，Z 序与鼠标命中天然优先给模拟器。
    static IntPtr FindChromeRender(IntPtr host)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(host, delegate(IntPtr c, IntPtr p)
        {
            if (ClassOf(c).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) >= 0)
            {
                found = c;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string _windowError = "";
    static int _windowWin32Error = 0;
    static bool _hasFitRect = false;
    static int _fitX, _fitY, _fitW, _fitH;
    static IntPtr _placementEmu = IntPtr.Zero;
    static RECT _standaloneRect;
    static bool _hasStandaloneRect = false;

    static bool WindowFailure(string error, int code)
    {
        _windowError = error;
        _windowWin32Error = code;
        return false;
    }

    static string WindowReply(bool ok)
    {
        return "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64()
            + (ok ? "" : ",\"error\":" + JsonStr(_windowError) + ",\"win32\":" + _windowWin32Error) + "}";
    }

    static bool Reparent(IntPtr child, IntPtr parent)
    {
        // SetParent returns the PREVIOUS parent: zero is normal for a top-level window.
        // Clear/capture last-error at the call boundary, then verify the actual result.
        SetLastError(0);
        SetParent(child, parent);
        int error = Marshal.GetLastWin32Error();
        IntPtr actual = GetParent(child);
        // SetParent(child, NULL) moves a WS_CHILD window to the desktop. Until
        // ReleaseEmulator clears WS_CHILD, GetParent returns that desktop HWND.
        bool desktop = parent == IntPtr.Zero && actual == GetDesktopWindow();
        if (!IsWindow(child) || (actual != parent && !desktop))
            return WindowFailure("set-parent-failed", error);
        return true;
    }

    static bool SetStyle(IntPtr hwnd, int index, int value)
    {
        SetLastError(0);
        int previous = SetWindowLong(hwnd, index, value);
        int error = Marshal.GetLastWin32Error();
        return previous != 0 || error == 0 || WindowFailure("set-style-failed", error);
    }

    static bool ValidHost()
    {
        if (_host == IntPtr.Zero || !IsWindow(_host)) return false;
        uint pid;
        GetWindowThreadProcessId(_host, out pid);
        return _appPid == 0 || pid == _appPid;
    }

    static void RememberStandalone(IntPtr emu)
    {
        RECT r;
        if (GetParent(emu) == IntPtr.Zero && ((uint)GetWindowLong(emu, GWL_STYLE) & WS_CHILD) == 0
            && GetWindowRect(emu, out r) && r.R > r.L && r.B > r.T)
        {
            _placementEmu = emu;
            _standaloneRect = r;
            _hasStandaloneRect = true;
        }
    }

    static bool Embed(IntPtr host, IntPtr emu)
    {
        _hasFitRect = false;
        if (!IsOurWindow(emu)) return WindowFailure("emu=0", 0);
        if (host != _host || !ValidHost()) return WindowFailure("host-not-ours", 0);
        HideToolWindows();
        RememberStandalone(emu);
        IntPtr parent = FindChromeRender(host);
        if (parent == IntPtr.Zero) parent = host;
        int originalStyle = GetWindowLong(emu, GWL_STYLE);
        uint style = (uint)originalStyle;
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        // WS_CHILD makes GetParent unambiguous (WS_POPUP would report its owner).
        if (!SetStyle(emu, GWL_STYLE, (int)style)) return false;
        if (!Reparent(emu, parent))
        {
            SetWindowLong(emu, GWL_STYLE, originalStyle);
            return false;
        }
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        if (!SetStyle(emu, GWL_EXSTYLE, ex)) return false;
        _standalone = false;
        _chromeRender = parent == host ? IntPtr.Zero : parent;
        SetWindowRgn(emu, IntPtr.Zero, false);
        return true;
    }

    // Win32 HWND_TOP is zero. 1 is HWND_BOTTOM, which hides Qt behind Chromium.
    static readonly IntPtr HWND_TOP = IntPtr.Zero;
    static bool Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (!IsOurWindow(_emu)) return WindowFailure("emu=0", 0);
        if (_standalone) return WindowFailure("not-embedded", 0);
        if (!ValidHost())
        {
            ShowWindow(_emu, 0);
            return WindowFailure("host-not-ours", 0);
        }
        IntPtr ep = GetParent(_emu);
        if (ep == IntPtr.Zero || (ep != _host && ep != _chromeRender))
        {
            ShowWindow(_emu, 0);
            return WindowFailure("embed-parent-mismatch", 0);
        }
        if (w <= 0 || h <= 0) return WindowFailure("invalid-rect", 0);
        // The render child may appear after embed. Never acknowledge a failed reparent.
        IntPtr cr = FindChromeRender(_host);
        if (cr != IntPtr.Zero && ep != cr && !Reparent(_emu, cr))
        {
            ShowWindow(_emu, 0);
            return false;
        }
        _chromeRender = cr;
        RECT hc;
        if (!GetClientRect(_host, out hc))
        {
            int error = Marshal.GetLastWin32Error();
            ShowWindow(_emu, 0);
            return WindowFailure("host-client-rect-failed", error);
        }
        // Keep Chromium's clipping surface in sync, but do NOT replace JS's DPI-scaled
        // LCD rectangle with an unscaled 38px title bar. Direct-host fallback uses exactly
        // the same x/y/w/h as the render-child path and periodic sweeps.
        if (cr != IntPtr.Zero)
        {
            RECT crc;
            int cw = hc.R - hc.L, ch = hc.B - hc.T;
            if (cw <= 0 || ch <= 0) return WindowFailure("invalid-host-rect", 0);
            if (!GetWindowRect(cr, out crc) || crc.R - crc.L != cw || crc.B - crc.T != ch)
            {
                if (!SetWindowPos(cr, IntPtr.Zero, 0, 0, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE))
                {
                    int error = Marshal.GetLastWin32Error();
                    ShowWindow(_emu, 0);
                    return WindowFailure("render-fit-failed", error);
                }
            }
        }
        // Only show after re-checking the real parent; stale/foreign parents are failures.
        ep = GetParent(_emu);
        if (ep == IntPtr.Zero || (ep != _host && ep != cr))
        {
            ShowWindow(_emu, 0);
            return WindowFailure("embed-parent-mismatch", 0);
        }
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        if (!SetWindowPos(_emu, HWND_TOP, x, y, Math.Max(16, w), Math.Max(16, h), flags))
        {
            int error = Marshal.GetLastWin32Error();
            ShowWindow(_emu, 0);
            return WindowFailure("emu-fit-failed", error);
        }
        _fitX = x; _fitY = y; _fitW = w; _fitH = h;
        _hasFitRect = true;
        // No window region: it breaks Qt/GL hit testing. Keep the existing physical 8px pad.
        return true;
    }

    static void Raise()
    {
        if (!IsOurWindow(_emu) || !ValidHost()) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static bool ReleaseEmulator(bool show)
    {
        _hasFitRect = false;
        if (!IsOurWindow(_emu)) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero)
        {
            _host = IntPtr.Zero;
            return show ? WindowFailure("emu=0", 0) : true;
        }
        RememberStandalone(e);
        bool wasChild = ((uint)GetWindowLong(e, GWL_STYLE) & WS_CHILD) != 0;
        RECT placement = new RECT();
        bool place = wasChild && (_hasStandaloneRect && _placementEmu == e);
        if (place) placement = _standaloneRect;
        else if (wasChild) place = GetWindowRect(e, out placement);
        // Park must hide BEFORE removing the parent; failed release stays hidden and the
        // caller receives false. No pending fit may re-show it during close/park handoff.
        if (!show) ShowWindow(e, 0);
        if (GetParent(e) != IntPtr.Zero && !Reparent(e, IntPtr.Zero)) return false;
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        if (!SetStyle(e, GWL_STYLE, (int)style)) return false;
        int ex = GetWindowLong(e, GWL_EXSTYLE) | WS_EX_APPWINDOW;
        if (!SetStyle(e, GWL_EXSTYLE, ex)) return false;
        uint flags = SWP_NOZORDER | SWP_FRAMECHANGED | (show ? SWP_SHOWWINDOW : SWP_NOACTIVATE);
        if (!place) flags |= SWP_NOMOVE | SWP_NOSIZE;
        if (!SetWindowPos(e, IntPtr.Zero, placement.L, placement.T,
            placement.R - placement.L, placement.B - placement.T, flags))
            return WindowFailure("release-fit-failed", Marshal.GetLastWin32Error());
        _standalone = show;
        if (show)
        {
            // SW_SHOW preserves maximized geometry; restore only if actually minimized.
            // Repeated foreground requests never reset the user's screen/position/size.
            ShowWindow(e, IsIconic(e) ? 9 : 5);
            HideToolWindows();
            SetForegroundWindow(e);
        }
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
        _chromeRender = IntPtr.Zero;
        return true;
    }

    static bool Detach() { return ReleaseEmulator(true); }

    // Hide -> detach -> acknowledge -> JS destroys host. Preserve the existing ordering.
    static bool ParkEmulator()
    {
        _standalone = false;
        return ReleaseEmulator(false);
    }

    // ------------------------------------------------------------------ rotation
    // 模拟器的转屏是「改面板方向」，只有它自己的 Qt 快捷键 Ctrl+←/→ 会触发；
    // 控制台命令 adb emu rotate 只是把画面转 90°，系统里仍然是竖屏（画面横躺）。
    // 难点是快捷键必须由模拟器窗口收到键盘消息，而它已经是我们窗口的子窗口、
    // 焦点在网页层。所以先把两个线程的输入队列接起来，把焦点临时给模拟器，
    // 按完键再还回去。
    static void Rotate(string dir)
    {
        if (!IsOurWindow(_emu)) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (RemoteInputActive())
        {
            if (_hook != IntPtr.Zero || (_hookThread != null && _hookThread.IsAlive)) HookOff();
            _hookReady.Set();
            return;
        }
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }

    static bool RemoteInputActive()
    {
        string[] names = { "SunloginClient", "SunloginRemote", "SunloginControl", "SunloginService", "awesun", "awesun_guard", "OrayRemote", "ToDesk", "RustDesk" };
        try
        {
            for (int i = 0; i < names.Length; i++)
                if (Process.GetProcessesByName(names[i]).Length > 0) return true;
        }
        catch { }
        return false;
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // _hookProc 故意保留引用：钩子线程可能正在执行回调，提前置 null
        // 会让委托被 GC 回收。线程退出时会自然释放。
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        StringBuilder value = new StringBuilder();
        while (i < line.Length)
        {
            char c = line[i++];
            if (c == '"') return value.ToString();
            if (c < 32) return "";
            if (c != '\\') { value.Append(c); continue; }
            if (i >= line.Length) return "";
            c = line[i++];
            if (c == '"' || c == '\\' || c == '/') value.Append(c);
            else if (c == 'b') value.Append('\b');
            else if (c == 'f') value.Append('\f');
            else if (c == 'n') value.Append('\n');
            else if (c == 'r') value.Append('\r');
            else if (c == 't') value.Append('\t');
            else if (c == 'u')
            {
                int code;
                if (i + 4 > line.Length || !int.TryParse(line.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code)) return "";
                value.Append((char)code); i += 4;
            }
            else return "";
        }
        return "";
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
        // 必须在任何窗口操作之前：PerMonitorV2 = -4；老系统退回 System DPI Aware。
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch { try { SetProcessDPIAware(); } catch { } }
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // 常驻压制：模拟器主窗 / 工具栏 / qemu·netsimd 控制台黑窗。
            // 每轮要枚举全桌面窗口若干次，开销不小 —— 之前 120ms 一轮持续 90 秒，
            // 会明显拖慢整机（用户反馈「整个系统卡顿」）。实际上窗口已经嵌入后
            // 根本不需要这么频繁：开机前 10 秒 250ms 抓闪窗，之后 1500ms 兜底即可。
            // game 模式（_perfMode）下进一步降到 3000ms，把 CPU 全留给安卓渲染。
            long sweepGap;
            if (_perfMode) sweepGap = (now - _bootHideStart < 10000) ? 300 : 3000;
            else sweepGap = (now - _bootHideStart < 10000) ? 250 : 1500;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            try
            {
                // 连接已经断了（ApkStart 退出 / 异常崩溃）：不立刻收工。
                // 模拟器可能还在开机，几十秒后 Qt 才把窗口显示出来 —— 那时如果
                // 已经没有代理在盯着，桌面上就会留一个 Android Emulator 黑窗。
                // 所以断线后继续「守」一会儿，直到最后一段时间没有模拟器进程。
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // 模拟器都退干净了就不用再守
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        SetAvdScope(S(line, "avdDir"), S(line, "avdName"), System.Text.RegularExpressions.Regex.IsMatch(line, "\"avdDir\"\\s*:"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // 嵌入即代表「用户要看画面了」。压制不关（它只藏非嵌入窗口
                        // 与控制台黑窗），但要先把窗口从隐藏状态正确地交给 SetParent，
                        // 再由 Fit 的 SWP_SHOWWINDOW 显示出来。
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "ApkStart ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _chromeRender = FindChromeRender(want);
                            // A previous attempt may have reparented successfully before Fit failed;
                            // EnumWindows cannot rediscover that child. Reuse only a revalidated handle.
                            if (!IsOurWindow(_emu)) _emu = FindEmulator();
                            bool ok = Embed(_host, _emu)
                                && Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            _embedAt = ok ? Environment.TickCount : 0;
                            _lastToolSweep = 0;
                            Reply(sock, WindowReply(ok));
                        }
                    }
                    else if (cmd == "fit")
                    {
                        bool ok = Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, WindowReply(ok));
                    }
                    else if (cmd == "refresh")
                    {
                        Refresh();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "pixmean")
                    {
                        // 采样模拟器窗口当前画面的平均亮度，判定「嵌入成功但全黑」
                        Reply(sock, "{\"ok\":true,\"mean\":" + MeanBrightness(_emu) + "}");
                    }
                    else if (cmd == "emuok")
                    {
                        Reply(sock, "{\"ok\":true,\"alive\":" + (EmuAlive() ? "true" : "false") + "}");
                    }
                    else if (cmd == "children")
                    {
                        Reply(sock, "{\"ok\":true," + ListChildren(L(line, "host")) + "}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (IsOurWindow(_emu)) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "perf")
                    {
                        // JS 侧根据 priorityMode 通知：game 模式下降频窗口扫描
                        _perfMode = L(line, "on") != 0;
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        if (IsOurWindow(_emu)) ShowWindow(_emu, 5);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "detach")
                    {
                        // 找不到模拟器窗口时如实回 false：上层要靠这个值区分
                        // 「已经切到独立窗口」和「窗口根本没了，得重启运行时」。
                        bool detached = Detach();
                        Reply(sock, WindowReply(detached));
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64() + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            QuietSweep();
                        }
                        else
                        {
                            // 保留窗口不动，只把控制台黑窗再压一遍（关掉 quiet 一般是因为
                            // 用户想自己看一眼模拟器窗口，见设置 startVisible）。
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // 应用窗口要关了：先把模拟器窗口从宿主上摘下来并藏好，
                        // 避免宿主销毁时 Windows 把它重新挂到桌面、恢复成顶层可见窗口
                        // （用户看到的「凭空冒出一个 Android Emulator 黑窗」就是这么来的）。
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        bool parked = ParkEmulator();
                        Reply(sock, WindowReply(parked));
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
