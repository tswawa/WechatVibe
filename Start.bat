@echo off
rem 本文件以 GBK(CP936) 保存。中文 Windows 下 cmd.exe 按当前代码页分块读取批处理，
rem 存成 UTF-8 会在块边界把多字节字符截断，导致行被吞掉或当成命令执行。
chcp 936 >nul
rem ============================================================================
rem  WechatVibe 源码一键启动（Windows）
rem
rem  作用：选一条运行时路径启动桌面客户端。
rem    1. 找到 Rust 可执行文件（rust\app\target\release\）就启动它 —— 这条路径
rem       不需要 Node，也不需要 Python。
rem    2. 否则回落到原有 Electron + Python 链路：校验 Node/Python 环境、补齐依赖
rem       后启动 Electron。
rem
rem  用法：
rem    Start.bat                自动选择（优先 Rust，没有则 Electron）
rem    Start.bat --rust         强制走 Rust，找不到产物直接报错
rem    Start.bat --electron     强制走 Electron
rem    Start.bat --check        只做环境自检，不启动
rem    Start.bat --no-pause     结束时不等待按键（脚本 / CI 调用）
rem    Start.bat --help         显示用法
rem
rem  退出码：0 正常，1 环境或启动失败。
rem  退出：关闭 WechatVibe 窗口即结束本进程。
rem ============================================================================

setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

set "MODE=run"
set "FORCE="
set "NOPAUSE="
set "HELP="
set "EXIT_CODE=0"
set "VENV_DIR=%CD%\.venv"
set "VENV_PY=%VENV_DIR%\Scripts\python.exe"
set "LOCK_FILE=%CD%\python-requirements.lock.txt"
set "RUST_BIN="

rem ---------------------------------------------------------------- 参数解析
rem 先解析完全部参数再动作，否则 --help --no-pause 这类组合会因为提前 goto 丢掉后面的开关。
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--check"    set "MODE=check"
if /i "%~1"=="--rust"     set "FORCE=rust"
if /i "%~1"=="--electron" set "FORCE=electron"
if /i "%~1"=="--no-pause" set "NOPAUSE=1"
if /i "%~1"=="-h"         set "HELP=1"
if /i "%~1"=="--help"     set "HELP=1"
if /i "%~1"=="/?"         set "HELP=1"
shift
goto :parse_args

:args_done
if defined HELP goto :usage

echo.
echo ============================================================
echo   WechatVibe 源码启动
echo   工作目录：%CD%
echo ============================================================
echo.
goto :runtime_select

:usage
echo 用法: Start.bat [--rust ^| --electron] [--check] [--no-pause]
echo.
echo   --rust       强制启动 Rust 版（rust\app\target\release\）
echo   --electron   强制启动 Electron + Python 版
echo   --check      只做环境自检，不启动
echo   --no-pause   结束时不等待按键
echo   -h, --help   显示本帮助
set "EXIT_CODE=0"
goto :finish

rem ------------------------------------------------------------ 选择运行时路径
:runtime_select
rem 显式指定的优先：WECHATVIBE_RUST_BIN 环境变量，其次常规构建产物位置。
if defined WECHATVIBE_RUST_BIN if exist "%WECHATVIBE_RUST_BIN%" set "RUST_BIN=%WECHATVIBE_RUST_BIN%"
if not defined RUST_BIN if exist "rust\app\target\release\wechatvibe.exe" set "RUST_BIN=%CD%\rust\app\target\release\wechatvibe.exe"
if not defined RUST_BIN if exist "rust\app\target\release\wechatvibe-desktop.exe" set "RUST_BIN=%CD%\rust\app\target\release\wechatvibe-desktop.exe"

if /i "%FORCE%"=="electron" (
  set "RUST_BIN="
  echo [路径] 按要求使用 Electron + Python
  goto :node_checks
)
if /i "%FORCE%"=="rust" if not defined RUST_BIN goto :no_rust_bin
if defined RUST_BIN goto :rust_checks

echo [路径] 未找到 Rust 构建产物，回落到 Electron + Python
goto :node_checks

rem ========================================================== 路径 A：Rust
:rust_checks
echo [1/1] Rust 可执行文件：%RUST_BIN%
if /i "%MODE%"=="check" goto :check_done
goto :launch_rust

