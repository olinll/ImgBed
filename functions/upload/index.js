import { userAuthCheck, UnauthorizedResponse } from "../utils/auth/userAuth";
import { fetchUploadConfig, fetchSecurityConfig } from "../utils/sysConfig";
import {
    createResponse, getUploadIp, getIPAddress, resolveFileExt,
    moderateContent, isBlockedUploadIp, buildUniqueFileId, endUpload, getImageDimensions,
    sanitizeUploadFolder
} from "./uploadTools";
import { initializeChunkedUpload, handleChunkUpload, handleCleanupRequest } from "./chunkUpload";
import { handleChunkMerge } from "./chunkMerge";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';


export async function onRequest(context) {  // Contents of context object
    const { request, env, params, waitUntil, next, data } = context;

    // 解析请求的URL，存入 context
    const url = new URL(request.url);
    context.url = url;

    // 读取各项配置，存入 context
    const securityConfig = await fetchSecurityConfig(env);
    const uploadConfig = await fetchUploadConfig(env, context);

    context.securityConfig = securityConfig;
    context.uploadConfig = uploadConfig;

    // 鉴权
    const requiredPermission = 'upload';
    if (!await userAuthCheck(env, url, request, requiredPermission)) {
        return UnauthorizedResponse('Unauthorized');
    }

    // 获得上传IP
    const uploadIp = getUploadIp(request);
    // 判断上传ip是否被封禁
    const isBlockedIp = await isBlockedUploadIp(env, uploadIp);
    if (isBlockedIp) {
        return createResponse('Error: Your IP is blocked', { status: 403 });
    }

    // 检查是否为清理请求
    const cleanupRequest = url.searchParams.get('cleanup') === 'true';
    if (cleanupRequest) {
        const uploadId = url.searchParams.get('uploadId');
        const totalChunks = parseInt(url.searchParams.get('totalChunks')) || 0;
        return await handleCleanupRequest(context, uploadId, totalChunks);
    }

    // 检查是否为初始化分块上传请求
    const initChunked = url.searchParams.get('initChunked') === 'true';
    if (initChunked) {
        return await initializeChunkedUpload(context);
    }

    // 检查是否为分块上传
    const isChunked = url.searchParams.get('chunked') === 'true';
    const isMerge = url.searchParams.get('merge') === 'true';

    if (isChunked) {
        if (isMerge) {
            return await handleChunkMerge(context);
        } else {
            return await handleChunkUpload(context);
        }
    }

    // 处理非分块文件上传
    return await processFileUpload(context);
}


