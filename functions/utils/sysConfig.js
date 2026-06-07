import { getUploadConfig } from '../api/manage/sysConfig/upload.js';
import { getSecurityConfig } from '../api/manage/sysConfig/security.js';
import { getPageConfig } from '../api/manage/sysConfig/page.js';
import { getOthersConfig } from '../api/manage/sysConfig/others.js';
import { getDatabase } from './databaseAdapter.js';
import { getIndexMeta } from './indexManager.js';

async function filterChannelsByQuota(context, channels) {
    const hasQuotaEnabled = channels.some(ch => ch.quota?.enabled && ch.quota?.limitGB);
    if (!hasQuotaEnabled) {
        return channels;
    }

    const indexMeta = await getIndexMeta(context);
    const channelStats = indexMeta.channelStats || {};

    const result = [];
    for (const channel of channels) {
        if (!channel.quota?.enabled || !channel.quota?.limitGB) {
            result.push(channel);
            continue;
        }

        try {
            const stats = channelStats[channel.name] || { usedMB: 0, fileCount: 0 };
            const usedGB = stats.usedMB / 1024;
            const limitGB = channel.quota.limitGB;
            const threshold = channel.quota.threshold || 95;

            if ((usedGB / limitGB) * 100 < threshold) {
                result.push(channel);
            } else {
                console.log(`Channel ${channel.name} quota exceeded: ${usedGB.toFixed(2)}GB / ${limitGB}GB (${threshold}% threshold)`);
            }
        } catch (error) {
            console.error(`Failed to check quota for channel ${channel.name}:`, error);
            result.push(channel);
        }
    }
    return result;
}

export async function fetchUploadConfig(env, context = null) {
    try {
        const db = getDatabase(env);
        const settings = await getUploadConfig(db, env);
        settings.s3.channels = settings.s3.channels.filter((channel) => channel.enabled);
        settings.local.channels = (settings.local?.channels || []).filter((channel) => channel.enabled);

        if (context) {
            settings.s3.channels = await filterChannelsByQuota(context, settings.s3.channels);
            if (settings.local?.channels) {
                settings.local.channels = await filterChannelsByQuota(context, settings.local.channels);
            }
        }

        return settings;
    } catch (error) {
        console.error('Failed to fetch upload config:', error);
        return {
            s3: { channels: [] },
            local: { channels: [] }
        };
    }
}

export async function fetchSecurityConfig(env) {
    try {
        const db = getDatabase(env);
        const settings = await getSecurityConfig(db, env);
        return settings;
    } catch (error) {
        console.error('Failed to fetch security config:', error);
        return {
            auth: {
                user: { authCode: "" },
                admin: { adminUsername: "", adminPassword: "" }
            },
            upload: {
                moderate: { enabled: false, channel: "default", moderateContentApiKey: "", nsfwApiPath: "" }
            },
            access: { allowedDomains: "", whiteListMode: false, sessionSecure: false, userSessionMaxAge: 14, adminSessionMaxAge: 14 }
        };
    }
}

export async function fetchPageConfig(env) {
    try {
        const db = getDatabase(env);
        const settings = await getPageConfig(db, env);
        return settings;
    } catch (error) {
        console.error('Failed to fetch page config:', error);
        return { config: [] };
    }
}

export async function fetchOthersConfig(env) {
    try {
        const db = getDatabase(env);
        const settings = await getOthersConfig(db, env);
        return settings;
    } catch (error) {
        console.error('Failed to fetch others config:', error);
        return {
            telemetry: { enabled: false }
        };
    }
}
