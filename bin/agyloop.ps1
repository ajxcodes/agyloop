<#
.SYNOPSIS
  agyloop - Windows PowerShell Launcher
#>
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required to run the agyloop CLI. Please install Node.js or run /agyloop inside Antigravity."
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$ScriptDir\agyloop.js" @args
