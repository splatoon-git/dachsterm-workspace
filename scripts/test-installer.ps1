param([string]$Version = '', [switch]$Reinstall, [string]$PreviousVersion = '', [string]$InstallerPath = '', [string]$ExpectedBinarySha256 = '')
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version }
$installer = Join-Path $workspace "target\release\bundle\nsis\DachsTerm_${Version}_x64-setup.exe"
if ($InstallerPath) { $installer = [IO.Path]::GetFullPath($InstallerPath) }
if ($ExpectedBinarySha256 -and $ExpectedBinarySha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid expected executable SHA256' }
$target = [IO.Path]::GetFullPath((Join-Path $workspace ("target\install-smoke-" + [Guid]::NewGuid().ToString('N'))))
if (-not $target.StartsWith($workspace + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation target' }
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DachsTerm'
foreach ($key in @($registry, 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DachsTerm', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\DachsTerm')) {
  if (Test-Path -LiteralPath $key) { throw 'Existing DachsTerm installation: isolated install test skipped' }
}
if (Get-Process dachsterm -ErrorAction SilentlyContinue) { throw 'Close test-owned app processes before installer validation' }
if (-not (Test-Path -LiteralPath $installer)) { throw 'Installer is missing' }
$appProcess = $null
$installed = $false
try {
  if ($PreviousVersion) {
    if ($PreviousVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid previous version' }
    $previousInstaller = Join-Path $workspace "target\release\bundle\nsis\DachsTerm_${PreviousVersion}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $previousInstaller)) { throw 'Previous installer is missing' }
    $previous = Start-Process -FilePath $previousInstaller -ArgumentList @('/S', "/D=$target") -WindowStyle Hidden -PassThru
    if (-not $previous.WaitForExit(60000) -or $previous.ExitCode -ne 0) { throw 'Previous installer failed' }
    $installed = $true
    if ((Get-ItemProperty -LiteralPath $registry).DisplayVersion -ne $PreviousVersion) { throw 'Previous version registration mismatch' }
    [IO.File]::WriteAllText((Join-Path $target 'upgrade-preservation-check.txt'), 'test-owned-upgrade-marker')
  }
  $setup = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$target") -WindowStyle Hidden -PassThru
  if (-not $setup.WaitForExit(60000)) { throw 'Installer timeout' }
  if ($setup.ExitCode -ne 0) { throw "Installer failed: $($setup.ExitCode)" }
  $binary = Join-Path $target 'dachsterm.exe'
  if (-not (Test-Path -LiteralPath $binary)) { throw 'Installed binary is missing' }
  if (-not (Test-Path -LiteralPath (Join-Path $target 'THIRD_PARTY_NOTICES.txt'))) { throw 'Third-party notices are missing from the installation' }
  $installed = $true
  $registered = Get-ItemProperty -LiteralPath $registry
  if ($registered.DisplayVersion -ne $Version -or $registered.InstallLocation.Trim('"') -ne $target) { throw 'Installed registry metadata mismatch' }
  $installedVersion = (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion
  if ($installedVersion -ne $Version) { throw "Installed executable version mismatch: $installedVersion" }
  if ((Get-Item -LiteralPath $binary).VersionInfo.ProductName -ne 'DachsTerm') { throw 'Installed executable product name mismatch' }
  if ($ExpectedBinarySha256 -and (Get-FileHash -LiteralPath $binary).Hash -ne $ExpectedBinarySha256) { throw 'Installed executable SHA256 mismatch' }
  Copy-Item -LiteralPath $binary -Destination (Join-Path $workspace 'target\installed-smoke.exe')
  Write-Output "PASS NSIS silent install, registry and executable version $Version"
  if ($PreviousVersion) {
    $marker = Join-Path $target 'upgrade-preservation-check.txt'
    if ([IO.File]::ReadAllText($marker) -ne 'test-owned-upgrade-marker') { throw 'Upgrade removed an unrelated installation file' }
    Remove-Item -LiteralPath $marker
    Write-Output "PASS installer upgrade $PreviousVersion -> $Version (application-data migration remains separate)"
  }
  Write-Output ("Installed SHA256: " + (Get-FileHash -LiteralPath $binary).Hash)
  if ($Reinstall) {
    $sentinel = Join-Path $target 'install-preservation-check.txt'
    [IO.File]::WriteAllText($sentinel, 'test-owned-marker')
    $again = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$target") -WindowStyle Hidden -PassThru
    if (-not $again.WaitForExit(60000) -or $again.ExitCode -ne 0) { throw 'In-place reinstall failed' }
    if ([IO.File]::ReadAllText($sentinel) -ne 'test-owned-marker') { throw 'Reinstall removed an unrelated file' }
    Remove-Item -LiteralPath $sentinel
    Write-Output 'PASS same-version in-place reinstall preserves unrelated installation files (not a cross-version data migration test)'
  }

  $appProcess = Start-Process -FilePath $binary -WindowStyle Hidden -PassThru
  for ($attempt = 0; $attempt -lt 80; $attempt++) {
    Start-Sleep -Milliseconds 250
    $appProcess.Refresh()
    if ($appProcess.HasExited) { throw 'Installed app exited during startup' }
    if ($appProcess.MainWindowHandle -ne 0) { break }
  }
  if ($appProcess.MainWindowHandle -eq 0) { throw 'Installed application window did not initialize' }
  Write-Output 'PASS installed release application initializes a native window'
  [void]$appProcess.CloseMainWindow()
  if (-not $appProcess.WaitForExit(20000)) { throw 'Installed app did not close normally' }
  Write-Output 'PASS installed application closes normally'
} finally {
  if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force }
  if ($installed) {
    $uninstaller = Join-Path $target 'uninstall.exe'
    $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$target") -WindowStyle Hidden -PassThru
    if (-not $remove.WaitForExit(60000)) { Write-Error 'Uninstaller timeout' }
    if ($remove.ExitCode -ne 0 -or (Test-Path -LiteralPath (Join-Path $target 'dachsterm.exe')) -or (Test-Path -LiteralPath $registry)) { Write-Error 'Uninstall validation failed' }
    else { Write-Output 'PASS uninstall removes test installation and registration; application data retained' }
  }
}
