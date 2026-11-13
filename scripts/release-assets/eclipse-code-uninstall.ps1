$ErrorActionPreference = 'Stop'

$LocalAppData = if ($env:LOCALAPPDATA) {
  $env:LOCALAPPDATA
} else {
  Join-Path $HOME 'AppData\Local'
}
$InstallRoot = if ($env:ECLIPSE_CODE_INSTALL_ROOT) {
  $env:ECLIPSE_CODE_INSTALL_ROOT
} else {
  Join-Path $LocalAppData 'Eclipse Code\standalone'
}
$BinDir = if ($env:ECLIPSE_CODE_BIN_DIR) {
  $env:ECLIPSE_CODE_BIN_DIR
} else {
  Join-Path $LocalAppData 'Eclipse Code\bin'
}
$LauncherPath = Join-Path $BinDir 'eclipse-code.cmd'
$CliWrapperMarker = '__ECLIPSE_CODE_CLI_WRAPPER__'
$CliWrapperOwnerKey = 'ECLIPSE_CODE_INSTALL_OWNER'
$CliWrapperOwnerStandalone = 'standalone'

function Normalize-PathSegment([string]$Value) {
  return $Value.Trim().TrimEnd('\', '/').ToLowerInvariant()
}

function Split-PathValue([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }

  return @($Value -split ';' | Where-Object { $_.Trim().Length -gt 0 })
}

function Remove-EclipseCodeUserPath([string]$TargetPath) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $segments = Split-PathValue $current
  $normalizedTarget = Normalize-PathSegment $TargetPath
  $nextSegments = @()

  foreach ($segment in $segments) {
    if ((Normalize-PathSegment $segment) -ne $normalizedTarget) {
      $nextSegments += $segment
    }
  }

  [Environment]::SetEnvironmentVariable('Path', ($nextSegments -join ';'), 'User')
}

$shouldRemovePath = $true

function Get-LauncherMetadataValue([string]$Path, [string]$Key) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }

  $prefix = "$Key="
  foreach ($line in Get-Content -LiteralPath $Path) {
    $candidate = $line.Trim() -replace '^(?:#|@?rem|::)\s*', ''
    if ($candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      return $candidate.Substring($prefix.Length).Trim()
    }
  }

  return $null
}

function Test-StandaloneLauncher([string]$Path) {
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $content = Get-Content -LiteralPath $Path -Raw
  if (!$content.Contains($CliWrapperMarker)) {
    return $false
  }

  $owner = Get-LauncherMetadataValue $Path $CliWrapperOwnerKey
  if ($owner -eq $CliWrapperOwnerStandalone) {
    return $true
  }

  if (![string]::IsNullOrWhiteSpace($owner)) {
    return $false
  }

  $electronBin = Get-LauncherMetadataValue $Path 'ECLIPSE_CODE_ELECTRON_BIN'
  if ([string]::IsNullOrWhiteSpace($electronBin)) {
    return $false
  }

  $normalizedElectronBin = Normalize-PathSegment $electronBin
  $normalizedInstallRoot = Normalize-PathSegment $InstallRoot
  return $normalizedElectronBin.StartsWith("$normalizedInstallRoot\", [StringComparison]::OrdinalIgnoreCase)
}

if (Test-Path -LiteralPath $LauncherPath -PathType Leaf) {
  $content = Get-Content -LiteralPath $LauncherPath -Raw
  if (!$content.Contains($CliWrapperMarker)) {
    throw "Refusing to remove existing non-Eclipse Code launcher at $LauncherPath"
  }

  if (Test-StandaloneLauncher $LauncherPath) {
    Remove-Item -LiteralPath $LauncherPath -Force
    Write-Output "Removed Eclipse Code CLI launcher at $LauncherPath"
  } else {
    $shouldRemovePath = $false
    Write-Output "Leaving non-standalone Eclipse Code launcher at $LauncherPath"
  }
}

if (Test-Path -LiteralPath $InstallRoot) {
  Get-ChildItem -LiteralPath $InstallRoot -Filter 'eclipse-code-server-*' -Force |
    Remove-Item -Recurse -Force
  $currentPath = Join-Path $InstallRoot 'current'
  if (Test-Path -LiteralPath $currentPath) {
    Remove-Item -LiteralPath $currentPath -Recurse -Force
  }
}

if ($shouldRemovePath) {
  Remove-EclipseCodeUserPath $BinDir
}
Write-Output "Removed Eclipse Code standalone runtime bundles from $InstallRoot"
