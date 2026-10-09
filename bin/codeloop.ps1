<#
.SYNOPSIS
  codeloop - Windows PowerShell Launcher
#>
$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required to run the codeloop CLI. Please install Node.js or run /agyloop inside Antigravity."
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$ScriptDir\codeloop.js" @args
