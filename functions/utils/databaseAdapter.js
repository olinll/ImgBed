/**
 * Database adapter — creates and validates a SQLite-backed database instance.
 */

import { D1Database } from './d1Database.js';

export function createDatabaseAdapter(env) {
    if (env.img_d1 && typeof env.img_d1.prepare === 'function') {
        return new D1Database(env.img_d1);
    }
    console.error('No database configured. Please configure the SQLite database.');
    return null;
}

export function getDatabase(env) {
    var adapter = createDatabaseAdapter(env);
    if (!adapter) {
        throw new Error('Database not configured.');
    }
    return adapter;
}

export function checkDatabaseConfig(env) {
    var hasDb = env.img_d1 && typeof env.img_d1.prepare === 'function';
    return {
        configured: hasDb,
        usingD1: true,
    };
}