:launch_rust
echo.
echo 正在启动 WechatVibe（Rust）...
echo 关闭应用窗口即结束本脚本。
echo.
"%RUST_BIN%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [启动异常] Rust 客户端退出码：%EXIT_CODE%
  goto :finish
)
echo 客户端已退出。
goto :finish

rem ================================================= 路径 B：Electron + Python
:node_checks
rem 一次 node 调用同时取版本号和主版本号，省掉 node -v 与两次 where 的启动开销。
set "NODE_VERSION="
set "NODE_MAJOR_RAW="
for /f "usebackq tokens=1,2" %%a in (`node -p "process.versions.node + ' ' + process.versions.node.split('.')[0]" 2^>nul`) do (
  set "NODE_VERSION=%%a"
  set "NODE_MAJOR_RAW=%%b"
)
if not defined NODE_VERSION goto :no_node

rem 只有解析出的主版本确实是个数字才参与比较；否则按 0 处理，跳过告警而不是让 if 报语法错。
set "NODE_MAJOR=0"
if defined NODE_MAJOR_RAW set /a NODE_MAJOR=NODE_MAJOR_RAW >nul 2>nul
echo [1/4] Node.js %NODE_VERSION% 已就绪
if %NODE_MAJOR% LSS 24 if not "%NODE_MAJOR%"=="0" echo       [警告] 项目要求 Node.js 24.11.1，当前为 %NODE_VERSION%，可能出现异常。

rem ------------------------------------------------------------ 2. Node 依赖
if exist "node_modules\" goto :node_modules_ok
where npm >nul 2>nul
if errorlevel 1 goto :no_npm
echo [2/4] 未检测到 node_modules，正在执行 npm ci（首次运行约需数分钟）...
call npm ci
if errorlevel 1 goto :npm_cleanup
:node_modules_ok
if exist "node_modules\electron\dist\electron.exe" goto :electron_ok
echo       正在补全 Electron 运行时（npm run setup:electron）...
call npm run setup:electron
if errorlevel 1 goto :npm_failed
:electron_ok
echo [2/4] Node 依赖已就绪
goto :python_checks

:npm_cleanup
rem node_modules 在本次运行前不存在，里面的东西都是这次 npm ci 装了一半的，可以整个清掉。
if not exist "node_modules\" goto :npm_failed
echo       清理 npm ci 留下的半成品 node_modules ...
rd /s /q "node_modules" 2>nul
goto :npm_failed

rem ---------------------------------------------------------------- 3. Python
:python_checks
if not exist "%LOCK_FILE%" goto :no_lockfile
if exist "%VENV_PY%" goto :venv_ok
echo [3/4] 未检测到 .venv，正在创建 Python 虚拟环境...
set "PY_LAUNCH="
py -3.14 -c "import sys" >nul 2>nul && set "PY_LAUNCH=py -3.14"
if not defined PY_LAUNCH (
  py -3.13 -c "import sys" >nul 2>nul && set "PY_LAUNCH=py -3.13"
)
if not defined PY_LAUNCH (
  py -3.12 -c "import sys" >nul 2>nul && set "PY_LAUNCH=py -3.12"
)
if not defined PY_LAUNCH (
  py -3 -c "import sys" >nul 2>nul && set "PY_LAUNCH=py -3"
)
if not defined PY_LAUNCH (
  python -c "import sys" >nul 2>nul && set "PY_LAUNCH=python"
)
if not defined PY_LAUNCH goto :no_python

%PY_LAUNCH% -m venv "%VENV_DIR%"
if errorlevel 1 goto :venv_failed
echo       已用 %PY_LAUNCH% 创建 .venv

:venv_ok
rem 固定使用项目虚拟环境，避免测试与构建误用系统 Python。
set "WECHATVIBE_PYTHON=%VENV_PY%"
set "PATH=%VENV_DIR%\Scripts;%PATH%"
rem 一次探测。退出码是精确匹配的，不是 if errorlevel 的「大于等于」：3 表示缺包，
rem 其余非零表示解释器本身跑不起来。
"%VENV_PY%" -c "import sys,importlib.util as u;print('       Python','.'.join(map(str,sys.version_info[:3])),'(.venv)');sys.exit(0 if all(u.find_spec(m) for m in ('cffi','numpy','wechatauto')) else 3)"
set "PROBE=%ERRORLEVEL%"
if "%PROBE%"=="0" goto :deps_ok
if "%PROBE%"=="3" goto :pip_install
goto :venv_broken

