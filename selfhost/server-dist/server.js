import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { deviceRegistrationRequestSchema, deviceRefreshRequestSchema, parseWireJson } from '@dsh-remote/protocol';
import { ApiError, Store, hash, secret } from './store.js';
import { Gateway } from './gateway.js';
import { buildIceServers, parseIceConfig } from './ice.js';
import { Logger } from './logger.js';
import { FORCE_TERMINATE_GRACE_MS_RANGE, HEARTBEAT_DISCONNECT_MS_MAX, HELLO_TIMEOUT_MS_RANGE, HEARTBEAT_INTERVAL_MS_RANGE, MAX_FRAMES_PER_SEC_RANGE, normalizeForceTerminateGraceMs, normalizeGatewayOptions, normalizeHeartbeatDisconnectMs, normalizeHeartbeatIntervalMs, normalizeHelloTimeoutMs, normalizeMaxFramesPerSec, } from './config.js';
/**
 * Timing configuration is normalized in one place (`config.ts`) so the CLI and
 * programmatic callers share the same bounds and fallbacks. These wrappers keep
 * the env-var parsing API used by `main.ts` and the tests, and never echo the
 * offending input in their warnings.
 */
export function parseHelloTimeout(val) {
    return normalizeHelloTimeoutMs(val);
}
export function parseHeartbeatInterval(val) {
    return normalizeHeartbeatIntervalMs(val);
}
export function parseHeartbeatDisconnect(val, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS_RANGE.fallback) {
    return normalizeHeartbeatDisconnectMs(val, heartbeatIntervalMs);
}
export function parseForceTerminateGrace(val) {
    return normalizeForceTerminateGraceMs(val);
}
export function parseMaxFramesPerSec(val) {
    return normalizeMaxFramesPerSec(val);
}
export { normalizeGatewayOptions, normalizeHelloTimeoutMs, normalizeHeartbeatIntervalMs, normalizeHeartbeatDisconnectMs, normalizeForceTerminateGraceMs, normalizeMaxFramesPerSec, HELLO_TIMEOUT_MS_RANGE, HEARTBEAT_INTERVAL_MS_RANGE, HEARTBEAT_DISCONNECT_MS_MAX, FORCE_TERMINATE_GRACE_MS_RANGE, MAX_FRAMES_PER_SEC_RANGE, };
const emailField = z.string().trim().min(1).max(254);
const newPasswordField = z.string().min(12).max(1024);
const existingPasswordField = z.string().min(1).max(1024);
const inviteCodeField = z.string().max(256);
const loginSchema = z.object({ email: emailField, password: existingPasswordField }).strict();
const registerSchema = z.object({ email: emailField, password: newPasswordField, inviteCode: inviteCodeField.optional().default('') }).strict();
const passwordChangeSchema = z.object({ oldPassword: existingPasswordField, newPassword: newPasswordField }).strict();
const adminCreateAccountSchema = z.object({ email: emailField, password: newPasswordField, isAdmin: z.boolean().optional() }).strict();
const adminAccountPasswordSchema = z.object({ email: emailField, newPassword: newPasswordField }).strict();
const adminAccountDisableSchema = z.object({ email: emailField, disabled: z.boolean() }).strict();
const adminAccountDeleteSchema = z.object({ email: emailField }).strict();
const adminDeviceDeleteSchema = z.object({ deviceId: z.string().trim().min(1).max(256) }).strict();
const publicDir = fileURLToPath(new URL('../dist/public/', import.meta.url));
function readAssets() {
    if (!existsSync(publicDir))
        return new Map();
    const assets = new Map();
    for (const entry of readdirSync(publicDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile())
            continue;
        const file = join(entry.parentPath, entry.name);
        const path = file.slice(publicDir.length).replaceAll('\\', '/');
        assets.set(path, readFileSync(file));
    }
    return assets;
}
async function body(req) {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
        throw new ApiError('INVALID_MESSAGE', 415);
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 16384)
            throw new ApiError('FRAME_TOO_LARGE', 413);
        chunks.push(chunk);
    }
    try {
        return parseWireJson(Buffer.concat(chunks));
    }
    catch {
        throw new ApiError('INVALID_MESSAGE');
    }
}
/**
 * Normalize one bare IPv4/IPv6 literal to a single canonical form. IPv4-mapped
 * IPv6 addresses (e.g. ::ffff:127.0.0.1) collapse to plain IPv4, so a peer
 * observed through a dual-stack socket and a config entry compare equal.
 * Returns null for anything that is not a single IP literal: hostnames, ports,
 * CIDR ranges, comma-separated lists, bracketed hosts and zone identifiers.
 */
