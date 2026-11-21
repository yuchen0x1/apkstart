'use strict';
// Production AppWindow with inert Electron/agent doubles. No main, ADB or emulator startup.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const CORE = path.resolve(__dirname, '../src/core');
const source = fs.readFileSync(path.join(CORE, 'appwin.js'), 'utf8');

function harness(scaleFactor = 1) {
  const commands = [], timers = new Set();
  const cursorDisplay = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
  const windowDisplay = { workArea: { x: -1920, y: -100, width: 1920, height: 1080 }, scaleFactor };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.resizes = 0;
      this.moves = 0;
    }
    loadFile() {}
    isDestroyed() { return false; }
    isVisible() { return !!this.visible; }
    isMaximized() { return !!this.maximized; }
    isMinimized() { return !!this.minimized; }
    getBounds() { return { ...this.bounds }; }
    getContentBounds() { return this.getBounds(); }
    getNativeWindowHandle() { return Buffer.from([7, 0, 0, 0]); }
    show() { this.visible = true; commands.push('host:show'); }
    hide() { this.visible = false; commands.push('host:hide'); }
    focus() { commands.push('host:focus'); }
    moveTop() { commands.push('host:top'); }
    restore() { this.minimized = false; commands.push('host:restore'); }
    maximize() { this.maximized = true; }
    unmaximize() { this.maximized = false; }
    setPosition(x, y) { this.moves++; Object.assign(this.bounds, { x, y }); }
    setContentSize(width, height) { this.resizes++; Object.assign(this.bounds, { width, height }); }
  }
  const agent = {
    detach: async () => { commands.push('native:detach'); return { ok: true }; },
    fit: async rect => { commands.push({ fit: { ...rect } }); return { ok: true }; },
    show: async () => { commands.push('native:show'); return { ok: true }; },
  };
  const dependencies = {
    electron: { BrowserWindow: FakeWindow, nativeImage: {}, screen: {
      getCursorScreenPoint: () => ({ x: 300, y: 300 }),
      getDisplayNearestPoint: () => cursorDisplay,
      getDisplayMatching: () => windowDisplay,
    } },
    fs: { existsSync: () => false }, path,
    './pointer': { hookOptions: () => ({ enabled: false }) },
    './platform': { canEmbed: true }, './store': { getSettings: () => ({}) },
  };
  const mod = { exports: {} };
  vm.runInNewContext(source, {
    __dirname: CORE, process: { env: {} }, module: mod,
    setTimeout(fn, delay) { const t = { fn, delay, unref() {} }; timers.add(t); return t; },
    clearTimeout(t) { timers.delete(t); },
    require(name) { assert(name in dependencies, `unexpected dependency ${name}`); return dependencies[name]; },
  }, { filename: path.join(CORE, 'appwin.js') });
  const app = new mod.exports.AppWindow({ agent });
  const win = app.open({ pkg: 'test.app', lcd: { w: 540, h: 960 } });
  win.bounds = { x: -1850, y: -70, width: 600, height: 900 };
  return { app, win, commands, timers, windowDisplay };
}

for (const scale of [1, 1.25, 1.5, 2]) {
  test(`LCD physical rectangle uses the current display at ${scale * 100}%`, async () => {
    const h = harness(scale);
    await h.app.fitNow();
    const rect = h.commands.find(c => c.fit).fit;
    assert.deepEqual(rect, {
      x: -8, y: Math.round(38 * scale) - 8,
      w: Math.round(600 * scale) + 16, h: Math.round(862 * scale) + 16, clipTop: 8,
    });
    assert.equal(rect.y + rect.h - 8, Math.round(38 * scale) + Math.round(862 * scale));
  });
}

test('applyBox retains its display and position instead of following the cursor/centering', () => {
  const h = harness(1.5);
  h.app.applyBox({ w: 720, h: 1280 });
  assert.equal(h.win.bounds.x, -1850);
  assert.equal(h.win.bounds.y, -70);
  assert(h.win.bounds.x + h.win.bounds.width <= 0);
  assert(h.win.bounds.y + h.win.bounds.height <= 980);
  h.win.bounds = { x: -1700, y: 0, width: 440, height: 700 };
  const calls = [h.win.resizes, h.win.moves];
  h.app.applyBox({ w: 720, h: 1280 });
  assert.deepEqual([h.win.resizes, h.win.moves], calls, 'same LCD must preserve user size/position');
  assert.deepEqual(h.win.bounds, { x: -1700, y: 0, width: 440, height: 700 });
});

