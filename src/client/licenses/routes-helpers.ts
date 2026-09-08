import {
  isValidDisplayName,
  normalizeDisplayName,
  normalizeDisplayNameKey,
} from "../../lib/display-name-format.ts";

export type LicenseCreateFields = {
  name?: string;
  installBaseUrl?: string;
  /** Hosted only: the billing tier the seat is minted against. */
  tierId?: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const tierId = optionalStringField(record.tierId);
  if (!tierId.ok) return "invalid";
  if (
    tierId.value !== undefined && tierId.value.trim() !== "" &&
    !UUID_RE.test(tierId.value.trim())
  ) {
    return "invalid";
  }

  const parsedName = parseOptionalLicenseName(nameField.value);
  if (!parsedName.ok) return "invalid";

  const fields: LicenseCreateFields = {};
  if (parsedName.value !== undefined) {
    fields.name = parsedName.value;
  }
  if (installBaseUrl.value !== undefined) {
    fields.installBaseUrl = installBaseUrl.value;
  }
  if (tierId.value !== undefined && tierId.value.trim() !== "") {
    fields.tierId = tierId.value.trim().toLowerCase();
  }

  return fields;
}

export const NO_FREE_SEAT_ERROR = "no_free_seat";
export const TIER_REQUIRED_ERROR = "tier_required";
export const TIER_NOT_PURCHASABLE_ERROR = "tier_not_purchasable";

export function noFreeSeatBody(
  input: {
    tierId: string;
    seats: number;
    licensesUsed: number;
    licensesFree: number;
  },
) {
  return { error: NO_FREE_SEAT_ERROR, ...input };
}

/** `null` when the tier still has a free seat; otherwise the 409 body. */
export function noFreeSeatRefusal(input: {
  tierId: string;
  summary:
    | { seats: number; licensesUsed: number; licensesFree: number }
    | undefined;
}) {
  const summary = input.summary;
  if (summary && summary.licensesFree > 0) return null;
  return noFreeSeatBody({
    tierId: input.tierId,
    seats: summary?.seats ?? 0,
    licensesUsed: summary?.licensesUsed ?? 0,
    licensesFree: summary?.licensesFree ?? 0,
  });
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
