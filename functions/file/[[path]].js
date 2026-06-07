import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fetchSecurityConfig } from "../utils/sysConfig";
import {
    setCommonHeaders, handleHeadRequest,
    returnWithCheck, returnBlockImg, isDomainAllowed, FILE_CACHE_CONTROL
} from './fileTools';
import { getDatabase } from '../utils/databaseAdapter.js';
import { authenticate, AUTH_SCOPE } from '../utils/auth/authCore.js';
import {
    resolveS3Credentials,
} from '../utils/metadata/channelCredentials.js';
import { buildCdnFileUrl } from '../utils/metadata/metadataView.js';


export async function onRequest(context) {  // Contents of context object
    const {
        request, // same as existing Worker API
        env, // same as existing Worker API
        params, // if filename includes [id] or [[path]]
        waitUntil, // same as ctx.waitUntil in existing Worker API
        next, // used for middleware or to fetch assets
        data, // arbitrary space for passing data between middlewares
    } = context;

    // 解码文件ID
    let fileId = '';
    try {
        params.path = decodeURIComponent(params.path);
        fileId = params.path.split(',').join('/');
    } catch (e) {
        return new Response('Error: Decode Image ID Failed', { status: 400 });
    }

    // 读取安全配置，解析必要参数
    const securityConfig = await fetchSecurityConfig(env);
    context.securityConfig = securityConfig;

    const url = new URL(request.url);
    context.url = url;

    const Referer = request.headers.get('Referer')
    context.Referer = Referer;

    context.fileAccess = await buildFileAccessContext(context);

    // 检查引用域名是否被允许
    if (!isDomainAllowed(context)) {
        return await returnBlockImg(url);
    }

    // 从数据库中获取图片记录
    const db = getDatabase(env);
    const imgRecord = await db.getWithMetadata(fileId);
    if (!imgRecord) {
        return new Response('Error: Image Not Found', { status: 404 });
    }

    // 如果metadata不存在，只可能是之前未设置KV，且存储在Telegraph上的图片
    if (!imgRecord.metadata) {
        imgRecord.metadata = {};
    }

    const fileName = imgRecord.metadata?.FileName || fileId;
    const encodedFileName = encodeURIComponent(fileName);
    const fileType = imgRecord.metadata?.FileType || null;

    // 检查文件可访问状态
    let accessRes = await returnWithCheck(context, imgRecord);
    if (accessRes.status !== 200) {
        return accessRes; // 如果不可访问，直接返回
    }

    /* 本地文件系统渠道 */
    if (imgRecord.metadata?.Channel === 'Local') {
        return await handleLocalFile(context, fileId, encodedFileName, fileType);
    }

    /* S3渠道 */
    if (imgRecord.metadata?.Channel === "S3") {
        return await handleS3File(context, imgRecord.metadata, encodedFileName, fileType);
    }

    // 未匹配任何可用渠道
    return new Response('Error: Unsupported channel', { status: 500 });
}

async function buildFileAccessContext(context) {
    const { request, env, url } = context;
    const fromAdmin = url.searchParams.get('from') === 'admin';
    const fileAccess = {
        isAdminPreview: fromAdmin,
        adminAuthResult: { authorized: false, authType: null },
        cacheControl: undefined,
    };

    if (fileAccess.isAdminPreview) {
        fileAccess.adminAuthResult = await authenticate({
            env,
            request,
            requiredPermission: 'manage',
            authScope: AUTH_SCOPE.ADMIN,
        });
    }

    return fileAccess;
}

function getFileCacheControl(context) {
    return context.fileAccess?.cacheControl;
}


