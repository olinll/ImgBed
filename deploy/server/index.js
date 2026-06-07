/**
 * ImgBed Node.js server — Hono web framework with Vite dev middleware.
 * Storage: SQLite (database) + local filesystem or S3-compatible (files).
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createServer } from 'http';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { SqliteD1 } from './sqliteD1.js';
import { LocalR2Storage } from './r2Storage.js';

const NativeResponse = globalThis.Response;

// ==================== Global API polyfills ====================

// In-memory cache for caches.default (replaces Cloudflare Cache API)
if (typeof globalThis.caches === 'undefined') {
    const cacheStore = new Map();
    // Periodic cleanup every 5 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of cacheStore) {
            if (entry.ttl && now > entry.ttl) {
                cacheStore.delete(key);
            }
        }
    }, 5 * 60 * 1000).unref();
    globalThis.caches = {
        default: {
            async match(request) {
                const key = typeof request === 'string' ? request : (request instanceof Request ? request.url : String(request));
                const entry = cacheStore.get(key);
                if (!entry) return undefined;
                if (entry.ttl && Date.now() > entry.ttl) {
                    cacheStore.delete(key);
                    return undefined;
                }
                return new Response(entry.body, entry.init);
            },
            async put(request, response) {
                const key = typeof request === 'string' ? request : (request instanceof Request ? request.url : String(request));
                const ttlHeader = response.headers.get('Cache-Control');
                let ttl = null;
                if (ttlHeader) {
                    const match = ttlHeader.match(/max-age=(\d+)/);
                    if (match) ttl = Date.now() + parseInt(match[1]) * 1000;
                }
                const body = await response.clone().arrayBuffer();
                cacheStore.set(key, {
                    body,
                    init: { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
                    ttl,
                });
            },
            async delete(request) {
                const key = typeof request === 'string' ? request : (request instanceof Request ? request.url : String(request));
                return cacheStore.delete(key);
            },
        },
    };
}

// ==================== 自引用 Fetch 拦截器 ====================
// 解决 Docker 端口映射导致 functions 内部 fetch(url.origin + ...) 失败的问题
// 不再重写请求 URL，而是拦截自引用的 fetch 调用，透明路由到内部端口
// 这样 url.origin 保持为外部 origin，确保 Referer 匹配、返回链接、重定向等功能正常

const selfOrigins = new Set();
const originalFetch = globalThis.fetch;

globalThis.fetch = async function(input, init) {
    try {
        let urlStr;
        if (typeof input === 'string') {
            urlStr = input;
        } else if (input instanceof URL) {
            urlStr = input.toString();
        } else if (input instanceof Request) {
            urlStr = input.url;
        }

        if (urlStr) {
            const parsed = new URL(urlStr);
            const internalOrigin = `http://localhost:${port}`;
            // 如果目标 origin 是已知的外部自身 origin，重写为内部地址
            if (parsed.origin !== internalOrigin && selfOrigins.has(parsed.origin)) {
                const newUrl = `${internalOrigin}${parsed.pathname}${parsed.search}`;
                if (input instanceof Request) {
                    return originalFetch(new Request(newUrl, input), init);
                }
                return originalFetch(newUrl, init);
            }
        }
    } catch (e) {
        // URL 解析失败等异常，回退到原始 fetch
        if (!(e instanceof TypeError)) {
            console.error('Fetch interceptor error:', e.message);
        }
    }
    return originalFetch(input, init);
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '../..');
const FUNCTIONS_DIR = resolve(ROOT_DIR, 'functions');
const DATA_DIR = resolve(ROOT_DIR, 'data');
const port = parseInt(process.env.PORT || '8080', 10);

// 确保数据目录存在
mkdirSync(DATA_DIR, { recursive: true });

// ==================== 初始化数据库 ====================

const sqliteD1 = new SqliteD1(join(DATA_DIR, 'database.sqlite'));

// Inline database schema — creates tables, indexes, triggers, and applies migrations
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    value TEXT,
    metadata TEXT NOT NULL,
    file_name TEXT,
    file_type TEXT,
    file_size TEXT,
    upload_ip TEXT,
    upload_address TEXT,
    list_type TEXT,
    timestamp INTEGER,
    label TEXT,
    directory TEXT,
    channel TEXT,
    channel_name TEXT,
    is_chunked BOOLEAN DEFAULT FALSE,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    category TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS index_operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    data TEXT NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS index_metadata (
    key TEXT PRIMARY KEY,
    last_updated INTEGER,
    total_count INTEGER DEFAULT 0,
    last_operation_id TEXT,
    chunk_count INTEGER DEFAULT 0,
    chunk_size INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS other_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_timestamp ON files(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_files_directory ON files(directory);
CREATE INDEX IF NOT EXISTS idx_files_channel ON files(channel);
CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type);
CREATE INDEX IF NOT EXISTS idx_files_upload_ip ON files(upload_ip);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_tags ON files(tags);

CREATE INDEX IF NOT EXISTS idx_settings_category ON settings(category);

CREATE INDEX IF NOT EXISTS idx_index_operations_timestamp ON index_operations(timestamp);
CREATE INDEX IF NOT EXISTS idx_index_operations_processed ON index_operations(processed);
CREATE INDEX IF NOT EXISTS idx_index_operations_type ON index_operations(type);

CREATE INDEX IF NOT EXISTS idx_other_data_type ON other_data(type);

CREATE TRIGGER IF NOT EXISTS update_files_updated_at
    AFTER UPDATE ON files
    BEGIN
        UPDATE files SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_settings_updated_at
    AFTER UPDATE ON settings
    BEGIN
        UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;

CREATE TRIGGER IF NOT EXISTS update_index_metadata_updated_at
    AFTER UPDATE ON index_metadata
    BEGIN
        UPDATE index_metadata SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;

CREATE TRIGGER IF NOT EXISTS update_other_data_updated_at
    AFTER UPDATE ON other_data
    BEGIN
        UPDATE other_data SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;

`;

try {
    sqliteD1.exec(INIT_SQL);
    console.log('Database initialized successfully');
} catch (e) {
    // "duplicate column name" is expected on re-runs after migration was applied
    if (!e.message.includes('duplicate column name')) {
        console.log('Database init:', e.message);
    }
}

// Migration: add tags column for databases created before v2.2.1
try {
    sqliteD1.exec('ALTER TABLE files ADD COLUMN tags TEXT;');
} catch (e) {
    // Column already exists — ok
}

// ==================== 初始化存储 ====================

// 本地文件系统存储
const localStoragePath = process.env.LOCAL_STORAGE_PATH
    ? resolve(process.env.LOCAL_STORAGE_PATH)
    : join(DATA_DIR, 'local');
const localStorage = new LocalR2Storage(localStoragePath);
console.log('Local storage initialized at:', localStoragePath);

// ==================== 创建环境对象 ====================

// Only expose env vars needed by functions
const ALLOWED_ENV_KEYS = [
    'NODE_ENV', 'PORT', 'LOCAL_STORAGE_PATH',
    'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_BUCKET_NAME',
    'S3_ENDPOINT', 'S3_REGION', 'S3_PATH_STYLE', 'S3_CDN_DOMAIN',
    'ADMIN_USER', 'ADMIN_PASS', 'RESET_KEY', 'AUTH_SECRET',
];

function createEnv() {
    const filteredEnv = {};
    for (const key of ALLOWED_ENV_KEYS) {
        if (process.env[key] !== undefined) {
            filteredEnv[key] = process.env[key];
        }
    }
    return {
        ...filteredEnv,
        LOCAL_STORAGE_PATH: localStoragePath,
        img_d1: sqliteD1,
        img_local: localStorage,
    };
}

// ==================== Functions 路由解析 ====================

/**
 * 根据请求路径查找对应的 function 文件
 */
