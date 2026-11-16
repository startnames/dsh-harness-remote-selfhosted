import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { accountDeviceDescriptorSchema } from '@dsh-remote/protocol';
import { z } from 'zod';
export class ApiError extends Error {
    code;
    status;
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const equal = (left, right) => timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
const tokenSchema = z.object({
    kind: z.enum(['access', 'refresh']), deviceId: z.string(), expires: z.number(), used: z.boolean(),
    recovery: z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), accessExpires: z.number().int().positive() }).optional(),
});
const savedDeviceSchema = z.object({
    descriptor: accountDeviceDescriptorSchema,
    owner: z.string().min(1),
    revoked: z.boolean(),
    lastSeenAt: z.number(),
});
const accountSchema = z.object({
    account: z.string().min(1).max(254),
    isAdmin: z.boolean(),
    disabled: z.boolean(),
    createdAt: z.number().int().nonnegative(),
    salt: z.string(),
    verifier: z.string(),
});
const stateSchema = z.object({
    version: z.literal(2),
    accounts: z.record(z.string(), accountSchema),
    devices: z.record(z.string(), savedDeviceSchema),
    tokens: z.record(z.string(), tokenSchema),
    settings: z.object({ registrationEnabled: z.boolean(), inviteCode: z.string() }),
});
/** Password verifier: scrypt with a per-account random salt. */
function verifierOf(password, salt) {
    return scryptSync(password, salt, 32).toString('hex');
}
/** Domain-separated HMACs keyed by the presented bearer, NOT its stored digest. */
function successor(token, nonce, deviceId) {
    const derive = (kind) => createHmac('sha256', token)
        .update(JSON.stringify(['ds-harness-remote/refresh/v1', deviceId, nonce, kind])).digest('base64url');
    return { accessToken: derive('access'), refreshToken: derive('refresh') };
}
/**
 * Single-process, multi-account store. Only token digests, password verifiers
 * and public identities reach disk. Every device is owned by exactly one
 * account, so account isolation is enforced here rather than by convention.
 */
