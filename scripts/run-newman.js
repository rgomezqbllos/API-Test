import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
    parseCliArgs,
    resolveRuntime,
    saveRuntimeCache,
    loadRuntimeCache,
    ensureDir,
    extractHostFromBaseUrl,
    extractTokenPath
} from '../lib/runtime.js';

const require = createRequire(import.meta.url);
const newman = require('newman');
require('newman-reporter-htmlextra');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const COLLECTION_FILE = path.join(ROOT_DIR, 'collections', 'Integration-consumer.postman_collection.normalized.json');
const TEMPLATE_ENV_FILE = path.join(ROOT_DIR, 'envs', 'Dev.postman_environment.json');
const GENERATED_ENV_FILE = path.join(ROOT_DIR, 'envs', 'Active.postman_environment.json');
const ITERATION_DATA_FILE = path.join(ROOT_DIR, 'data.json');
const NEWMAN_OUTPUT_DIR = path.join(ROOT_DIR, 'newman');

function setEnvValue(environment, key, value, type = 'default') {
    if (!environment.values) {
        environment.values = [];
    }
    const existing = environment.values.find((entry) => entry.key === key);
    if (existing) {
        existing.value = value;
        existing.type = type;
        existing.enabled = true;
    } else {
        environment.values.push({
            key,
            value,
            type,
            enabled: true
        });
    }
}

function clearEnvValue(environment, key) {
    setEnvValue(environment, key, '');
}

function computeHostMap(baseUrl) {
    const integrationUrl = new URL(baseUrl);
    const origin = integrationUrl.origin;
    const trimTrailingSlash = (value) => value.replace(/\/+$/, '');
    const ensureTrailingSlash = (value) => (value.endsWith('/') ? value : `${value}/`);

    const basePath = trimTrailingSlash(integrationUrl.pathname || '');
    const hasIntegrationSuffix = basePath.endsWith('/api-integration');
    const rootOrigin = origin;

    const build = (pathSuffix, opts = { trailingSlash: false }) => {
        const url = `${rootOrigin}${pathSuffix}`;
        return opts.trailingSlash ? ensureTrailingSlash(url) : url;
    };

    return {
        origin: rootOrigin,
        integration: hasIntegrationSuffix ? `${rootOrigin}${basePath}` : trimTrailingSlash(baseUrl),
        planning: build('/api-planning'),
        scheduling: build('/api-scheduling'),
        scheduler: build('/api-scheduler/', { trailingSlash: true }),
        vehicle: build('/api-vehicle'),
        rostering: build('/api-rostering'),
        reports: build('/api-reports'),
        app: rootOrigin,
        back: rootOrigin
    };
}

