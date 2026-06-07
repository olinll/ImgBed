import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { removeFileFromIndex, batchRemoveFilesFromIndex } from "../../../utils/indexManager.js";
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { resolveS3Credentials } from '../../../utils/metadata/channelCredentials.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
    const { request, env, params, waitUntil } = context;

    const url = new URL(request.url);

    // 读取folder参数，判断是否为文件夹删除请求
    const folder = url.searchParams.get('folder');
    if (folder === 'true') {
        try {
            params.path = decodeURIComponent(params.path);
            // 使用队列存储需要处理的文件夹
            const folderQueue = [{
                path: params.path.split(',').join('/')
            }];

            const deletedFiles = [];
            const failedFiles = [];

            while (folderQueue.length > 0) {
                const currentFolder = folderQueue.shift();

                // 获取指定目录下的所有文件
                const listUrl = new URL(`${url.origin}/api/manage/list?count=-1&dir=${currentFolder.path}`);
                const listRequest = new Request(listUrl, {
                    headers: request.headers,
                });
                const listResponse = await fetch(listRequest);
                const listData = await listResponse.json();

                const files = listData.files;

                // 处理当前文件夹下的所有文件
                for (const file of files) {
                    const fileId = file.name;
                    const cdnUrl = `https://${url.hostname}/file/${fileId}`;

                    const success = await deleteFile(env, fileId, cdnUrl);
                    if (success) {
                        deletedFiles.push(fileId);
                    } else {
                        failedFiles.push(fileId);
                    }
                }

                // 将子文件夹添加到队列
                const directories = listData.directories;
                for (const dir of directories) {
                    folderQueue.push({
                        path: dir
                    });
                }
            }

            // 批量从索引中删除文件
            if (deletedFiles.length > 0) {
                waitUntil(batchRemoveFilesFromIndex(context, deletedFiles));
            }

            return new Response(JSON.stringify({
                success: true,
                deleted: deletedFiles,
                failed: failedFiles
            }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });

        } catch (e) {
            return new Response(JSON.stringify({
                success: false,
                error: e.message
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }
    }

    // 单个文件删除处理
    try {
        // 解码params.path
        params.path = decodeURIComponent(params.path);
        const fileId = params.path.split(',').join('/');
        const cdnUrl = `https://${url.hostname}/file/${fileId}`;

        const success = await deleteFile(env, fileId, cdnUrl);
        if (!success) {
            throw new Error('Delete file failed');
        } else {
            // 从索引中删除文件
            waitUntil(removeFileFromIndex(context, fileId));
        }

        return new Response(JSON.stringify({
            success: true,
            fileId: fileId
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    } catch (e) {
        return new Response(JSON.stringify({
            success: false,
            error: e.message
        }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

// 删除单个文件的核心函数
async function deleteFile(env, fileId, cdnUrl) {
    try {
        // 读取图片信息
        const db = getDatabase(env);
        const img = await db.getWithMetadata(fileId);

        // 如果文件记录不存在，直接返回成功（幂等删除）
        if (!img) {
            console.warn(`File ${fileId} not found in database, skipping delete`);
            return true;
        }

        // S3 渠道的图片，需要删除S3中对应的图片
        if (img.metadata?.Channel === 'S3') {
            await deleteS3File(env, img);
        } else {
            // 本地存储的图片，R2-style 处理
            const localStore = env.img_local;
            if (localStore) {
                await localStore.delete(fileId);
            }
        }

        // 删除数据库中的记录
        // 注意：容量统计现在由索引自动维护，删除文件后索引更新时会自动重新计算
        await db.delete(fileId);

        return true;
    } catch (e) {
        console.error('Delete file failed:', e);
        return false;
    }
}

// 删除 S3 渠道的图片
async function deleteS3File(env, img) {
    const db = getDatabase(env);
    const s3Credentials = await resolveS3Credentials(db, env, img.metadata);
    const s3Client = new S3Client({
        region: s3Credentials.region || "auto",
        endpoint: s3Credentials.endpoint,
        credentials: {
            accessKeyId: s3Credentials.accessKeyId,
            secretAccessKey: s3Credentials.secretAccessKey
        },
        forcePathStyle: s3Credentials.pathStyle || false // 是否启用路径风格
    });

    const bucketName = s3Credentials.bucketName;
    const key = s3Credentials.key;

    try {
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key,
        }));
        return true;
    } catch (error) {
        console.error("S3 Delete Failed:", error);
        return false;
    }
}
