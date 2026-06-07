/* ========== 分块合并处理 ========== */
import { createResponse, getUploadIp, getIPAddress, selectConsistentChannel, buildUniqueFileId, endUpload, sanitizeUploadFolder } from './uploadTools';
import { retryFailedChunks, cleanupFailedMultipartUploads, checkChunkUploadStatuses, cleanupChunkData, cleanupUploadSession } from './chunkUpload';
import { S3Client, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase } from '../utils/databaseAdapter.js';

// 处理分块合并
export async function handleChunkMerge(context) {
    const { request, env, url, waitUntil } = context;
    const db = getDatabase(env);

    // 解析表单数据
    const formdata = await request.formData();
    context.formdata = formdata;

    let uploadId, totalChunks, originalFileName, originalFileType, uploadChannel;
    try {
        uploadId = formdata.get('uploadId');
        totalChunks = parseInt(formdata.get('totalChunks'));
        originalFileName = formdata.get('originalFileName');
        originalFileType = formdata.get('originalFileType');

        if (!uploadId || !totalChunks || !originalFileName) {
            return createResponse('Error: Missing merge parameters', { status: 400 });
        }

        // 验证上传会话
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return createResponse('Error: Invalid or expired upload session', { status: 400 });
        }

        const sessionInfo = JSON.parse(sessionData);

        // 验证会话信息
        if (sessionInfo.originalFileName !== originalFileName ||
            sessionInfo.totalChunks !== totalChunks) {
            return createResponse('Error: Session parameters mismatch', { status: 400 });
        }

        // 检查会话是否过期
        if (Date.now() > sessionInfo.expiresAt) {
            return createResponse('Error: Upload session expired', { status: 410 });
        }

        // 使用会话中的上传渠道，或者从URL参数获取
        uploadChannel = url.searchParams.get('uploadChannel') || sessionInfo.uploadChannel || 's3';

        // 获取指定的渠道名称（优先URL参数，其次会话信息）
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';
        context.specifiedChannelName = channelName;

        // 检查分块上传状态
        const chunkStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);

        // 输出初始状态摘要
        const initialStatusSummary = chunkStatuses.reduce((acc, chunk) => {
            acc[chunk.status] = (acc[chunk.status] || 0) + 1;
            return acc;
        }, {});
        console.log(`Initial chunk status summary: ${JSON.stringify(initialStatusSummary)}`);

        // 开始合并处理
        return await startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel);

    } catch (error) {
        // 清理失败的multipart uploads
        if (uploadChannel === 's3') {
            waitUntil(cleanupFailedMultipartUploads(context, uploadId, uploadChannel));
        }

        // 清理临时分块数据
        waitUntil(cleanupChunkData(env, uploadId, totalChunks));

        // 清理上传会话
        waitUntil(cleanupUploadSession(env, uploadId));

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 开始合并处理
async function startMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { env } = context;

    try {
        // 合并任务状态输出
        const mergeStatus = {
            uploadId,
            status: 'processing',
            progress: 0,
            totalChunks,
            originalFileName,
            originalFileType,
            uploadChannel,
            createdAt: Date.now(),
            message: 'Starting merge process...'
        };
        console.log(`Merge status: ${JSON.stringify(mergeStatus)}`);

        // 同步执行合并
        const result = await handleChannelBasedMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel);

        if (result.success) {
            // 清理临时分块数据
            await cleanupChunkData(env, uploadId, totalChunks);

            // 清理上传会话
            await cleanupUploadSession(env, uploadId);

            return createResponse(JSON.stringify(result.result), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            throw new Error(result.error || 'Merge failed');
        }

    } catch (error) {
        // 清理失败的multipart uploads
        if (uploadChannel === 's3') {
            await cleanupFailedMultipartUploads(context, uploadId, uploadChannel);
        }

        // 清理分块数据
        await cleanupChunkData(env, uploadId, totalChunks);

        // 清理上传会话
        await cleanupUploadSession(env, uploadId);

        return createResponse(`Error: Failed to merge chunks - ${error.message}`, { status: 500 });
    }
}

