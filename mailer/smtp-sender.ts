import nodemailer from 'nodemailer'
import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createServerTierNoticeEmail,
} from '../src/lib/email/templates.ts'
import { resolveEmailSettings, type ResolvedEmailSettings } from '../src/lib/settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../src/client/authn/secrets.ts'
import type { EmailJob } from '../src/lib/email/types.ts'
import type { MailerSendResult } from '../src/lib/email/sender-types.ts'
import { PermanentSendError, validateEmailAddress } from '../src/lib/email/validate-address.ts'
import type { Db } from './db.ts'
import { logError } from '../src/logger.ts'
import type { SmtpConfig } from '../src/lib/email/smtp/smtp-resolve.ts'

type Transporter = ReturnType<typeof nodemailer.createTransport>

const POOL_OPTS = { pool: true, maxConnections: 5, maxMessages: 100 }

export type { MailerSendResult }

function mailpitPort(env: Record<string, string | undefined>): number {
  const mailpit = env.MAILPIT_SMTP_PORT?.trim()
  if (mailpit) {
    const parsed = Number.parseInt(mailpit, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  const smtp = env.SMTP_PORT?.trim() ?? env.TURBOPANEL_SYSTEM_EMAIL__SMTP_PORT?.trim()
  if (smtp) {
    const parsed = Number.parseInt(smtp, 10)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 1025
}

const SMTP_SETTING_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] as const

function smtpConfigAttempted(resolved: ResolvedEmailSettings): boolean {
  for (const key of SMTP_SETTING_KEYS) {
    const meta = resolved.keys[key]
    if (meta.isEnvOverridden || meta.isDbSet) return true
  }
  return resolved.keys.SMTP_HOST.value.trim() !== '' ||
    resolved.keys.SMTP_PORT.value.trim() !== ''
}

function validateResolvedSmtpConfig(resolved: ResolvedEmailSettings): SmtpConfig | undefined {
  if (resolved.provider !== 'smtp') {
    throw new PermanentSendError(`email provider is ${resolved.provider}, not smtp`)
  }

  if (smtpConfigAttempted(resolved) && !resolved.smtp) {
    throw new PermanentSendError('invalid SMTP configuration')
  }

  return resolved.smtp
}

function buildTransport(
  cfg: SmtpConfig | undefined,
  env: Record<string, string | undefined>,
): Transporter {
  if (cfg) {
    const auth =
      typeof cfg.user === 'string' &&
        cfg.user.length > 0 &&
        typeof cfg.pass === 'string' &&
        cfg.pass.length > 0
        ? { user: cfg.user, pass: cfg.pass }
        : undefined
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: false,
      ...(auth && { auth }),
      ...POOL_OPTS,
    })
  }
  return nodemailer.createTransport({
    host: 'localhost',
    port: mailpitPort(env),
    secure: false,
    tls: { rejectUnauthorized: false },
    ...POOL_OPTS,
  })
}

function isPermanentSmtpError(error: unknown): boolean {
  if (error instanceof PermanentSendError) return true
  if (!error || typeof error !== 'object') return false

  const maybeError = error as { responseCode?: unknown; code?: unknown; command?: unknown }
  if (typeof maybeError.responseCode === 'number' && maybeError.responseCode >= 500) {
    return true
  }

  const code = typeof maybeError.code === 'string' ? maybeError.code : ''
  const command = typeof maybeError.command === 'string' ? maybeError.command : ''
  return code === 'EENVELOPE' ||
    code === 'EAUTH' ||
    command === 'API' ||
    command === 'AUTH'
}

export class MailerSmtpSender {
  private readonly db: Db | undefined
  private readonly env: Record<string, string | undefined>
  private readonly dataEncryptionSecrets: DerivedSecretsConfig | undefined
  private transportCache: { sig: string; transport: Transporter } | null = null

  constructor(opts: {
    db: Db | undefined
    env?: Record<string, string | undefined>
    dataEncryptionSecrets?: DerivedSecretsConfig
  }) {
    this.db = opts.db
    this.env = opts.env ?? Deno.env.toObject()
    this.dataEncryptionSecrets = opts.dataEncryptionSecrets
  }

