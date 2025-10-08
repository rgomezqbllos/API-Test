import fs from 'fs/promises';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const ROOT_DIR = process.cwd();
export const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');
export const TARGETS_FILE = path.join(ROOT_DIR, 'config', 'targets.json');
export const RUNTIME_CACHE_FILE = path.join(ROOT_DIR, 'config', 'runtime.cache.json');

const ENV_ENV_VAR = 'API_TEST_ENV';
const TENANT_ENV_VAR = 'API_TEST_TENANT';

let sharedReadline = null;

export function parseCliArgs(argv = process.argv.slice(2)) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        const eq = token.indexOf('=');
        if (eq !== -1) {
            const key = token.slice(2, eq);
            const value = token.slice(eq + 1);
            args[key] = value;
        } else {
            const key = token.slice(2);
            const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            args[key] = value;
        }
    }
    return args;
}

function isInteractive() {
    return Boolean(input.isTTY && output.isTTY);
}

function normaliseKey(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function matchKey(value, collection) {
    if (!value) return null;
    if (collection[value]) return value;
    const lower = value.toLowerCase();
    const keys = Object.keys(collection);
    for (const key of keys) {
        if (key.toLowerCase() === lower) {
            return key;
        }
    }
    return null;
}

async function loadJsonIfExists(filePath) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function ensureArray(value) {
    return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
    return value && typeof value === 'object' ? value : {};
}

async function getReadline() {
    if (!sharedReadline) {
        sharedReadline = readline.createInterface({ input, output });
    }
    return sharedReadline;
}

async function closeReadline() {
    if (sharedReadline) {
        await sharedReadline.close();
        sharedReadline = null;
    }
}

async function promptChoice(message, options, defaultKey) {
    if (!options.length) return null;

    const rl = await getReadline();
    console.log('');
    console.log(message);
    options.forEach((option, index) => {
        console.log(`  [${index + 1}] ${option.label}`);
    });
    const defaultIndex = defaultKey
        ? options.findIndex((option) => option.key === defaultKey)
        : -1;
    const promptSuffix = defaultIndex >= 0 ? ` (${defaultIndex + 1})` : '';

    while (true) {
        const answer = await rl.question(`Selecciona una opción${promptSuffix}: `);
        const trimmed = answer.trim();
        if (!trimmed && defaultIndex >= 0) {
            return options[defaultIndex].key;
        }
        const parsedIndex = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(parsedIndex) && parsedIndex >= 1 && parsedIndex <= options.length) {
            return options[parsedIndex - 1].key;
        }
        const match = options.find((option) => option.key.toLowerCase() === trimmed.toLowerCase());
        if (match) {
            return match.key;
        }
        console.log('Opción inválida, intenta nuevamente.');
    }
}

function tenantOptionsFromConfig(tenants) {
    return Object.entries(tenants).map(([key, value]) => ({
        key,
        label: value && value.label ? `${key} - ${value.label}` : key
    }));
}

function environmentOptionsFromConfig(environments) {
    return Object.entries(environments).map(([key, value]) => ({
        key,
        label: value && value.description ? `${key} - ${value.description}` : key
    }));
}

function buildTokenUrl(identityBaseUrl, realm) {
    if (!identityBaseUrl || !realm) {
        return null;
    }
    return `${identityBaseUrl.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/token`;
}

function urlOrigin(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.origin;
    } catch {
        return null;
    }
}

function urlPathname(urlString) {
    try {
        const parsed = new URL(urlString);
        return parsed.pathname;
    } catch {
        return null;
    }
}

function deriveBaseUrl(legacy, envConf) {
    if (envConf && envConf.api_base_url) {
        return envConf.api_base_url;
    }
    if (legacy && legacy.baseUrl) {
        return legacy.baseUrl;
    }
    return null;
}

