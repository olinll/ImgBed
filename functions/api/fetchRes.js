import { dualAuthCheck } from '../utils/auth/dualAuth.js';

export async function onRequest(context) {
    // 获取请求体中URL的内容
    const {
        request,
        env,
        params,
        waitUntil,
        next,
        data
    } = context;

    // 双重鉴权检查
    const url = new URL(request.url);
    const { authorized } = await dualAuthCheck(env, url, request);
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const jsonRequest = await request.json();
    const targetUrl = jsonRequest.url;
    if (targetUrl === undefined) {
        return new Response('URL is required', { status: 400 })
    }

    // Validate URL to prevent SSRF
    let parsedUrl;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return new Response('Invalid URL', { status: 400 })
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return new Response('Only http and https protocols are allowed', { status: 400 })
    }
    const hostname = parsedUrl.hostname.toLowerCase();
    const blocked = [
        '127.0.0.1', 'localhost', '0.0.0.0',
        '169.254.169.254', // AWS/cloud metadata
        'metadata.google.internal', // GCP metadata
        '100.100.100.200', // Aliyun metadata
    ];
    if (blocked.includes(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return new Response('Access to internal hosts is forbidden', { status: 403 })
    }

    const response = await fetch(targetUrl);
    const headers = new Headers(response.headers);
    return new Response(response.body, {
        headers: headers
    })
}