import { type AccountDeviceDescriptor } from '@dsh-remote/protocol';
import { z } from 'zod';
export declare class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status?: number);
}
export declare const hash: (value: string) => string;
export declare const secret: () => string;
export declare const equal: (left: string, right: string) => boolean;
declare const savedDeviceSchema: z.ZodObject<{
    descriptor: z.ZodType<AccountDeviceDescriptor, unknown, z.core.$ZodTypeInternals<AccountDeviceDescriptor, unknown>>;
    owner: z.ZodString;
    revoked: z.ZodBoolean;
    lastSeenAt: z.ZodNumber;
}, z.core.$strip>;
declare const accountSchema: z.ZodObject<{
    account: z.ZodString;
    isAdmin: z.ZodBoolean;
    disabled: z.ZodBoolean;
    createdAt: z.ZodNumber;
    salt: z.ZodString;
    verifier: z.ZodString;
}, z.core.$strip>;
export type AccountRecord = z.infer<typeof accountSchema>;
export type SavedDevice = z.infer<typeof savedDeviceSchema>;
export interface StoreOptions {
    initialAccount: string;
    initialPassword: string;
    inviteCode?: string;
    registrationEnabled?: boolean;
}
/**
 * Single-process, multi-account store. Only token digests, password verifiers
 * and public identities reach disk. Every device is owned by exactly one
 * account, so account isolation is enforced here rather than by convention.
 */
export declare class Store {
    private readonly file;
    private state;
    onInvalidate: (id: string) => void;
    constructor(file: string, options: StoreOptions | string, legacyPassword?: string);
    private load;
    private save;
    registrationPolicy(): {
        registrationEnabled: boolean;
        inviteCodeRequired: boolean;
    };
    private accountRecord;
    authenticateAccount(email: string, password: string): AccountRecord;
    registerAccount(email: string, password: string, inviteCode: string): AccountRecord;
    createAccount(email: string, password: string, isAdmin?: boolean): AccountRecord;
    listAccounts(): Array<{
        account: string;
        isAdmin: boolean;
        disabled: boolean;
        createdAt: number;
        deviceCount: number;
    }>;
    isAdmin(email: string): boolean;
    setAccountDisabled(email: string, disabled: boolean): void;
    setAccountPassword(email: string, newPassword: string): void;
    setOwnPassword(email: string, oldPassword: string, newPassword: string): void;
    deleteAccount(email: string): void;
    private invalidateAccountDevices;
    get(id: string): SavedDevice;
    /** Global list. Retained for compatibility; prefer devicesOfAccount for authorization. */
    list(): SavedDevice[];
    devicesOfAccount(email: string): SavedDevice[];
    allDevices(): Array<SavedDevice & {
        owner: string;
    }>;
    accountOfDevice(id: string): string;
    /** True only when the owning account exists and is enabled. */
    accountExists(email: string): boolean;
    /** Bind a freshly registered device to its owning account. */
    bindDevice(id: string, email: string): void;
    /** Devices registered by a device-authenticated caller inherit the source owner. */
    ownerOfAuthenticatedDevice(id: string): string;
    register(descriptor: AccountDeviceDescriptor, owner?: string): ReturnType<Store['issue']>;
    /** Owner used by legacy callers that register without an explicit account. */
    private get legacyOwner();
    revoke(id: string): void;
    deleteDevice(id: string): void;
    rename(id: string, name: string): void;
    touch(id: string, clientVersion?: string, harnessVersion?: string): void;
    private issue;
    authenticate(token: string): SavedDevice;
    refresh(deviceId: string, token: string): {
        accessToken: string;
        refreshToken: string;
        accessTokenExpiresAt: number;
        refreshTokenExpiresAt: number;
    };
    invalidate(deviceId: string): void;
}
export {};
//# sourceMappingURL=store.d.ts.map