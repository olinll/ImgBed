// 获取上传渠道列表 API
import { fetchUploadConfig } from '../utils/sysConfig.js';
import { getUploadConfig } from './manage/sysConfig/upload.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { dualAuthCheck } from '../utils/auth/dualAuth.js';

export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'GET') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const url = new URL(request.url);
    const { authorized } = await dualAuthCheck(env, url, request);
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const includeDisabled = url.searchParams.get('includeDisabled') === 'true';

        let uploadConfig;
        if (includeDisabled) {
            const db = getDatabase(env);
            uploadConfig = await getUploadConfig(db, env);
        } else {
            uploadConfig = await fetchUploadConfig(env, context);
        }

        const channels = {
            s3: uploadConfig.s3.channels.map(ch => ({
                name: ch.name,
                type: 'S3'
            })),
            local: (uploadConfig.local?.channels || []).map(ch => ({
                name: ch.name,
                type: 'Local'
            }))
        };

        return new Response(JSON.stringify(channels), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('Failed to get channels:', error);
        return new Response(JSON.stringify({ error: 'Failed to get channels' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
