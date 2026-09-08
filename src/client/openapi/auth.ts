const denoClientStatusSchema = {
  type: 'object',
  required: ['ok', 'runtime', 'needsInstall', 'isInstallMode', 'isSignupEnabled', 'billingEnabled'],
  description:
    'Public client status on Deno self-hosted. Reflects install wizard and sign-up state.',
  properties: {
    ok: { type: 'boolean', const: true },
    runtime: {
      type: 'string',
      const: 'deno',
      description:
        'Control-plane runtime. Self-hosted Deno uses green auth chrome in the UI.',
    },
    needsInstall: {
      type: 'boolean',
      description: 'True when org + superadmin do not exist yet.',
    },
    isInstallMode: {
      type: 'boolean',
      description: 'True while the install wizard is active.',
    },
    isSignupEnabled: {
      type: 'boolean',
      description:
        'Whether public sign-up is enabled. The `IS_SIGNUP_ENABLED` database setting wins unless `TURBOPANEL_IS_SIGNUP_ENABLED` is set to an explicit force-enable (`1`/`true`) or force-disable (`0`/`false`). Defaults to false when both are unset.',
    },
    billingEnabled: {
      type: 'boolean',
      description:
        'Whether this instance holds a Stripe key. Presence only — the console hides the billing area wholesale when false. Never the key.',
    },
  },
} as const

const workersClientStatusSchema = {
  type: 'object',
  required: ['ok', 'runtime', 'isSignupEnabled', 'billingEnabled'],
  description:
    'Public client status on Cloudflare Workers. Install fields are omitted — Workers bootstraps via public sign-up.',
  properties: {
    ok: { type: 'boolean', const: true },
    runtime: {
      type: 'string',
      const: 'workers',
      description:
        'Control-plane runtime. TurboPanel High Availability (Workers) uses blue auth chrome in the UI.',
    },
    isSignupEnabled: {
      type: 'boolean',
      description:
        'Whether public sign-up is enabled. The `IS_SIGNUP_ENABLED` database setting wins unless `TURBOPANEL_IS_SIGNUP_ENABLED` is set to an explicit force-enable (`1`/`true`) or force-disable (`0`/`false`). Defaults to false when both are unset so production can open sign-up from the panel without a deploy.',
    },
    billingEnabled: {
      type: 'boolean',
      description:
        'Whether this instance holds a Stripe key. Presence only — the console hides the billing area wholesale when false. Never the key.',
    },
  },
} as const

const denoSessionResponseSchema = {
  type: 'object',
  required: [
    'ok',
    'userId',
    'email',
    'role',
    'needsInstall',
  ],
  properties: {
    ok: { type: 'boolean', const: true },
    userId: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    role: { type: ['string', 'null'] },
    needsInstall: { type: 'boolean' },
  },
} as const

const workersSessionResponseSchema = {
  type: 'object',
  required: ['ok', 'userId', 'email', 'role'],
  description:
    'Session payload on Workers. needsInstall is omitted — Workers has no install wizard.',
  properties: {
    ok: { type: 'boolean', const: true },
    userId: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    role: { type: ['string', 'null'] },
  },
} as const

export function buildAuthSchemas(runtime?: 'deno' | 'workers') {
  const includeInstall = runtime !== 'workers'
  return {
    OkHealth: {
      type: 'object',
      required: ['ok', 'license', 'revision'],
      properties: {
        ok: { type: 'boolean', const: true },
        license: { type: 'string', const: 'AGPL-3.0-only' },
        revision: {
          type: 'object',
          required: ['commit', 'sourceUrl'],
          properties: {
            commit: { type: 'string' },
            sourceUrl: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    ClientStatus: includeInstall ? denoClientStatusSchema : workersClientStatusSchema,
    ErrorResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: false },
        error: { type: 'string' },
      },
    },
    UnauthorizedResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: false },
      },
    },
    SignInRequest: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', format: 'password' },
      },
    },
    SessionResponse: includeInstall
      ? denoSessionResponseSchema
      : workersSessionResponseSchema,
    SignOutResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
    SignUpRequest: {
      type: 'object',
      required: ['email', 'password'],
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string', format: 'password' },
      },
    },
    SignUpResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
    VerifyEmailResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
    OtpType: {
      type: 'string',
      enum: ['sign-in', 'email-verification', 'forget-password'],
    },
    SendOtpRequest: {
      type: 'object',
      required: ['email', 'type'],
      properties: {
        email: { type: 'string', format: 'email' },
        type: { $ref: '#/components/schemas/OtpType' },
      },
    },
    VerifyOtpRequest: {
      type: 'object',
      required: ['email', 'otp', 'type'],
      properties: {
        email: { type: 'string', format: 'email' },
        otp: { type: 'string' },
        type: { $ref: '#/components/schemas/OtpType' },
      },
    },
    SignInOtpRequest: {
      type: 'object',
      required: ['email', 'otp'],
      properties: {
        email: { type: 'string', format: 'email' },
        otp: { type: 'string' },
        name: { type: 'string' },
      },
    },
    VerifyEmailOtpRequest: {
      type: 'object',
      required: ['email', 'otp'],
      properties: {
        email: { type: 'string', format: 'email' },
        otp: { type: 'string' },
      },
    },
    RequestPasswordResetOtpRequest: {
      type: 'object',
      required: ['email'],
      properties: {
        email: { type: 'string', format: 'email' },
      },
    },
    ResetPasswordOtpRequest: {
      type: 'object',
      required: ['email', 'otp', 'password'],
      properties: {
        email: { type: 'string', format: 'email' },
        otp: { type: 'string' },
        password: { type: 'string', format: 'password' },
      },
    },
    OkResponse: {
      type: 'object',
      required: ['ok'],
      properties: {
        ok: { type: 'boolean', const: true },
      },
    },
  }
}

