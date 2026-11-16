import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiError, Store } from '../src/store.js'

let dir: string
let file: string
const ADMIN = 'owner@example.com'
const ADMIN_PASS = 'initial-admin-password'
const INVITE = 'join-me-2026'

function makeStore(overrides: Partial<{ inviteCode: string; registrationEnabled: boolean }> = {}) {
  return new Store(file, {
    initialAccount: ADMIN,
    initialPassword: ADMIN_PASS,
    inviteCode: INVITE,
    registrationEnabled: true,
    ...overrides,
  })
}

function expectCode(fn: () => unknown, code: string) {
  try { fn(); throw new Error(`expected ${code} but no error thrown`) }
  catch (error) {
    if (error instanceof ApiError) expect(error.code).toBe(code)
    else throw error
  }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-multi-')); file = join(dir, 'state.json') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('multi-account store', () => {
  it('bootstraps the env account as a non-disableable admin', () => {
    const s = makeStore()
    const list = s.listAccounts()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ account: ADMIN, isAdmin: true, disabled: false, deviceCount: 0 })
    expect(s.isAdmin(ADMIN)).toBe(true)
    expect(s.authenticateAccount(ADMIN, ADMIN_PASS).isAdmin).toBe(true)
    expectCode(() => s.authenticateAccount(ADMIN, 'wrong'), 'AUTH_INVALID')
  })

  it('reload keeps accounts, devices and settings', () => {
    const s = makeStore()
    s.registerAccount('alice@example.com', 'alice-password-123', INVITE)
    const s2 = makeStore()
    expect(s2.listAccounts()).toHaveLength(2)
    expect(s2.registrationPolicy().inviteCodeRequired).toBe(true)
    expect(s2.authenticateAccount('alice@example.com', 'alice-password-123').account).toBe('alice@example.com')
  })

  it('rotating the bootstrap env password takes effect on restart', () => {
    makeStore()
    const rotated = new Store(file, { initialAccount: ADMIN, initialPassword: 'rotated-admin-password', inviteCode: INVITE })
    expectCode(() => rotated.authenticateAccount(ADMIN, ADMIN_PASS), 'AUTH_INVALID')
    expect(rotated.authenticateAccount(ADMIN, 'rotated-admin-password').isAdmin).toBe(true)
  })

  describe('registration', () => {
    it('requires the invite code when configured', () => {
      const s = makeStore()
      expectCode(() => s.registerAccount('a@example.com', 'password-123456', ''), 'INVITE_CODE_INVALID')
      expectCode(() => s.registerAccount('a@example.com', 'password-123456', 'wrong'), 'INVITE_CODE_INVALID')
      expect(s.registerAccount('a@example.com', 'password-123456', INVITE).account).toBe('a@example.com')
    })

    it('rejects duplicates, weak passwords and closed registration', () => {
      const s = makeStore()
      s.registerAccount('a@example.com', 'password-123456', INVITE)
      expectCode(() => s.registerAccount('a@example.com', 'password-123456', INVITE), 'ACCOUNT_EXISTS')
      expectCode(() => s.registerAccount('b@example.com', 'short', INVITE), 'WEAK_PASSWORD')
      const closed = makeStore({ registrationEnabled: false })
      expectCode(() => closed.registerAccount('c@example.com', 'password-123456', INVITE), 'INVITE_CODE_INVALID')
    })

    it('registered accounts are non-admin and can sign in', () => {
      const s = makeStore()
      const r = s.registerAccount('a@example.com', 'password-123456', INVITE)
      expect(r.isAdmin).toBe(false)
      expect(s.authenticateAccount('a@example.com', 'password-123456').isAdmin).toBe(false)
    })
  })

  describe('account management', () => {
    it('lists, creates, disables, resets password and deletes', () => {
      const s = makeStore()
      s.createAccount('bob@example.com', 'bob-password-1234', false)
      expect(s.listAccounts()).toHaveLength(2)

      s.setAccountDisabled('bob@example.com', true)
      expectCode(() => s.authenticateAccount('bob@example.com', 'bob-password-1234'), 'ACCOUNT_DISABLED')
      s.setAccountDisabled('bob@example.com', false)
      expect(s.authenticateAccount('bob@example.com', 'bob-password-1234').account).toBe('bob@example.com')

      s.setAccountPassword('bob@example.com', 'new-bob-password-9')
      expectCode(() => s.authenticateAccount('bob@example.com', 'bob-password-1234'), 'AUTH_INVALID')
      expect(s.authenticateAccount('bob@example.com', 'new-bob-password-9').account).toBe('bob@example.com')

      s.deleteAccount('bob@example.com')
      expect(s.listAccounts()).toHaveLength(1)
      expectCode(() => s.authenticateAccount('bob@example.com', 'new-bob-password-9'), 'AUTH_INVALID')
    })

    it('cannot disable or delete the bootstrap admin', () => {
      const s = makeStore()
      expectCode(() => s.setAccountDisabled(ADMIN, true), 'INVALID_MESSAGE')
      expectCode(() => s.deleteAccount(ADMIN), 'INVALID_MESSAGE')
    })

    it('own-password change verifies the old password', () => {
      const s = makeStore()
      expectCode(() => s.setOwnPassword(ADMIN, 'wrong', 'new-password-1234'), 'AUTH_INVALID')
      s.setOwnPassword(ADMIN, ADMIN_PASS, 'new-password-1234')
      expect(s.authenticateAccount(ADMIN, 'new-password-1234').account).toBe(ADMIN)
    })
  })

  describe('device ownership and isolation', () => {
    const descriptor = (id: string, role: 'host' | 'client' = 'host') => ({
      deviceId: id, identityKey: `key-${id}`, name: `device-${id}`, role,
      platform: 'linux', clientVersion: '0.6.5',
    })

    it('binds devices to their registering account', () => {
      const s = makeStore()
      s.registerAccount('alice@example.com', 'alice-password-123', INVITE)
      s.register(descriptor('h1'), ADMIN)
      s.register(descriptor('h2'), 'alice@example.com')
      expect(s.accountOfDevice('h1')).toBe(ADMIN)
      expect(s.accountOfDevice('h2')).toBe('alice@example.com')
      expect(s.devicesOfAccount(ADMIN).map(d => d.descriptor.deviceId)).toEqual(['h1'])
      expect(s.devicesOfAccount('alice@example.com').map(d => d.descriptor.deviceId)).toEqual(['h2'])
      expect(s.allDevices()).toHaveLength(2)
    })

    it('a re-registered device keeps its original owner', () => {
      const s = makeStore()
      s.register(descriptor('h1'), ADMIN)
      s.register(descriptor('h1'), 'someone-else@example.com')
      expect(s.accountOfDevice('h1')).toBe(ADMIN)
    })

    it('disabling an account invalidates its device tokens', () => {
      const s = makeStore()
      s.createAccount('bob@example.com', 'bob-password-1234')
      const issued = s.register(descriptor('h1'), 'bob@example.com')
      expect(s.authenticate(issued.accessToken).descriptor.deviceId).toBe('h1')
      s.setAccountDisabled('bob@example.com', true)
      expectCode(() => s.authenticate(issued.accessToken), 'AUTH_INVALID')
      expect(s.accountExists('bob@example.com')).toBe(false)
    })

    it('deleting an account removes its devices', () => {
      const s = makeStore()
      s.createAccount('bob@example.com', 'bob-password-1234')
      s.register(descriptor('h1'), 'bob@example.com')
      expect(s.allDevices()).toHaveLength(1)
      s.deleteAccount('bob@example.com')
      expect(s.allDevices()).toHaveLength(0)
    })
  })
})
