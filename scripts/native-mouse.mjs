// Real windows and a real mouse, for what only the OS can do: a drag out to the file manager.
// It takes over the pointer for a few seconds. Before pressing, it checks that the expected window
// is on top at both ends, so a stray drag can never land in some other program.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Windows is required.');

const desk = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class Desk {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int size);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int ht, uint flags);
  const uint Show = 0x40, NoMoveSize = 3, Down = 2, Up = 4, Move = 1;
  public static void Arrange(IntPtr left, IntPtr right) {
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1) - 80;
    SetWindowPos(left, new IntPtr(-1), 0, 0, w / 2, h, Show);
    SetWindowPos(right, new IntPtr(-1), w / 2, 0, w / 2, h, Show);
  }
  public static void Release(IntPtr window) { SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, NoMoveSize); }
  public static string Origin(IntPtr h) {
    POINT p = new POINT(); ClientToScreen(h, ref p);
    return p.X + "," + p.Y;
  }
  static void Check(IntPtr expected, int x, int y) {
    POINT p = new POINT(); p.X = x; p.Y = y;
    IntPtr found = GetAncestor(WindowFromPoint(p), 2);
    if (found == expected) return;
    System.Text.StringBuilder name = new System.Text.StringBuilder(256);
    GetClassName(found, name, 256);
    uint owner; GetWindowThreadProcessId(found, out owner);
    throw new Exception("Expected window " + expected + " at " + x + "," + y + " but found " + found + " class " + name + " process " + owner);
  }
  static void Go(int x, int y) { SetCursorPos(x, y); mouse_event(Move, 0, 0, 0, UIntPtr.Zero); }
  public static void Drag(IntPtr a, int x1, int y1, IntPtr b, int x2, int y2) {
    Check(a, x1, y1); Check(b, x2, y2);
    Go(x1, y1); Thread.Sleep(200);
    mouse_event(Down, 0, 0, 0, UIntPtr.Zero);
    try {
      Thread.Sleep(200);
      for (int i = 1; i <= 4; i++) { Go(x1 + i * 3, y1 + i * 2); Thread.Sleep(40); }
      Thread.Sleep(700);
      for (int i = 1; i <= 25; i++) { Go(x1 + (x2 - x1) * i / 25, y1 + (y2 - y1) * i / 25); Thread.Sleep(30); }
      Thread.Sleep(500);
    } finally {
      mouse_event(Up, 0, 0, 0, UIntPtr.Zero);
    }
    Thread.Sleep(500);
  }
}
'@
[Desk]::SetProcessDPIAware() | Out-Null
function Find-Folder($folder) {
  (New-Object -ComObject Shell.Application).Windows() | Where-Object {
    try { $_.Document.Folder.Self.Path -eq $folder } catch { $false }
  } | Select-Object -First 1
}
`;

function run(body, env = {}) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', desk + body],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
      env: { ...process.env, ...env },
    },
  );
  if (result.status !== 0) throw new Error(`Desktop step failed: ${result.stderr}`);
  return result.stdout.trim();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The window handle of a started app, once its window exists. */
export async function appWindow(pid) {
  for (let i = 0; i < 80; i++) {
    const handle = Number(run(`(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`));
    if (handle) return handle;
    await sleep(250);
  }
  throw new Error('The app window did not appear.');
}

/** Opens a folder in a file manager window and returns its handle. */
export async function openFolder(folder) {
  spawn(path.join(process.env.SystemRoot, 'explorer.exe'), [folder], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  return folderWindow(folder);
}
export async function folderWindow(folder) {
  for (let i = 0; i < 40; i++) {
    const handle = Number(
      run('$w = Find-Folder $env:DESK_FOLDER; if ($w) { [int64]$w.HWND } else { 0 }', {
        DESK_FOLDER: folder,
      }),
    );
    if (handle) return handle;
    await sleep(250);
  }
  throw new Error(`No file manager window shows ${folder}.`);
}
/** What the file manager window of this folder has selected. */
export const selectedInFolder = (folder) =>
  run(
    '$w = Find-Folder $env:DESK_FOLDER; if ($w) { $w.Document.SelectedItems() | ForEach-Object { $_.Path } }',
    { DESK_FOLDER: folder },
  )
    .split(/\r?\n/)
    .filter(Boolean);
export const closeFolder = (folder) =>
  run('$w = Find-Folder $env:DESK_FOLDER; if ($w) { $w.Quit() }', { DESK_FOLDER: folder });

/** Puts the two windows side by side, above everything else. */
export const arrange = (left, right) => run(`[Desk]::Arrange([IntPtr]${left}, [IntPtr]${right})`);
export const releaseWindow = (handle) => run(`[Desk]::Release([IntPtr]${handle})`);

/** The screen position of a page point in physical pixels. */
export function screenPoint(handle, cssX, cssY, scale) {
  const [x, y] = run(`[Desk]::Origin([IntPtr]${handle})`).split(',').map(Number);
  return { x: Math.round(x + cssX * scale), y: Math.round(y + cssY * scale) };
}

/** Presses at `from` in window `a`, moves to `to` in window `b` and lets go. */
export function dragBetween(a, from, b, to) {
  run(`[Desk]::Drag([IntPtr]${a}, ${from.x}, ${from.y}, [IntPtr]${b}, ${to.x}, ${to.y})`);
}