export class Store {
    file;
    state;
    onInvalidate = () => { };
    constructor(file, options, legacyPassword) {
        this.file = file;
        // Backward compatibility with the original single-account constructor:
        // new Store(file, account, password). Existing tests and callers use it.
        const resolved = typeof options === 'string'
            ? { initialAccount: options, initialPassword: legacyPassword ?? '' }
            : options;
        const initialAccount = resolved.initialAccount.trim();
        if (!initialAccount)
            throw new Error('initialAccount is required');
        const loaded = this.load();
        // Snapshot account names before mutating this.state: loaded and this.state
        // share the same object, so the rotation check below must use the snapshot.
        const loadedAccountNames = Object.keys(loaded?.accounts ?? {});
        this.state = loaded ?? {
            version: 2,
            accounts: {},
            devices: {},
            tokens: {},
            settings: {
                registrationEnabled: resolved.registrationEnabled ?? true,
                inviteCode: resolved.inviteCode ?? '',
            },
        };
        // The bootstrap account is always an admin and is never disabled. Its
        // password is re-derived from the env var on every start, so changing the
        // env var rotates it without needing a management API call. Changing the
        // bootstrap password or account name invalidates that account's device
        // tokens — the single-account behavior the original Store guaranteed.
        const previous = loaded?.accounts[initialAccount];
        // Generate the salt exactly once: the saved salt and the password verifier
        // must be derived from the same value, otherwise the first login fails.
        const salt = previous?.salt ?? secret();
        const nextVerifier = verifierOf(resolved.initialPassword, salt);
        const passwordChanged = previous !== undefined && !equal(previous.verifier, nextVerifier);
        this.state.accounts[initialAccount] = {
            account: initialAccount,
            isAdmin: true,
            disabled: false,
            createdAt: previous?.createdAt ?? Date.now(),
            salt,
            verifier: nextVerifier,
        };
        if (passwordChanged) {
            for (const [id, device] of Object.entries(this.state.devices)) {
                if (device.owner === initialAccount)
                    this.invalidate(id);
            }
        }
        // Legacy single-account callers change the configured account name to
        // rotate the whole installation. In that case no account of that name
        // exists yet and it is the only account: drop all device tokens so
        // credentials from the previous installation cannot be refreshed.
        if (loaded && loadedAccountNames.length === 1 && !loadedAccountNames.includes(initialAccount)) {
            // Account rotation on a legacy single-account installation: drop the
            // previous installation's tokens so they cannot be refreshed anymore.
            this.state.tokens = {};
        }
        if (loaded) {
            this.state.settings.registrationEnabled = resolved.registrationEnabled ?? this.state.settings.registrationEnabled;
            this.state.settings.inviteCode = resolved.inviteCode ?? this.state.settings.inviteCode;
        }
        this.save();
    }
    load() {
        if (!existsSync(this.file))
            return undefined;
        const raw = JSON.parse(readFileSync(this.file, 'utf8'));
        // Migrate the legacy single-account schema (version 1). All existing
        // devices belong to the bootstrap account, which becomes its admin.
        if (isLegacyState(raw))
            return migrateLegacy(raw);
        return stateSchema.parse(raw);
    }
    save() {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
        renameSync(tmp, this.file);
    }
    // ---- accounts -----------------------------------------------------------
    registrationPolicy() {
        return {
            registrationEnabled: this.state.settings.registrationEnabled,
            inviteCodeRequired: this.state.settings.inviteCode.trim().length > 0,
        };
    }
    accountRecord(email) {
        const record = this.state.accounts[email];
        if (!record)
            throw new ApiError('AUTH_INVALID', 401);
        return record;
    }
    authenticateAccount(email, password) {
        const record = this.accountRecord(email.trim());
        if (record.disabled)
            throw new ApiError('ACCOUNT_DISABLED', 403);
        if (!equal(verifierOf(password, record.salt), record.verifier))
            throw new ApiError('AUTH_INVALID', 401);
        return record;
    }
    registerAccount(email, password, inviteCode) {
        const name = email.trim();
        if (!this.state.settings.registrationEnabled)
            throw new ApiError('INVITE_CODE_INVALID', 403);
        const required = this.state.settings.inviteCode;
        if (required && !equal(inviteCode, required))
            throw new ApiError('INVITE_CODE_INVALID', 403);
        if (this.state.accounts[name])
            throw new ApiError('ACCOUNT_EXISTS', 409);
        if (password.length < 12)
            throw new ApiError('WEAK_PASSWORD', 400);
        if (Object.keys(this.state.accounts).length >= 256)
            throw new ApiError('RATE_LIMITED', 429);
        const salt = secret();
        const record = {
            account: name, isAdmin: false, disabled: false, createdAt: Date.now(),
            salt, verifier: verifierOf(password, salt),
        };
        this.state.accounts[name] = record;
        this.save();
        return record;
    }
    createAccount(email, password, isAdmin = false) {
        const name = email.trim();
        if (!name)
            throw new ApiError('INVALID_MESSAGE');
        if (password.length < 12)
            throw new ApiError('WEAK_PASSWORD', 400);
        if (this.state.accounts[name])
            throw new ApiError('ACCOUNT_EXISTS', 409);
        if (Object.keys(this.state.accounts).length >= 256)
            throw new ApiError('RATE_LIMITED', 429);
        const salt = secret();
        const record = {
            account: name, isAdmin, disabled: false, createdAt: Date.now(),
            salt, verifier: verifierOf(password, salt),
        };
        this.state.accounts[name] = record;
        this.save();
        return record;
    }
    listAccounts() {
        return Object.values(this.state.accounts).map(record => ({
            account: record.account,
            isAdmin: record.isAdmin,
            disabled: record.disabled,
            createdAt: record.createdAt,
            deviceCount: Object.values(this.state.devices).filter(d => d.owner === record.account && !d.revoked).length,
        })).sort((a, b) => a.createdAt - b.createdAt);
    }
    isAdmin(email) { return this.state.accounts[email]?.isAdmin === true; }
    setAccountDisabled(email, disabled) {
        const record = this.accountRecord(email);
        if (record.isAdmin)
            throw new ApiError('INVALID_MESSAGE', 400);
        record.disabled = disabled;
        if (disabled)
            this.invalidateAccountDevices(email);
        this.save();
    }
    setAccountPassword(email, newPassword) {
        if (newPassword.length < 12)
            throw new ApiError('WEAK_PASSWORD', 400);
        const record = this.accountRecord(email);
        const salt = secret();
        record.salt = salt;
        record.verifier = verifierOf(newPassword, salt);
        this.invalidateAccountDevices(email);
        this.save();
    }
    setOwnPassword(email, oldPassword, newPassword) {
        const record = this.authenticateAccount(email, oldPassword);
        if (newPassword.length < 12)
            throw new ApiError('WEAK_PASSWORD', 400);
        const salt = secret();
        record.salt = salt;
        record.verifier = verifierOf(newPassword, salt);
        this.invalidateAccountDevices(email);
        this.save();
    }
    deleteAccount(email) {
        const record = this.accountRecord(email);
        if (record.isAdmin)
            throw new ApiError('INVALID_MESSAGE', 400);
        for (const [id, device] of Object.entries(this.state.devices)) {
            if (device.owner === email) {
                delete this.state.devices[id];
                this.invalidate(id);
            }
        }
        delete this.state.accounts[email];
        this.save();
    }
    invalidateAccountDevices(email) {
        for (const [id, device] of Object.entries(this.state.devices)) {
            if (device.owner === email)
                this.invalidate(id);
        }
    }
    // ---- devices ------------------------------------------------------------
    get(id) {
        const d = Object.hasOwn(this.state.devices, id) ? this.state.devices[id] : undefined;
        if (!d)
            throw new ApiError('DEVICE_NOT_FOUND', 404);
        if (d.revoked)
            throw new ApiError('DEVICE_REVOKED', 403);
        return d;
    }
    /** Global list. Retained for compatibility; prefer devicesOfAccount for authorization. */
    list() { return Object.values(this.state.devices).filter(d => !d.revoked); }
    devicesOfAccount(email) {
        return Object.values(this.state.devices).filter(d => d.owner === email && !d.revoked);
    }
    allDevices() {
        return Object.values(this.state.devices).filter(d => !d.revoked)
            .map(d => ({ ...d, owner: d.owner }));
    }
    accountOfDevice(id) { return this.get(id).owner; }
    /** True only when the owning account exists and is enabled. */
    accountExists(email) {
        const record = this.state.accounts[email];
        return record !== undefined && !record.disabled;
    }
    /** Bind a freshly registered device to its owning account. */
    bindDevice(id, email) {
        const d = this.state.devices[id];
        if (!d)
            throw new ApiError('DEVICE_NOT_FOUND', 404);
        if (!this.state.accounts[email])
            throw new ApiError('AUTH_INVALID', 401);
        d.owner = email;
        this.save();
    }
    /** Devices registered by a device-authenticated caller inherit the source owner. */
    ownerOfAuthenticatedDevice(id) { return this.get(id).owner; }
    register(descriptor, owner) {
        const old = this.state.devices[descriptor.deviceId];
        if (old?.revoked)
            throw new ApiError('DEVICE_REVOKED', 403);
        if (old && (old.descriptor.identityKey !== descriptor.identityKey || old.descriptor.role !== descriptor.role))
            throw new ApiError('PEER_IDENTITY_MISMATCH', 409);
        if (!old && Object.keys(this.state.devices).length >= 256)
            throw new ApiError('RATE_LIMITED', 429);
        const resolvedOwner = old?.owner ?? owner ?? this.legacyOwner;
        this.state.devices[descriptor.deviceId] = { descriptor, owner: resolvedOwner, revoked: false, lastSeenAt: old?.lastSeenAt ?? 0 };
        this.invalidate(descriptor.deviceId);
        return this.issue(descriptor.deviceId);
    }
    /** Owner used by legacy callers that register without an explicit account. */
    get legacyOwner() {
        const first = Object.values(this.state.accounts)[0];
        if (!first)
            throw new ApiError('AUTH_INVALID', 401);
        return first.account;
    }
    revoke(id) { this.get(id).revoked = true; this.invalidate(id); }
    deleteDevice(id) {
        this.get(id);
        delete this.state.devices[id];
        this.invalidate(id);
        this.save();
    }
    rename(id, name) {
        this.get(id).descriptor.name = name;
        this.save();
    }
    touch(id, clientVersion, harnessVersion) {
        const d = this.get(id);
        d.lastSeenAt = Date.now();
        if (clientVersion)
            d.descriptor.clientVersion = clientVersion.slice(0, 64);
        if (d.descriptor.role === 'host' && harnessVersion)
            d.descriptor.harnessVersion = harnessVersion.slice(0, 64);
        this.save();
    }
    // ---- tokens -------------------------------------------------------------
    issue(deviceId, refreshTokenExpiresAt = Date.now() + 30 * 86400_000, previous) {
        const tokens = { ...this.state.tokens };
        for (const [key, value] of Object.entries(tokens))
            if (value.expires <= Date.now())
                delete tokens[key];
        if (Object.keys(tokens).length + 2 > 16384)
            throw new ApiError('RATE_LIMITED', 429);
        const accessTokenExpiresAt = Date.now() + 60 * 60_000;
        const nonce = secret();
        const { accessToken, refreshToken } = previous
            ? successor(previous.token, nonce, deviceId)
            : { accessToken: secret(), refreshToken: secret() };
        if (previous)
            tokens[hash(previous.token)] = {
                ...previous.record, used: true, recovery: { nonce, accessExpires: accessTokenExpiresAt },
            };
        tokens[hash(accessToken)] = { kind: 'access', deviceId, expires: accessTokenExpiresAt, used: false };
        tokens[hash(refreshToken)] = { kind: 'refresh', deviceId, expires: refreshTokenExpiresAt, used: false };
        const before = this.state.tokens;
        this.state.tokens = tokens;
        try {
            this.save();
        }
        catch (error) {
            this.state.tokens = before;
            throw error;
        }
        return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt };
    }
    authenticate(token) {
        const record = this.state.tokens[hash(token)];
        if (!record || record.kind !== 'access')
            throw new ApiError('AUTH_INVALID', 401);
        if (record.expires <= Date.now())
            throw new ApiError('TOKEN_EXPIRED', 401);
        return this.get(record.deviceId);
    }
    refresh(deviceId, token) {
        this.get(deviceId);
        const record = this.state.tokens[hash(token)];
        if (!record || record.kind !== 'refresh' || record.deviceId !== deviceId)
            throw new ApiError('AUTH_INVALID', 401);
        if (record.expires <= Date.now())
            throw new ApiError('TOKEN_EXPIRED', 401);
        if (!record.used)
            return this.issue(deviceId, record.expires, { token, record });
        if (!record.recovery)
            throw new ApiError('AUTH_INVALID', 401);
        const pair = successor(token, record.recovery.nonce, deviceId);
        const next = this.state.tokens[hash(pair.refreshToken)];
        if (!next || next.kind !== 'refresh' || next.deviceId !== deviceId || next.expires !== record.expires) {
            throw new ApiError('INTERNAL_ERROR', 503);
        }
        if (next.used)
            throw new ApiError('AUTH_INVALID', 401);
        const access = this.state.tokens[hash(pair.accessToken)];
        if (access ? access.kind !== 'access' || access.deviceId !== deviceId || access.expires !== record.recovery.accessExpires
            : record.recovery.accessExpires > Date.now())
            throw new ApiError('INTERNAL_ERROR', 503);
        return { ...pair, accessTokenExpiresAt: record.recovery.accessExpires, refreshTokenExpiresAt: next.expires };
    }
    invalidate(deviceId) {
        for (const [key, value] of Object.entries(this.state.tokens))
            if (value.deviceId === deviceId)
                delete this.state.tokens[key];
        this.onInvalidate(deviceId);
        this.save();
    }
}
/** Legacy single-account schema, kept only for migration. */
const legacyStateSchema = z.object({
    version: z.literal(1),
    account: z.string(),
    salt: z.string(),
    verifier: z.string(),
    devices: z.record(z.string(), z.object({ descriptor: accountDeviceDescriptorSchema, revoked: z.boolean(), lastSeenAt: z.number() })),
    tokens: z.record(z.string(), tokenSchema),
});
function isLegacyState(value) {
    return typeof value === 'object' && value !== null && value.version === 1;
}
function migrateLegacy(raw) {
    const parsed = legacyStateSchema.parse(raw);
    const account = parsed.account;
    return {
        version: 2,
        accounts: {
            [account]: {
                account, isAdmin: true, disabled: false, createdAt: Date.now(),
                salt: parsed.salt, verifier: parsed.verifier,
            },
        },
        devices: Object.fromEntries(Object.entries(parsed.devices).map(([id, d]) => [id, { ...d, owner: account }])),
        tokens: parsed.tokens,
        settings: { registrationEnabled: true, inviteCode: '' },
    };
}
//# sourceMappingURL=store.js.map