// 通用文件上传处理函数
async function processFileUpload(context, formdata = null) {
    const { request, url } = context;

    // 解析表单数据
    formdata = formdata || await request.formData();

    // 将 formdata 存储在 context 中
    context.formdata = formdata;

    // 获得上传渠道类型
    const urlParamUploadChannel = url.searchParams.get('uploadChannel');
    // 获得指定的渠道名称（可选）
    const urlParamChannelName = url.searchParams.get('channelName');

    // 获取IP地址
    const uploadIp = getUploadIp(request);
    const ipAddress = await getIPAddress(uploadIp);

    // 获取上传文件夹路径
    let uploadFolder = url.searchParams.get('uploadFolder') || '';

    // 路径安全性处理：防止路径穿越和特殊字符注入
    uploadFolder = sanitizeUploadFolder(uploadFolder);

    let uploadChannel = 'S3';
    switch (urlParamUploadChannel) {
        case 's3':
            uploadChannel = 'S3';
            break;
        case 'local':
            uploadChannel = 'Local';
            break;
        default:
            uploadChannel = 'S3';
            break;
    }

    // 将指定的渠道名称存入 context，供后续上传函数使用
    context.specifiedChannelName = urlParamChannelName || null;

    // 获取文件信息
    const time = new Date().getTime();
    const file = formdata.get('file');
    const fileType = file.type;
    let fileName = file.name;
    const fileSizeBytes = file.size; // 文件大小，单位字节
    const fileSize = (fileSizeBytes / 1024 / 1024).toFixed(2); // 文件大小，单位MB

    // 检查fileType和fileName是否存在
    if (fileType === null || fileType === undefined || fileName === null || fileName === undefined) {
        return createResponse('Error: fileType or fileName is wrong, check the integrity of this file!', { status: 400 });
    }

    // 提取图片尺寸
    let imageDimensions = null;
    if (fileType.startsWith('image/')) {
        try {
            // 统一读取 64KB，足以覆盖 JPEG 的 EXIF 数据和其他格式
            const headerBuffer = await file.slice(0, 65536).arrayBuffer();
            imageDimensions = getImageDimensions(headerBuffer, fileType);
        } catch (error) {
            console.error('Error reading image dimensions:', error);
        }
    }

    // 如果上传文件夹路径为空，尝试从文件名中获取
    if (uploadFolder === '' || uploadFolder === null || uploadFolder === undefined) {
        uploadFolder = fileName.split('/').slice(0, -1).join('/');
        // 对从文件名中提取的路径也进行安全处理
        uploadFolder = sanitizeUploadFolder(uploadFolder);
        // 从文件名中去除路径信息，只保留文件名部分
        fileName = fileName.split('/').pop();
    }
    // uploadFolder 已经过 sanitizeUploadFolder 处理，直接使用
    const normalizedFolder = uploadFolder;

    const metadata = {
        FileName: fileName,
        FileType: fileType,
        FileSize: fileSize,
        FileSizeBytes: fileSizeBytes,
        UploadIP: uploadIp,
        UploadAddress: ipAddress,
        ListType: "None",
        TimeStamp: time,
        Label: "None",
        Directory: normalizedFolder === '' ? '' : normalizedFolder + '/',
        Tags: []
    };

    // 添加图片尺寸信息
    if (imageDimensions) {
        metadata.Width = imageDimensions.width;
        metadata.Height = imageDimensions.height;
    }

    const fileExt = resolveFileExt(fileName, fileType);

    // 构建文件ID
    const fullId = await buildUniqueFileId(context, fileName, fileType);

    // 获得返回链接格式, default为返回/file/id, full为返回完整链接
    const returnFormat = url.searchParams.get('returnFormat') || 'default';
    let returnLink = '';
    if (returnFormat === 'full') {
        returnLink = `${url.origin}/file/${fullId}`;
    } else {
        returnLink = `/file/${fullId}`;
    }

    /* ====================================不同渠道上传======================================= */
    // 出错是否切换渠道自动重试，默认开启
    const autoRetry = url.searchParams.get('autoRetry') === 'false' ? false : true;

    let err = '';
    // 上传到不同渠道
    if (uploadChannel === 'S3') {
        // ---------------------S3 渠道------------------
        const res = await uploadFileToS3(context, fullId, metadata, returnLink);
        if (res.status === 200 || !autoRetry) {
            return res;
        } else {
            err = await res.text();
        }
    } else if (uploadChannel === 'Local') {
        // ------------------本地文件系统 渠道-----------------
        const res = await uploadFileToLocal(context, fullId, metadata, returnLink);
        if (res.status === 200 || !autoRetry) {
            return res;
        } else {
            err = await res.text();
        }
    }

    // 上传失败，开始自动切换渠道重试
    const res = await tryRetry(err, context, uploadChannel, fullId, metadata, returnLink);
    return res;
}


// 上传到本地文件系统
async function uploadFileToLocal(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    if (typeof env.img_local == "undefined" || env.img_local == null) {
        return createResponse('Error: Local storage is not available in this environment', { status: 500 });
    }

    const localSettings = uploadConfig.local;
    if (!localSettings || !localSettings.channels || localSettings.channels.length === 0) {
        return createResponse('Error: No local channel provided', { status: 400 });
    }

    let localChannel;
    if (specifiedChannelName) {
        localChannel = localSettings.channels.find(ch => ch.name === specifiedChannelName);
    }
    if (!localChannel) {
        localChannel = localSettings.channels[0];
    }

    await env.img_local.put(fullId, formdata.get('file'));

    metadata.Channel = "Local";
    metadata.ChannelName = localChannel.name || "Local_env";

    try {
        await db.put(fullId, "", { metadata });
    } catch (error) {
        return createResponse('Error: Failed to write to database', { status: 500 });
    }

    waitUntil(endUpload(context, fullId, metadata));

    return createResponse(
        JSON.stringify([{ 'src': `${returnLink}` }]),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        }
    );
}


