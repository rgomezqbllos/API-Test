import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import {
    parseCliArgs,
    resolveRuntime,
    saveRuntimeCache
} from './lib/runtime.js';

const OUTPUT_DIR = 'output';
const DEFAULT_RESULT_PATH = 'data';
const MAX_ITERATIONS_FALLBACK = 1000;

// --- Simple .env loader (optional, no external deps) ---
async function loadDotEnvIfPresent() {
    try {
        const raw = await fs.readFile('.env', 'utf8');
        raw.split(/\r?\n/).forEach((line) => {
            if (!line || /^\s*#/.test(line)) return;
            const idx = line.indexOf('=');
            if (idx === -1) return;
            const key = line.slice(0, idx).trim();
            const val = line.slice(idx + 1).trim();
            if (key && process.env[key] === undefined) {
                const unquoted = val.replace(/^['"]|['"]$/g, '');
                process.env[key] = unquoted;
            }
        });
    } catch {
        // .env not found is fine
    }
}

// --- Helpers ---------------------------------------------------------------

function cloneDeep(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function resolvePathTemplate(template, pathParams = {}) {
    let finalPath = template || '';
    Object.entries(pathParams).forEach(([key, value]) => {
        const pattern = new RegExp(`{${key}}`, 'g');
        finalPath = finalPath.replace(pattern, value);
    });
    return finalPath;
}

function composeUrl(baseUrl, finalPath) {
    const base = (baseUrl || '').replace(/\/+$/u, '');
    const suffix = finalPath.startsWith('/') ? finalPath : `/${finalPath}`;
    return `${base}${suffix}`;
}

function mergeParams(base = {}, overrides = {}) {
    const merged = { ...base };
    Object.entries(overrides || {}).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    });
    return merged;
}

function appendSearchParams(url, params) {
    if (!params) return;
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => {
                if (entry !== undefined && entry !== null) {
                    url.searchParams.append(key, String(entry));
                }
            });
            return;
        }
        url.searchParams.append(key, String(value));
    });
}

function buildRequestUrl(baseUrl, query, paramsOverrides) {
    const finalPath = resolvePathTemplate(query.path, query.pathParams);
    const fullUrl = composeUrl(baseUrl, finalPath);
    const url = new URL(fullUrl);
    const combinedParams = mergeParams(query.params, paramsOverrides);
    appendSearchParams(url, combinedParams);
    return url.toString();
}

function getPathSegments(pathExpression) {
    if (!pathExpression || pathExpression === '.') {
        return null;
    }
    return pathExpression.split('.').map((segment) => segment.trim()).filter(Boolean);
}

function getValueAtPath(obj, pathExpression) {
    const segments = getPathSegments(pathExpression);
    if (!segments) {
        return obj;
    }
    let current = obj;
    for (const segment of segments) {
        if (current === undefined || current === null) {
            return undefined;
        }
        current = current[segment];
    }
    return current;
}

function ensureArrayAtPath(obj, pathExpression) {
    const segments = getPathSegments(pathExpression);
    if (!segments) {
        return Array.isArray(obj) ? obj : null;
    }
    let current = obj;
    for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i];
        if (i === segments.length - 1) {
            if (!Array.isArray(current[segment])) {
                current[segment] = [];
            }
            return current[segment];
        }
        if (!current[segment] || typeof current[segment] !== 'object') {
            current[segment] = {};
        }
        current = current[segment];
    }
    return null;
}

function setValueAtPath(obj, pathExpression, value) {
    if (!pathExpression) return;
    const segments = getPathSegments(pathExpression);
    if (!segments || segments.length === 0) return;
    let current = obj;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i];
        if (!current[segment] || typeof current[segment] !== 'object') {
            current[segment] = {};
        }
        current = current[segment];
    }
    current[segments[segments.length - 1]] = value;
}

function normalizeNumber(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        const num = Number(value);
        if (Number.isFinite(num)) {
            return num;
        }
    }
    return null;
}

async function performRequest(query, baseUrl, tenantId, authConfig, paramsOverrides, attempt = 0) {
    const tokenValue = await getAuthToken(authConfig, { forceRenew: attempt > 0 });
    const requestUrl = buildRequestUrl(baseUrl, query, paramsOverrides);
    try {
        const response = await axios({
            method: query.method,
            url: requestUrl,
            headers: {
                Authorization: `Bearer ${tokenValue}`,
                'X-TENANT-ID': String(tenantId)
            }
        });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 401 && attempt === 0) {
            // Force token refresh and retry once
            token = null;
            tokenExpiresAt = 0;
            return performRequest(query, baseUrl, tenantId, authConfig, paramsOverrides, attempt + 1);
        }
        throw error;
    }
}

