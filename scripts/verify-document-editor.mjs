// TL.4: the tools menu opens a real file of this PC with no terminal open, through the real OS file
// picker. Run by `test-local-native.mjs --document-editor-only` (`npm run test:document-editor`)
// after building the app. UI Automation finds the picker and window messages answer it, because
// its classic controls report no patterns on Windows 11 26300. The real pointer and keyboard stay
// with whoever is using this PC.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const answerScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$ae = [System.Windows.Automation.AutomationElement]
$condition = [System.Windows.Automation.PropertyCondition]
$and = [System.Windows.Automation.AndCondition]
$scope = [System.Windows.Automation.TreeScope]
$title = New-Object $condition($ae::NameProperty, '문서 열기')
$process = New-Object $condition($ae::ProcessIdProperty, [int]$env:DACHSTERM_APP_PID)
$match = New-Object $and($title, $process)
$dialog = $null
for ($i = 0; $i -lt 100 -and -not $dialog; $i++) {
  $dialog = $ae::RootElement.FindFirst($scope::Children, $match)
  if (-not $dialog) { Start-Sleep -Milliseconds 200 }
}
if (-not $dialog) { throw 'The file picker did not appear.' }
Add-Type -Namespace DachsTerm -Name Win32 -MemberDefinition (
  '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, string l);' +
  '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);'
)
$WM_SETTEXT = 0x000C
$WM_COMMAND = 0x0111
$window = [IntPtr]$dialog.Current.NativeWindowHandle
if ($env:DACHSTERM_PICK_FILE) {
  $byId = New-Object $condition($ae::AutomationIdProperty, '1148')
  $byClass = New-Object $condition($ae::ClassNameProperty, 'Edit')
  $edit = $null
  for ($i = 0; $i -lt 50 -and -not $edit; $i++) {
    $edit = $dialog.FindFirst($scope::Descendants, (New-Object $and($byId, $byClass)))
    if (-not $edit) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $edit) { throw 'The file name box was not found.' }
  [void][DachsTerm.Win32]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, $WM_SETTEXT, [IntPtr]::Zero, $env:DACHSTERM_PICK_FILE)
  [void][DachsTerm.Win32]::PostMessage($window, $WM_COMMAND, [IntPtr]1, [IntPtr]::Zero)
} else {
  [void][DachsTerm.Win32]::PostMessage($window, $WM_COMMAND, [IntPtr]2, [IntPtr]::Zero)
}
`;

/** Waits for the app's file picker, then chooses `file`, or closes the picker without one. */
function answerPicker(appPid, file) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(answerScript, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: {
        ...process.env,
        DACHSTERM_APP_PID: String(appPid),
        DACHSTERM_PICK_FILE: file ?? '',
      },
    },
  );
  assert.equal(result.status, 0, `file picker automation failed: ${result.stderr}`);
}

export async function checkDocumentEditor(page, directory, appPid) {
  const folder = path.join(await realpath(directory), '문서 편집기');
  await mkdir(folder, { recursive: true });
  const name = '한글 문서.txt';
  const file = path.join(folder, name);
  await writeFile(file, '첫 줄\n');
  const tab = page.getByRole('tab', { name, exact: true });
  const dirty = page.getByRole('tab', { name: `${name} 저장 안 됨` });
  const editor = page.locator('.pane-cell:not([hidden]) .file-tab .view-lines').first();
  const open = async (picked) => {
    await page.locator('.toolbar-menu summary', { hasText: '도구' }).click();
    await page.getByRole('button', { name: '문서 편집기', exact: true }).click();
    answerPicker(appPid, picked);
  };
  const noTerminal = async () => {
    await expect(page.locator('.xterm')).toHaveCount(0);
    await expect(page.getByLabel('작업 상태')).toContainText('연결 없음');
  };

  await open(null);
  await expect(page.locator('.app-error')).toHaveCount(0);
  await expect(page.locator('.file-tab')).toHaveCount(0);
  console.log('PASS closing the real file picker opens nothing');

  await open(file);
  await expect(tab).toHaveCSS('font-style', 'normal', { timeout: 15000 });
  await expect(editor).toContainText('첫', { timeout: 30000 });
  await expect(page.locator('.file-tab-banner')).toHaveCount(0);
  await noTerminal();
  console.log('PASS the tools menu opens a Korean-named file with no terminal, and can edit');

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('저장');
  await expect(dirty).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(dirty).toHaveCount(0, { timeout: 15000 });
  assert.equal(await readFile(file, 'utf8'), '첫 줄\n저장');
  await noTerminal();
  console.log('PASS Ctrl+S writes the real file under its Korean name');

  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('버림');
  await expect(dirty).toBeVisible();
  const closeTab = page.getByRole('button', { name: `${name} 탭 닫기` });
  const asked = page.getByRole('dialog', { name: `${name} 저장` });
  await closeTab.click();
  await asked.getByRole('button', { name: '취소', exact: true }).click();
  await expect(asked).toHaveCount(0);
  await expect(dirty).toBeVisible();
  await closeTab.click();
  await asked.getByRole('button', { name: '저장 안 함', exact: true }).click();
  await expect(dirty).toHaveCount(0);
  await expect(tab).toHaveCount(0);
  assert.equal(await readFile(file, 'utf8'), '첫 줄\n저장');
  console.log('PASS closing asks first, cancel keeps the edit, and not saving writes nothing');
}