export const authPaths: Record<string, unknown> = {
  '/api/health': {
    get: {
      tags: ['Health'],
      summary: 'Health probe',
      responses: {
        '200': {
          description: 'Instance is reachable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkHealth' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/status': {
    get: {
      tags: ['Health'],
      summary: 'Public client status',
      description:
        'Install and sign-up flags for the client UI. Replaces the former GET /api/install/v1/status for client callers.',
      responses: {
        '200': {
          description: 'Client status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ClientStatus' },
            },
          },
        },
        '503': {
          description: 'Database unavailable (Deno self-hosted only)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/sign-in': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign in with email credentials',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SignInRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Signed in; session cookie set',
          headers: {
            'Set-Cookie': {
              schema: { type: 'string' },
              description: 'Signed session cookie',
            },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SessionResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Invalid credentials',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Root account must use install wizard',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/sign-out': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign out and clear session cookie',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Signed out',
          headers: {
            'Set-Cookie': {
              schema: { type: 'string' },
              description: 'Clears session cookie',
            },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignOutResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/authn/session': {
    get: {
      tags: ['Authorization'],
      summary: 'Get current session',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Active session',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SessionResponse' },
            },
          },
        },
        '401': {
          description: 'No valid session',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UnauthorizedResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/sign-up': {
    post: {
      tags: ['Authentication'],
      summary: 'Create a user account when sign-up is enabled',
      description:
        'Creates a regular user account when sign-up is enabled (`IS_SIGNUP_ENABLED` DB setting, or `TURBOPANEL_IS_SIGNUP_ENABLED` force override). On Deno self-hosted, the install wizard must complete first. On Workers, sign-up is the first-user bootstrap path. No session is returned — the user must sign in after verifying email.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SignUpRequest' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Account created; verification email queued when available',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignUpResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body or validation error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description:
            'Deno self-hosted: install incomplete. Any runtime: sign-up disabled.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'Email already registered',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '500': {
          description: 'Sign-up failed',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/verify-email': {
    get: {
      tags: ['Authentication'],
      summary: 'Verify email with a one-time token',
      description:
        'Consumes a 24-hour email verification token and sets `user.isEmailVerified` to true.',
      parameters: [
        {
          name: 'token',
          in: 'query',
          required: true,
          schema: { type: 'string' },
          description: 'Verification token from the signup email link',
        },
      ],
      responses: {
        '200': {
          description: 'Email verified',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/VerifyEmailResponse' },
            },
          },
        },
        '400': {
          description: 'Missing, invalid, or expired token',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/send-otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Send an OTP to an email address',
      description:
        'Generates a short-lived OTP and queues an email. Never reveals whether the email is registered. `email-verification` requires an active session.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SendOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'OTP queued (or silently accepted)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Session required for email-verification OTP',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/verify-otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Check OTP validity (optional step)',
      description:
        'Validates an OTP without consuming it. Failed attempts count toward the per-OTP attempt limit.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/VerifyOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'OTP is valid',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid or expired OTP',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '429': {
          description: 'Too many attempts',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/sign-in/otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Sign in (or auto-register) with OTP',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SignInOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Signed in; session cookie set',
          headers: {
            'Set-Cookie': {
              schema: { type: 'string' },
              description: 'Signed session cookie',
            },
          },
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SessionResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request or OTP',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description:
            'Deno self-hosted: install incomplete. Any runtime: auto-registration disabled.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '429': {
          description: 'Too many OTP attempts',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/verify-email/otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Verify email address with OTP',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/VerifyEmailOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Email verified',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid or expired OTP',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Session required',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '429': {
          description: 'Too many attempts',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/reset-password/request-otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Request a password-reset OTP',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/RequestPasswordResetOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'OTP queued (or silently accepted)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/auth/reset-password/otp': {
    post: {
      tags: ['Authentication'],
      summary: 'Reset password using OTP',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ResetPasswordOtpRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Password updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OkResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request, OTP, or password',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'User or credential account not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '429': {
          description: 'Too many OTP attempts',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
}
