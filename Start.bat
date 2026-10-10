@echo off
chcp 65001 >nul
rem ============================================================================
rem  WechatVibe 源码一键启动（Windows）
rem
rem  作用：检查 Node/Python 环境 -> 补齐依赖 -> 启动 Electron 桌面客户端。
rem  首次运行会自动执行 npm ci、创建 .venv 并安装 Python 依赖，之后启动只做校验。
rem
rem  用法：双击本文件，或在 PowerShell 中执行 .\Start.bat
rem  退出：关闭 WechatVibe 窗口即结束本进程。
rem ============================================================================

setlocal EnableExtensions
cd /d "%~dp0"

set "VENV_DIR=%CD%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "LOCK_FILE=python-requirements.lock.txt"

echo.
echo ============================================================
echo   WechatVibe 源码启动
echo   工作目录：%CD%
echo ============================================================
echo.

rem ---------------------------------------------------------------- 1. Node
where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_npm
for /f "usebackq delims=" %%v in (`node -v`) do set "NODE_VERSION=%%v"
for /f "usebackq delims=" %%m in (`node -p "process.versions.node.split('.')[0]"`) do set "NODE_MAJOR=%%m"
echo [1/4] Node.js %NODE_VERSION%、npm 已就绪
if defined NODE_MAJOR if %NODE_MAJOR% LSS 24 echo       [警告] 项目要求 Node.js 24.11.1，当前为 %NODE_VERSION%，可能出现异常。

rem --------------------------------------------------------- 2. Node 依赖
if exist "node_modules\" goto :node_modules_ok
echo [2/4] 未检测到 node_modules，正在执行 npm ci（首次运行约需数分钟）...
call npm ci
if errorlevel 1 goto :npm_failed
:node_modules_ok
if exist "node_modules\electron\dist\electron.exe" goto :electron_ok
echo       正在补全 Electron 运行时（npm run setup:electron）...
call npm run setup:electron
if errorlevel 1 goto :npm_failed
:electron_ok
echo [2/4] Node 依赖已就绪

rem ------------------------------------------------------------ 3. Python
if exist "%VENV_PY%" goto :venv_ok
echo [3/4] 未检测到 .venv，正在创建 Python 虚拟环境...
py -3.14 -c "import sys" >nul 2>nul && goto :venv_py314
py -3.13 -c "import sys" >nul 2>nul && goto :venv_py313
py -3.12 -c "import sys" >nul 2>nul && goto :venv_py312
py -3 -c "import sys" >nul 2>nul && goto :venv_py3
python -c "import sys" >nul 2>nul && goto :venv_python
goto :no_python

:venv_py314
set "PY_LAUNCH=py -3.14"
goto :venv_create
:venv_py313
set "PY_LAUNCH=py -3.13"
goto :venv_create
:venv_py312
set "PY_LAUNCH=py -3.12"
goto :venv_create
:venv_py3
set "PY_LAUNCH=py -3"
goto :venv_create
:venv_python
set "PY_LAUNCH=python"
goto :venv_create

:venv_create
%PY_LAUNCH% -m venv "%VENV_DIR%"
if errorlevel 1 goto :venv_failed
echo       已用 %PY_LAUNCH% 创建 .venv

:venv_ok
rem 固定使用项目虚拟环境，避免测试与构建误用系统 Python
set "WECHATVIBE_PYTHON=%VENV_PY%"
set "PATH=%VENV_DIR%\Scripts;%PATH%"
"%VENV_PY%" -c "import sys;print('       Python','.'.join(map(str,sys.version_info[:3])),'(.venv)')"
if errorlevel 1 goto :venv_broken

rem 校验关键依赖，缺失时按锁文件补装
"%VENV_PY%" -c "import cffi, numpy, wechatauto" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo       正在安装 Python 依赖（pip install --no-deps -r %LOCK_FILE%）...
"%VENV_PY%" -m pip install --no-deps -r "%LOCK_FILE%"
if errorlevel 1 goto :pip_failed
:deps_ok
echo [3/4] Python 环境已就绪

rem ---------------------------------------------------- 4. 模型目录与启动
if exist ".models\laya\" goto :model_ok
if defined LAYA_MODEL_DIR goto :model_ok
echo [4/4] 未检测到本地 Laya 模型（.models\laya）
echo       本地分析需要模型：可先执行 npm run setup:models 下载，
echo       或启动后在「设置 → 本地部署」下载；只用 API 模式可跳过。
goto :model_ready

:model_ok
if defined LAYA_MODEL_DIR (
  echo [4/4] 使用 LAYA_MODEL_DIR 指定的模型目录：%LAYA_MODEL_DIR%
) else (
  echo [4/4] 本地 Laya 模型目录：%CD%\.models\laya
)

:model_ready
rem 自检模式：只检查环境，不启动客户端（Start.bat --check）
if /i "%~1"=="--check" goto :check_only

:launch
echo.
echo 正在启动 WechatVibe（npm start）...
echo 关闭应用窗口即结束本脚本。
echo.
call npm start
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" (
  echo [启动异常] npm start 退出码：%EXIT_CODE%
  echo 可尝试：npm run start:service -- --no-open 单独启动本地服务查看日志。
  goto :finish
)
echo 客户端已退出。

:check_only
echo 环境自检通过，未启动客户端（Start.bat --check）。

:finish
echo.
pause
endlocal
exit /b 0

rem ---------------------------------------------------------------- 失败分支
:no_node
echo [错误] 未找到 Node.js。请安装 Node.js 24.11.1 x64 后重试：https://nodejs.org/
goto :abort

:no_npm
echo [错误] 未找到 npm。请重新安装 Node.js（自带 npm）后重试。
goto :abort

:npm_failed
echo [错误] Node 依赖安装失败。可手动执行 npm ci 查看详细报错。
goto :abort

:no_python
echo [错误] 未找到 Python。请安装 Python 3.14（3.13 亦可运行）并勾选 Add to PATH：
echo        https://www.python.org/downloads/windows/
goto :abort

:venv_failed
echo [错误] 创建 .venv 失败。
goto :abort

:venv_broken
echo [错误] .venv\Scripts\python.exe 无法执行，请删除 .venv 目录后重新运行本脚本。
goto :abort

:pip_failed
echo [错误] Python 依赖安装失败。可手动执行：
echo        .\.venv\Scripts\python.exe -m pip install --no-deps -r %LOCK_FILE%
goto :abort

:abort
echo.
pause
endlocal
exit /b 1