function findFunctionFile(pathname) {
    const parts = pathname.split('/').filter(Boolean);

    // 1. 尝试精确匹配
    if (parts.length > 0) {
        const exactFile = join(FUNCTIONS_DIR, ...parts) + '.js';
        if (existsSync(exactFile) && statSync(exactFile).isFile()) {
            return { file: exactFile, params: {} };
        }
    }

    // 2. 尝试 index.js 匹配
    if (parts.length > 0) {
        const indexFile = join(FUNCTIONS_DIR, ...parts, 'index.js');
        if (existsSync(indexFile) && statSync(indexFile).isFile()) {
            return { file: indexFile, params: {} };
        }
    }

    // 3. 尝试 [[path]].js 通配符匹配（从深到浅）
    for (let i = parts.length; i >= 0; i--) {
        const dirParts = parts.slice(0, i);
        const dirPath = join(FUNCTIONS_DIR, ...dirParts);
        if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
            const catchAllFile = join(dirPath, '[[path]].js');
            if (existsSync(catchAllFile) && statSync(catchAllFile).isFile()) {
                const pathParam = parts.slice(i);
                return { file: catchAllFile, params: { path: pathParam } };
            }
        }
    }

    return null;
}

/**
 * 查找请求路径对应的中间件链
 */
const middlewareCache = new Map();