:pip_install
echo       正在安装 Python 依赖（pip install --no-deps -r python-requirements.lock.txt）...
"%VENV_PY%" -m pip install --no-deps -r "%LOCK_FILE%"
if errorlevel 1 goto :pip_failed

:deps_ok
echo [3/4] Python 环境已就绪

rem ---------------------------------------------------- 4. 模型目录与启动
if defined LAYA_MODEL_DIR goto :model_env
if exist ".models\laya\" goto :model_ok
echo [4/4] 未检测到本地 Laya 模型（.models\laya）
echo       本地分析需要模型：可先执行 npm run setup:models 下载，
echo       或启动后在「设置 → 本地部署」下载；只用 API 模式可跳过。
goto :model_ready

:model_env
echo [4/4] 使用 LAYA_MODEL_DIR 指定的模型目录：%LAYA_MODEL_DIR%
goto :model_ready

:model_ok
echo [4/4] 本地 Laya 模型目录：%CD%\.models\laya

:model_ready
if /i "%MODE%"=="check" goto :check_done

echo.
echo 正在启动 WechatVibe...
echo 关闭应用窗口即结束本脚本。
echo.
rem 直接启动 Electron 可执行文件：走 npm 包装层光 shim 和 CLI 引导就要多花约 4 秒。
if not exist "node_modules\electron\dist\electron.exe" goto :launch_npm
"node_modules\electron\dist\electron.exe" .
set "EXIT_CODE=%ERRORLEVEL%"
goto :launch_done

:launch_npm
where npm >nul 2>nul
if errorlevel 1 goto :no_npm
call npm start
set "EXIT_CODE=%ERRORLEVEL%"

:launch_done
echo.
if not "%EXIT_CODE%"=="0" (
  echo [启动异常] 客户端退出码：%EXIT_CODE%
  echo 可尝试：npm run start:service -- --no-open 单独启动本地服务查看日志。
  goto :finish
)
echo 客户端已退出。
goto :finish

:check_done
echo 环境自检通过，未启动客户端。

rem ------------------------------------------------------------------ 收尾
:finish
echo.
if defined NOPAUSE goto :no_pause
if /i "%MODE%"=="check" goto :no_pause
pause
:no_pause
endlocal & exit /b %EXIT_CODE%

rem ---------------------------------------------------------------- 失败分支
:no_rust_bin
echo [错误] 指定了 --rust，但没有找到 Rust 可执行文件。
echo        预期位置：rust\app\target\release\wechatvibe.exe
echo        先构建：cargo build --release --manifest-path rust\app\Cargo.toml
echo        或设置环境变量 WECHATVIBE_RUST_BIN 指向已有产物。
set "EXIT_CODE=1"
goto :finish

:no_node
echo [错误] 未找到 Node.js。请安装 Node.js 24.11.1 x64 后重试：https://nodejs.org/
set "EXIT_CODE=1"
goto :finish

:no_npm
echo [错误] 未找到 npm。请重新安装 Node.js（自带 npm）后重试。
set "EXIT_CODE=1"
goto :finish

:npm_failed
echo [错误] Node 依赖安装失败。可手动执行 npm ci 查看详细报错。
set "EXIT_CODE=1"
goto :finish

:no_lockfile
echo [错误] 未找到 python-requirements.lock.txt，无法校验 Python 依赖。
set "EXIT_CODE=1"
goto :finish

:no_python
echo [错误] 未找到 Python。请安装 Python 3.14（3.13 亦可运行）并勾选 Add to PATH：
echo        https://www.python.org/downloads/windows/
set "EXIT_CODE=1"
goto :finish

:venv_failed
echo [错误] 创建 .venv 失败。
set "EXIT_CODE=1"
goto :finish

:venv_broken
echo [错误] .venv\Scripts\python.exe 无法执行，请删除 .venv 目录后重新运行本脚本。
set "EXIT_CODE=1"
goto :finish

:pip_failed
echo [错误] Python 依赖安装失败。可手动执行：
echo        .\.venv\Scripts\python.exe -m pip install --no-deps -r python-requirements.lock.txt
set "EXIT_CODE=1"
goto :finish
