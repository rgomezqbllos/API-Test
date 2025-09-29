@echo off
setlocal enabledelayedexpansion

echo === Contenido del directorio newman: ===
dir newman

echo === Moviendo archivos... ===
set "files_moved=0"

for %%F in (newman\*.html) do (
  if exist "%%~fF" (
    move /Y "%%~fF" "reports\" >nul
    echo Movido: %%~nxF
    set /a files_moved+=1
  )
)

for %%F in (newman\*.json) do (
  if exist "%%~fF" (
    move /Y "%%~fF" "reports\" >nul
    echo Movido: %%~nxF
    set /a files_moved+=1
  )
)

if !files_moved! EQU 0 (
  echo No se encontraron reportes para mover.
)

echo === Contenido del directorio reports: ===
if exist reports (
  dir reports
) else (
  echo El directorio 'reports' no existe.
)

endlocal