function computeMaxIterations(pagination) {
    if (pagination && Number.isFinite(Number(pagination.maxPages))) {
        return Number(pagination.maxPages);
    }
    return MAX_ITERATIONS_FALLBACK;
}

async function fetchWithPagination(query, baseUrl, tenantId, authConfig) {
    const pagination = query.pagination || {};
    const mode = (pagination.mode || 'page').toLowerCase();
    const resultPath = pagination.resultPath || DEFAULT_RESULT_PATH;
    const arraySegments = getPathSegments(resultPath);
    const maxIterations = computeMaxIterations(pagination);

    const baseParams = { ...(query.params || {}) };
    let aggregatedData = null;
    let aggregatedArray = null;

    const collectPage = (responseData) => {
        const pageItems = arraySegments ? getValueAtPath(responseData, resultPath) : responseData;
        const pageArray = Array.isArray(pageItems) ? pageItems : [];
        if (!aggregatedData) {
            aggregatedData = cloneDeep(responseData);
            aggregatedArray = ensureArrayAtPath(aggregatedData, resultPath);
            if (!aggregatedArray) {
                throw new Error(`El resultado de la consulta "${query.name}" no contiene un arreglo en la ruta "${resultPath}".`);
            }
        } else if (pageArray.length) {
            aggregatedArray.push(...pageArray.map((item) => cloneDeep(item)));
        }
        return pageArray.length;
    };

    if (mode === 'page') {
        const pageParam = pagination.pageParam || 'page';
        const pageSizeParam = pagination.pageSizeParam || 'pageSize';
        const startPage = normalizeNumber(pagination.startPage, baseParams[pageParam], 0) ?? 0;
        const pageSize = normalizeNumber(pagination.pageSize, baseParams[pageSizeParam], 20) ?? 20;
        delete baseParams[pageParam];
        delete baseParams[pageSizeParam];

        let currentPage = startPage;
        let iterations = 0;

        while (iterations < maxIterations) {
            const responseData = await performRequest(query, baseUrl, tenantId, authConfig, {
                ...baseParams,
                [pageParam]: currentPage,
                [pageSizeParam]: pageSize
            });

            const fetchedItems = collectPage(responseData);
            iterations += 1;

            const totalPages = getValueAtPath(responseData, pagination.totalPagesPath || 'totalPages');
            const currentReturnedPage = getValueAtPath(responseData, pagination.currentPagePath || 'currentPage');

            let shouldContinue = true;
            if (fetchedItems === 0) {
                shouldContinue = false;
            } else if (typeof totalPages === 'number') {
                const nextPage = typeof currentReturnedPage === 'number' ? currentReturnedPage + 1 : currentPage + 1;
                if (nextPage >= totalPages) {
                    shouldContinue = false;
                }
            } else if (fetchedItems < pageSize) {
                shouldContinue = false;
            }

            if (!shouldContinue) {
                break;
            }

            currentPage += 1;
        }

        if (aggregatedArray && pagination.updateTotals !== false) {
            if (pagination.totalRecordsPath || 'totalRecords') {
                setValueAtPath(aggregatedData, pagination.totalRecordsPath || 'totalRecords', aggregatedArray.length);
            }
            if (pagination.totalPagesPath || 'totalPages') {
                const computedPages = pageSize > 0 ? Math.ceil(aggregatedArray.length / pageSize) : aggregatedArray.length;
                setValueAtPath(aggregatedData, pagination.totalPagesPath || 'totalPages', computedPages);
            }
            if (pagination.currentPagePath || 'currentPage') {
                setValueAtPath(aggregatedData, pagination.currentPagePath || 'currentPage', startPage);
            }
        }

        return aggregatedData;
    }

    if (mode === 'offset') {
        const offsetParam = pagination.offsetParam || 'offset';
        const limitParam = pagination.limitParam || 'limit';
        const startOffset = normalizeNumber(pagination.startOffset, baseParams[offsetParam], 0) ?? 0;
        const limit = normalizeNumber(pagination.limit, baseParams[limitParam], 20) ?? 20;
        delete baseParams[offsetParam];
        delete baseParams[limitParam];

        let currentOffset = startOffset;
        let iterations = 0;

        while (iterations < maxIterations) {
            const responseData = await performRequest(query, baseUrl, tenantId, authConfig, {
                ...baseParams,
                [offsetParam]: currentOffset,
                [limitParam]: limit
            });

            const fetchedItems = collectPage(responseData);
            iterations += 1;

            if (fetchedItems === 0) {
                break;
            }

            if (pagination.maxRecords && aggregatedArray && aggregatedArray.length >= pagination.maxRecords) {
                aggregatedArray.length = pagination.maxRecords;
                break;
            }

            if (fetchedItems < limit) {
                break;
            }

            currentOffset += limit;
        }

        if (aggregatedArray && pagination.updateTotals !== false) {
            setValueAtPath(aggregatedData, pagination.totalRecordsPath || 'totalRecords', aggregatedArray.length);
        }

        return aggregatedData;
    }

    throw new Error(`Modo de paginación no soportado "${pagination.mode}" para la consulta "${query.name}".`);
}

