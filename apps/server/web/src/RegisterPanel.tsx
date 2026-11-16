// Registration page; keeps the auth-page layout from LoginPanel.tsx.
import { Alert, Button, Card, Form, Input, Typography } from 'antd'
import { GithubOutlined } from '@ant-design/icons'
import { useEffect, useState } from 'react'
import { api, type Account, type RegistrationPolicy } from './api'
import { ThemeToggle } from './ThemeToggle'
import { SiteFooter } from './SiteFooter'

interface RegisterValues {
  email: string; password: string; confirmPassword: string; inviteCode?: string;
}
export function RegisterPanel({ onAuthSuccess, onGoLogin }: { onAuthSuccess: (account: Account) => void; onGoLogin: () => void }) {
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const [policy, setPolicy] = useState<RegistrationPolicy>()
  const [form] = Form.useForm<RegisterValues>()
  useEffect(() => {
    let active = true
    api<RegistrationPolicy>('/auth/registration').then(data => { if (active) setPolicy(data) })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : '无法获取注册设置。') })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [])
  async function submit(values: RegisterValues) {
    if (!policy?.enabled) return
    setLoading(true); setError('')
    try {
      const body: { email: string; password: string; inviteCode?: string } = { email: values.email.trim(), password: values.password }
      if (policy.inviteCodeRequired) body.inviteCode = values.inviteCode?.trim()
      const result = await api<Account>('/auth/register', body)
      form.resetFields(); onAuthSuccess(result)
    } catch (err) { setError(err instanceof Error ? err.message : '注册失败，请重试。'); form.resetFields(['password', 'confirmPassword']) }
    finally { setLoading(false) }
  }
  const disabled = checking || !policy?.enabled
  return <><main className="auth-page">
    <div className="auth-language-menu"><a className="auth-github-link" href="https://github.com/liguobao/dsh-harness-remote" target="_blank" rel="noreferrer"><GithubOutlined /> GitHub</a><ThemeToggle className="auth-theme-toggle" /></div>
    <section className="auth-content">
      <div className="auth-logo-stack"><a className="auth-home-link" href="/" aria-label="返回首页"><img className="auth-brand-icon" src="/brand-whale.webp" alt="" width="48" height="48" /><Typography.Title>DeepSeek Harness Remote</Typography.Title></a></div>
      <Card className="auth-panel">
        <div className="auth-intro"><Typography.Title level={3} className="auth-title">注册账号</Typography.Title></div>
        {error && <Alert className="selfhost-auth-error" type="error" showIcon message={error} />}
        {checking && <Alert className="selfhost-auth-error" type="info" showIcon message="正在检查注册设置…" />}
        {!checking && policy && !policy.enabled && <Alert className="selfhost-auth-error" type="warning" showIcon message="注册已关闭" description="请联系管理员开放注册后再试。" />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false} className="auth-form">
          <Form.Item name="email" label="账号" rules={[{ required: true, whitespace: true, message: '请输入账号' }, { max: 254, message: '账号不能超过 254 个字符' }]}><Input size="large" placeholder="请输入账号" autoComplete="username" /></Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }, { min: 12, message: '密码至少 12 位' }, { max: 1024, message: '密码不能超过 1024 个字符' }]}><Input.Password size="large" placeholder="请输入密码（至少 12 位）" autoComplete="new-password" /></Form.Item>
          <Form.Item name="confirmPassword" label="确认密码" dependencies={['password']} rules={[
            { required: true, message: '请再次输入密码' },
            ({ getFieldValue }) => ({ validator(_rule, value: string) { return !value || getFieldValue('password') === value ? Promise.resolve() : Promise.reject(new Error('两次输入的密码不一致')) } }),
          ]}><Input.Password size="large" placeholder="请再次输入密码" autoComplete="new-password" /></Form.Item>
          {policy?.inviteCodeRequired && <Form.Item name="inviteCode" label="邀请码" rules={[{ required: true, whitespace: true, message: '请输入邀请码' }]}><Input size="large" placeholder="请输入邀请码" /></Form.Item>}
          <Form.Item className="auth-submit-item"><Button loading={loading} disabled={disabled} block type="primary" size="large" htmlType="submit">注册</Button></Form.Item>
        </Form>
        <div style={{ textAlign: 'center' }}><span>已有账号？</span><Button type="link" size="small" onClick={onGoLogin} style={{ padding: 0 }}>去登录</Button></div>
      </Card>
    </section>
  </main><SiteFooter /></>
}
