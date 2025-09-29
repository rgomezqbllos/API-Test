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

  let dataOverrides = {};
  try {
    const dataRaw = pm.collectionVariables ? pm.collectionVariables.get("dataFile") : null;
    if (dataRaw) {
      dataOverrides = JSON.parse(dataRaw);
    }
    log("data overrides", dataOverrides);
  } catch (dataErr) {
    log("dataFile parse error", dataErr && dataErr.message ? dataErr.message : dataErr);
  }

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

  const cleanupPlaceholdersRaw = pm.variables.get("cleanup_placeholders");
  const cleanupPlaceholders = cleanupPlaceholdersRaw === undefined
    ? true
    : String(cleanupPlaceholdersRaw).toLowerCase() === "true";

  const placeholderTests = [
    function (value) {
      return typeof value === "string" && value.trim().toLowerCase() === "string";
    },
    function (value) {
      return typeof value === "string" && /\{\{.*\}\}/.test(value);
    }
  ];

  const sourcePriority = [
    function (key) {
      if (dataOverrides && Object.prototype.hasOwnProperty.call(dataOverrides, key)) {
        return dataOverrides[key];
      }
      return undefined;
    },
    function (key) {
      return pm.iterationData && typeof pm.iterationData.get === "function" ? pm.iterationData.get(key) : undefined;
    },
    function (key) {
      return pm.environment ? pm.environment.get(key) : undefined;
    },
    function (key) {
      return pm.collectionVariables ? pm.collectionVariables.get(key) : undefined;
    },
    function (key) {
      return pm.variables.get(key);
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

  const pushValues = function (target, key, values) {
    if (!values || !values.length) {
      return;
    }
    if (!target[key]) {
      target[key] = [];
    }
    values.forEach(function (value) {
      if (!hasValue(value)) {
        return;
      }
      target[key].push(String(value));
    });
  };

  const ensureTenantHeader = function () {
    try {
      const headers = pm.request && pm.request.headers;
      if (!headers) {
        return;
      }
      headers.remove("X-TENANT-ID");
      const tenantSkip = String(pm.variables.get("tenant_skip") || "false").toLowerCase() === "true";
      if (tenantSkip) {
        log("tenant header skipped");
        return;
      }
      let tenant = pm.variables.get("tenant_id_override");
      if (!tenant) {
        tenant = pm.variables.get("tenant_id");
      }
      if (!tenant) {
        tenant = pm.environment ? pm.environment.get("tenant_id") : undefined;
      }
      if (!tenant) {
        tenant = pm.collectionVariables ? pm.collectionVariables.get("tenant_id") : undefined;
      }
      if (!tenant) {
        throw new Error('Falta tenant_id para X-TENANT-ID');
      }
      headers.add({ key: "X-TENANT-ID", value: String(tenant) });
      log("tenant header", tenant);
    } catch (tenantErr) {
      console.warn('Tenant header error:', tenantErr && tenantErr.message ? tenantErr.message : tenantErr);
    }
  };

  const applyAuthHeader = function (token) {
    try {
      const headers = pm.request && pm.request.headers;
      if (!headers) {
        return;
      }
      headers.remove("Authorization");
      if (!token) {
        return;
      }
      headers.add({ key: "Authorization", value: "Bearer " + String(token) });
      log("auth header applied");
    } catch (authErr) {
      console.warn('Authorization header error:', authErr && authErr.message ? authErr.message : authErr);
    }
  };

  const requestToken = function (done) {
    try {
      const base = pm.variables.get("identity_base_url") || (pm.environment && pm.environment.get("identity_base_url"));
      const realm = pm.variables.get("realm") || (pm.environment && pm.environment.get("realm"));
      const tokenUrlVar = pm.variables.get("keycloak_token_url") || (pm.environment && pm.environment.get("keycloak_token_url"));
      if (!base || !realm) {
        log("token skipped: missing identity_base_url/realm");
        done();
        return;
      }
      const trimmedBase = String(base).replace(/\/$/, "");
      const tokenUrl = tokenUrlVar ? String(tokenUrlVar) : trimmedBase + "/realms/" + realm + "/protocol/openid-connect/token";
      const clientId = pm.variables.get("client_id") || (pm.environment && pm.environment.get("client_id")) || "";
      const clientSecret = pm.variables.get("client_secret") || (pm.environment && pm.environment.get("client_secret")) || "";
      const username = pm.variables.get("username") || (pm.environment && pm.environment.get("username")) || "";
      const password = pm.variables.get("password") || (pm.environment && pm.environment.get("password")) || "";
      let grant = pm.variables.get("auth_grant") || (pm.environment && pm.environment.get("auth_grant")) || "";
      grant = String(grant || "").trim();
      if (!grant) {
        grant = username && password ? "password" : "client_credentials";
      }
      const scopeRaw = pm.variables.get("scope") || (pm.environment && pm.environment.get("scope")) || "";
      const body = [];
      const addField = function (key, value) {
        body.push({ key: key, value: String(value) });
      };
      if (grant === "password") {
        if (!username || !password) {
          console.warn('Token error: grant=password pero faltan username/password');
          done();
          return;
        }
        addField("grant_type", "password");
        addField("username", username);
        addField("password", password);
        if (!clientSecret) {
          addField("client_id", clientId);
        }
      } else {
        addField("grant_type", "client_credentials");
        if (!clientSecret) {
          addField("client_id", clientId);
        }
      }
      if (scopeRaw) {
        addField("scope", scopeRaw);
      }
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      if (clientSecret) {
        try {
          headers.Authorization = "Basic " + btoa(String(clientId) + ":" + String(clientSecret));
        } catch (basicErr) {
          console.warn('Token basic auth error:', basicErr && basicErr.message ? basicErr.message : basicErr);
        }
      }
      log("requesting token", { tokenUrl: tokenUrl, grant: grant, confidential: !!clientSecret });
      pm.sendRequest({
        url: tokenUrl,
        method: "POST",
        header: headers,
        body: { mode: "urlencoded", urlencoded: body }
      }, function (err, res) {
        if (err) {
          console.warn('Token request error:', err && err.message ? err.message : err);
          done();
          return;
        }
        let data;
        try {
          data = res.json();
        } catch (parseErr) {
          console.warn('Token parse error:', parseErr && parseErr.message ? parseErr.message : parseErr);
          done();
          return;
        }
        if (!data || !data.access_token) {
          console.warn('Token response sin access_token');
          done();
          return;
        }
        try {
          pm.environment.set("access_token", data.access_token);
          if (data.refresh_token) {
            pm.environment.set("refresh_token", data.refresh_token);
          }
          const expiresIn = parseInt(data.expires_in || "0", 10);
          if (expiresIn) {
            pm.environment.set("token_expiry", String(Math.floor(Date.now() / 1000) + expiresIn));
          }
        } catch (setErr) {
          console.warn('Token save error:', setErr && setErr.message ? setErr.message : setErr);
        }
        applyAuthHeader(data.access_token);
        done();
      });
    } catch (tokenErr) {
      console.warn('Token setup error:', tokenErr && tokenErr.message ? tokenErr.message : tokenErr);
      done();
    }
  };

  const ensureAuthorization = function (done) {
    try {
      const env = pm.environment;
      const token = env ? env.get("access_token") : undefined;
      const expiryRaw = env ? env.get("token_expiry") : undefined;
      const expiry = parseInt(expiryRaw || "0", 10);
      const now = Math.floor(Date.now() / 1000);
      if (token && expiry && now < (expiry - 60)) {
        log("reusing token");
        applyAuthHeader(token);
        done();
        return;
      }
    } catch (reuseErr) {
      console.warn('Token reuse check error:', reuseErr && reuseErr.message ? reuseErr.message : reuseErr);
    }
    requestToken(done);
  };

  const adjustQueryParams = function () {
    try {
      const url = pm.request && pm.request.url;
      if (!url) {
        return;
      }

      const query = url.query;
      const originalValues = {};

      if (query && typeof query.each === "function") {
        query.each(function (item) {
          if (!item || !item.key) {
            return;
          }
          if (!originalValues[item.key]) {
            originalValues[item.key] = [];
          }
          originalValues[item.key].push(item.value);
        });
      }

      if (query && typeof query.remove === "function") {
        Object.keys(originalValues).forEach(function (key) {
          try {
            query.remove(key);
          } catch (removeErr) {
            // Ignorar errores en remove
          }
        });
      }

      const finalQueryValues = {};

      const applyOverrideValue = function (key, overrideValue) {
        if (Array.isArray(overrideValue)) {
          if (arraysMode === "csv") {
            pushValues(finalQueryValues, key, [overrideValue.map(function (value) { return String(value); }).join(",")]);
          } else {
            pushValues(finalQueryValues, key, overrideValue.map(function (value) { return String(value); }));
          }
        } else {
          pushValues(finalQueryValues, key, [overrideValue]);
        }
      };

      Object.keys(originalValues).forEach(function (key) {
        const overrideValue = resolveValue(key);
        if (hasValue(overrideValue)) {
          applyOverrideValue(key, overrideValue);
          log("query override", key, overrideValue);
        } else {
          var kept = originalValues[key] || [];
          if (cleanupPlaceholders) {
            kept = kept.filter(function (value) {
              return !placeholderTests.some(function (test) { return test(value); });
            });
          }
          pushValues(finalQueryValues, key, kept);
        }
      });

      if (injectMissing && overrideKeys) {
        overrideKeys.forEach(function (key) {
          if (finalQueryValues[key] && finalQueryValues[key].length) {
            return;
          }
          const overrideValue = resolveValue(key);
          if (!hasValue(overrideValue)) {
            return;
          }
          applyOverrideValue(key, overrideValue);
          log("query inject", key, overrideValue);
        });
      }

      if (query && typeof query.add === "function") {
        Object.keys(finalQueryValues).forEach(function (key) {
          finalQueryValues[key].forEach(function (value) {
            query.add({ key: key, value: value });
          });
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
  };

  const runAll = function () {
    ensureTenantHeader();
    adjustQueryParams();
  };

  ensureAuthorization(runAll);
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
