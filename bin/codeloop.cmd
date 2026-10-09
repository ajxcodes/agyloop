@ECHO OFF
REM ============================================================================
REM codeloop - Windows Command Prompt Launcher
REM ============================================================================
WHERE node >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
  ECHO Error: Node.js is required to run the codeloop CLI.
  ECHO Please install Node.js from https://nodejs.org or run /agyloop inside Antigravity.
  EXIT /B 1
)

node "%~dp0codeloop.js" %*