// 基于渠道的合并处理
async function handleChannelBasedMerge(context, uploadId, totalChunks, originalFileName, originalFileType, uploadChannel) {
    const { request, env, url } = context;

    try {
        // 获得上传IP
        const uploadIp = getUploadIp(request);

        const normalizedFolder = sanitizeUploadFolder(url.searchParams.get('uploadFolder') || '');

        // 构建基础metadata
        const metadata = {
            FileName: originalFileName,
            FileType: originalFileType,
            FileSize: '0', // 会在最终合并后更新
            UploadIP: uploadIp,
            UploadAddress: await getIPAddress(uploadIp),
            ListType: "None",
            TimeStamp: Date.now(),
            Label: "None",
            Directory: normalizedFolder === '' ? '' : normalizedFolder + '/',
            Tags: []
        };

        // 收集所有已上传的分块信息
        const chunkStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
        let completedChunks = chunkStatuses.filter(chunk => chunk.status === 'completed');
        let uploadingChunks = chunkStatuses.filter(chunk =>
            chunk.status === 'uploading' ||
            chunk.status === 'retrying'
        );
        let failedChunks = chunkStatuses.filter(chunk =>
            chunk.status === 'failed' ||
            chunk.status === 'timeout'
        );

        // 统计不同状态的分块
        const statusSummary = chunkStatuses.reduce((acc, chunk) => {
            acc[chunk.status] = (acc[chunk.status] || 0) + 1;
            return acc;
        }, {});

        console.log(`Chunk status summary: ${JSON.stringify(statusSummary)}`);

        // 如果有失败的分块，尝试重试
        if (failedChunks.length > 0) {
            console.log(`Retrying ${failedChunks.length} failed chunks...`);
            // 同步重试（await）
            await retryFailedChunks(context, failedChunks, uploadChannel);
        }

        // 重新检查状态
        const updatedStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
        completedChunks = updatedStatuses.filter(chunk => chunk.status === 'completed');

        // 最终检查是否所有分块都完成
        if (completedChunks.length !== totalChunks) {
            // 获取最新的状态信息
            const finalStatuses = await checkChunkUploadStatuses(env, uploadId, totalChunks);
            const finalStatusSummary = finalStatuses.reduce((acc, chunk) => {
                acc[chunk.status] = (acc[chunk.status] || 0) + 1;
                return acc;
            }, {});

            throw new Error(`Only ${completedChunks.length}/${totalChunks} chunks completed successfully. Final status: ${JSON.stringify(finalStatusSummary)}`);
        }

        // 根据渠道合并分块信息
        let result;
        if (uploadChannel === 's3') {
            result = await mergeS3ChunksInfo(context, uploadId, completedChunks, metadata);
        } else {
            throw new Error(`Unsupported upload channel: ${uploadChannel}`);
        }

        return result;

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 合并S3分块信息
async function mergeS3ChunksInfo(context, uploadId, completedChunks, metadata) {
    const { env, waitUntil, uploadConfig, url, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const s3Settings = uploadConfig.s3;
        const s3Channels = s3Settings.channels;

        // 优先使用指定的渠道名称
        let s3Channel;
        if (specifiedChannelName) {
            s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
        }
        if (!s3Channel) {
            s3Channel = selectConsistentChannel(s3Channels, uploadId, s3Settings.loadBalance.enabled);
        }

        console.log(`Merging S3 chunks for uploadId: ${uploadId}, selected channel: ${s3Channel.name || 'default'}`);

        const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

        const s3Client = new S3Client({
            region: region || "auto",
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: pathStyle
        });

        const multipartKey = `multipart_${uploadId}`;

        // 获取multipart info
        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            throw new Error('Multipart upload info not found');
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        // 组织所有分块
        const sortedChunks = completedChunks.sort((a, b) => a.index - b.index);
        const parts = [];

        for (const chunk of sortedChunks) {
            const part = {
                ETag: chunk.uploadResult.etag,
                PartNumber: chunk.uploadResult.partNumber
            };
            parts.push(part);
        }

        // 完成multipart upload
        await s3Client.send(new CompleteMultipartUploadCommand({
            Bucket: bucketName,
            Key: multipartInfo.key,
            UploadId: multipartInfo.uploadId,
            MultipartUpload: { Parts: parts }
        }));

        // 计算总大小
        const totalSize = completedChunks.reduce((sum, chunk) => sum + chunk.uploadResult.size, 0);

        // 使用multipart info中的finalFileId更新metadata
        const finalFileId = multipartInfo.key;
        metadata.Channel = "S3";
        metadata.ChannelName = s3Channel.name;
        metadata.FileSize = (totalSize / 1024 / 1024).toFixed(2);
        metadata.FileSizeBytes = totalSize;
        metadata.S3FileKey = finalFileId;

        // 清理multipart info
        await db.delete(multipartKey);

        // 写入数据库
        await db.put(finalFileId, "", { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, finalFileId, metadata));

        // 更新返回链接
        const returnFormat = url.searchParams.get('returnFormat') || 'default';
        let updatedReturnLink = '';
        if (returnFormat === 'full') {
            updatedReturnLink = `${url.origin}/file/${finalFileId}`;
        } else {
            updatedReturnLink = `/file/${finalFileId}`;
        }

        return {
            success: true,
            result: [{ src: updatedReturnLink }]
        };

    } catch (error) {
        throw new Error(`S3 merge failed: ${error.message}`);
    }
}
