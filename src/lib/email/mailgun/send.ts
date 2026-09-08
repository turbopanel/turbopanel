import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createServerTierNoticeEmail,
} from '../templates.ts'
import type { EmailJob } from '../types.ts'

export type MailgunSendConfig = {
  apiKey: string
  domain: string
  from: string
  /** Defaults to US (`https://api.mailgun.net/v3`). Use EU base when region is `eu`. */
  apiBase?: string
}

export type MailgunSendOutcome =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean }

function isPermanentMailgunStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 429
}

function resolveMailgunTemplate(job: EmailJob) {
  if (job.type === 'signup-verification') {
    return createEmailVerificationLinkEmail(job.to, job.verificationUrl)
  }
  if (job.type === 'email-otp') {
    return createEmailOtpEmail(job.to, job.otp, job.otpType)
  }
  if (job.type === 'server-tier-notice') {
    return createServerTierNoticeEmail(job)
  }
  return null
}

export async function sendMailgunJob(
  job: EmailJob,
  config: MailgunSendConfig,
): Promise<MailgunSendOutcome> {
  const template = resolveMailgunTemplate(job)
  if (!template) {
    return { ok: false, error: `unknown job type: ${(job as EmailJob).type}`, permanent: true }
  }

  const body = new URLSearchParams({
    from: config.from,
    to: job.to,
    subject: template.subject,
    text: template.text,
    html: template.html,
  })

  const apiBase = (config.apiBase ?? 'https://api.mailgun.net/v3').replace(/\/$/, '')
  const domain = config.domain.trim()
  const apiKey = config.apiKey.trim()

  const basicAuth = btoa(`api:${apiKey}`)

  try {
    const res = await fetch(`${apiBase}/${encodeURIComponent(domain)}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    if (!res.ok) {
      const message = await res.text()
      if (res.status === 401) {
        console.error(
          '[TurboPanel email] Mailgun 401 — verify the Private API key, sending domain, and region (set TURBOPANEL_SYSTEM_EMAIL__MAILGUN_REGION=eu for EU accounts)',
          { apiBase, domain },
        )
      }
      return {
        ok: false,
        error: `Mailgun ${res.status}: ${message}`,
        permanent: isPermanentMailgunStatus(res.status),
      }
    }
    return { ok: true }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: errMsg, permanent: false }
  }
}