// 处理本地文件系统文件读取
async function handleLocalFile(context, fileId, encodedFileName, fileType) {
    const { env, request, url, Referer } = context;

    try {
        if (typeof env.img_local == "undefined" || env.img_local == null) {
            return new Response('Error: Local storage is not available in this environment', { status: 500 });
        }

        const localStorage = env.img_local;

        const range = request.headers.get('Range');
        let object;

        if (range) {
            const matches = range.match(/bytes=(\d+)-(\d*)/);
            if (matches) {
                const start = parseInt(matches[1]);
                const end = matches[2] ? parseInt(matches[2]) : undefined;

                const rangeOptions = { range: { offset: start } };
                if (end !== undefined) {
                    rangeOptions.range.length = end - start + 1;
                }

                object = await localStorage.get(fileId, rangeOptions);
            } else {
                object = await localStorage.get(fileId);
            }
        } else {
            object = await localStorage.get(fileId);
        }

        if (object === null) {
            return new Response('Error: File not found in local storage', { status: 404 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        if (range && object.range) {
            headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
            headers.set('Content-Length', object.range.length.toString());
            return new Response(object.body, { status: 206, headers });
        }

        return new Response(object.body, { status: 200, headers });
    } catch (error) {
        return new Response(`Error: Failed to fetch from local storage - ${error.message}`, { status: 500 });
    }
}

// 处理S3文件读取
async function handleS3File(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request } = context;

    // 检查是否配置了 CDN 文件完整路径
    const cdnFileUrl = await getS3CdnFileUrl(context.env, metadata);

    // 如果配置了 CDN 文件路径，通过 CDN 读取文件
    if (cdnFileUrl) {
        try {
            // 处理 HEAD 请求
            if (request.method === 'HEAD') {
                const headers = new Headers();
                setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));
                return handleHeadRequest(headers);
            }

            // 构建请求头
            const fetchHeaders = {};

            // 支持 Range 请求
            const range = request.headers.get('Range');
            if (range) {
                fetchHeaders['Range'] = range;
            }

            // 通过 CDN 获取文件（直接使用完整路径，无需拼接）
            const response = await fetch(cdnFileUrl, {
                method: 'GET',
                headers: fetchHeaders
            });

            if (!response.ok && response.status !== 206) {
                // CDN 读取失败，回退到 S3 API
                console.warn(`CDN fetch failed (${response.status}), falling back to S3 API`);
                return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
            }

            // 构建响应头
            const headers = new Headers();
            setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

            // 复制相关头部
            if (response.headers.get('Content-Length')) {
                headers.set('Content-Length', response.headers.get('Content-Length'));
            }
            if (response.headers.get('Content-Range')) {
                headers.set('Content-Range', response.headers.get('Content-Range'));
            }

            return new Response(response.body, {
                status: response.status,
                headers
            });

        } catch (error) {
            // CDN 读取出错，回退到 S3 API
            console.error(`CDN fetch error: ${error.message}, falling back to S3 API`);
            return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
        }
    }

    // 没有配置 CDN 文件路径，使用 S3 API
    return await handleS3FileViaAPI(context, metadata, encodedFileName, fileType);
}

async function getS3CdnFileUrl(env, metadata) {
    try {
        const db = getDatabase(env);
        const s3Credentials = await resolveS3Credentials(db, env, metadata);
        return buildCdnFileUrl(s3Credentials.cdnDomain, s3Credentials.key);
    } catch (error) {
        console.warn('Failed to build S3 CDN file URL:', error.message);
        return '';
    }
}

// 通过 S3 API 读取文件
async function handleS3FileViaAPI(context, metadata, encodedFileName, fileType) {
    const { Referer, url, request, env } = context;
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, metadata);

    const s3Client = new S3Client({
        region: s3Credentials.region || "auto",
        endpoint: s3Credentials.endpoint,
        credentials: {
            accessKeyId: s3Credentials.accessKeyId,
            secretAccessKey: s3Credentials.secretAccessKey
        },
        forcePathStyle: s3Credentials.pathStyle || false
    });

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        // 检查Range请求头
        const range = request.headers.get('Range');
        const commandParams = {
            Bucket: bucketName,
            Key: key
        };

        if (range) {
            // 添加Range参数用于部分内容请求
            commandParams.Range = range;
        }

        const command = new GetObjectCommand(commandParams);
        const response = await s3Client.send(command);

        // 设置响应头
        const headers = new Headers();
        setCommonHeaders(headers, encodedFileName, fileType, getFileCacheControl(context));

        // 设置Content-Length和Content-Range头
        if (response.ContentLength) {
            headers.set('Content-Length', response.ContentLength.toString());
        }

        if (response.ContentRange) {
            headers.set('Content-Range', response.ContentRange);
        }

        // 处理HEAD请求
        if (request.method === 'HEAD') {
            return handleHeadRequest(headers);
        }

        // 返回响应，支持流式传输
        const statusCode = range ? 206 : 200; // Range请求返回206 Partial Content
        return new Response(response.Body, {
            status: statusCode,
            headers
        });

    } catch (error) {
        return new Response(`Error: Failed to fetch from S3 - ${error.message}`, { status: 500 });
    }
}
