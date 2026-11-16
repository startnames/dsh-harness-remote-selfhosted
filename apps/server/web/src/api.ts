export interface Account { account: string; isAdmin: boolean }
export interface Device {
  deviceId: string; name: string; role: 'host' | 'client'; platform: string;
  clientVersion: string; harnessVersion?: string; online: boolean; lastSeenAt?: number;
}
export interface DeviceList { items: Device[]; serverUrl: string; transport: string }
export interface RegistrationPolicy { enabled: boolean; inviteCodeRequired: boolean }
export interface AdminConfig { registrationEnabled: boolean; inviteCodeRequired: boolean }
export interface AdminAccount {
  account: string; isAdmin: boolean; disabled: boolean; createdAt: number | string; deviceCount: number;
}
export interface AdminAccountList { items: AdminAccount[] }
export interface AdminDevice extends Device { owner: string }
export interface AdminDeviceList { items: AdminDevice[] }
export class RequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
export async function api<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    })
  } catch { throw new RequestError('连接失败，请重试。', 0) }
  const data = (await response.json()) as { error?: { code?: string } }
  if (!response.ok) {
    const messages: Record<string, string> = {
      AUTH_INVALID: '账号或密码错误，请重试。', ACCOUNT_AUTH_REQUIRED: '登录已过期，请重新登录。', RATE_LIMITED: '请求频繁，请稍后重试。',
      ACCOUNT_DISABLED: '账号已被禁用', ADMIN_REQUIRED: '需要管理员权限', INVITE_CODE_INVALID: '邀请码无效或注册已关闭',
      ACCOUNT_EXISTS: '该账号已存在', WEAK_PASSWORD: '密码至少 12 位',
    }
    const code = data.error?.code ?? ''
    throw new RequestError(messages[code] ?? '请求失败，请稍后重试。', response.status)
  }
  return data as unknown as T
}
export function apiDelete<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, body, 'DELETE')
}