test('applyBox only clamps overflow inside the existing display and restores maximization', () => {
  const h = harness();
  h.win.bounds = { x: -350, y: 800, width: 320, height: 420 };
  h.win.maximized = true;
  h.app.applyBox({ w: 960, h: 540 });
  assert.equal(h.win.bounds.x + h.win.bounds.width, 0);
  assert.equal(h.win.bounds.y + h.win.bounds.height, 980);
  assert.equal(h.win.isMaximized(), true);
});

test('warm reveal restores the existing host without changing geometry or ready state', async () => {
  const h = harness();
  const before = h.win.getBounds();
  h.win.minimized = true;
  h.app.state.ready = true;
  assert.equal(await h.app.reveal(), true);
  assert.deepEqual(h.commands, ['host:restore', 'host:show', 'host:top', 'host:focus']);
  assert.deepEqual(h.win.getBounds(), before);
  assert.equal(h.app.state.ready, true);
  assert.equal(h.win.moves, 0);
  assert.equal(h.win.resizes, 0);
});

test('standalone reveal never shows the hidden host or fits/repositions it', async () => {
  const h = harness();
  h.app.standaloneActive = true;
  h.app._hidden = true;
  for (let i = 0; i < 3; i++) {
    assert.equal(await h.app.reveal(), true);
    await h.app.fitNow();
  }
  assert.deepEqual(h.commands, ['native:detach', 'native:detach', 'native:detach']);
  assert.equal(h.win.moves, 0);
  assert.equal(h.win.resizes, 0);
  h.app.standaloneActive = false;
  assert.equal(await h.app.reveal(), false, 'unready hidden host must stay hidden');
});

test('queued fit rechecks standalone state after ownership handoff', async () => {
  const h = harness();
  let done;
  const gate = new Promise(resolve => { done = resolve; });
  const pending = h.app._queueOwnership(h.app.agent, () => gate);
  const fit = h.app.fitNow();
  h.app.standaloneActive = true;
  done();
  await Promise.all([pending, fit]);
  assert.equal(h.commands.length, 0);
});

// Replace only OS/identity boundaries, then compile and execute the production C# methods.
// Every unimplemented P/Invoke throws, so this cannot touch actual windows/processes.
function replaceMethod(text, signature, body) {
  const start = text.indexOf(signature);
  assert(start >= 0, `missing native boundary ${signature}`);
  const open = text.indexOf('{', start);
  let end = open + 1, depth = 1;
  while (depth && end < text.length) {
    const c = text[end++];
    if (c === '{') depth++;
    if (c === '}') depth--;
  }
  assert.equal(depth, 0);
  return text.slice(0, open) + '{ ' + body + ' }' + text.slice(end);
}

