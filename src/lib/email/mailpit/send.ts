import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createServerTierNoticeEmail,
} from '../templates.ts'
import type { EmailJob } from '../types.ts'

export type MailpitSendConfig = {
  apiBaseUrl: string
  from: string
}

export type MailpitSendOutcome =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean }

function isPermanentMailpitStatus(status: number): boolean {
  return status >= 400 && status < 500
}

function resolveMailpitTemplate(job: EmailJob) {
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

export function resolveMailpitApiBaseUrl(
  env: Record<string, string | undefined>,
): string {
  const apiUrl = env.MAILPIT_API_URL?.trim()
  if (apiUrl) {
    return apiUrl.replace(/\/$/, '')
  }

  const portRaw = env.MAILPIT_WEB_PORT?.trim()
  const port = portRaw ? Number.parseInt(portRaw, 10) : 8025
  const effectivePort = Number.isNaN(port) ? 8025 : port
  return `http://127.0.0.1:${effectivePort}`
}

export async function sendMailpitJob(
  job: EmailJob,
  config: MailpitSendConfig,
): Promise<MailpitSendOutcome> {
  const template = resolveMailpitTemplate(job)
  if (!template) {
    return { ok: false, error: `unknown job type: ${(job as EmailJob).type}`, permanent: true }
  }

  const apiBase = config.apiBaseUrl.replace(/\/$/, '')
  const payload = {
    From: { Email: config.from },
    To: [{ Email: job.to }],
    Subject: template.subject,
    HTML: template.html,
    Text: template.text ?? template.html,
  }

  try {
    const response = await fetch(`${apiBase}/api/v1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.ok) {
      return { ok: true }
    }

    const message = await response.text()
    return {
      ok: false,
      error: message || `Mailpit ${response.status}`,
      permanent: isPermanentMailpitStatus(response.status),
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    return { ok: false, error: errMsg, permanent: false }
  }
}