async function findMiddlewares(pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const allMiddlewares = [];

    // 检查根 functions 目录
    const rootMiddleware = join(FUNCTIONS_DIR, '_middleware.js');
    if (existsSync(rootMiddleware)) {
        const mod = await importModule(rootMiddleware);
        if (mod.onRequest) {
            const handlers = Array.isArray(mod.onRequest) ? mod.onRequest : [mod.onRequest];
            allMiddlewares.push(...handlers);
        }
    }

    // 逐级检查子目录中间件
    for (let i = 1; i <= parts.length; i++) {
        const dirParts = parts.slice(0, i);
        const middlewareFile = join(FUNCTIONS_DIR, ...dirParts, '_middleware.js');
        if (existsSync(middlewareFile) && statSync(middlewareFile).isFile()) {
            const mod = await importModule(middlewareFile);
            if (mod.onRequest) {
                const handlers = Array.isArray(mod.onRequest) ? mod.onRequest : [mod.onRequest];
                allMiddlewares.push(...handlers);
            }
        }
    }

    return allMiddlewares;
}

/**
 * 模块导入缓存
 */
const moduleCache = new Map();

async function importModule(filePath) {
    if (moduleCache.has(filePath)) {
        return moduleCache.get(filePath);
    }
    // Windows 上 ESM 动态 import 必须使用 file:// URL，不能直接用磁盘路径
    const mod = await import(pathToFileURL(filePath).href);
    moduleCache.set(filePath, mod);
    return mod;
}


/**
 * 执行中间件链和处理函数
 */
async function executeChain(middlewares, handler, context) {
    const chain = [...middlewares, handler];
    let index = 0;

    context.next = async function () {
        if (index < chain.length) {
            const fn = chain[index++];
            return await fn(context);
        }
        // 如果链执行完毕，返回 404
        return new Response('Not Found', { status: 404 });
    };

    return await context.next();
}

/**
 * 处理 Functions 请求
 */
async function handleFunctionRequest(originalRequest, pathname) {
    // 查找对应的 function 文件
    const funcInfo = findFunctionFile(pathname);
    if (!funcInfo) return null;

    // 记录外部 origin，供 fetch 拦截器使用
    // 不再重写请求 URL，保持 url.origin 为外部 origin
    const request = originalRequest;
    const requestUrl = new URL(originalRequest.url);
    const internalOrigin = `http://localhost:${port}`;
    if (requestUrl.origin !== internalOrigin) {
        selfOrigins.add(requestUrl.origin);
    }

    // 导入模块
    const mod = await importModule(funcInfo.file);

    // 根据请求方法查找处理函数
    const method = request.method.toUpperCase();
    const methodHandlerName = 'onRequest' + method.charAt(0) + method.slice(1).toLowerCase();

    let handler = null;
    if (typeof mod[methodHandlerName] === 'function') {
        handler = mod[methodHandlerName];
    } else if (mod.onRequest) {
        handler = typeof mod.onRequest === 'function'
            ? mod.onRequest
            : mod.onRequest[mod.onRequest.length - 1];
    }

    if (!handler) {
        return new Response('Method Not Allowed', { status: 405 });
    }

    // 获取中间件
    const middlewares = await findMiddlewares(pathname);

    // 如果 onRequest 是数组，把前面的加入中间件链
    if (Array.isArray(mod.onRequest) && mod.onRequest.length > 1 && handler === mod.onRequest[mod.onRequest.length - 1]) {
        middlewares.push(...mod.onRequest.slice(0, -1));
    }

    // Add request.cf polyfill (used by telemetry middleware)
    if (!request.cf) {
        request.cf = {
            country: 'XX',
            city: 'Unknown',
            continent: 'XX',
            latitude: '0',
            longitude: '0',
            region: '',
            regionCode: '',
            timezone: '',
            postalCode: '',
            asn: 0,
            asOrganization: '',
            colo: 'LOCAL',
            httpProtocol: 'HTTP/1.1',
            requestPriority: '',
            tlsCipher: '',
            tlsVersion: '',
        };
    }

    // Create function context object
    const env = createEnv();
    const context = {
        request,
        env,
        params: funcInfo.params,
        waitUntil: (promise) => {
            if (promise && typeof promise.catch === 'function') {
                promise.catch(err => console.error('waitUntil error:', err));
            }
        },
        next: null, // 由 executeChain 设置
        data: {},
    };

    // 执行中间件链和处理函数
    return await executeChain(middlewares, handler, context);
}

// ==================== Hono 应用 ====================

const app = new Hono();

// 判断是否是 function 路径
const FUNCTION_PREFIXES = ['/api/', '/upload', '/file/', '/dav/', '/random'];