async function prepareEnvironmentFile(runtime) {
    let template;
    try {
        const raw = await fs.readFile(TEMPLATE_ENV_FILE, 'utf8');
        template = JSON.parse(raw);
    } catch (error) {
        throw new Error(`No se pudo cargar el entorno base de Postman (${TEMPLATE_ENV_FILE}): ${error.message}`);
    }

    const hostMap = computeHostMap(runtime.baseUrl);
    const tokenPath = extractTokenPath(runtime.auth.token_url);
    const identityBase = runtime.auth.identity_base_url || extractHostFromBaseUrl(runtime.auth.token_url);

    const nameSuffix = runtime.envName ? `${runtime.envName.toUpperCase()} - Tenant ${runtime.tenantId}` : `Tenant ${runtime.tenantId}`;
    template.name = `Runtime ${nameSuffix}`;

    setEnvValue(template, 'baseUrl', runtime.baseUrl);
    setEnvValue(template, 'api_base_url', runtime.baseUrl);
    setEnvValue(template, 'integration_host', runtime.baseUrl);
    setEnvValue(template, 'tenant_id', runtime.tenantId);
    setEnvValue(template, 'x_tenant_id', runtime.tenantId);
    setEnvValue(template, 'client_id', runtime.auth.client_id);
    if (runtime.auth.client_secret) {
        setEnvValue(template, 'client_secret', runtime.auth.client_secret);
    }
    setEnvValue(template, 'auth_grant', runtime.auth.grant_type || 'client_credentials');
    if (runtime.auth.username) {
        setEnvValue(template, 'username', runtime.auth.username);
    } else {
        clearEnvValue(template, 'username');
    }
    if (runtime.auth.password) {
        setEnvValue(template, 'password', runtime.auth.password);
    } else {
        clearEnvValue(template, 'password');
    }
    if (runtime.auth.scope) {
        setEnvValue(template, 'scope', runtime.auth.scope);
    }

    if (identityBase) {
        setEnvValue(template, 'keycloak_host', identityBase);
        setEnvValue(template, 'identity_base_url', identityBase);
    }
    if (runtime.auth.realm) {
        setEnvValue(template, 'realm', runtime.auth.realm);
    }
    if (tokenPath) {
        setEnvValue(template, 'sso_url', tokenPath);
    }
    setEnvValue(template, 'keycloak_token_url', runtime.auth.token_url);

    // Derived hosts
    setEnvValue(template, 'app_host', hostMap.app);
    setEnvValue(template, 'back_host', hostMap.back);
    setEnvValue(template, 'planning_host', hostMap.planning);
    setEnvValue(template, 'scheduling_host', hostMap.scheduling);
    setEnvValue(template, 'scheduler_host', hostMap.scheduler);
    setEnvValue(template, 'vehicle_host', hostMap.vehicle);
    setEnvValue(template, 'rostering_host', hostMap.rostering);
    setEnvValue(template, 'reports_host', hostMap.reports);

    // Clear cached tokens to avoid stale data
    ['token', 'token_subus', 'refresh_token', 'access_token', 'token_expires_at', 'token_expiry'].forEach((key) => {
        clearEnvValue(template, key);
    });
    ['tenant_11_access_token', 'tenant_11_token_expires_in', 'tenant_11_token_type', 'tenant_11_token_expires_at'].forEach((key) => {
        clearEnvValue(template, key);
    });

    await fs.writeFile(GENERATED_ENV_FILE, JSON.stringify(template, null, 2), 'utf8');
    return GENERATED_ENV_FILE;
}

function filterPassthroughArgs(argv, consumedKeys) {
    const passthrough = [];
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            passthrough.push(token);
            continue;
        }
        const isAssign = token.includes('=');
        const key = token.slice(2, isAssign ? token.indexOf('=') : undefined);

        if (consumedKeys.has(key)) {
            if (!isAssign && argv[i + 1] && !argv[i + 1].startsWith('--')) {
                i += 1;
            }
            continue;
        }
        passthrough.push(token);
        if (!isAssign && argv[i + 1] && !argv[i + 1].startsWith('--')) {
            passthrough.push(argv[i + 1]);
            i += 1;
        }
    }
    return passthrough;
}

async function ensureCollectionAvailable() {
    try {
        await fs.access(COLLECTION_FILE);
    } catch {
        throw new Error('No se encontro la coleccion normalizada. Ejecuta "npm run normalize:collection" antes de lanzar Newman.');
    }
}

async function runNewman(envFile, additionalArgs = []) {
    await ensureDir(NEWMAN_OUTPUT_DIR);
    const htmlReport = path.join(NEWMAN_OUTPUT_DIR, 'report.html');
    const jsonReport = path.join(NEWMAN_OUTPUT_DIR, 'report.json');

    const options = {
        collection: COLLECTION_FILE,
        environment: envFile,
        iterationData: ITERATION_DATA_FILE,
        reporters: ['cli', 'htmlextra', 'json'],
        delayRequest: 50,
        reporter: {
            htmlextra: {
                export: htmlReport
            },
            json: {
                export: jsonReport
            }
        }
    };

    if (additionalArgs.length) {
        console.warn('Argumentos extra para Newman ignorados en modo programático:', additionalArgs.join(' '));
    }

    return new Promise((resolve, reject) => {
        newman.run(options, (err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        });
    });
}

async function main() {
    const argv = process.argv.slice(2);
    const args = parseCliArgs(argv);
    const consumedKeys = new Set(['env', 'tenant']);
    const passthroughArgs = filterPassthroughArgs(argv, consumedKeys);

    let runtime = null;
    const hasExplicitSelection = Boolean(args.env || args.tenant);

    if (!hasExplicitSelection) {
        runtime = await loadRuntimeCache();
    }

    if (!runtime) {
        runtime = await resolveRuntime({ args });
        await saveRuntimeCache(runtime);
    }

    await ensureCollectionAvailable();
    const envFile = await prepareEnvironmentFile(runtime);
    await runNewman(envFile, passthroughArgs);
}

main().catch((error) => {
    console.error('Error ejecutando Newman:', error.message);
    process.exit(1);
});
