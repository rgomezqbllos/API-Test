# API Test

Este proyecto ejecuta consultas contra la API de Metrorrey y después corre una batería de pruebas automatizadas con Newman.

## Seleccion de entorno y tenant (multi-entorno)
- Los entornos TEST, PRE y PRO ya estan definidos en `config/targets.json` con la informacion suministrada (incluye client_credentials).
- Si ejecutas los scripts sin parametros se abrira un breve menu interactivo para elegir ambiente y tenant; el ultimo valor usado queda guardado en `config/runtime.cache.json`.
- Para forzar valores desde la linea de comandos usa `--env` y `--tenant`, o define las variables `API_TEST_ENV` / `API_TEST_TENANT`.
- Puedes sobreescribir cualquier secreto mediante variables de entorno; por ejemplo `KC_SECRET_T77_PRE` tiene prioridad sobre el valor incluido en el JSON.

### Paso 1: secretos opcionales
Los secretos proporcionados ya vienen cargados para que la herramienta funcione al instante. Si prefieres gestionarlos fuera del repositorio, crea un `.env` basado en `.env.example` e introduce las variables que quieras mantener privadas:
- `KC_SECRET_T77_PRE`, `KC_SECRET_T76_PRE`
- `AUTH_PASSWORD` para el flujo password del entorno TEST
- `API_TEST_ENV` y `API_TEST_TENANT` para fijar defaults locales

### Paso 2: escoger target al ejecutar
- `./run.sh --env pre --tenant 77` o `run.bat --env pre --tenant 77`
- `npm start -- --env pro --tenant 53`
- Si ejecutas `./run.sh` o `node index.js` sin argumentos, se mostrara un selector interactivo.

`index.js` detecta el modo de autenticacion (password o client_credentials), obtiene el token y añade la cabecera `X-TENANT-ID` automaticamente.

## Configuración de queries
- `config.json` contiene únicamente el arreglo `queries`; cada entrada define `name`, `method`, `path`, parámetros (`params`), parámetros de ruta (`pathParams`) y el archivo JSON que se generará en `output/`.
- Los detalles de conexión por ambiente (URLs, realms, tenants, secretos) viven en `config/targets.json`, por lo que cambiar de entorno no requiere modificar `config.json`.
- Los parámetros de consulta del JSON se aplican tal cual al ejecutar `node index.js`. Si también quieres que Newman use esos valores, replica los cambios en `data.json` o elimina las claves allí para que prevalezcan las definidas en la colección.
- Puedes añadir o ajustar queries sin reiniciar nada: guarda el archivo y vuelve a ejecutar `run.bat` o `run.sh` con el ambiente y tenant deseados.
- Para endpoints paginados puedes añadir la clave `pagination` en cada entrada (modo `page` o `offset`), indicando los nombres de los parámetros (`page`, `pageSize`, `offset`, `limit`, etc.). El script recorrerá todas las páginas hasta agotar los datos actualizando los totales finales.
- Si un endpoint responde con error, el detalle queda guardado como `output/error_<archivo>.json` para que puedas corregir rápidamente los parámetros.
- Puedes limitar la ejecución a consultas concretas con `--query "Get Staff Detail,Get Task"` (usa el nombre exacto separado por comas). Esto es útil para reprocesar un único JSON sin relanzar colecciones completas.
- Para acotar el rango temporal ajusta `startDate` / `endDate` en la entrada correspondiente de `config.json`; el script respeta esos valores al momento de descargar los datos.

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
  - Añade/actualiza automáticamente la cabecera `X-TENANT-ID` usando `tenant_id` (o `tenant_id_override`).
  - Gestiona el token de Keycloak: reutiliza `access_token` si sigue vigente o solicita uno nuevo con las variables de entorno (`identity_base_url`, `realm`, `client_id`, credenciales...).
  - Precedencia estricta: **iteration-data (`data.json`) > environment (`envs/*.json`) > variables de colección > contrato Postman**. Si ninguna fuente aporta un valor, se mantiene el valor del contrato.
  - Solo se consideran las claves con coincidencia exacta (sensible a mayúsculas/minúsculas). No hay conversión automática entre `snake_case`, `camelCase` ni variantes.

### Autenticación con `client_credentials`
Algunos entornos no usan usuario/contraseña, sino el flujo `client_credentials` de Keycloak. Para ello necesitas únicamente:

1. La URL del endpoint de token de tu realm (`.../protocol/openid-connect/token`).
2. El `client_id` y su `client_secret`.
3. El `X-Tenant-Id` que corresponde al entorno que vas a probar.

Con esos datos el script (tanto `index.js` como la colección normalizada) enviará una petición `application/x-www-form-urlencoded` con `grant_type=client_credentials` y añadirá el `client_secret`. En Keycloak es habitual incluirlo mediante la cabecera `Authorization: Basic base64(client_id:client_secret)`, que es lo que hace el pre-request de Newman; el script de Node lee el secreto desde variables de entorno para no guardarlo en Git y construye el mismo encabezado.

> **Importante:** mantén el `client_secret` fuera del repositorio y cárgalo como variable de entorno (por ejemplo `CLIENT_SECRET` antes de ejecutar `run.sh` o `run.bat`). El JSON de configuración (`config.json`) y los environments de Postman/Newman (`envs/`) solo deberían referenciar el nombre de la variable.

Si recibiste credenciales como las siguientes:

```
URL token: https://identity-pre.otto.goalsystems.es/realms/metrorreytest10/protocol/openid-connect/token
client_id: external-client
client_secret: a#WJlb_O<xbM^cByOaATy@-u&v&+_}jI(-Nm89.^gCULG}x%
X-Tenant-Id: 77
```

puedes crear un environment específico (por ejemplo `envs/Metrorrey77.postman_environment.json`) con `grant_type` ajustado a `client_credentials`, indicar el `client_id` y dejar el `client_secret` como `{{CLIENT_SECRET}}`. Antes de ejecutar Newman o los scripts, exporta la variable `CLIENT_SECRET` en tu terminal y obtendrás el token sin necesidad de usuario/contraseña.

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
