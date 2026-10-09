<#
.SYNOPSIS
  agyloop - Windows PowerShell Launcher (Deprecated)
#>
$ErrorActionPreference = 'Stop'

Write-Warning "The 'agyloop' command is deprecated. Please use 'codeloop' instead."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required to run the agyloop CLI. Please install Node.js or run /agyloop inside Antigravity."
  exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$ScriptDir\agyloop.js" @args