function isFunctionPath(pathname) {
    return FUNCTION_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

// Functions 路由处理
app.all('*', async (c, next) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    if (isFunctionPath(pathname)) {
        try {
            let request = c.req.raw;
            try {
                const info = getConnInfo(c);
                let clientIp = info.remote?.address;
                if (clientIp && clientIp.startsWith('::ffff:')) {
                    clientIp = clientIp.slice(7);
                }
                if (clientIp && !request.headers.get('x-real-ip')) {
                    const newHeaders = new Headers(request.headers);
                    newHeaders.set('x-real-ip', clientIp);
                    request = new Request(request.url, {
                        method: request.method,
                        headers: newHeaders,
                        body: request.body,
                        duplex: 'half',
                    });
                }
            } catch (e) {
                // 获取 IP 失败不影响请求处理
            }
            const response = await handleFunctionRequest(request, pathname);
            if (response) {
                return response;
            }
        } catch (err) {
            console.error('Function error:', err);
            return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
        }
    }

    await next();
});

// ==================== Node.js → Hono 适配 ====================

function nodeReqToHonoRequest(req) {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headers.set(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    return new Request(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
    });
}

async function pipeHonoResponse(honoRes, nodeRes) {
    nodeRes.statusCode = honoRes.status;
    for (const [key, value] of honoRes.headers) {
        if (key.toLowerCase() !== 'content-encoding') {
            nodeRes.setHeader(key, value);
        }
    }
    if (honoRes.body) {
        const reader = honoRes.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) { nodeRes.end(); break; }
            nodeRes.write(value);
        }
    } else {
        nodeRes.end();
    }
}

// ==================== 启动服务器 ====================

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
    // 生产模式：静态文件服务
    app.use('/*', serveStatic({
        root: './frontend-dist',
        rewriteRequestPath: (path) => path,
    }));
    app.get('*', async (c) => {
        const indexPath = join(ROOT_DIR, 'frontend-dist', 'index.html');
        if (existsSync(indexPath)) {
            return c.html(readFileSync(indexPath, 'utf8'));
        }
        return c.text('Not Found', 404);
    });

    async function fetchWithNativeResponse(request, env, executionCtx) {
        const response = await app.fetch(request, env, executionCtx);
        if (!response) return response;
        return new NativeResponse(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    serve({
        fetch: fetchWithNativeResponse,
        port,
    }, (info) => {
        console.log(`Server running at http://0.0.0.0:${info.port}`);
        console.log(`Data directory: ${DATA_DIR}`);
        console.log(`Mode: Production`);
    });
} else {
    // 开发模式：同一个 HTTP 服务器，Vite 中间件处理前端，Hono 处理 API
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
        configFile: join(ROOT_DIR, 'vite.config.js'),
    });

    const server = createServer(async (req, res) => {
        const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;

        if (isFunctionPath(pathname)) {
            // API 请求交给 Hono
            try {
                const request = nodeReqToHonoRequest(req);
                request.cf = {
                    country: 'XX', city: 'Unknown', continent: 'XX',
                    latitude: '0', longitude: '0', region: '', regionCode: '',
                    timezone: '', postalCode: '', asn: 0, asOrganization: '',
                    colo: 'LOCAL', httpProtocol: 'HTTP/1.1', requestPriority: '',
                    tlsCipher: '', tlsVersion: '',
                };
                const clientIp = req.socket.remoteAddress?.replace(/^::ffff:/, '');
                if (clientIp && !request.headers.get('x-real-ip')) {
                    const newHeaders = new Headers(request.headers);
                    newHeaders.set('x-real-ip', clientIp);
                    // Re-create request with updated headers
                    const updatedRequest = new Request(request.url, {
                        method: request.method,
                        headers: newHeaders,
                        body: request.body,
                        duplex: 'half',
                    });
                    updatedRequest.cf = request.cf;
                    const honoRes = await app.fetch(updatedRequest);
                    await pipeHonoResponse(honoRes, res);
                } else {
                    const honoRes = await app.fetch(request);
                    await pipeHonoResponse(honoRes, res);
                }
            } catch (err) {
                console.error('API error:', err);
                res.statusCode = 500;
                res.end('Internal Server Error');
            }
        } else {
            // 前端资源交给 Vite（HTML、JS、CSS、HMR WebSocket）
            vite.middlewares(req, res);
        }
    });

    server.listen(port, () => {
        console.log(`[dev] Server running at http://0.0.0.0:${port} (Vite HMR enabled)`);
        console.log(`Data directory: ${DATA_DIR}`);
    });
}
