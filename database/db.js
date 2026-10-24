'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

let pgPool = null;
let isPgConnected = false;
let fallbackStore = null;

// File path for standalone fallback persistence
const FALLBACK_STORE_FILE = path.join(__dirname, '..', '.bionpay_db.json');

/**
 * Initialize Fallback Store structure
 */
function initFallbackStore() {
    if (fs.existsSync(FALLBACK_STORE_FILE)) {
        try {
            const raw = fs.readFileSync(FALLBACK_STORE_FILE, 'utf-8');
            fallbackStore = JSON.parse(raw);
        } catch (e) {
            // Keep existing in-memory store if disk read fails momentarily
        }
    }

    if (!fallbackStore) {
        fallbackStore = {
            applications: [],
            api_credentials: [],
            provider_accounts: [],
            payments: [],
            payment_attempts: [],
            provider_transactions: [],
            settlement_claims: [],
            webhook_endpoints: [],
            webhook_events: [],
            webhook_deliveries: [],
            idempotency_records: [],
            audit_logs: []
        };
        saveFallbackStore();
    }

    // Ensure all tables exist in store
    const requiredTables = [
        'applications', 'api_credentials', 'provider_accounts', 'payments',
        'payment_attempts', 'provider_transactions', 'settlement_claims',
        'webhook_endpoints', 'webhook_events', 'webhook_deliveries',
        'idempotency_records', 'audit_logs'
    ];
    for (const t of requiredTables) {
        if (!fallbackStore[t]) fallbackStore[t] = [];
    }

    return fallbackStore;
}

function saveFallbackStore() {
    if (!fallbackStore) return;
    try {
        const tmpPath = FALLBACK_STORE_FILE + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(fallbackStore, null, 2), 'utf-8');
        fs.renameSync(tmpPath, FALLBACK_STORE_FILE);
    } catch (e) {
        // Log silently
    }
}

/**
 * Initialize Database Connection
 */
async function initDb() {
    const connectionString = process.env.DATABASE_URL || (process.env.PGHOST ? {
        host: process.env.PGHOST,
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'bionpay_db',
        user: process.env.PGUSER || 'bionpay',
        password: process.env.PGPASSWORD || 'bionpay_secret_2026'
    } : null);

    if (connectionString) {
        try {
            pgPool = new Pool(typeof connectionString === 'string' ? {
                connectionString,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 4000
            } : {
                ...connectionString,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 4000
            });

            // Test connection
            const client = await pgPool.connect();
            await client.query('SELECT 1');
            client.release();
            isPgConnected = true;
            console.log('✅ Connected to PostgreSQL transactional database successfully.');
            await runMigrations();
            return;
        } catch (err) {
            console.warn(`⚠️ PostgreSQL connection attempt failed (${err.message}). Using transactional fallback engine.`);
            isPgConnected = false;
        }
    }

    // Initialize standalone transactional fallback
    initFallbackStore();
    await runMigrations();
}

/**
 * Execute Migrations & Seed Default Application
 */
async function runMigrations() {
    if (isPgConnected && pgPool) {
        const schemaPath = path.join(__dirname, 'schema.sql');
        if (fs.existsSync(schemaPath)) {
            const sql = fs.readFileSync(schemaPath, 'utf-8');
            await pgPool.query(sql);
        }
    }

    // Ensure Default System Application exists for legacy API compatibility
    await seedDefaultApplication();
}

