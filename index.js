
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import {
    parseCliArgs,
    resolveRuntime,
    saveRuntimeCache
} from './lib/runtime.js';

const OUTPUT_DIR = 'output';

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
                // Remove optional surrounding quotes
                const unquoted = val.replace(/^['\"]|['\"]$/g, '');
                process.env[key] = unquoted;
            }
        });
    } catch {
        // .env not found is fine
    }
}

let token = null;
let tokenExpiresAt = 0;

async function getAuthToken(authConfig) {
    if (token && Date.now() < tokenExpiresAt) {
        console.log('Reusing existing token.');
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
        // Set expiration time to 60 seconds before the actual expiration to be safe
        tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;
        console.log('New token obtained.');
        return token;
    } catch (error) {
        console.error('Error getting auth token:', error.response ? error.response.data : error.message);
        throw new Error('Authentication failed.');
    }
}

async function executeQueries() {
    try {
        // Load optional .env values (e.g., client secrets)
        await loadDotEnvIfPresent();

        // Parse CLI args (e.g., --env pre --tenant 77)
        const args = parseCliArgs();

        // Resolve runtime configuration (environments, tenants, auth)
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

        await saveRuntimeCache(runtime);

        if (envName) {
            console.log(`Ambiente seleccionado: ${envName}${envDescription ? ` (${envDescription})` : ''}`);
        }
        if (tenantId) {
            console.log(`Tenant activo: ${tenantLabel || tenantId}`);
        }

        // 2. Ensure output directory exists
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // 3. Get auth token (supports password or client_credentials)
        const authToken = await getAuthToken(auth);

        // 4. Execute each query
        for (const query of queries) {
            console.log(`Executing query: ${query.name}`);

            let finalPath = query.path;
            if (query.pathParams) {
                for (const [key, value] of Object.entries(query.pathParams)) {
                    finalPath = finalPath.replace(`{${key}}`, value);
                }
            }

            const url = new URL(baseUrl + finalPath);

            if (query.params) {
                for (const [key, value] of Object.entries(query.params)) {
                    url.searchParams.append(key, value);
                }
            }

            try {
                const response = await axios({
                    method: query.method,
                    url: url.toString(),
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                        'X-TENANT-ID': String(tenantId)
                    }
                });

                const outputFilePath = path.join(OUTPUT_DIR, query.outputFile);
                await fs.writeFile(outputFilePath, JSON.stringify(response.data, null, 2));
                console.log(`Successfully saved response to ${outputFilePath}`);

            } catch (error) {
                console.error(`Error executing query "${query.name}":`, error.response ? `${error.response.status} ${error.response.statusText}` : error.message);
                if (error.response && error.response.data) {
                    const errorFilePath = path.join(OUTPUT_DIR, `error_${query.outputFile}`);
                    await fs.writeFile(errorFilePath, JSON.stringify(error.response.data, null, 2));
                    console.error(`Error details saved to ${errorFilePath}`);
                }
            }
        }
    } catch (error) {
        console.error('An unexpected error occurred:', error.message);
    }
}

executeQueries();
