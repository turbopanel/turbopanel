import { sendMailgunJob } from '../src/lib/email/mailgun/send.ts'
import { resolveEmailSettings } from '../src/lib/settings/email-settings.ts'
import type { DerivedSecretsConfig } from '../src/client/authn/secrets.ts'
import type { EmailJob } from '../src/lib/email/types.ts'
import type { MailerSendResult } from '../src/lib/email/sender-types.ts'
import { PermanentSendError, validateEmailAddress } from '../src/lib/email/validate-address.ts'
import type { Db } from './db.ts'
import { logError } from '../src/logger.ts'

class MailgunConfigError extends Error {}

function validateMailgunSettings(
  resolved: Awaited<ReturnType<typeof resolveEmailSettings>>,
): { apiKey: string; domain: string; from: string; apiBase: string } {
  if (resolved.provider !== 'mailgun') {
    throw new MailgunConfigError(`email provider is ${resolved.provider}, not mailgun`)
  }
  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') {
    throw new MailgunConfigError('Mailgun API key and domain are required')
  }
  return {
    apiKey,
    domain,
    from: resolved.from,
    apiBase: resolved.mailgunApiBase,
  }
}

function isPermanentError(error: unknown): boolean {
  if (error instanceof PermanentSendError || error instanceof MailgunConfigError) return true
  return false
}

export class MailerMailgunSender {
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

  private async resolveMailgunConfig(): Promise<{
    apiKey: string
    domain: string
    from: string
    apiBase: string
  }> {
    const resolved = await resolveEmailSettings(
      this.db,
      this.env,
      this.dataEncryptionSecrets,
    )
    return validateMailgunSettings(resolved)
  }

  async sendJob(job: EmailJob): Promise<MailerSendResult> {
    try {
      const config = await this.resolveMailgunConfig()
      validateEmailAddress(config.from, 'from')
      if (
        job.type === 'signup-verification' ||
        job.type === 'email-otp' ||
        job.type === 'server-tier-notice'
      ) {
        validateEmailAddress(job.to, 'recipient')
      }

      const outcome = await sendMailgunJob(job, {
        apiKey: config.apiKey,
        domain: config.domain,
        from: config.from,
        apiBase: config.apiBase,
      })

      if (outcome.ok) return { success: true }
      return { success: false, error: outcome.error, permanent: outcome.permanent }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      logError('mailer', `send failed: ${errMsg}`)
      return { success: false, error: errMsg, permanent: isPermanentError(e) }
    }
  }
}

export function createMailerMailgunSender(opts: {
  db: Db | undefined
  env?: Record<string, string | undefined>
  dataEncryptionSecrets?: DerivedSecretsConfig
}): MailerMailgunSender {
  return new MailerMailgunSender(opts)
}
