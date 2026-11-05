@ECHO OFF
REM ============================================================================
REM agyloop - Windows Command Prompt Launcher (Deprecated)
REM ============================================================================
ECHO Warning: The 'agyloop' command is deprecated. Please use 'codeloop' instead. 1>&2

WHERE node >nul 2>nul
IF %ERRORLEVEL% NEQ 0 (
  ECHO Error: Node.js is required to run the agyloop CLI.
  ECHO Please install Node.js from https://nodejs.org or run /agyloop inside Antigravity.
  EXIT /B 1
)

node "%~dp0agyloop.js" %*
