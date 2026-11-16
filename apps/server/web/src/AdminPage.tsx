// Account administration page; follows the product topbar/card style of DevicesPage.tsx.
import { Alert, Button, Card, Checkbox, Form, Input, Layout, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import type { TableColumnsType } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, apiDelete, RequestError, type Account, type AdminAccount, type AdminAccountList, type AdminConfig, type AdminDevice, type AdminDeviceList } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'

const { Paragraph, Text, Title } = Typography
const platformNames: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux', android: 'Android' }

interface CreateValues { email: string; password: string; isAdmin: boolean }
interface ResetValues { newPassword: string; confirmPassword: string }
interface OwnPasswordValues { oldPassword: string; newPassword: string; confirmPassword: string }

function formatTime(value: number | string): string {
  if (value === '' || value === 0 || value === undefined || value === null) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
}

export function AdminPage({ account, onSignedOut, onBack }: { account: Account; onSignedOut: () => void; onBack: () => void }) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [config, setConfig] = useState<AdminConfig>()
  const [loading, setLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [resetTarget, setResetTarget] = useState<AdminAccount>()
  const [createForm] = Form.useForm<CreateValues>()
  const [resetForm] = Form.useForm<ResetValues>()
  const [ownPasswordForm] = Form.useForm<OwnPasswordValues>()

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [accountData, deviceData, configData] = await Promise.all([
        api<AdminAccountList>('/admin/accounts'),
        api<AdminDeviceList>('/admin/devices'),
        api<AdminConfig>('/admin/config'),
      ])
      setAccounts(accountData.items); setDevices(deviceData.items); setConfig(configData)
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) onSignedOut()
      else setError(err instanceof Error ? err.message : '加载失败，请重试。')
    } finally { setLoading(false) }
  }, [onSignedOut])
  useEffect(() => { void load() }, [load])

  function startAction(key: string) { setBusy(key); setError(''); setSuccess('') }
  function finishAction(message: string) { setBusy(''); setSuccess(message) }
  function failAction(err: unknown, fallback: string) { setBusy(''); setError(err instanceof Error ? err.message : fallback) }

  async function logout() {
    setLoggingOut(true)
    try { await api('/auth/logout', {}); onSignedOut() }
    catch (err) { setError(err instanceof Error ? err.message : '退出失败，请重试。') }
    finally { setLoggingOut(false) }
  }

  async function createAccount(values: CreateValues) {
    startAction('create')
    try {
      await api('/admin/accounts', { email: values.email.trim(), password: values.password, isAdmin: values.isAdmin ?? false })
      createForm.resetFields(); await load(); finishAction('账号创建成功')
    } catch (err) { failAction(err, '创建账号失败，请重试。') }
  }

  function openReset(record: AdminAccount) { resetForm.resetFields(); setResetTarget(record) }
  async function submitReset(values: ResetValues) {
    if (!resetTarget) return
    startAction('reset')
    try {
      await api('/admin/accounts/password', { email: resetTarget.account, newPassword: values.newPassword })
      setResetTarget(undefined); await load(); finishAction('密码已重置')
    } catch (err) { failAction(err, '重置密码失败，请重试。') }
  }

  async function toggleDisable(record: AdminAccount, disabled: boolean) {
    startAction(`disable:${record.account}`)
    try {
      await api('/admin/accounts/disable', { email: record.account, disabled })
      await load(); finishAction(disabled ? '账号已禁用' : '账号已启用')
    } catch (err) { failAction(err, '操作失败，请重试。') }
  }

  async function deleteAccount(email: string) {
    startAction(`delete-account:${email}`)
    try {
      await apiDelete('/admin/accounts', { email })
      await load(); finishAction('账号已删除')
    } catch (err) { failAction(err, '删除账号失败，请重试。') }
  }

  async function deleteDevice(deviceId: string) {
    startAction(`delete-device:${deviceId}`)
    try {
      await apiDelete('/admin/devices', { deviceId })
      await load(); finishAction('设备已删除')
    } catch (err) { failAction(err, '删除设备失败，请重试。') }
  }

  async function changeOwnPassword(values: OwnPasswordValues) {
    startAction('ownPassword')
    try {
      await api('/auth/password', { oldPassword: values.oldPassword, newPassword: values.newPassword })
      ownPasswordForm.resetFields(); finishAction('密码修改成功')
    } catch (err) { failAction(err, '修改密码失败，请重试。') }
  }

  const accountColumns: TableColumnsType<AdminAccount> = [
    { title: '账号', dataIndex: 'account', key: 'account', render: (value: string) => <Text strong className="selfhost-device-name">{value}</Text> },
    { title: '角色', dataIndex: 'isAdmin', key: 'isAdmin', render: (value: boolean) => value ? <Tag color="blue">管理员</Tag> : <Tag>普通</Tag> },
    { title: '状态', dataIndex: 'disabled', key: 'disabled', render: (value: boolean) => value ? <Tag color="red">禁用</Tag> : <Tag color="green">启用</Tag> },
    { title: '设备数', dataIndex: 'deviceCount', key: 'deviceCount' },
    { title: '创建时间', dataIndex: 'createdAt', key: 'createdAt', render: (value: number | string) => formatTime(value) },
    {
      title: '操作', key: 'actions', width: 260, render: (_value: unknown, record: AdminAccount) => <Space size={4} wrap>
        <Button size="small" loading={busy === `disable:${record.account}`} onClick={() => void toggleDisable(record, !record.disabled)}>{record.disabled ? '启用' : '禁用'}</Button>
        <Button size="small" onClick={() => openReset(record)}>重置密码</Button>
        <Popconfirm title="删除账号" description={`确定删除账号 ${record.account} 吗？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteAccount(record.account)}>
          <Button size="small" danger loading={busy === `delete-account:${record.account}`}>删除</Button>
        </Popconfirm>
      </Space>,
    },
  ]

  const deviceColumns: TableColumnsType<AdminDevice> = [
    { title: '设备名称', dataIndex: 'name', key: 'name', render: (value: string) => <Text strong className="selfhost-device-name">{value}</Text> },
    { title: '归属账号', dataIndex: 'owner', key: 'owner' },
    { title: '角色', dataIndex: 'role', key: 'role', render: (value: string) => value === 'host' ? 'Host' : '客户端' },
    { title: '状态', dataIndex: 'online', key: 'online', render: (value: boolean) => value ? <Tag color="green">在线</Tag> : <Tag>离线</Tag> },
    { title: '系统', dataIndex: 'platform', key: 'platform', render: (value: string) => platformNames[value] ?? value },
    {
      title: '操作', key: 'actions', render: (_value: unknown, record: AdminDevice) => <Popconfirm title="删除设备" description={`确定删除设备 ${record.name} 吗？`} okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => void deleteDevice(record.deviceId)}>
        <Button size="small" danger loading={busy === `delete-device:${record.deviceId}`}>删除设备</Button>
      </Popconfirm>,
    },
  ]

  return <>
    <Layout.Header className="topbar product-topbar"><div className="topbar-inner"><div className="topbar-brand-group is-product"><a className="topbar-brand" href="/" aria-label="返回首页"><img className="topbar-brand-mark" src="/brand-whale.webp" alt="" width="40" height="40" /><span className="topbar-brand-copy"><Title level={3}>DeepSeek Harness Remote</Title><small>账号管理后台</small></span></a></div><div className="topbar-actions"><a className="topbar-github-link product-github-link" href="https://github.com/liguobao/dsh-harness-remote" target="_blank" rel="noreferrer" aria-label="GitHub"><GithubOutlined /> GitHub</a><ThemeToggle /><Button type="text" onClick={onBack}>返回设备页</Button><Button type="text" loading={loggingOut} onClick={() => void logout()}>退出登录</Button></div></div></Layout.Header>
    <Layout.Content className="product-content selfhost-content" id="main-content">
      <div className="app-area"><div className="workspace-view"><div className="hosts-page" style={{ display: 'grid', gap: 20 }}>
        <header className="workspace-page-header"><div><Title level={2}>账号管理</Title><Paragraph className="selfhost-account">当前管理员：{account.account}</Paragraph></div><Space className="workspace-page-actions" wrap><Button onClick={() => void load()} loading={loading}>刷新</Button></Space></header>
        {error && <Alert className="selfhost-error" type="error" showIcon message={error} />}
        {success && <Alert className="selfhost-error" type="success" showIcon message={success} />}
        <Card className="page-card" title="注册设置">
          <Space size={24} wrap>
            <span>注册状态：{config ? (config.registrationEnabled ? <Tag color="green">开放</Tag> : <Tag color="red">关闭</Tag>) : '加载中…'}</span>
            <span>邀请码：{config ? (config.inviteCodeRequired ? <Tag color="blue">需要</Tag> : <Tag>不需要</Tag>) : '加载中…'}</span>
          </Space>
        </Card>
        <Card className="page-card hosts-list-card" title="账号列表" extra={config ? <Text type="secondary">共 {accounts.length} 个账号</Text> : undefined}>
          <Table<AdminAccount> rowKey="account" columns={accountColumns} dataSource={accounts} loading={loading} pagination={false} scroll={{ x: 'max-content' }} />
        </Card>
        <Card className="page-card" title="创建账号">
          <Form form={createForm} layout="vertical" onFinish={createAccount} requiredMark={false} initialValues={{ isAdmin: false }} style={{ maxWidth: 480 }}>
            <Form.Item name="email" label="账号" rules={[{ required: true, whitespace: true, message: '请输入账号' }, { max: 254, message: '账号不能超过 254 个字符' }]}><Input size="large" placeholder="请输入账号（邮箱）" autoComplete="off" /></Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { min: 12, message: '密码至少 12 位' }, { max: 1024, message: '密码不能超过 1024 个字符' }]}><Input.Password size="large" placeholder="请输入密码（至少 12 位）" autoComplete="new-password" /></Form.Item>
            <Form.Item name="isAdmin" valuePropName="checked"><Checkbox>设为管理员</Checkbox></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" loading={busy === 'create'}>创建账号</Button></Form.Item>
          </Form>
        </Card>
        <Card className="page-card hosts-list-card" title="全部设备" extra={<Text type="secondary">共 {devices.length} 台设备</Text>}>
          <Table<AdminDevice> rowKey="deviceId" columns={deviceColumns} dataSource={devices} loading={loading} pagination={false} scroll={{ x: 'max-content' }} />
        </Card>
        <Card className="page-card" title="修改我的密码">
          <Form form={ownPasswordForm} layout="vertical" onFinish={changeOwnPassword} requiredMark={false} style={{ maxWidth: 480 }}>
            <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}><Input.Password size="large" placeholder="请输入旧密码" autoComplete="current-password" /></Form.Item>
            <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 12, message: '密码至少 12 位' }, { max: 1024, message: '密码不能超过 1024 个字符' }]}><Input.Password size="large" placeholder="请输入新密码（至少 12 位）" autoComplete="new-password" /></Form.Item>
            <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({ validator(_rule, value: string) { return !value || getFieldValue('newPassword') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) } }),
            ]}><Input.Password size="large" placeholder="请再次输入新密码" autoComplete="new-password" /></Form.Item>
            <Form.Item><Button type="primary" htmlType="submit" loading={busy === 'ownPassword'}>修改密码</Button></Form.Item>
          </Form>
        </Card>
      </div></div></div>
    </Layout.Content>
    <Modal title={resetTarget ? `重置密码：${resetTarget.account}` : '重置密码'} open={!!resetTarget} onCancel={() => setResetTarget(undefined)} onOk={() => resetForm.submit()} okText="重置" cancelText="取消" confirmLoading={busy === 'reset'} forceRender>
      <Form form={resetForm} layout="vertical" onFinish={submitReset} requiredMark={false} style={{ marginTop: 16 }}>
        <Form.Item name="newPassword" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 12, message: '密码至少 12 位' }, { max: 1024, message: '密码不能超过 1024 个字符' }]}><Input.Password size="large" placeholder="请输入新密码（至少 12 位）" autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({ validator(_rule, value: string) { return !value || getFieldValue('newPassword') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) } }),
        ]}><Input.Password size="large" placeholder="请再次输入新密码" autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>
    <SiteFooter />
  </>
}
