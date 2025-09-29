@echo off
setlocal enabledelayedexpansion

call :run_step "Verificando requisitos"
call :require_command node "Node.js" || exit /b 1
call :check_node_version || exit /b 1
call :require_command npm "npm" || exit /b 1

call :ensure_dependencies || exit /b 1

call :run_step "Ejecutando script de descarga"
node index.js || goto :error
call :run_step "Descarga completada"

call :run_step "Ejecutando pruebas de newman"
if not exist reports mkdir reports
call npm run test:report || goto :error

if exist newman (
  call "%~dp0move_reports.bat"
) else (
  echo No existe el directorio 'newman'. No se moveran reportes.
)

call :run_step "Proceso completado"
exit /b 0

:run_step
echo ==============================
echo %~1
echo ==============================
exit /b 0

:require_command
where %1 >nul 2>&1
if errorlevel 1 (
  echo No se encontro %2. Instalalo y vuelve a ejecutar este script.
  exit /b 1
)
exit /b 0

:check_node_version
for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=!NODE_MAJOR:~1!
if "!NODE_MAJOR!"=="" (
  echo No fue posible determinar la version de Node.js.
  exit /b 1
)
if !NODE_MAJOR! LSS 18 (
  for /f %%v in ('node -v') do set NODE_VERSION=%%v
  echo Se requiere Node.js 18 o superior. Version detectada: !NODE_VERSION!
  exit /b 1
)
exit /b 0

:ensure_dependencies
set NEEDS_INSTALL=0
if not exist node_modules set NEEDS_INSTALL=1
if not exist node_modules\.bin\newman.cmd if not exist node_modules\.bin\newman set NEEDS_INSTALL=1
if !NEEDS_INSTALL! EQU 1 (
  call :run_step "Instalando dependencias con npm install"
  npm install || exit /b 1
) else (
  call :run_step "Dependencias ya instaladas"
)
exit /b 0

:error
exit /b 1