function resolveTenantSecret(tenantConf, envVars) {
    if (!tenantConf) return null;
    const candidateKeys = [];
    if (tenantConf.client_secret_env) {
        candidateKeys.push(tenantConf.client_secret_env);
    }
    if (Array.isArray(tenantConf.client_secret_envs)) {
        candidateKeys.push(...tenantConf.client_secret_envs);
    }
    for (const key of candidateKeys) {
        if (key && envVars[key]) {
            return envVars[key];
        }
    }
    if (tenantConf.client_secret) {
        return tenantConf.client_secret;
    }
    return null;
}

function ensureString(value) {
    if (value === undefined || value === null) return null;
    return String(value);
}

export async function resolveRuntime({
    args = {},
    allowPrompt = true,
    envVars = process.env
} = {}) {
    const config = ensureObject(await loadJsonIfExists(CONFIG_FILE));
    const queries = ensureArray(config.queries);
    const legacy = ensureObject(config.globals);

    const targets = ensureObject(await loadJsonIfExists(TARGETS_FILE));
    const environments = ensureObject(targets.environments);
    const envOptions = environmentOptionsFromConfig(environments);

    const interactive = allowPrompt && isInteractive();

    let envName = normaliseKey(args.env || envVars[ENV_ENV_VAR] || '');
    envName = matchKey(envName, environments);
    if (!envName && envOptions.length === 1) {
        envName = envOptions[0].key;
    }
    if (!envName && envOptions.length > 1 && interactive) {
        envName = await promptChoice('Selecciona el ambiente a utilizar:', envOptions, null);
    }

    if (envName && !environments[envName]) {
        const available = envOptions.map((option) => option.key).join(', ') || 'ninguno';
        throw new Error(`Ambiente "${envName}" no configurado. Disponibles: ${available}`);
    }

    const envConf = envName ? environments[envName] : null;
    const baseUrl = deriveBaseUrl(legacy, envConf);
    if (!baseUrl) {
        throw new Error('No se pudo determinar el baseUrl. Configura config.globals.baseUrl o config/targets.json.');
    }

    const tenantOptions = envConf && envConf.tenants ? tenantOptionsFromConfig(envConf.tenants) : [];
    let tenantId = ensureString(
        args.tenant
        || envVars[TENANT_ENV_VAR]
        || (envConf && envConf.default_tenant_id)
        || legacy.tenant_id
    );
    tenantId = tenantId ? tenantId.trim() : null;

    if (tenantId && envConf && envConf.tenants) {
        const matchedTenant = matchKey(tenantId, envConf.tenants);
        if (matchedTenant) {
            tenantId = matchedTenant;
        }
    }

    if ((!tenantId || (envConf && envConf.tenants && !envConf.tenants[tenantId])) && tenantOptions.length && interactive) {
        tenantId = await promptChoice('Selecciona el tenant a utilizar:', tenantOptions, envConf && envConf.default_tenant_id);
    }

    if (envConf && envConf.tenants && !tenantId) {
        const availableTenants = tenantOptions.map((option) => option.key).join(', ') || 'ninguno';
        throw new Error(`Debe especificar un tenant para el ambiente ${envName}. Disponibles: ${availableTenants}`);
    }

    const tenantConf = envConf && envConf.tenants ? envConf.tenants[tenantId] : null;

    let auth = null;
    let tenantLabel = tenantId;

    if (envConf && envConf.auth_mode === 'client_credentials') {
        if (!tenantConf) {
            throw new Error(`Tenant "${tenantId}" no configurado para el ambiente ${envName}.`);
        }
        tenantLabel = tenantConf.label || tenantId;

        const identityBaseUrl = tenantConf.identity_base_url
            || envConf.identity_base_url
            || urlOrigin(tenantConf.token_url)
            || urlOrigin(envConf.token_url);

        const realm = tenantConf.realm || envConf.realm;
        const tokenUrl = tenantConf.token_url
            || envConf.token_url
            || buildTokenUrl(identityBaseUrl, realm);

        if (!tokenUrl) {
            throw new Error(`No se pudo determinar el token_url para el tenant ${tenantId} en ${envName}.`);
        }

        const clientSecret = resolveTenantSecret(tenantConf, envVars);
        if (!clientSecret) {
            const secretHints = [];
            if (tenantConf.client_secret_env) secretHints.push(`variable de entorno ${tenantConf.client_secret_env}`);
            if (tenantConf.client_secret) secretHints.push('client_secret en config/targets.json');
            throw new Error(`No se encontró el client_secret para el tenant ${tenantId}. Configura ${secretHints.join(' o ')}.`);
        }

        auth = {
            grant_type: 'client_credentials',
            client_id: tenantConf.client_id,
            client_secret: clientSecret,
            token_url: tokenUrl,
            realm,
            identity_base_url: identityBaseUrl
        };
        if (tenantConf.scope || envConf.scope) {
            auth.scope = tenantConf.scope || envConf.scope;
        }
    } else if (envConf && envConf.auth_mode === 'password') {
        const identityBaseUrl = envConf.identity_base_url || (legacy.auth && legacy.auth.identity_base_url);
        const realm = envConf.realm || (legacy.auth && legacy.auth.realm);
        const username = envConf.username || (legacy.auth && legacy.auth.username);
        const password = (envConf.password_env && envVars[envConf.password_env]) || (legacy.auth && legacy.auth.password);
        const clientId = envConf.client_id || (legacy.auth && legacy.auth.client_id);

        if (!identityBaseUrl || !realm || !username || !password || !clientId) {
            throw new Error('Configuración de password grant incompleta. Revisa config/targets.json o config.json.');
        }

        auth = {
            identity_base_url: identityBaseUrl,
            realm,
            grant_type: 'password',
            client_id: clientId,
            username,
            password
        };
    } else {
        auth = ensureObject(legacy.auth);
    }

    if (!auth || !auth.client_id) {
        throw new Error('No se pudo determinar la configuración de autenticación.');
    }

    const runtime = {
        envName: envName || 'default',
        envConfig: envConf,
        envDescription: envConf && envConf.description ? envConf.description : null,
        tenantId: tenantId || legacy.tenant_id || null,
        tenantLabel,
        tenantConfig: tenantConf,
        baseUrl,
        auth,
        config,
        queries,
        targets
    };

    if (!runtime.tenantId) {
        throw new Error('No se pudo determinar el tenant. Usa --tenant o define un valor por defecto en config/targets.json o config.json.');
    }

    await closeReadline();

    return runtime;
}

