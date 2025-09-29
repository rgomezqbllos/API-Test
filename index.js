
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const CONFIG_FILE = 'config.json';
const OUTPUT_DIR = 'output';

let token = null;
let tokenExpiresAt = 0;

async function getAuthToken(authConfig) {
    if (token && Date.now() < tokenExpiresAt) {
        console.log('Reusing existing token.');
        return token;
    }

    console.log('Requesting new auth token...');
    const tokenUrl = `${authConfig.identity_base_url}/realms/${authConfig.realm}/protocol/openid-connect/token`;

    const params = new URLSearchParams();
    params.append('grant_type', authConfig.grant_type);
    params.append('client_id', authConfig.client_id);
    params.append('username', authConfig.username);
    params.append('password', authConfig.password);

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
        // 1. Read and parse config file
        const configFileContent = await fs.readFile(CONFIG_FILE, 'utf8');
        const config = JSON.parse(configFileContent);
        const { globals, queries } = config;

        // 2. Ensure output directory exists
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        // 3. Get auth token
        const authToken = await getAuthToken(globals.auth);

        // 4. Execute each query
        for (const query of queries) {
            console.log(`Executing query: ${query.name}`);

            let finalPath = query.path;
            if (query.pathParams) {
                for (const [key, value] of Object.entries(query.pathParams)) {
                    finalPath = finalPath.replace(`{${key}}`, value);
                }
            }

            const url = new URL(globals.baseUrl + finalPath);

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
                        'X-TENANT-ID': globals.tenant_id
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
