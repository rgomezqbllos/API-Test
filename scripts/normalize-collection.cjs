const fs = require('fs');
const path = require('path');

const COLLECTION_SOURCE = path.join(process.cwd(), 'collections', 'Integration-consumer.postman_collection.json');
const COLLECTION_NORMALIZED = path.join(process.cwd(), 'collections', 'Integration-consumer.postman_collection.normalized.json');

function loadCollection() {
  const source = fs.readFileSync(COLLECTION_SOURCE, 'utf8');
  try {
    return JSON.parse(source);
  } catch (err) {
    throw new Error(`No se pudo parsear la colección: ${err.message}`);
  }
}

function ensurePreRequest(data) {
  if (!data.event) {
    data.event = [];
  }

  let preRequest = data.event.find((event) => event && event.listen === 'prerequest');
  if (!preRequest) {
    preRequest = { listen: 'prerequest', script: { type: 'text/javascript', exec: [] } };
    data.event.unshift(preRequest);
  }

  if (!preRequest.script) {
    preRequest.script = { type: 'text/javascript', exec: [] };
  }

  preRequest.script.type = 'text/javascript';
  preRequest.script.id = preRequest.script.id || 'collection-prerequest-managed';

  const scriptContent = String.raw`
try {
  const iterationObj = pm.iterationData && typeof pm.iterationData.toObject === "function" ? pm.iterationData.toObject() : {};
  pm.collectionVariables.set("dataFile", JSON.stringify(iterationObj));
} catch (setDataErr) {
  pm.collectionVariables.set("dataFile", "{}");
}

(function () {
  const debugRaw = pm.variables.get("override_debug") || "false";
  const debug = String(debugRaw).toLowerCase() === "true";
  const log = function () {
    if (!debug) {
      return;
    }
    try {
      const args = Array.prototype.slice.call(arguments);
      console.log.apply(console, ["[override]"].concat(args));
    } catch (consoleErr) {
      // Silenciar errores de consola en entornos donde no exista
    }
  };
  const overrideKeysInput = pm.variables.get("override_keys") || "";
  const overrideKeysArray = String(overrideKeysInput)
    .split(",")
    .map(function (key) { return key.trim(); })
    .filter(function (key) { return key.length > 0; });
  const overrideKeys = overrideKeysArray.length ? overrideKeysArray : null;
  const arraysModeRaw = pm.variables.get("arrays_as") || "repeat";
  const arraysMode = String(arraysModeRaw).toLowerCase() === "csv" ? "csv" : "repeat";
  const injectMissingRaw = pm.variables.get("inject_missing_params") || "false";
  const injectMissing = String(injectMissingRaw).toLowerCase() === "true";
  const sourcePriority = [
    function (key) {
      return pm.iterationData && typeof pm.iterationData.get === "function" ? pm.iterationData.get(key) : undefined;
    },
    function (key) {
      return pm.environment ? pm.environment.get(key) : undefined;
    },
    function (key) {
      return pm.collectionVariables ? pm.collectionVariables.get(key) : undefined;
    }
  ];
  const hasValue = function (value) {
    return value !== undefined && value !== null;
  };
  const resolveValue = function (key) {
    for (var i = 0; i < sourcePriority.length; i += 1) {
      try {
        const candidate = sourcePriority[i](key);
        if (hasValue(candidate)) {
          return candidate;
        }
      } catch (resolveErr) {
        // Ignorar errores de origen aislados
      }
    }
    return undefined;
  };
  const shouldOverride = function (key) {
    if (!key) {
      return false;
    }
    if (!overrideKeys) {
      return true;
    }
    return overrideKeys.indexOf(key) !== -1;
  };
  try {
    const url = pm.request && pm.request.url;
    if (!url) {
      return;
    }
    const query = url.query;
    const existingKeys = {};
    const queuedOverrides = [];
    if (query && typeof query.each === "function") {
      query.each(function (item) {
        if (!item || !item.key) {
          return;
        }
        const key = item.key;
        existingKeys[key] = true;
        if (queuedOverrides.indexOf(key) === -1) {
          queuedOverrides.push(key);
        }
      });
    }
    queuedOverrides.forEach(function (key) {
      if (!shouldOverride(key)) {
        return;
      }
      const overrideValue = resolveValue(key);
      if (!hasValue(overrideValue)) {
        return;
      }
      if (Array.isArray(overrideValue)) {
        if (query && typeof query.remove === "function") {
          query.remove(key);
        }
        if (arraysMode === "csv") {
          const joined = overrideValue.map(function (value) { return String(value); }).join(",");
          if (query && typeof query.add === "function") {
            query.add({ key: key, value: joined });
            log("query csv", key, joined);
          }
        } else {
          overrideValue.forEach(function (value) {
            if (!hasValue(value)) {
              return;
            }
            if (query && typeof query.add === "function") {
              query.add({ key: key, value: String(value) });
            }
          });
          log("query repeat", key, overrideValue);
        }
      } else {
        if (query && typeof query.upsert === "function") {
          query.upsert({ key: key, value: String(overrideValue) });
          log("query upsert", key, overrideValue);
        }
      }
    });
    if (query && injectMissing && overrideKeys) {
      overrideKeys.forEach(function (key) {
        if (existingKeys[key]) {
          return;
        }
        const overrideValue = resolveValue(key);
        if (!hasValue(overrideValue)) {
          return;
        }
        if (Array.isArray(overrideValue)) {
          if (arraysMode === "csv") {
            const joined = overrideValue.map(function (value) { return String(value); }).join(",");
            if (query && typeof query.add === "function") {
              query.add({ key: key, value: joined });
              log("query inject csv", key, joined);
            }
          } else {
            overrideValue.forEach(function (value) {
              if (!hasValue(value)) {
                return;
              }
              if (query && typeof query.add === "function") {
                query.add({ key: key, value: String(value) });
              }
            });
            log("query inject repeat", key, overrideValue);
          }
        } else {
          if (query && typeof query.add === "function") {
            query.add({ key: key, value: String(overrideValue) });
            log("query inject", key, overrideValue);
          }
        }
      });
    }
    const applyToVariables = function (variables, callback) {
      if (!variables || typeof variables.each !== "function") {
        return;
      }
      variables.each(function (item) {
        if (!item || !item.key || !shouldOverride(item.key)) {
          return;
        }
        const value = resolveValue(item.key);
        if (!hasValue(value)) {
          return;
        }
        callback(item.key, value);
      });
    };
    applyToVariables(url.variables, function (key, value) {
      if (url.variables && typeof url.variables.upsert === "function") {
        url.variables.upsert({ key: key, value: String(value) });
        log("path variable", key, value);
      }
    });
    const templateMatches = String(url.toString()).match(/{{([^{}]+)}}/g) || [];
    templateMatches.forEach(function (token) {
      const key = token.slice(2, -2);
      if (!shouldOverride(key)) {
        return;
      }
      const value = resolveValue(key);
      if (!hasValue(value)) {
        return;
      }
      pm.variables.set(key, String(value));
      log("template variable", key, value);
    });
  } catch (scriptErr) {
    console.warn('Parameter override error:', scriptErr && scriptErr.message ? scriptErr.message : scriptErr);
  }
})();
`.trim();

  preRequest.script.exec = scriptContent.split('\n');
}

function writeNormalized(data) {
  const serialized = JSON.stringify(data, null, '\t');
  fs.writeFileSync(COLLECTION_NORMALIZED, serialized);
  return COLLECTION_NORMALIZED;
}

(function main() {
  const collection = loadCollection();
  ensurePreRequest(collection);
  const outputPath = writeNormalized(collection);
  console.log(`Colección normalizada generada en: ${path.relative(process.cwd(), outputPath)}`);
})();
