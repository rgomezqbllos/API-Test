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

Los scripts validan que `node` y `npm` estén disponibles, comprueban que la versión de Node.js cumpla el mínimo y ejecutan `npm install` automáticamente si las dependencias aún no están instaladas. Después lanzan `index.js`, normalizan la colección, corren las pruebas de Newman y mueven los reportes a `reports/`.

## Ejecución manual (opcional)
Si prefieres ejecutar cada paso manualmente:
```bash
npm install
node index.js
npm run normalize:collection
npm run test:newman
mkdir -p reports
mv newman/*.html newman/*.json reports/ || true
```

Los reportes finales se encuentran en `reports/` y los datos crudos en `output/`.

## Normalización y parámetros dinámicos para Newman
- `scripts/normalize-collection.cjs` genera `collections/Integration-consumer.postman_collection.normalized.json` cada vez que se ejecuta `npm run normalize:collection` (los scripts `run.sh`/`run.bat` lo hacen automáticamente).
- Durante la normalización se inyecta un pre-request a nivel colección que:
  - Sigue ejecutando `pm.collectionVariables.set('dataFile', JSON.stringify(pm.iterationData.toObject()))` (comportamiento previo).
  - Sobrescribe parámetros de query y variables de ruta con los valores definidos por el usuario.
  - Añade/actualiza automáticamente la cabecera X-TENANT-ID usando 	enant_id (o 	enant_id_override).
  - Gestiona el token de Keycloak: reutiliza ccess_token si sigue vigente o solicita uno nuevo con las variables de entorno (identity_base_url, 
ealm, client_id, credenciales...).
  - Precedencia estricta: **iteration-data (`data.json`) > environment (`envs/*.json`) > variables de colección > contrato Postman**. Si ninguna fuente aporta un valor, se mantiene el valor del contrato.
  - Solo se consideran las claves con coincidencia exacta (sensible a mayúsculas/minúsculas). No hay conversión automática entre `snake_case`, `camelCase` ni variantes.

### Configuración rápida por parte del usuario
1. **`data.json`**: debe ser un arreglo de objetos (Newman itera uno a uno). Cada objeto puede incluir las claves con el nombre exacto que usa el endpoint (por ejemplo `startDate`, `endDate`, `limit`, etc.).
2. **Variables de entorno opcionales** (pueden definirse en la colección, en el environment o vía `newman --env-var`):
   - `override_keys`: lista separada por comas para limitar qué claves se pueden sobrescribir/injectar (ej. `override_keys="startDate,endDate,limit"`). Si no se define, el script intentará sobrescribir cualquier clave que ya exista en la URL.
   - `arrays_as`: define el tratamiento de arrays (`repeat` por defecto, `csv` para enviar un único valor con comas).
   - `inject_missing_params`: `true` para añadir a la query las claves listadas en `override_keys` que no existan en la URL (se ignora si `override_keys` no está definido).
   - `override_debug`: `true` para loggear en consola qué valores se están inyectando.
   - `cleanup_placeholders`: `true` (por defecto) elimina automáticamente los parámetros de query que sigan con valores de ejemplo como `string` o `{{variable}}`.

### Contratos nuevos
Cuando recibas una colección Postman distinta:
1. Sustituye `collections/Integration-consumer.postman_collection.json` por la versión nueva.
2. Ejecuta `npm run normalize:collection` (o simplemente `run.bat` / `run.sh`).
3. Define en `data.json` los valores que quieras sobrescribir con las claves exactas del contrato. Cualquier clave no definida se mantiene con el valor por defecto del contrato.

De este modo puedes introducir nuevos parámetros o eliminar los antiguos sin tocar manualmente la colección: basta con ajustar `data.json` o las variables de entorno correspondientes.
