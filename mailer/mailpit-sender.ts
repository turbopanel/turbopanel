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

function validateResolvedMailpitConfig(resolved: ResolvedEmailSettings): { from: string } {
  if (resolved.provider !== 'mailpit') {
    throw new PermanentSendError(`email provider is ${resolved.provider}, not mailpit`)
  }
  return { from: resolved.from }
}

function isPermanentError(error: unknown): boolean {
  return error instanceof PermanentSendError
}

export class MailerMailpitSender {
  private readonly db: Db | undefined
  private readonly env: Record<string, string | undefined>
  private readonly dataEncryptionSecrets: DerivedSecretsConfig | undefined

  constructor(opts: {
    db: Db | undefined
    env?: Record<string, string | undefined>
    dataEncryptionSecrets?: DerivedSecretsConfig
  }) {
    this.db = opts.db
    this.env = opts.env ?? Deno.env.toObject()
    this.dataEncryptionSecrets = opts.dataEncryptionSecrets
  }

  private resolveApiBaseUrl(): string {
    const apiUrl = this.env.MAILPIT_API_URL?.trim()
    if (apiUrl) return apiUrl

    const portRaw = this.env.MAILPIT_WEB_PORT?.trim()
    const port = portRaw ? Number.parseInt(portRaw, 10) : 8025
    const effectivePort = Number.isNaN(port) ? 8025 : port
    return `http://127.0.0.1:${effectivePort}`
  }

  private async resolveMailpitConfig(): Promise<{ from: string }> {
    const resolved = await resolveEmailSettings(
      this.db,
      this.env,
      this.dataEncryptionSecrets,
    )
    return validateResolvedMailpitConfig(resolved)
  }

  async sendJob(job: EmailJob): Promise<MailerSendResult> {
    try {
      const { from } = await this.resolveMailpitConfig()
      validateEmailAddress(from, 'from')

      let result: { subject: string; html: string; text?: string }
      switch (job.type) {
        case 'signup-verification': {
          validateEmailAddress(job.to, 'recipient')
          result = createEmailVerificationLinkEmail(job.to, job.verificationUrl)
          break
        }
        case 'email-otp': {
          validateEmailAddress(job.to, 'recipient')
          result = createEmailOtpEmail(job.to, job.otp, job.otpType)
          break
        }
        case 'server-tier-notice': {
          validateEmailAddress(job.to, 'recipient')
          result = createServerTierNoticeEmail(job)
          break
        }
        default:
          return {
            success: false,
            error: `unknown job type: ${(job as EmailJob).type}`,
            permanent: true,
          }
      }

      const baseUrl = this.resolveApiBaseUrl()
      const payload = {
        From: { Email: from },
        To: [{ Email: job.to }],
        Subject: result.subject,
        HTML: result.html,
        Text: result.text ?? result.html,
      }

      let response: Response
      try {
        response = await fetch(`${baseUrl}/api/v1/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        return { success: false, error: errMsg, permanent: false }
      }

      if (response.status >= 200 && response.status < 300) {
        return { success: true }
      }

      const responseText = await response.text()
      if (response.status >= 400 && response.status < 500) {
        return { success: false, error: responseText, permanent: true }
      }

      return { success: false, error: responseText || `HTTP ${response.status}`, permanent: false }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${errMsg}`)
      return { success: false, error: errMsg, permanent: isPermanentError(e) }
    }
  }
}

export function createMailerMailpitSender(opts: {
  db: Db | undefined
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerMailpitSender {
  return new MailerMailpitSender(opts)
}
