import type { Context } from 'hono'

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password'

export type EmailJob =
  | {
      type: 'signup-verification'
      to: string
      from: string
      verificationUrl: string
    }
  | {
      type: 'email-otp'
      to: string
      from: string
      otp: string
      otpType: OtpType
    }
  | {
      type: 'server-tier-notice'
      to: string
      from: string
      kind: 'exceeds' | 'overprovisioned'
      serverName: string
      organizationName: string
      licenseTierLabel: string
      requiredTierLabel: string
      recommendedTierLabel: string
      unwatched: { nics: string[]; drives: string[]; gpus: string[] }
      consoleUrl: string
    }

export interface EmailQueue {
  enqueue(job: EmailJob): Promise<void>
  close?(): Promise<void>
}

export function getEmailQueue(c: Context): EmailQueue | undefined {
  return c.get('emailQueue')
}