export async function saveRuntimeCache(runtime) {
    if (!runtime) return;
    const payload = {
        envName: runtime.envName,
        tenantId: runtime.tenantId,
        baseUrl: runtime.baseUrl,
        timestamp: new Date().toISOString(),
        auth: {
            client_id: runtime.auth.client_id,
            client_secret: runtime.auth.client_secret,
            grant_type: runtime.auth.grant_type,
            token_url: runtime.auth.token_url,
            identity_base_url: runtime.auth.identity_base_url || urlOrigin(runtime.auth.token_url),
            realm: runtime.auth.realm || null,
            scope: runtime.auth.scope || null,
            username: runtime.auth.username || null,
            password: runtime.auth.password || null
        },
        tenantLabel: runtime.tenantLabel,
        envDescription: runtime.envDescription
    };
    await fs.mkdir(path.dirname(RUNTIME_CACHE_FILE), { recursive: true });
    await fs.writeFile(RUNTIME_CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

export async function loadRuntimeCache() {
    const data = await loadJsonIfExists(RUNTIME_CACHE_FILE);
    if (!data) return null;
    if (!data.baseUrl || !data.auth || !data.auth.client_id) {
        return null;
    }
    return data;
}

export async function ensureDir(dirPath) {
    await fs.mkdir(dirPath, { recursive: true });
}

export function extractHostFromBaseUrl(baseUrl, fallback = null) {
    return urlOrigin(baseUrl) || fallback;
}

export function extractTokenPath(tokenUrl) {
    return urlPathname(tokenUrl);
}
