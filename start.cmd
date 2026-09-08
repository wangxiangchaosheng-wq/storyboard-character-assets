@echo off
rem 历史推演台 - 一键启动（关闭本窗口即停止服务）
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo [错误] 未找到 Node.js，请先安装 Node 24+ & pause & exit /b 1)
echo 正在启动 AI 历史模拟引擎（http://localhost:8787）...
echo 启动完成后浏览器已/请打开: http://localhost:8787
where pnpm >nul 2>nul && (pnpm serve) || (node --experimental-strip-types packages/serve/src/index.ts)
echo 服务已停止（按任意键关闭窗口）
pause >nul