  private smtpSignature(cfg: SmtpConfig | undefined): string {
    if (!cfg) return 'mailpit'
    return `${cfg.host}:${cfg.port}:${cfg.user ?? ''}:${cfg.pass ?? ''}`
  }

  private async resolveEmailConfig(): Promise<Awaited<ReturnType<typeof resolveEmailSettings>>> {
    return await resolveEmailSettings(this.db, this.env, this.dataEncryptionSecrets)
  }

  private async resolveSmtpConfig(): Promise<SmtpConfig | undefined> {
    const resolved = await this.resolveEmailConfig()
    return validateResolvedSmtpConfig(resolved)
  }

  private async resolveFromAddress(): Promise<string> {
    const resolved = await this.resolveEmailConfig()
    return resolved.from
  }

  private async transporterForCurrentSmtp(): Promise<Transporter> {
    const cfg = await this.resolveSmtpConfig()
    const sig = this.smtpSignature(cfg)
    if (this.transportCache?.sig === sig) return this.transportCache.transport
    const transport = buildTransport(cfg, this.env)
    this.transportCache = { sig, transport }
    return transport
  }

  private stripHtml(html: string): string {
    let text = this.stripTagsLinear(html)
    text = text
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
    return this.collapseWhitespace(text.trim())
  }

  private stripTagsLinear(s: string): string {
    const out: string[] = []
    let i = 0
    while (i < s.length) {
      const open = s.indexOf('<', i)
      if (open === -1) {
        out.push(s.slice(i))
        break
      }
      out.push(s.slice(i, open))
      const close = s.indexOf('>', open + 1)
      i = close === -1 ? s.length : close + 1
    }
    return out.join('')
  }

  private collapseWhitespace(s: string): string {
    const parts: string[] = []
    let i = 0
    while (i < s.length) {
      if (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') {
        parts.push(' ')
        while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) {
          i++
        }
      } else {
        const start = i
        while (i < s.length && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '\n' && s[i] !== '\r') {
          i++
        }
        parts.push(s.slice(start, i))
      }
    }
    return parts.join('')
  }

  async sendJob(job: EmailJob): Promise<MailerSendResult> {
    try {
      switch (job.type) {
        case 'signup-verification': {
          const from = await this.resolveFromAddress()
          validateEmailAddress(from, 'from')
          validateEmailAddress(job.to, 'recipient')
          const { subject, html, text } = createEmailVerificationLinkEmail(
            job.to,
            job.verificationUrl,
          )
          const transporter = await this.transporterForCurrentSmtp()
          await transporter.sendMail({
            from,
            to: job.to,
            subject,
            html,
            text: text ?? this.stripHtml(html),
          })
          return { success: true }
        }
        case 'email-otp': {
          const from = await this.resolveFromAddress()
          validateEmailAddress(from, 'from')
          validateEmailAddress(job.to, 'recipient')
          const { subject, html, text } = createEmailOtpEmail(
            job.to,
            job.otp,
            job.otpType,
          )
          const transporter = await this.transporterForCurrentSmtp()
          await transporter.sendMail({
            from,
            to: job.to,
            subject,
            html,
            text: text ?? this.stripHtml(html),
          })
          return { success: true }
        }
        case 'server-tier-notice': {
          const from = await this.resolveFromAddress()
          validateEmailAddress(from, 'from')
          validateEmailAddress(job.to, 'recipient')
          const { subject, html, text } = createServerTierNoticeEmail(job)
          const transporter = await this.transporterForCurrentSmtp()
          await transporter.sendMail({
            from,
            to: job.to,
            subject,
            html,
            text: text ?? this.stripHtml(html),
          })
          return { success: true }
        }
        default:
          return {
            success: false,
            error: `unknown job type: ${(job as EmailJob).type}`,
            permanent: true,
          }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${errMsg}`)
      return { success: false, error: errMsg, permanent: isPermanentSmtpError(e) }
    }
  }
}

export function createMailerSmtpSender(opts: {
  db: Db | undefined
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerSmtpSender {
  return new MailerSmtpSender(opts)
}
