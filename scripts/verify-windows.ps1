param([switch]$Native, [switch]$Package, [switch]$RequireSigned)
$ErrorActionPreference = 'Stop'
if ($RequireSigned -and -not $Package) { throw '-RequireSigned requires -Package' }
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
Set-Location -LiteralPath $workspace
function Invoke-Check([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Check failed: $Program $($Arguments -join ' ')" }
}
Invoke-Check 'npm.cmd' @('run', 'typecheck')
Invoke-Check 'npm.cmd' @('run', 'lint')
Invoke-Check 'npm.cmd' @('run', 'format:check')
Invoke-Check 'npm.cmd' @('test')
Invoke-Check 'npm.cmd' @('run', 'build')
Invoke-Check 'npm.cmd' @('run', 'test:ui', '--', '--workers=2')
Invoke-Check 'cargo' @('fmt', '--all', '--check')
Invoke-Check 'cargo' @('clippy', '--workspace', '--all-targets', '--locked', '--', '-D', 'warnings')
Invoke-Check 'cargo' @('test', '--workspace', '--locked')
Invoke-Check 'npm.cmd' @('audit', '--audit-level=low')
Invoke-Check 'node' @('scripts/audit-dependencies.mjs')
Invoke-Check 'node' @('scripts/generate-notices.mjs')
if ($Native) {
  Invoke-Check 'npm.cmd' @('run', 'test:native')
  Invoke-Check 'npm.cmd' @('run', 'test:native:edit')
  Invoke-Check 'npm.cmd' @('run', 'test:ssh-key')
  Invoke-Check 'npm.cmd' @('run', 'test:session-log')
  Invoke-Check 'npm.cmd' @('run', 'test:network-base')
  Invoke-Check 'npm.cmd' @('run', 'test:port-tools')
  Invoke-Check 'npm.cmd' @('run', 'test:git-settings')
  Invoke-Check 'npm.cmd' @('run', 'test:git-diff')
  Invoke-Check 'node' @('scripts/test-workspace-native.mjs')
  Invoke-Check 'node' @('scripts/test-maintenance-native.mjs')
  Invoke-Check 'node' @('scripts/run-ftp.mjs', '--native')
}
if ($Package) {
  Invoke-Check 'npm.cmd' @('run', 'tauri', '--', 'build', '--bundles', 'nsis')
  $version = (Get-Content -LiteralPath (Join-Path $workspace 'package.json') -Raw | ConvertFrom-Json).version
  $installer = Join-Path $workspace "target\release\bundle\nsis\DachsTerm_${version}_x64-setup.exe"
  $signature = Get-AuthenticodeSignature -LiteralPath $installer
  if ($RequireSigned -and $signature.Status -ne 'Valid') { throw 'Public release refused: valid Authenticode signature required' }
  $manifest = [ordered]@{ version = $version; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash; signature = $signature.Status.ToString(); publicReleaseApproved = $false; manualVerification = 'docs/verification/windows-release-checklist.md' }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath "$installer.manifest.json" -Encoding utf8
  & (Join-Path $PSScriptRoot 'test-installer.ps1') -Version $version -Reinstall
  if (-not $?) { throw 'Installer validation failed' }
}
Write-Output 'PASS requested automatic checks. Manual release gates remain separate.'
