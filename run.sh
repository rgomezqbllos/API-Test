#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

SCRIPT_ARGS=("$@")

run_step() {
  local message=$1
  echo "=============================="
  echo "$message"
  echo "=============================="
}

require_command() {
  local command_name=$1
  local friendly_name=$2
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "No se encontró $friendly_name. Instálalo y vuelve a ejecutar este script."
    exit 1
  fi
}

check_node_version() {
  local version major
  version=$(node -v)
  major=${version#v}
  major=${major%%.*}
  if [[ -z $major ]]; then
    echo "No fue posible determinar la versión de Node.js."
    exit 1
  fi
  if (( major < 18 )); then
    echo "Se requiere Node.js 18 o superior. Versión detectada: $version"
    exit 1
  fi
}

ensure_dependencies() {
  local needs_install=0

  if [[ ! -d node_modules ]]; then
    needs_install=1
  fi

  if [[ ! -f node_modules/.bin/newman ]]; then
    needs_install=1
  fi

  if (( needs_install == 1 )); then
    run_step "Instalando dependencias con npm install"
    npm install
  else
    run_step "Dependencias ya instaladas"
  fi
}

run_step "Verificando requisitos"
require_command node "Node.js"
check_node_version
require_command npm "npm"

ensure_dependencies

run_step "Ejecutando script de descarga"
node index.js "${SCRIPT_ARGS[@]}"
run_step "Descarga completada"

run_step "Normalizando colección"
npm run normalize:collection

run_step "Ejecutando pruebas de newman"
mkdir -p reports
if (( ${#SCRIPT_ARGS[@]} )); then
  npm run test:newman -- "${SCRIPT_ARGS[@]}"
else
  npm run test:newman
fi

if [[ -d newman ]]; then
  run_step "Contenido del directorio newman"
  ls -al newman

  shopt -s nullglob
  html_files=(newman/*.html)
  json_files=(newman/*.json)
  shopt -u nullglob

  if (( ${#html_files[@]} == 0 && ${#json_files[@]} == 0 )); then
    echo "No se encontraron reportes para mover."
  else
    run_step "Moviendo archivos a reports"
    if (( ${#html_files[@]} > 0 )); then
      mv "${html_files[@]}" reports/
    fi
    if (( ${#json_files[@]} > 0 )); then
      mv "${json_files[@]}" reports/
    fi
  fi

  run_step "Contenido del directorio reports"
  ls -al reports
else
  echo "No existe el directorio 'newman'. No se moverán reportes."
fi

run_step "Proceso completado"