async function seedDefaultApplication() {
    const defaultAppId = 'app_default';
    const defaultSlug = 'default';
    const legacyApiKey = process.env.API_KEY || 'gopay_dev_secret_2026';
    const legacyKeyHash = crypto.createHash('sha256').update(legacyApiKey).digest('hex');
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    if (isPgConnected && pgPool) {
        // Seed default application in Postgres
        await pgPool.query(`
            INSERT INTO applications (id, name, slug, website_url, description, is_active, provider_preference, webhook_secret)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
        `, [
            defaultAppId,
            'BionPay Default Merchant',
            defaultSlug,
            'http://localhost:3000',
            'Sistem aplikasi default untuk kompatibilitas gateway legacy',
            true,
            'AUTO',
            webhookSecret
        ]);

        // Seed default API key
        await pgPool.query(`
            INSERT INTO api_credentials (id, application_id, name, key_type, api_key_hash, api_key_prefix, permissions, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO NOTHING
        `, [
            'key_default_live',
            defaultAppId,
            'Legacy Root Master Key',
            'LIVE',
            legacyKeyHash,
            legacyApiKey.substring(0, 8),
            JSON.stringify(['payments:read', 'payments:write', 'admin']),
            true
        ]);
    } else {
        // Fallback Store Seeding
        const store = initFallbackStore();
        let app = store.applications.find(a => a.id === defaultAppId);
        if (!app) {
            app = {
                id: defaultAppId,
                name: 'BionPay Default Merchant',
                slug: defaultSlug,
                website_url: 'http://localhost:3000',
                description: 'Sistem aplikasi default untuk kompatibilitas gateway legacy',
                is_active: true,
                provider_preference: 'AUTO',
                webhook_url: null,
                webhook_secret: webhookSecret,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            store.applications.push(app);
        }

        let cred = store.api_credentials.find(c => c.id === 'key_default_live');
        if (!cred) {
            cred = {
                id: 'key_default_live',
                application_id: defaultAppId,
                name: 'Legacy Root Master Key',
                key_type: 'LIVE',
                api_key_hash: legacyKeyHash,
                api_key_prefix: legacyApiKey.substring(0, 8),
                permissions: ['payments:read', 'payments:write', 'admin'],
                is_active: true,
                last_used_at: null,
                expires_at: null,
                created_at: new Date().toISOString()
            };
            store.api_credentials.push(cred);
        }
        saveFallbackStore();
    }
}

/**
 * Standard Query Interface
 * Returns { rows: [...], rowCount: number }
 */
async function query(text, params = []) {
    if (isPgConnected && pgPool) {
        const res = await pgPool.query(text, params);
        return { rows: res.rows, rowCount: res.rowCount };
    }

    // Fallback store queries
    return queryFallback(text, params);
}

/**
 * Unified Transaction Interface
 * Ensures atomic rollback on failure
 */
async function transaction(callback) {
    if (isPgConnected && pgPool) {
        const client = await pgPool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Fallback transactional engine with snapshot rollback
    const store = initFallbackStore();
    const snapshot = JSON.stringify(store);
    try {
        const client = {
            query: async (text, params) => queryFallback(text, params)
        };
        const result = await callback(client);
        saveFallbackStore();
        return result;
    } catch (err) {
        // Rollback fallback store on error
        fallbackStore = JSON.parse(snapshot);
        saveFallbackStore();
        throw err;
    }
}

/**
 * Fallback SQL-like evaluator supporting BionPay core operations
 */
function queryFallback(sql, params = []) {
    const store = initFallbackStore();
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // 1. SELECT queries
    if (upper.startsWith('SELECT')) {
        // Match table name
        const fromMatch = trimmed.match(/FROM\s+([a-zA-Z0-9_]+)/i);
        if (!fromMatch) return { rows: [], rowCount: 0 };
        const tableName = fromMatch[1].toLowerCase();
        let items = store[tableName] ? [...store[tableName]] : [];

        // Join applications metadata if query contains JOIN applications
        if (upper.includes('JOIN APPLICATIONS')) {
            items = items.map(c => {
                const app = store.applications.find(a => a.id === c.application_id);
                return {
                    ...c,
                    app_name: app ? app.name : null,
                    app_slug: app ? app.slug : null,
                    app_active: app ? app.is_active : false,
                    webhook_url: app ? app.webhook_url : null,
                    webhook_secret: app ? app.webhook_secret : null,
                    provider_preference: app ? app.provider_preference : 'AUTO'
                };
            });
        }

        // Simple filtering evaluator
        if (upper.includes('WHERE')) {
            items = filterFallbackItems(items, trimmed, params);
        }

        // Sorting
        if (upper.includes('ORDER BY')) {
            const orderMatch = trimmed.match(/ORDER\s+BY\s+([a-zA-Z0-9_]+)\s*(ASC|DESC)?/i);
            if (orderMatch) {
                const col = orderMatch[1];
                const dir = (orderMatch[2] || 'ASC').toUpperCase();
                items.sort((a, b) => {
                    const valA = a[col] || '';
                    const valB = b[col] || '';
                    return dir === 'DESC' ? (valB > valA ? 1 : -1) : (valA > valB ? 1 : -1);
                });
            }
        }

        // Limit & Offset
        const limitMatch = trimmed.match(/LIMIT\s+(\$?[0-9]+)/i);
        if (limitMatch) {
            let limitVal = limitMatch[1];
            if (limitVal.startsWith('$')) {
                const idx = parseInt(limitVal.substring(1), 10) - 1;
                limitVal = params[idx];
            } else {
                limitVal = parseInt(limitVal, 10);
            }

            let offsetVal = 0;
            const offsetMatch = trimmed.match(/OFFSET\s+(\$?[0-9]+)/i);
            if (offsetMatch) {
                let off = offsetMatch[1];
                if (off.startsWith('$')) {
                    const idx = parseInt(off.substring(1), 10) - 1;
                    offsetVal = params[idx] || 0;
                } else {
                    offsetVal = parseInt(off, 10) || 0;
                }
            }
            items = items.slice(offsetVal, offsetVal + limitVal);
        }

        return { rows: items, rowCount: items.length };
    }

    // 2. INSERT queries
    if (upper.startsWith('INSERT INTO')) {
        const match = trimmed.match(/INSERT\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
        if (match) {
            const tableName = match[1].toLowerCase();
            const columns = match[2].split(',').map(c => c.trim().toLowerCase());
            const valuesPlaceholders = match[3].split(',').map(v => v.trim());

            if (!store[tableName]) store[tableName] = [];

            const record = {};
            columns.forEach((col, idx) => {
                const placeholder = valuesPlaceholders[idx];
                if (placeholder.startsWith('$')) {
                    const paramIdx = parseInt(placeholder.substring(1), 10) - 1;
                    record[col] = params[paramIdx] !== undefined ? params[paramIdx] : null;
                } else {
                    let v = placeholder !== undefined && placeholder !== null ? String(placeholder).replace(/^['"]|['"]$/g, '') : null;
                    if (typeof v === 'string') {
                        if (v.toLowerCase() === 'true') v = true;
                        else if (v.toLowerCase() === 'false') v = false;
                    }
                    record[col] = v;
                }
            });

            // Enforce Unique constraints
            if (tableName === 'applications') {
                if (store.applications.some(a => a.id === record.id || a.slug === record.slug)) {
                    throw new Error(`Unique constraint violation on applications (slug: ${record.slug})`);
                }
            } else if (tableName === 'payments') {
                if (store.payments.some(p => p.id === record.id || p.uuid === record.uuid)) {
                    throw new Error(`Unique constraint violation on payment id/uuid`);
                }
                if (store.payments.some(p => p.application_id === record.application_id && p.order_id === record.order_id)) {
                    throw new Error(`Unique constraint violation: Order ID ${record.order_id} sudah ada untuk aplikasi ini`);
                }
            } else if (tableName === 'settlement_claims') {
                if (store.settlement_claims.some(c => c.provider_transaction_id === record.provider_transaction_id)) {
                    if (upper.includes('DO NOTHING')) {
                        return { rows: [], rowCount: 0 };
                    }
                    throw new Error(`Atomic violation: Transaksi provider ${record.provider_transaction_id} sudah pernah diklaim!`);
                }
            } else if (tableName === 'provider_transactions') {
                if (store.provider_transactions.some(t => t.provider === record.provider && t.provider_transaction_id === record.provider_transaction_id)) {
                    // Do nothing or ignore
                    return { rows: [], rowCount: 0 };
                }
            } else if (tableName === 'idempotency_records') {
                if (store.idempotency_records.some(r => r.application_id === record.application_id && r.idempotency_key === record.idempotency_key)) {
                    throw new Error(`Unique constraint violation on idempotency_key: ${record.idempotency_key}`);
                }
            }

            if (!record.created_at) record.created_at = new Date().toISOString();
            if (!record.updated_at) record.updated_at = new Date().toISOString();

            store[tableName].push(record);
            saveFallbackStore();
            return { rows: [record], rowCount: 1 };
        }
    }

    // 3. UPDATE queries
    if (upper.startsWith('UPDATE')) {
        const match = trimmed.match(/UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
        if (match) {
            const tableName = match[1].toLowerCase();
            const setClause = match[2];
            const whereClause = match[3];

            if (!store[tableName]) return { rows: [], rowCount: 0 };

            let targetItems = store[tableName];
            if (whereClause) {
                targetItems = filterFallbackItems(targetItems, 'WHERE ' + whereClause, params);
            }

            // Parse SET expressions
            const setAssignments = setClause.split(',').map(s => s.trim());
            for (const item of targetItems) {
                for (const assign of setAssignments) {
                    const [col, valExpr] = assign.split('=').map(s => s.trim());
                    const colName = col.toLowerCase();
                    if (valExpr.startsWith('$')) {
                        const pIdx = parseInt(valExpr.substring(1), 10) - 1;
                        item[colName] = params[pIdx];
                    } else if (valExpr.toUpperCase() === 'CURRENT_TIMESTAMP' || valExpr.toUpperCase() === 'NOW()') {
                        item[colName] = new Date().toISOString();
                    } else {
                        let v = valExpr !== undefined && valExpr !== null ? String(valExpr).replace(/^['"]|['"]$/g, '') : null;
                        if (typeof v === 'string') {
                            if (v.toLowerCase() === 'true') v = true;
                            else if (v.toLowerCase() === 'false') v = false;
                        }
                        item[colName] = v;
                    }
                }
                item.updated_at = new Date().toISOString();
            }

            saveFallbackStore();
            return { rows: targetItems, rowCount: targetItems.length };
        }
    }

    // 4. DELETE queries
    if (upper.startsWith('DELETE FROM')) {
        const match = trimmed.match(/DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+(.+))?$/i);
        if (match) {
            const tableName = match[1].toLowerCase();
            const whereClause = match[2];

            if (!store[tableName]) return { rows: [], rowCount: 0 };

            if (!whereClause) {
                const count = store[tableName].length;
                store[tableName] = [];
                saveFallbackStore();
                return { rows: [], rowCount: count };
            }

            const itemsToDelete = filterFallbackItems(store[tableName], 'WHERE ' + whereClause, params);
            const deleteIds = new Set(itemsToDelete.map(it => it.id));
            store[tableName] = store[tableName].filter(it => !deleteIds.has(it.id));
            saveFallbackStore();
            return { rows: [], rowCount: itemsToDelete.length };
        }
    }

    return { rows: [], rowCount: 0 };
}

/**
 * Helper to filter store items based on simple SQL WHERE clauses
 */
function filterFallbackItems(items, sql, params) {
    const whereIdx = sql.toUpperCase().indexOf('WHERE');
    if (whereIdx === -1) return items;

    // Cut off ORDER BY, LIMIT, etc.
    let whereClause = sql.substring(whereIdx + 5);
    const stopWords = ['ORDER BY', 'LIMIT', 'GROUP BY', 'HAVING'];
    for (const sw of stopWords) {
        const pos = whereClause.toUpperCase().indexOf(sw);
        if (pos !== -1) whereClause = whereClause.substring(0, pos);
    }
    whereClause = whereClause.trim();

    return items.filter(item => {
        // Handle AND conditions
        const conditions = whereClause.split(/\s+AND\s+/i);
        for (const cond of conditions) {
            const cleanCond = cond.trim().replace(/^\(|\)$/g, '');
            if (cleanCond.includes('>=')) {
                const [col, valPart] = cleanCond.split('>=').map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart.startsWith('$') ? params[parseInt(valPart.substring(1), 10) - 1] : valPart.replace(/^['"]|['"]$/g, '');
                if (!(item[colName] >= targetVal)) return false;
            } else if (cleanCond.includes('<=')) {
                const [col, valPart] = cleanCond.split('<=').map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart.startsWith('$') ? params[parseInt(valPart.substring(1), 10) - 1] : valPart.replace(/^['"]|['"]$/g, '');
                if (!(item[colName] <= targetVal)) return false;
            } else if (cleanCond.includes('>')) {
                const [col, valPart] = cleanCond.split('>').map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart.startsWith('$') ? params[parseInt(valPart.substring(1), 10) - 1] : valPart.replace(/^['"]|['"]$/g, '');
                if (!(item[colName] > targetVal)) return false;
            } else if (cleanCond.includes('<')) {
                const [col, valPart] = cleanCond.split('<').map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart.startsWith('$') ? params[parseInt(valPart.substring(1), 10) - 1] : valPart.replace(/^['"]|['"]$/g, '');
                if (!(item[colName] < targetVal)) return false;
            } else if (cleanCond.toUpperCase().includes(' IN ') && cleanCond.includes('(') && cleanCond.includes(')')) {
                const parts = cleanCond.split(/\s+IN\s+/i);
                const colName = parts[0].toLowerCase().replace(/^[a-z0-9_]+\./, '').trim();
                const inList = parts[1].replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
                if (!inList.includes(String(item[colName]))) return false;
            } else if (cleanCond.includes('=')) {
                const [col, valPart] = cleanCond.split('=').map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart;
                if (valPart.startsWith('$')) {
                    const pIdx = parseInt(valPart.substring(1), 10) - 1;
                    targetVal = params[pIdx];
                } else {
                    targetVal = valPart.replace(/^['"]|['"]$/g, '');
                }

                // Handle boolean conversion
                if (targetVal === 'true' || targetVal === true) targetVal = true;
                if (targetVal === 'false' || targetVal === false) targetVal = false;

                let actualVal = item[colName];
                if (actualVal === 'true') actualVal = true;
                if (actualVal === 'false') actualVal = false;

                if (actualVal !== targetVal) return false;
            } else if (cleanCond.includes('!=') || cleanCond.includes('<>')) {
                const [col, valPart] = cleanCond.split(/!=|<>/).map(s => s.trim());
                const colName = col.toLowerCase().replace(/^[a-z0-9_]+\./, '');
                let targetVal = valPart;
                if (valPart.startsWith('$')) {
                    const pIdx = parseInt(valPart.substring(1), 10) - 1;
                    targetVal = params[pIdx];
                } else {
                    targetVal = valPart.replace(/^['"]|['"]$/g, '');
                }
                if (item[colName] == targetVal) return false;
            } else if (cleanCond.toUpperCase().includes('IS NOT NULL')) {
                const col = cleanCond.toUpperCase().replace('IS NOT NULL', '').trim().toLowerCase().replace(/^[a-z0-9_]+\./, '');
                if (item[col] === null || item[col] === undefined) return false;
            } else if (cleanCond.toUpperCase().includes('IS NULL')) {
                const col = cleanCond.toUpperCase().replace('IS NULL', '').trim().toLowerCase().replace(/^[a-z0-9_]+\./, '');
                if (item[col] !== null && item[col] !== undefined) return false;
            }
        }
        return true;
    });
}

module.exports = {
    initDb,
    query,
    transaction,
    runMigrations,
    isPostgres: () => isPgConnected,
    getPool: () => pgPool
};