export function normalizeIp(value) {
    const family = isIP(value);
    if (family === 4)
        return value.toLowerCase();
    if (family !== 6)
        return null;
    let canonical;
    try {
        canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    }
    catch {
        return null;
    }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
    if (!mapped)
        return canonical;
    const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
/** Validate and normalize the trusted proxy list at startup. Empty means disabled. */
export function normalizeTrustedProxyIps(values = []) {
    const result = new Set();
    for (const raw of values) {
        const value = raw.trim();
        const normalized = value === '' ? null : normalizeIp(value);
        if (normalized === null)
            throw new Error(`Invalid DSH_SERVER_TRUSTED_PROXY_IPS entry "${raw}": expected a bare IPv4/IPv6 address (no port, CIDR or hostname).`);
        result.add(normalized);
    }
    return result;
}
function readSingleForwardedFor(req) {
    let value;
    let count = 0;
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
        if (raw[i].toLowerCase() !== 'x-forwarded-for')
            continue;
        count++;
        value = raw[i + 1];
    }
    if (count !== 1)
        throw new ApiError('INVALID_MESSAGE');
    return value;
}
/**
 * Resolve the address used for rate limiting. X-Forwarded-For is honored only
 * when the socket peer is a configured trusted proxy; that peer must send one
 * header holding exactly one IP literal, otherwise the request is rejected.
 */
