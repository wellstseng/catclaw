@echo off
REM CatClaw CLI wrapper for Windows
REM Usage: catclaw [init|build|start|stop|restart|logs|status|reset-session|migrate-v2]
node "%~dp0catclaw.js" %*