function mockNativeSource(original) {
  const bodies = {
    EnumWindows: 'return FakeWindows.EnumTop(cb, p);',
    EnumChildWindows: 'if (FakeWindows.Chrome && parent == FakeWindows.Host) cb(FakeWindows.Render, p); return true;',
    IsWindowVisible: 'return FakeWindows.Visible;',
    GetClassNameW: 's.Append(h == FakeWindows.Render ? "Chrome_RenderWidgetHostHWND" : "QWindowIcon"); return s.Length;',
    GetWindowTextW: 's.Append("Android Emulator - apkstart:5554"); return s.Length;',
    IsWindow: 'return FakeWindows.Rects.ContainsKey(h);',
    GetParent: 'return FakeWindows.Parents.ContainsKey(c) ? FakeWindows.Parents[c] : IntPtr.Zero;',
    GetAncestor: 'return FakeWindows.Parents.ContainsKey(h) ? FakeWindows.Parents[h] : IntPtr.Zero;',
    SetParent: 'return FakeWindows.Parent(c, p);',
    SetLastError: 'FakeWindows.LastError = (int)error;',
    GetWindowLong: 'return FakeWindows.Styles[h.ToString() + ":" + i];',
    SetWindowLong: 'string key = h.ToString() + ":" + i; int old = FakeWindows.Styles[key]; FakeWindows.Styles[key] = v; return old;',
    SetWindowPos: 'return FakeWindows.Position(h, after, x, y, w, hh, f);',
    ShowWindow: 'FakeWindows.Log.Add((c == 0 ? "hide:" : "show:") + h); FakeWindows.Visible = c != 0; FakeWindows.ShowCommand = c; return false;',
    SetWindowRgn: 'return 1;',
    GetWindowRect: 'r = FakeWindows.Rects[h]; return true;',
    GetClientRect: 'r = new RECT { R = FakeWindows.ClientW, B = FakeWindows.ClientH }; return true;',
    GetWindowThreadProcessId: 'pid = h == FakeWindows.Host || h == FakeWindows.Render ? 111u : (h == FakeWindows.Emu ? 222u : 333u); return 1;',
    IsIconic: 'return FakeWindows.Minimized;',
    SetForegroundWindow: 'FakeWindows.Foreground = h; return true;',
    RedrawWindow: 'return true;',
  };
  let count = 0;
  let text = original.replace(/\[DllImport\([^\r\n]*\)\]\s*static extern ([^;\r\n]+);/g, (_, declaration) => {
    count++;
    const name = declaration.match(/(\w+)\s*\(/)[1];
    return `static ${declaration} { ${bodies[name] || `throw new InvalidOperationException("Unmocked native: ${name}");`} }`;
  });
  assert(count > 50, 'all native declarations must be isolated');
  assert(!text.includes('static extern'), 'no real P/Invoke may remain in the behavior harness');
  text = text.replace(/Marshal\.GetLastWin32Error\(\)/g, 'FakeWindows.LastError');
  text = replaceMethod(text, 'static string RealPath(string name)', 'return FakeWindows.Canonical(name);');
  text = replaceMethod(text, 'static string NarrowDirectory(string name)',
    'string path = FakeWindows.Canonical(name); return path.StartsWith(@"c:\\data\\", StringComparison.Ordinal) ? path : "";');
  text = replaceMethod(text, 'static bool IsOurs(uint pid)', 'return pid == 222;');
  text = replaceMethod(text, 'static bool ReadAvdIdentity(uint pid, long started, string exe)',
    'FakeWindows.WmiCalls++; return FakeWindows.QueryBirth == started && MatchesAvd(exe, FakeWindows.QueryArgs, _scopeAvd, _scopeAvdName);');
  return text.replace(/\bApkAgent\b/g, 'WindowSafetyAgent');
}

const nativeHarness = String.raw`
public static class FakeWindows
{
    public static readonly IntPtr Host = new IntPtr(100), Emu = new IntPtr(200), Render = new IntPtr(300), Foreign = new IntPtr(400);
    public static readonly System.Collections.Generic.Dictionary<IntPtr, WindowSafetyAgent.RECT> Rects = new System.Collections.Generic.Dictionary<IntPtr, WindowSafetyAgent.RECT>();
    public static readonly System.Collections.Generic.Dictionary<IntPtr, IntPtr> Parents = new System.Collections.Generic.Dictionary<IntPtr, IntPtr>();
    public static readonly System.Collections.Generic.Dictionary<string, int> Styles = new System.Collections.Generic.Dictionary<string, int>();
    public static readonly System.Collections.Generic.List<string> Log = new System.Collections.Generic.List<string>();
    public static bool Chrome, FailParent, LieParent, FailPosition, Visible, Minimized;
    public static int LastError, ShowCommand, ClientW, ClientH, WmiCalls;
    public static long QueryBirth;
    public static string[] QueryArgs;
    public static IntPtr Foreground;
    public static int X, Y, W, H;
    public static uint Flags;
    public static IntPtr After;
    public static string Canonical(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || !System.IO.Path.IsPathRooted(name)) return "";
        return name.Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();
    }
    public static void Reset(bool chrome)
    {
        Chrome = chrome; FailParent = LieParent = FailPosition = Visible = Minimized = false;
        LastError = ShowCommand = WmiCalls = 0;
        ClientW = 900; ClientH = 1350;
        Rects.Clear(); Parents.Clear(); Styles.Clear(); Log.Clear();
        Rects[Host] = new WindowSafetyAgent.RECT { L = -1800, T = 20, R = -900, B = 1370 };
        Rects[Emu] = new WindowSafetyAgent.RECT { L = -1650, T = 80, R = -1150, B = 880 };
        Rects[Render] = new WindowSafetyAgent.RECT { L = -1800, T = 20, R = -1400, B = 620 };
        Rects[Foreign] = new WindowSafetyAgent.RECT();
        Parents[Host] = Parents[Emu] = Parents[Foreign] = IntPtr.Zero;
        Parents[Render] = Host;
        foreach (IntPtr h in Rects.Keys) { Styles[h + ":-16"] = 0x00CF0000; Styles[h + ":-20"] = 0; }
        NativeWindowSafety.Set("_host", Host); NativeWindowSafety.Set("_emu", Emu);
        NativeWindowSafety.Set("_appPid", 111u); NativeWindowSafety.Set("_chromeRender", IntPtr.Zero);
        NativeWindowSafety.Set("_standalone", false); NativeWindowSafety.Set("_hasFitRect", false);
        NativeWindowSafety.Set("_hasStandaloneRect", false);
    }
    public static bool EnumTop(WindowSafetyAgent.EnumProc cb, IntPtr p)
    {
        if (Parents[Emu] == IntPtr.Zero) cb(Emu, p);
        return true;
    }
    public static IntPtr Parent(IntPtr child, IntPtr parent)
    {
        Log.Add("parent:" + child);
        if (FailParent) { LastError = 5; return IntPtr.Zero; }
        if (LieParent) return new IntPtr(777);
        IntPtr previous = Parents[child]; Parents[child] = parent;
        return previous;
    }
    public static bool Position(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags)
    {
        if (FailPosition && hwnd == Emu) { LastError = 1400; return false; }
        Log.Add("position:" + hwnd);
        WindowSafetyAgent.RECT r = Rects[hwnd];
        int width = (flags & 1) != 0 ? r.R - r.L : w;
        int height = (flags & 1) != 0 ? r.B - r.T : h;
        if ((flags & 2) == 0)
        {
            IntPtr parent = Parents[hwnd];
            r.L = x + (parent == IntPtr.Zero ? 0 : Rects[parent].L);
            r.T = y + (parent == IntPtr.Zero ? 0 : Rects[parent].T);
        }
        r.R = r.L + width; r.B = r.T + height; Rects[hwnd] = r;
        if (hwnd == Emu) { X = x; Y = y; W = w; H = h; Flags = flags; After = after; }
        if ((flags & 0x40) != 0) Visible = true;
        return true;
    }
}

public static class NativeWindowSafety
{
    static readonly System.Reflection.BindingFlags Private = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
    static readonly Type Agent = typeof(WindowSafetyAgent);
    public static void Set(string field, object value) { Agent.GetField(field, Private).SetValue(null, value); }
    static object Get(string field) { return Agent.GetField(field, Private).GetValue(null); }
    static object Call(string method, params object[] args) { return Agent.GetMethod(method, Private).Invoke(null, args); }
    static void Check(bool ok, string name) { if (!ok) throw new Exception(name); }
    static bool Embed() { return (bool)Call("Embed", FakeWindows.Host, FakeWindows.Emu); }
    static bool Fit(int x, int y, int w, int h) { return (bool)Call("Fit", x, y, w, h, true, 8); }
    static bool Same(WindowSafetyAgent.RECT a, WindowSafetyAgent.RECT b) { return a.L == b.L && a.T == b.T && a.R == b.R && a.B == b.B; }
    public static string Run()
    {
        foreach (bool chrome in new bool[] { false, true })
        {
            foreach (double scale in new double[] { 1, 1.25, 1.5, 2 })
            {
                FakeWindows.Reset(chrome);
                FakeWindows.LastError = 1234;
                Check(Embed(), "SetParent returning zero for old desktop parent must succeed");
                Check(FakeWindows.Parents[FakeWindows.Emu] == (chrome ? FakeWindows.Render : FakeWindows.Host), "actual parent");
                int y = (int)Math.Floor(38 * scale + 0.5) - 8;
                int w = (int)Math.Floor(600 * scale + 0.5) + 16;
                int h = (int)Math.Floor(862 * scale + 0.5) + 16;
                Check(Fit(-8, y, w, h), "fit success");
                Check(FakeWindows.X == -8 && FakeWindows.Y == y && FakeWindows.W == w && FakeWindows.H == h, "JS rectangle must survive native fit/fallback at " + scale);
                Check(FakeWindows.After == IntPtr.Zero, "HWND_TOP is zero, not HWND_BOTTOM=1");
                Check((FakeWindows.Flags & 0x20) != 0, "first fit frame change");
                Call("QuietSweep");
                Check(FakeWindows.Y == y && FakeWindows.W == w && FakeWindows.H == h, "quiet sweep must replay DPI rectangle");
                Check((FakeWindows.Flags & 0x20) == 0, "sweep cannot repeatedly frame-change");
                if (!chrome)
                {
                    FakeWindows.Chrome = true;
                    Call("QuietSweep");
                    Check(FakeWindows.Parents[FakeWindows.Emu] == FakeWindows.Render, "late Chromium child reparent");
                    Check(FakeWindows.Y == y && FakeWindows.H == h, "late parent keeps physical geometry");
                }
            }
        }
        FakeWindows.Reset(true); FakeWindows.FailParent = true;
        Check(!Embed(), "failed SetParent must not report embedded");
        Check(!(bool)Get("_hasFitRect"), "failed embed cannot arm sweep");
        Check(((string)Call("WindowReply", false)).Contains("\"ok\":false"), "negative native reply");
        Check((int)Get("_windowWin32Error") == 5, "SetParent error captured before GetParent");
        FakeWindows.Reset(true); FakeWindows.LieParent = true;
        Check(!Embed(), "nonzero SetParent return cannot override mismatching GetParent");
        FakeWindows.Reset(true); Check(Embed(), "embed for parent mismatch");
        FakeWindows.Parents[FakeWindows.Emu] = FakeWindows.Foreign;
        Check(!Fit(-8, 49, 916, 1317), "foreign parent fit must fail");
        Check(!FakeWindows.Visible, "unexpected-parent failure remains hidden");
        Check(((string)Call("WindowReply", false)).Contains("embed-parent-mismatch"), "fit reason must reach reply");
        FakeWindows.Reset(true); Check(Embed(), "embed for fit failure"); FakeWindows.FailPosition = true;
        Check(!Fit(-8, 49, 916, 1317), "failed SetWindowPos must fail reply");
        Check((int)Get("_windowWin32Error") == 1400, "fit Win32 error");
        FakeWindows.Reset(false); Check(Embed(), "fallback embed"); FakeWindows.Chrome = true; FakeWindows.FailParent = true;
        Check(!Fit(-8, 49, 916, 1317), "late Chromium reparent failure must not return success");

        FakeWindows.Reset(true);
        WindowSafetyAgent.RECT original = FakeWindows.Rects[FakeWindows.Emu];
        Check(Embed() && Fit(-8, 49, 916, 1317), "embed before detach");
        Check((bool)Call("Detach"), "detach");
        Check(Same(original, FakeWindows.Rects[FakeWindows.Emu]), "detach restores original screen and size");
        for (int i = 0; i < 3; i++)
        {
            FakeWindows.Rects[FakeWindows.Emu] = new WindowSafetyAgent.RECT { L = -1500 + i * 20, T = 120, R = -950 + i * 20, B = 920 };
            WindowSafetyAgent.RECT moved = FakeWindows.Rects[FakeWindows.Emu];
            Check((bool)Call("Detach"), "repeat standalone reveal");
            Check(Same(moved, FakeWindows.Rects[FakeWindows.Emu]), "standalone reveal retains user geometry");
            Check((FakeWindows.Flags & 3) == 3, "standalone reveal must use NOMOVE/NOSIZE");
            Check(FakeWindows.ShowCommand == 5, "do not restore/unmaximize normal standalone");
        }
        FakeWindows.Minimized = true;
        Check((bool)Call("Detach") && FakeWindows.ShowCommand == 9, "restore minimized standalone only");
        FakeWindows.Reset(true); Check(Embed() && Fit(-8, 49, 916, 1317), "embed before park");
        FakeWindows.Log.Clear();
        Check((bool)Call("ParkEmulator"), "park");
        Check(FakeWindows.Log.IndexOf("hide:200") < FakeWindows.Log.IndexOf("parent:200"), "park must hide before detach");
        Check(!FakeWindows.Visible && (FakeWindows.Flags & 0x40) == 0 && (FakeWindows.Flags & 0x10) != 0, "park never shows/activates");
        FakeWindows.Reset(true); Check(Embed(), "embed before failed park"); FakeWindows.FailParent = true;
        Check(!(bool)Call("ParkEmulator") && !FakeWindows.Visible && !(bool)Get("_hasFitRect"), "failed park stays hidden and unconfirmed");

        FakeWindows.Reset(true);
        var dirs = (System.Collections.Generic.List<string>)Get("_scopeDirs");
        dirs.Clear(); dirs.Add(@"c:\runtime\emulator\");
        Call("SetAvdScope", @"C:\data\a.avd", "apkstart", true);
        string exe = @"c:\runtime\emulator\emulator.exe";
        FakeWindows.QueryBirth = 500;
        FakeWindows.QueryArgs = new string[] { exe, "-avd", "apkstart", "-datadir", @"C:\DATA\a.avd" };
        Check((bool)Call("CandidateOwned", 222u, exe, 500L), "exact canonical datadir match");
        Check((bool)Call("CandidateOwned", 222u, exe, 500L) && FakeWindows.WmiCalls == 1, "positive cache keyed by birth and exe");
        FakeWindows.QueryBirth = 501;
        FakeWindows.QueryArgs[4] = @"C:\data\other.avd";
        Check(!(bool)Call("CandidateOwned", 222u, exe, 501L) && FakeWindows.WmiCalls == 2, "PID reuse must invalidate cached ownership");
        int calls = FakeWindows.WmiCalls;
        Check(!(bool)Call("CandidateOwned", 223u, @"c:\other\emulator.exe", 501L), "outside executable scope");
        Check(!(bool)Call("CandidateOwned", 224u, @"c:\runtime\emulator\wechat.exe", 501L) && FakeWindows.WmiCalls == calls, "no WMI for unrelated executable candidates");
        FakeWindows.QueryBirth = 0;
        Check(!(bool)Call("CandidateOwned", 225u, exe, 502L), "unreadable/recycled WMI identity must fail closed");
        Check(!(bool)Call("MatchesAvd", exe, new string[] { exe, "-avd", "apkstart" }, @"c:\data\a.avd", "apkstart"), "name alone is not instance identity");
        Check((bool)Call("MatchesAvd", exe, new string[] { exe, "-android-hw", @"c:\data\a.avd\hardware-qemu.ini" }, @"c:\data\a.avd", "apkstart"), "QEMU exact hardware path proof");
        Check(!(bool)Call("MatchesAvd", exe, new string[] { exe, "-avd", "other", "-datadir", @"c:\data\a.avd" }, @"c:\data\a.avd", "apkstart"), "conflicting AVD name");
        Check(!(bool)Call("MatchesAvd", exe, new string[] { exe, "-avd", "apkstart", "-datadir", @"c:\data\a.avd", "-datadir", @"c:\data\b.avd" }, @"c:\data\a.avd", "apkstart"), "all duplicate path claims must agree");
        Call("SetAvdScope", "", "apkstart", true);
        Check(!(bool)Call("CandidateOwned", 222u, exe, 500L), "supplied empty/invalid AVD cannot silently broaden scope");
        Call("SetAvdScope", "", "", false);
        Check((bool)Call("CandidateOwned", 222u, exe, 500L), "legacy protocol without AVD remains compatible");
        return "WINDOW_NATIVE_OK: parent truth, Win32 errors, HWND_TOP, DPI/fallback/sweep, standalone placement, park order, AVD isolation/cache";
    }
}
`;

test('native C# window behavior with fake handles, geometry and process identity', { skip: process.platform !== 'win32' }, t => {
  const agentPath = path.join(CORE, 'win/agent.ps1');
  const script = fs.readFileSync(agentPath, 'utf8');
  const match = script.match(/\$src = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert(match, 'embedded C# source');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-window-native-'));
  try {
    const originalFile = path.join(tmp, 'original.cs');
    const fakeFile = path.join(tmp, 'fake.cs');
    const testFile = path.join(tmp, 'run.ps1');
    fs.writeFileSync(originalFile, '\ufeff' + match[1]);
    fs.writeFileSync(fakeFile, '\ufeff' + mockNativeSource(match[1]) + '\n' + nativeHarness);
    fs.writeFileSync(testFile, '\ufeff' + String.raw`param([string]$Agent, [string]$Original, [string]$Fake)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Agent, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Compile the untouched production source too, but never call Serve().
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Original))
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Fake))
[NativeWindowSafety]::Run()
`);
    // Deliberately no ExecutionPolicy Bypass/Unrestricted, no encoded-command fallback.
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', testFile,
      '-Agent', agentPath, '-Original', originalFile, '-Fake', fakeFile], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const output = String(result.stdout || '') + String(result.stderr || '');
    if (result.status !== 0 && /PSSecurityException|UnauthorizedAccess|about_Execution_Policies|AuthorizationManagerCheckFailed/i.test(output)) {
      t.skip('PowerShell execution policy blocked native compile/behavior test; policy was not changed');
      t.diagnostic(output.trim());
      return;
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, output);
    assert.match(output, /WINDOW_NATIVE_OK/);
    t.diagnostic(output.trim());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
