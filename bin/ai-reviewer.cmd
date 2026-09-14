@ECHO OFF
REM ============================================================================
REM ai-reviewer - Windows Command Prompt Launcher
REM ============================================================================
WHERE node >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
  ECHO Error: Node.js is required to run the ai-reviewer CLI.
  ECHO Please install Node.js from https://nodejs.org.
  EXIT /B 1
)

node "%~dp0ai-reviewer.js" %*
