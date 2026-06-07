import { getDatabase } from '../../../utils/databaseAdapter.js';

export async function onRequest(context) {
    const {
        request,
        env,
        params,
        waitUntil,
        next,
        data,
    } = context;

    const db = getDatabase(env);

    if (request.method === 'GET') {
        const settings = await getUploadConfig(db, env)

        return new Response(JSON.stringify(settings), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

    if (request.method === 'POST') {
        const body = await request.json()
        const settings = body

        await db.put('manage@sysConfig@upload', JSON.stringify(settings))

        return new Response(JSON.stringify(settings), {
            headers: {
                'content-type': 'application/json',
            },
        })
    }

}

export async function getUploadConfig(db, env) {
    const settings = {}
    const settingsStr = await db.get('manage@sysConfig@upload')
    const settingsKV = settingsStr ? JSON.parse(settingsStr) : {}

    // =====================读取s3渠道配置=====================
    const s3 = {}
    const s3Channels = []
    s3.channels = s3Channels
    if (env.S3_ACCESS_KEY_ID) {
        s3Channels.push({
            id: 1,
            name: 'S3_env',
            type: 's3',
            savePath: 'environment variable',
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            region: env.S3_REGION || 'auto',
            bucketName: env.S3_BUCKET_NAME,
            endpoint: env.S3_ENDPOINT,
            pathStyle: env.S3_PATH_STYLE === 'true',
            cdnDomain: env.S3_CDN_DOMAIN || '',
            enabled: true,
            fixed: true,
        })
    }
    for (const s of settingsKV.s3?.channels || []) {
        if (s.savePath === 'environment variable') {
            if (s3Channels[0]) {
                s3Channels[0].enabled = s.enabled
                s3Channels[0].quota = s.quota
                s3Channels[0].cdnDomain = s.cdnDomain
            }
            continue
        }
        s.id = s3Channels.length + 1
        s3Channels.push(s)
    }
    const s3LoadBalance = settingsKV.s3?.loadBalance || {
        enabled: false,
        channels: [],
    }
    s3.loadBalance = s3LoadBalance

    // =====================读取本地存储渠道配置=====================
    const local = {}
    const localChannels = []
    local.channels = localChannels

    if (env.img_local) {
        localChannels.push({
            id: 1,
            name: 'Local_env',
            type: 'local',
            savePath: 'environment variable',
            storagePath: env.LOCAL_STORAGE_PATH || '',
            enabled: true,
            fixed: true,
        })
    }

    for (const loc of settingsKV.local?.channels || []) {
        if (loc.savePath === 'environment variable') {
            if (localChannels[0]) {
                localChannels[0].enabled = loc.enabled
                localChannels[0].storagePath = loc.storagePath || localChannels[0].storagePath
                localChannels[0].quota = loc.quota
            }
            continue
        }
        loc.id = localChannels.length + 1
        localChannels.push(loc)
    }

    const localLoadBalance = settingsKV.local?.loadBalance || {
        enabled: false,
        channels: [],
    }
    local.loadBalance = localLoadBalance

    settings.s3 = s3
    settings.local = local

    return settings;
}
