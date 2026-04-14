@echo off
:: CatClaw CLI wrapper — Windows
:: 用法：catclaw [init|build|start|stop|restart|logs|status|reset-session]
node "%~dp0catclaw.js" %*
