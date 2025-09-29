# API Test

Este proyecto ejecuta consultas contra la API de Metrorrey y después corre una batería de pruebas automatizadas con Newman.

## Requisitos
- Node.js 18 o superior
- npm (se instala junto con Node.js)

## Ejecución rápida
### macOS / Linux
```bash
chmod +x run.sh   # solo la primera vez
./run.sh
```

### Windows
Doble clic en `run.bat` o ejecútalo desde `cmd`:
```bat
run.bat
```

Los scripts validan que `node` y `npm` estén disponibles, comprueban que la versión de Node.js cumpla el mínimo y ejecutan `npm install` automáticamente si las dependencias aún no están instaladas. Después lanzan `index.js`, corren las pruebas de Newman y mueven los reportes a `reports/`.

## Ejecución manual (opcional)
Si prefieres ejecutar cada paso manualmente:
```bash
npm install
node index.js
npm run test:report
mkdir -p reports
mv newman/*.html newman/*.json reports/ || true
```

Los reportes finales se encuentran en `reports/` y los datos crudos en `output/`.