// 上传到 S3（支持自定义端点）
async function uploadFileToS3(context, fullId, metadata, returnLink) {
    const { env, waitUntil, uploadConfig, securityConfig, url, formdata, specifiedChannelName } = context;
    const db = getDatabase(env);

    const uploadModerate = securityConfig.upload.moderate;

    const s3Settings = uploadConfig.s3;
    const s3Channels = s3Settings.channels;

    // 选择渠道：优先使用指定的渠道名称
    let s3Channel;
    if (specifiedChannelName) {
        s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
    }
    if (!s3Channel) {
        s3Channel = s3Settings.loadBalance.enabled
            ? s3Channels[Math.floor(Math.random() * s3Channels.length)]
            : s3Channels[0];
    }

    if (!s3Channel) {
        return createResponse('Error: No S3 channel provided', { status: 400 });
    }

    const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

    // 创建 S3 客户端
    const s3Client = new S3Client({
        region: region || "auto", // R2 可用 "auto"
        endpoint, // 自定义 S3 端点
        credentials: {
            accessKeyId,
            secretAccessKey
        },
        forcePathStyle: pathStyle // 是否启用路径风格
    });

    // 获取文件
    const file = formdata.get("file");
    if (!file) return createResponse("Error: No file provided", { status: 400 });

    // 转换 Blob 为 Uint8Array
    const arrayBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const s3FileName = fullId;

    try {
        // S3 上传参数
        const putObjectParams = {
            Bucket: bucketName,
            Key: s3FileName,
            Body: uint8Array, // 直接使用 Blob
            ContentType: file.type
        };

        // 执行上传
        await s3Client.send(new PutObjectCommand(putObjectParams));

        // 更新 metadata
        metadata.Channel = "S3";
        metadata.ChannelName = s3Channel.name;
        metadata.S3FileKey = s3FileName;

        // 图像审查
        if (uploadModerate && uploadModerate.enabled) {
            try {
                await db.put(fullId, "", { metadata });
            } catch {
                return createResponse("Error: Failed to write to KV database", { status: 500 });
            }

            const moderateUrl = `https://${url.hostname}/file/${fullId}`;
            metadata.Label = await moderateContent(env, moderateUrl);
        }

        // 写入数据库
        try {
            await db.put(fullId, "", { metadata });
        } catch {
            return createResponse("Error: Failed to write to database", { status: 500 });
        }

        // 结束上传
        waitUntil(endUpload(context, fullId, metadata));

        return createResponse(JSON.stringify([{ src: returnLink }]), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
            },
        });
    } catch (error) {
        return createResponse(`Error: Failed to upload to S3 - ${error.message}`, { status: 500 });
    }
}


// 自动切换渠道重试
async function tryRetry(err, context, uploadChannel, fullId, metadata, returnLink) {
    const channelList = ['Local', 'S3'];
    const errMessages = {};
    errMessages[uploadChannel] = 'Error: ' + uploadChannel + err;

    // 先用原渠道再试一次
    let retryRes = null;
    if (uploadChannel === 'S3') {
        retryRes = await uploadFileToS3(context, fullId, metadata, returnLink);
    } else if (uploadChannel === 'Local') {
        retryRes = await uploadFileToLocal(context, fullId, metadata, returnLink);
    }

    // 原渠道重试成功，直接返回
    if (retryRes && retryRes.status === 200) {
        return retryRes;
    } else if (retryRes) {
        errMessages[uploadChannel + '_retry'] = 'Error: ' + uploadChannel + ' retry - ' + await retryRes.text();
    }

    // 原渠道重试失败，切换到其他渠道
    for (let i = 0; i < channelList.length; i++) {
        if (channelList[i] !== uploadChannel) {
            let res = null;
            if (channelList[i] === 'S3') {
                res = await uploadFileToS3(context, fullId, metadata, returnLink);
            } else if (channelList[i] === 'Local') {
                res = await uploadFileToLocal(context, fullId, metadata, returnLink);
            }

            if (res && res.status === 200) {
                return res;
            } else if (res) {
                errMessages[channelList[i]] = 'Error: ' + channelList[i] + await res.text();
            }
        }
    }

    return createResponse(JSON.stringify(errMessages), { status: 500 });
}