export function clientAddress(req, trustedProxyIps) {
    const peer = normalizeIp(req.socket.remoteAddress ?? '');
    if (peer === null)
        throw new ApiError('INVALID_MESSAGE');
    if (!trustedProxyIps.has(peer))
        return peer;
    const forwarded = normalizeIp(readSingleForwardedFor(req));
    if (forwarded === null)
        throw new ApiError('INVALID_MESSAGE');
    return forwarded;
}
export function createRemoteServer(config) {
    if (!config.account.trim() || config.password.length < 12)
        throw new Error('DSH_SERVER_ACCOUNT and DSH_SERVER_PASSWORD (at least 12 characters) are required.');
    const url = new URL(config.publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        throw new Error('DSH_SERVER_PUBLIC_URL must be an HTTP(S) origin.');
    const trustedProxyIps = normalizeTrustedProxyIps(config.trustedProxyIps);
    const ice = config.ice ?? parseIceConfig({});
    const store = new Store(config.dataFile, {
        initialAccount: config.account.trim(),
        initialPassword: config.password,
        inviteCode: config.inviteCode ?? '',
        registrationEnabled: config.registrationEnabled ?? true,
    });
    const assets = readAssets();
    const sessions = new Map();
    const sessionAccounts = new Map();
    const limits = new Map();
    function rate(key, max) {
        for (const [k, v] of limits)
            if (v.until < Date.now())
                limits.delete(k);
        let entry = limits.get(key);
        if (!entry) {
            if (limits.size >= 4096)
                throw new ApiError('RATE_LIMITED', 429);
            entry = { count: 0, until: Date.now() + 60_000 };
            limits.set(key, entry);
        }
        if (++entry.count > max)
            throw new ApiError('RATE_LIMITED', 429);
    }
    function token(req) {
        const authorization = req.headers.authorization;
        if (authorization)
            return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        return /(?:^|;\s*)dsh_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    }
    /** Resolve a valid account session. The account is taken from the local
     * session→account map; isAdmin is read from the Store on every request so a
     * live role change takes effect without a new login. */
    function sessionAccount(req) {
        const key = hash(token(req));
        const expiresAt = sessions.get(key);
        if (expiresAt === undefined || expiresAt <= Date.now()) {
            sessions.delete(key);
            sessionAccounts.delete(key);
            throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401);
        }
        const account = sessionAccounts.get(key);
        if (account === undefined)
            throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401);
        return { account, isAdmin: store.isAdmin(account) };
    }
    function accountAuth(req) {
        return sessionAccount(req);
    }
    function adminAuth(req) {
        const info = sessionAccount(req);
        if (!info.isAdmin)
            throw new ApiError('ADMIN_REQUIRED', 403);
        if (!store.accountExists(info.account))
            throw new ApiError('ACCOUNT_DISABLED', 403);
        return info;
    }
    function deviceAuth(req) {
        if (!req.headers.authorization?.startsWith('Bearer '))
            throw new ApiError('AUTH_REQUIRED', 401);
        return store.authenticate(req.headers.authorization.slice(7));
    }
    function cookie(value, age) { return `dsh_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${url.protocol === 'https:' ? '; Secure' : ''}`; }
    const profile = (account, isAdmin) => ({ account, profile: { displayName: account }, isAdmin });
    /** Create a session bound to an account; prune expired sessions from both maps. */
    function createSession(account) {
        for (const [key, expires] of sessions)
            if (expires <= Date.now()) {
                sessions.delete(key);
                sessionAccounts.delete(key);
            }
        if (sessions.size >= 256)
            throw new ApiError('RATE_LIMITED', 429);
        const value = secret(), expiresAt = Date.now() + 8 * 3600_000;
        const key = hash(value);
        sessions.set(key, expiresAt);
        sessionAccounts.set(key, account);
        return { value, expiresAt };
    }
    const server = createServer({ requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        void route(req, res).catch(error => {
            if (res.headersSent || res.destroyed)
                return;
            const e = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_MESSAGE') : new ApiError('INTERNAL_ERROR', 500);
            if (e.status === 429)
                res.setHeader('Retry-After', '60');
            json(res, e.status, { error: { code: e.code, message: e.code, requestId: randomUUID(), retryable: e.status === 429 || e.status >= 500 } });
        });
    });
    const logger = new Logger('server', config.logLevel ?? 'info');
    // Normalize at this boundary as well: a programmatic caller may pass NaN,
    // Infinity or a negative value straight through the Config object.
    const timing = normalizeGatewayOptions({
        helloTimeoutMs: config.helloTimeoutMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        heartbeatDisconnectMs: config.heartbeatDisconnectMs,
        forceTerminateGraceMs: config.forceTerminateGraceMs,
    });
    const gateway = new Gateway(server, store, url.origin, {
        ...timing,
        maxFramesPerSec: normalizeMaxFramesPerSec(config.maxFramesPerSec),
        logLevel: config.logLevel,
        logger: logger.child('gateway'),
        turnEnabled: ice.turnUrls.length > 0,
    });
    function descriptor(d, owner) {
        const account = owner === undefined ? store.accountOfDevice(d.descriptor.deviceId) : owner;
        return { ...d.descriptor, membershipId: `account:${hash(account).slice(0, 16)}`, online: gateway.peers.has(d.descriptor.deviceId), lastSeenAt: d.lastSeenAt };
    }
    async function route(req, res) {
        const requestUrl = new URL(req.url ?? '/', url);
        const path = requestUrl.pathname;
        const method = req.method;
        if (req.headers.origin && req.headers.origin !== url.origin)
            throw new ApiError('AUTH_INVALID', 403);
        if (req.headers['sec-fetch-site'] === 'cross-site')
            throw new ApiError('AUTH_INVALID', 403);
        const staticAsset = path.startsWith('/assets/') || ['/icon.png', '/brand-whale.webp', '/landing-atmosphere.webp'].includes(path);
        // SPA fallback: any GET that is not API / WebSocket / health-check returns index.html.
        // Without this, refreshing a client route such as /app/remote hits the unknown-method branch and yields METHOD_NOT_FOUND.
        const spaRoute = method === 'GET' && !staticAsset && !path.startsWith('/api/') && !path.startsWith('/ws/') && !['/health', '/healthz', '/ready'].includes(path);
        if (method === 'GET' && (spaRoute || staticAsset)) {
            const name = staticAsset ? path.slice(1) : 'index.html';
            const asset = assets.get(name);
            if (!asset)
                throw new ApiError('METHOD_NOT_FOUND', 404);
            const contentType = name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'text/html; charset=utf-8';
            if (!staticAsset)
                res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Content-Type', contentType);
            res.end(asset);
            return;
        }
        if (method === 'GET' && (path === '/health' || path === '/healthz' || path === '/ready')) {
            json(res, 200, { status: 'ok' });
            return;
        }
        const client = clientAddress(req, trustedProxyIps);
        rate(`api:${client}`, 240);
        // ---- Multi-account registration and administration ----
        if (method === 'POST' && path === '/api/v1/auth/register') {
            rate(`register:${client}`, 20);
            const input = registerSchema.parse(await body(req));
            // Registration policy (enabled / invite code / duplicates) is enforced
            // inside the Store, so no extra error codes are invented here.
            const record = store.registerAccount(input.email, input.password, input.inviteCode);
            const session = createSession(record.account);
            res.setHeader('Set-Cookie', cookie(session.value, 8 * 3600));
            json(res, 200, { ...profile(record.account, record.isAdmin), token: session.value, expiresAt: session.expiresAt });
            return;
        }
        if (method === 'GET' && path === '/api/v1/auth/registration') {
            const policy = store.registrationPolicy();
            json(res, 200, { enabled: policy.registrationEnabled, inviteCodeRequired: policy.inviteCodeRequired });
            return;
        }
        if (method === 'GET' && path === '/api/v1/admin/config') {
            adminAuth(req);
            const policy = store.registrationPolicy();
            json(res, 200, { registrationEnabled: policy.registrationEnabled, inviteCodeRequired: policy.inviteCodeRequired });
            return;
        }
        if (method === 'POST' && path === '/api/v1/auth/password') {
            rate(`password:${client}`, 20);
            const { account } = sessionAccount(req);
            const input = passwordChangeSchema.parse(await body(req));
            store.setOwnPassword(account, input.oldPassword, input.newPassword);
            // Invalidate every web session for this account after a password change;
            // setOwnPassword already invalidated its device tokens.
            for (const [key, owner] of sessionAccounts)
                if (owner === account) {
                    sessions.delete(key);
                    sessionAccounts.delete(key);
                }
            res.setHeader('Set-Cookie', cookie('', 0));
            json(res, 200, { status: 'ok' });
            return;
        }
        if (method === 'GET' && path === '/api/v1/admin/accounts') {
            adminAuth(req);
            json(res, 200, { items: store.listAccounts() });
            return;
        }
        if (method === 'POST' && path === '/api/v1/admin/accounts') {
            adminAuth(req);
            const input = adminCreateAccountSchema.parse(await body(req));
            const record = store.createAccount(input.email, input.password, input.isAdmin ?? false);
            json(res, 200, { account: record.account, isAdmin: record.isAdmin });
            return;
        }
        if (method === 'POST' && path === '/api/v1/admin/accounts/password') {
            adminAuth(req);
            const input = adminAccountPasswordSchema.parse(await body(req));
            store.setAccountPassword(input.email, input.newPassword);
            for (const [key, owner] of sessionAccounts)
                if (owner === input.email) {
                    sessions.delete(key);
                    sessionAccounts.delete(key);
                }
            json(res, 200, { status: 'ok' });
            return;
        }
        if (method === 'POST' && path === '/api/v1/admin/accounts/disable') {
            adminAuth(req);
            const input = adminAccountDisableSchema.parse(await body(req));
            store.setAccountDisabled(input.email, input.disabled);
            if (input.disabled)
                for (const [key, owner] of sessionAccounts)
                    if (owner === input.email) {
                        sessions.delete(key);
                        sessionAccounts.delete(key);
                    }
            json(res, 200, { status: 'ok' });
            return;
        }
        if (method === 'DELETE' && path === '/api/v1/admin/accounts') {
            adminAuth(req);
            const input = adminAccountDeleteSchema.parse(await body(req));
            store.deleteAccount(input.email);
            for (const [key, owner] of sessionAccounts)
                if (owner === input.email) {
                    sessions.delete(key);
                    sessionAccounts.delete(key);
                }
            json(res, 200, { status: 'ok' });
            return;
        }
        if (method === 'GET' && path === '/api/v1/admin/devices') {
            adminAuth(req);
            const items = store.allDevices().map(d => {
                const { identityKey: _key, ...item } = descriptor(d, d.owner);
                return { ...item, owner: d.owner };
            });
            json(res, 200, { items });
            return;
        }
        if (method === 'DELETE' && path === '/api/v1/admin/devices') {
            adminAuth(req);
            const input = adminDeviceDeleteSchema.parse(await body(req));
            store.revoke(input.deviceId);
            json(res, 200, { status: 'ok' });
            return;
        }
        // ---- Existing routes ----
        if (method === 'POST' && path === '/api/v1/auth/login') {
            rate(`login:${client}`, 20);
            const credentials = loginSchema.parse(await body(req));
            const record = store.authenticateAccount(credentials.email, credentials.password);
            const session = createSession(record.account);
            res.setHeader('Set-Cookie', cookie(session.value, 8 * 3600));
            json(res, 200, { ...profile(record.account, record.isAdmin), token: session.value, expiresAt: session.expiresAt });
            return;
        }
        if (method === 'GET' && path === '/api/v1/auth/me') {
            const { account, isAdmin } = accountAuth(req);
            json(res, 200, profile(account, isAdmin));
            return;
        }
        if (method === 'POST' && path === '/api/v1/auth/logout') {
            const key = hash(token(req));
            sessions.delete(key);
            sessionAccounts.delete(key);
            res.setHeader('Set-Cookie', cookie('', 0));
            json(res, 200, { status: 'ok' });
            return;
        }
        if (method === 'GET' && path === '/api/v1/account/devices') {
            const { account } = accountAuth(req);
            json(res, 200, { items: store.devicesOfAccount(account).map(d => descriptor(d, account)), serverUrl: url.origin, transport: 'webrtc' });
            return;
        }
        if (method === 'POST' && (path === '/api/v1/devices/register' || path === '/api/v1/devices/register-owned-role')) {
            const source = path.endsWith('register-owned-role') ? deviceAuth(req) : undefined;
            const account = source ? store.accountOfDevice(source.descriptor.deviceId) : sessionAccount(req).account;
            const { device } = deviceRegistrationRequestSchema.parse(await body(req));
            if (source && (source.descriptor.deviceId === device.deviceId || source.descriptor.role === device.role))
                throw new ApiError('INVALID_MESSAGE', 409);
            // Re-registering an existing device refreshes its credentials; never let
            // one account rebind a device that already belongs to a different owner.
            const existing = store.allDevices().find(d => d.descriptor.deviceId === device.deviceId);
            if (existing && existing.owner !== account)
                throw new ApiError('MEMBERSHIP_REQUIRED', 403);
            const result = store.register(device);
            store.bindDevice(device.deviceId, account);
            json(res, 200, result);
            return;
        }
        if (method === 'POST' && path === '/api/v1/auth/refresh') {
            const data = deviceRefreshRequestSchema.parse(await body(req));
            json(res, 200, store.refresh(data.deviceId, data.refreshToken));
            return;
        }
        if (method === 'DELETE' && path === '/api/v1/devices/self') {
            store.revoke(deviceAuth(req).descriptor.deviceId);
            json(res, 200, { status: 'revoked' });
            return;
        }
        if (method === 'GET' && path === '/api/v1/me') {
            json(res, 200, descriptor(deviceAuth(req)));
            return;
        }
        if (method === 'GET' && path === '/api/v1/turn/credentials') {
            const source = deviceAuth(req);
            const connectionId = requestUrl.searchParams.get('connection_id') ?? '';
            if (!connectionId || connectionId.length > 128)
                throw new ApiError('INVALID_MESSAGE');
            if (!gateway.authorizeIce(source.descriptor.deviceId, connectionId))
                throw new ApiError('CONNECTION_NOT_FOUND', 404);
            json(res, 200, { iceServers: buildIceServers(ice, source.descriptor.deviceId) });
            return;
        }
        if (method === 'GET' && path === '/api/v1/devices') {
            const source = deviceAuth(req);
            if (source.descriptor.role !== 'client')
                throw new ApiError('MEMBERSHIP_REQUIRED', 403);
            const accountOfSource = store.accountOfDevice(source.descriptor.deviceId);
            const items = store.devicesOfAccount(accountOfSource).filter(d => d.descriptor.role === 'host').map(d => {
                const { identityKey: _key, ...item } = descriptor(d, accountOfSource);
                return item;
            });
            json(res, 200, { items, nextCursor: null });
            return;
        }
        const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path);
        if (method === 'POST' && renameMatch) {
            const { account } = accountAuth(req);
            const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(await body(req));
            if (store.accountOfDevice(renameMatch[1]) !== account)
                throw new ApiError('MEMBERSHIP_REQUIRED', 403);
            store.rename(renameMatch[1], name);
            json(res, 200, descriptor(store.get(renameMatch[1])));
            return;
        }
        const match = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path);
        if (method === 'GET' && match) {
            const source = deviceAuth(req), target = store.get(match[1]);
            if (source.descriptor.role === target.descriptor.role)
                throw new ApiError('MEMBERSHIP_REQUIRED', 403);
            if (store.accountOfDevice(source.descriptor.deviceId) !== store.accountOfDevice(target.descriptor.deviceId))
                throw new ApiError('MEMBERSHIP_REQUIRED', 403);
            const d = descriptor(target);
            json(res, 200, match[2] ? { deviceId: d.deviceId, online: d.online, lastSeenAt: d.lastSeenAt } : d);
            return;
        }
        throw new ApiError('METHOD_NOT_FOUND', 404);
    }
    return { server, store, gateway, logger, close: async () => { gateway.close(); server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
}
//# sourceMappingURL=server.js.map