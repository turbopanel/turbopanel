import {
  isValidDisplayName,
  normalizeDisplayName,
  normalizeDisplayNameKey,
} from "../../lib/display-name-format.ts";

export type LicenseCreateFields = {
  name?: string;
  installBaseUrl?: string;
};

function optionalStringField(
  value: unknown,
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") return { ok: false };
  return { ok: true, value };
}

/**
 * Optional license labels: blank/whitespace is omitted; non-empty values use
 * the shared display-name contract (trim, NFC, apostrophe-fold, length, no
 * control characters).
 */
function parseOptionalLicenseName(
  value: string | undefined,
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true };
  const name = normalizeDisplayName(value);
  if (!name) return { ok: true };
  if (!isValidDisplayName(name)) return { ok: false };
  return { ok: true, value: name };
}

export function parseLicenseCreateFields(
  rawBody: string,
): LicenseCreateFields | "invalid" {
  if (!rawBody.trim()) {
    return {};
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return "invalid";
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "invalid";
  }

  const record = body as Record<string, unknown>;
  const nameField = optionalStringField(record.name);
  if (!nameField.ok) return "invalid";
  const installBaseUrl = optionalStringField(record.installBaseUrl);
  if (!installBaseUrl.ok) return "invalid";

  const parsedName = parseOptionalLicenseName(nameField.value);
  if (!parsedName.ok) return "invalid";

  const fields: LicenseCreateFields = {};
  if (parsedName.value !== undefined) {
    fields.name = parsedName.value;
  }
  if (installBaseUrl.value !== undefined) {
    fields.installBaseUrl = installBaseUrl.value;
  }

  return fields;
}

export const NO_LICENSE_AVAILABLE_ERROR = "no_license_available";

/**
 * The hosted mint refusal: every purchased license is held (bound or
 * waiting to connect) or already leaving at the boundary. Carries the
 * counts so the console can say "buy one more".
 */
export function noLicenseAvailableBody(
  summary: { purchased: number; releasing: number; held: number; available: number },
) {
  // Destructured, not spread: the route's summary also carries `bound`,
  // which is not part of this refusal's contract.
  const { purchased, releasing, held, available } = summary;
  return { error: NO_LICENSE_AVAILABLE_ERROR, purchased, releasing, held, available };
}

/** True when the client sent a base URL that failed `parseInstallBaseUrl`. */
export function isInvalidInstallBaseUrl(
  installBaseUrl: string | undefined,
  parsedInstallBaseUrl: string | null,
): boolean {
  if (!installBaseUrl?.trim()) return false;
  return parsedInstallBaseUrl == null;
}

export function isReservedColocatedLicenseName(
  name: string | undefined,
  reservedName: string,
): boolean {
  if (name == null) return false;
  return normalizeDisplayNameKey(name) ===
    normalizeDisplayNameKey(reservedName);
}

export function reservedColocatedLicenseNameError(
  reservedName: string,
): string {
  return `'${reservedName}' is reserved for the co-located control plane`;
}

export function installBaseUrlValidationError(devSurface: boolean): string {
  if (devSurface) {
    return "installBaseUrl must be a valid http(s) URL";
  }
  return "installBaseUrl must be a valid https URL";
}

export type LicenseListBoundServer = {
  id: string;
  name: string | null;
};

export type LicenseListStatus = {
  serverId: string;
  connected: boolean;
};

export function serializeLicenseListEntry(params: {
  id: string;
  name: string | null;
  createdAt: string;
  revocable: boolean;
  bound: LicenseListBoundServer | undefined;
  status: LicenseListStatus | undefined;
}) {
  return {
    id: params.id,
    name: params.name,
    createdAt: params.createdAt,
    revocable: params.revocable,
    boundServer: params.bound
      ? {
        id: params.bound.id,
        name: params.bound.name,
        connected: params.status?.connected ?? false,
      }
      : null,
  };
}

export function serverCapacityExceededBody(capacity: {
  maxServers: number | null;
  usedSeats: number;
  serverCount: number;
  reservedSeatCount: number;
}, errorCode: string) {
  return {
    error: errorCode,
    maxServers: capacity.maxServers,
    usedSeats: capacity.usedSeats,
    serverCount: capacity.serverCount,
    reservedSeatCount: capacity.reservedSeatCount,
  };
}