async function executeSingleQuery(query, baseUrl, tenantId, authConfig) {
    try {
        const data = query.pagination
            ? await fetchWithPagination(query, baseUrl, tenantId, authConfig)
            : await performRequest(query, baseUrl, tenantId, authConfig, {});

        const outputFilePath = path.join(OUTPUT_DIR, query.outputFile);
        await fs.writeFile(outputFilePath, JSON.stringify(data, null, 2));
        console.log(`Successfully saved response to ${outputFilePath}`);
    } catch (error) {
        const statusMsg = error.response ? `${error.response.status} ${error.response.statusText}` : error.message;
        console.error(`Error executing query "${query.name}":`, statusMsg);
        if (error.response && error.response.data) {
            const errorFilePath = path.join(OUTPUT_DIR, `error_${query.outputFile}`);
            await fs.writeFile(errorFilePath, JSON.stringify(error.response.data, null, 2));
            console.error(`Error details saved to ${errorFilePath}`);
        }
    }
}

// --- Token cache -----------------------------------------------------------
let token = null;
let tokenExpiresAt = 0;

async function getAuthToken(authConfig, { forceRenew = false } = {}) {
    if (!forceRenew && token && Date.now() < tokenExpiresAt) {
        return token;
    }

    console.log('Requesting new auth token...');
    const tokenUrl = authConfig.token_url
        ? authConfig.token_url
        : `${authConfig.identity_base_url}/realms/${authConfig.realm}/protocol/openid-connect/token`;

    const params = new URLSearchParams();
    if (authConfig.grant_type) params.append('grant_type', authConfig.grant_type);
    if (authConfig.client_id) params.append('client_id', authConfig.client_id);
    if (authConfig.client_secret) params.append('client_secret', authConfig.client_secret);
    if (authConfig.username) params.append('username', authConfig.username);
    if (authConfig.password) params.append('password', authConfig.password);
    if (authConfig.scope) params.append('scope', authConfig.scope);

    try {
        const response = await axios.post(tokenUrl, params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        const tokenData = response.data;
        token = tokenData.access_token;
        tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
        console.log('New token obtained.');
        return token;
    } catch (error) {
        console.error('Error getting auth token:', error.response ? error.response.data : error.message);
        throw new Error('Authentication failed.');
    }
}

// --- Main ------------------------------------------------------------------
async function executeQueries() {
    try {
        await loadDotEnvIfPresent();

        const args = parseCliArgs();
        const runtime = await resolveRuntime({ args });
        const {
            baseUrl,
            tenantId,
            auth,
            queries,
            envName,
            envDescription,
            tenantLabel
        } = runtime;

        const queryFilterRaw = args.query || args.only;
        let queriesToRun = queries;
        if (queryFilterRaw) {
            const desired = String(queryFilterRaw)
                .split(',')
                .map((name) => name.trim().toLowerCase())
                .filter(Boolean);
            queriesToRun = queries.filter((query) => desired.includes(query.name.toLowerCase()));
            const missing = desired.filter(
                (name) => !queriesToRun.some((query) => query.name.toLowerCase() === name)
            );
            if (missing.length) {
                console.warn(`No se encontraron las consultas solicitadas: ${missing.join(', ')}`);
            }
        }

        await saveRuntimeCache(runtime);

        if (envName) {
            console.log(`Ambiente seleccionado: ${envName}${envDescription ? ` (${envDescription})` : ''}`);
        }
        if (tenantId) {
            console.log(`Tenant activo: ${tenantLabel || tenantId}`);
        }

        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        for (const query of queriesToRun) {
            console.log(`Executing query: ${query.name}`);
            await executeSingleQuery(query, baseUrl, tenantId, auth);
        }
    } catch (error) {
        console.error('An unexpected error occurred:', error.message);
    }
}

executeQueries();
