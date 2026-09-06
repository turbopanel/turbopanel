import { assertEquals } from "@std/assert";
import {
  ipsFromDaemonPresence,
  parseServerIps,
  reportedIpsFromServerMetadata,
  serverIpsEquals,
} from "../../server-addresses.ts";
import {
  formatServerOsDisplay,
  mergeServerHardwareProfile,
  osColumnsFromMetadata,
  osMetadataFromColumns,
  parseNtpServersColumn,
  parseServerDockerMetadata,
  parseServerHardwareProfile,
  parseServerHostResources,
  parseServerOptions,
  parseServerOsMetadata,
  parseServerRuntimeMetadata,
  parseServerTimeSync,
  REDACTED_SERVER_OPTION_KEYS,
  redactServerOptions,
  resolveEffectiveCpuThermalLimits,
  resolveEffectiveServerTimezone,
  resolveServerOsLogoKey,
  resolveServerResponseTimezone,
  resourcesFromDaemonPresence,
  serverDockerMetadataEquals,
  serverHostResourcesEquals,
  serverOsMetadataEquals,
  serverTimeSyncEquals,
  timeSyncColumnPatch,
  timeSyncFromColumns,
} from "./server-metadata.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("formatServerOsDisplay formats Debian with point release", () => {
  assertEquals(
    formatServerOsDisplay({
      family: "linux",
      id: "debian",
      version: "13.5",
      codename: "trixie",
      prettyName: "Debian GNU/Linux 13 (trixie)",
    }),
    "Debian 13.5 (Trixie)",
  );
});

test("formatServerOsDisplay formats Raspberry Pi OS from variant", () => {
  assertEquals(
    formatServerOsDisplay({
      family: "linux",
      id: "debian",
      variant: "raspberry-pi-os",
      version: "12.11",
      codename: "bookworm",
    }),
    "Raspberry Pi OS 12.11 (Bookworm)",
  );
});

test("formatServerOsDisplay formats raspbian ID as Raspberry Pi OS", () => {
  assertEquals(
    formatServerOsDisplay({
      family: "linux",
      id: "raspbian",
      version: "11",
      codename: "bullseye",
    }),
    "Raspberry Pi OS 11 (Bullseye)",
  );
});

test("formatServerOsDisplay falls back when fields are sparse", () => {
  assertEquals(
    formatServerOsDisplay({ family: "linux", id: "ubuntu", version: "24.04" }),
    "Ubuntu 24.04",
  );
  assertEquals(
    formatServerOsDisplay({ family: "linux", id: "debian" }),
    "Debian",
  );
  assertEquals(
    formatServerOsDisplay({
      prettyName: "Debian GNU/Linux 13 (trixie)",
    }),
    "Debian",
  );
  assertEquals(formatServerOsDisplay(null), null);
  assertEquals(formatServerOsDisplay(undefined), null);
});

test("resolveServerOsLogoKey picks debian vs raspberry-pi-os", () => {
  assertEquals(
    resolveServerOsLogoKey({ family: "linux", id: "debian" }),
    "debian",
  );
  assertEquals(
    resolveServerOsLogoKey({
      family: "linux",
      id: "debian",
      variant: "raspberry-pi-os",
    }),
    "raspberry-pi-os",
  );
  assertEquals(
    resolveServerOsLogoKey({ family: "linux", id: "raspbian" }),
    "raspberry-pi-os",
  );
  assertEquals(resolveServerOsLogoKey({ family: "linux", id: "ubuntu" }), null);
});

test("parseServerOsMetadata accepts daemon hello os blocks", () => {
  assertEquals(
    parseServerOsMetadata({
      family: "linux",
      id: "debian",
      variant: "raspberry-pi-os",
      version: "13.5",
      codename: "trixie",
      prettyName: "Debian GNU/Linux 13 (trixie)",
      architecture: "aarch64",
    }),
    {
      family: "linux",
      id: "debian",
      variant: "raspberry-pi-os",
      version: "13.5",
      codename: "trixie",
      prettyName: "Debian GNU/Linux 13 (trixie)",
      architecture: "aarch64",
    },
  );
  assertEquals(parseServerOsMetadata({ family: "solaris" }), undefined);
  assertEquals(parseServerOsMetadata("nope"), undefined);
});

test("parseServerHostResources accepts capacity totals", () => {
  assertEquals(
    parseServerHostResources({
      cpus: [
        {
          vendorId: "GenuineIntel",
          cores: { total: 4 },
          threads: { total: 8 },
        },
      ],
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    }),
    {
      cpus: [
        {
          vendorId: "GenuineIntel",
          cores: { total: 4 },
          threads: { total: 8 },
        },
      ],
      memory: { totalBytes: 16_384_000_000 },
      swap: { totalBytes: 0 },
    },
  );
  assertEquals(
    parseServerHostResources({ memory: { totalBytes: -1 } }),
    undefined,
  );
  assertEquals(parseServerHostResources(null), undefined);
});

test("parseServerHostResources accepts gpus", () => {
  assertEquals(
    parseServerHostResources({
      gpus: [
        {
          vendorId: "0x10de",
          name: "NVIDIA GeForce RTX 5060 Ti",
          memoryBytes: 16 * 1024 * 1024 * 1024,
          driver: "nvidia",
          pciId: "10de:2d04",
          pciSlot: "0000:01:00.0",
        },
      ],
    }),
    {
      gpus: [
        {
          vendorId: "0x10de",
          name: "NVIDIA GeForce RTX 5060 Ti",
          memoryBytes: 16 * 1024 * 1024 * 1024,
          driver: "nvidia",
          pciId: "10de:2d04",
          pciSlot: "0000:01:00.0",
        },
      ],
    },
  );
});

test("serverHostResourcesEquals compares field-wise", () => {
  const a = {
    cpus: [{ cores: { total: 4 }, threads: { total: 8 } }],
    memory: { totalBytes: 100 },
    swap: { totalBytes: 0 },
  };
  assertEquals(
    serverHostResourcesEquals(a, { ...a, cpus: [{ ...a.cpus[0] }] }),
    true,
  );
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpus: [{ cores: { total: 8 }, threads: { total: 8 } }],
    }),
    false,
  );
  assertEquals(
    serverHostResourcesEquals(a, {
      ...a,
      cpus: [{ cores: { total: 4 }, threads: { total: 4 } }],
    }),
    false,
  );
  assertEquals(serverHostResourcesEquals(a, null), false);
});

test("serverOsMetadataEquals compares field-wise including variant", () => {
  const a = {
    family: "linux" as const,
    id: "debian",
    version: "13.5",
    variant: "raspberry-pi-os" as const,
  };
  assertEquals(serverOsMetadataEquals(a, { ...a }), true);
  assertEquals(serverOsMetadataEquals(a, { ...a, variant: undefined }), false);
  assertEquals(serverOsMetadataEquals(a, null), false);
});

test("parseServerTimeSync accepts daemon time-sync blocks", () => {
  assertEquals(
    parseServerTimeSync({
      timezone: "America/Chicago",
      ntpEnabled: true,
      ntpSynced: false,
      ntpServers: ["time.cloudflare.com", "  "],
      fallbackNtpServers: ["203.0.113.10"],
    }),
    {
      timezone: "America/Chicago",
      ntpEnabled: true,
      ntpSynced: false,
      ntpServers: ["time.cloudflare.com"],
      fallbackNtpServers: ["203.0.113.10"],
    },
  );
  assertEquals(parseServerTimeSync({ timezone: "  " }), undefined);
  assertEquals(parseServerTimeSync("nope"), undefined);
});

test("serverTimeSyncEquals compares field-wise", () => {
  const a = {
    timezone: "UTC",
    ntpEnabled: true,
    ntpServers: ["time.cloudflare.com"],
  };
  assertEquals(serverTimeSyncEquals(a, { ...a, ntpSynced: true }), false);
  assertEquals(
    serverTimeSyncEquals(a, { ...a, timezone: "Europe/London" }),
    false,
  );
});

test("parseServerDockerMetadata accepts daemon docker blocks", () => {
  assertEquals(
    parseServerDockerMetadata({
      version: "28.3.3",
      composeVersion: "v2.39.1",
    }),
    { version: "28.3.3", composeVersion: "2.39.1" },
  );
  assertEquals(parseServerDockerMetadata({ version: "28.3.3" }), {
    version: "28.3.3",
  });
  assertEquals(
    parseServerDockerMetadata({ composeVersion: "2.39.1-desktop.1" }),
    {
      composeVersion: "2.39.1-desktop.1",
    },
  );
  assertEquals(parseServerDockerMetadata({}), undefined);
  assertEquals(
    parseServerDockerMetadata({ version: "not a version" }),
    undefined,
  );
  assertEquals(parseServerDockerMetadata("nope"), undefined);
});

test("serverDockerMetadataEquals compares field-wise", () => {
  const a = { version: "28.3.3", composeVersion: "2.39.1" };
  assertEquals(serverDockerMetadataEquals(a, { ...a }), true);
  assertEquals(serverDockerMetadataEquals(a, { version: "28.3.3" }), false);
  assertEquals(serverDockerMetadataEquals(a, null), false);
  assertEquals(serverDockerMetadataEquals(undefined, undefined), true);
});

test("parseServerOptions and resolveEffectiveServerTimezone", () => {
  assertEquals(parseServerOptions({ timezone: "UTC", cellGeneration: 2 }), {
    timezone: "UTC",
    cellGeneration: 2,
  });
  assertEquals(
    parseServerOptions({
      sshPort: 2222,
      ntp: { enabled: true, servers: ["pool.ntp.org"] },
    }),
    {
      sshPort: 2222,
      ntp: { enabled: true, servers: ["pool.ntp.org"] },
    },
  );
  assertEquals(parseServerOptions(null), null);
  assertEquals(parseServerOptions({}), {});

  assertEquals(
    resolveEffectiveServerTimezone(
      { timezone: "America/Chicago" },
      { defaultServerTimezone: "UTC", enforceServerTimezone: false },
    ),
    { timezone: "America/Chicago", source: "server" },
  );
  assertEquals(
    resolveEffectiveServerTimezone(
      { timezone: "America/Chicago" },
      { defaultServerTimezone: "UTC", enforceServerTimezone: true },
    ),
    { timezone: "UTC", source: "organization" },
  );
  assertEquals(
    resolveEffectiveServerTimezone({}, { defaultServerTimezone: "UTC" }),
    {
      timezone: null,
      source: null,
    },
  );
  assertEquals(resolveEffectiveServerTimezone({}, {}), {
    timezone: null,
    source: null,
  });
});

test("resolveEffectiveServerTimezone datacenter precedence matrix", () => {
  const server = { timezone: "America/Chicago" };
  const org = { defaultServerTimezone: "UTC", enforceServerTimezone: false };
  const orgEnforce = {
    defaultServerTimezone: "UTC",
    enforceServerTimezone: true,
  };
  const dc = {
    defaultServerTimezone: "Europe/Berlin",
    enforceServerTimezone: false,
  };
  const dcEnforce = {
    defaultServerTimezone: "Europe/Berlin",
    enforceServerTimezone: true,
  };

  assertEquals(resolveEffectiveServerTimezone(server, org, dcEnforce), {
    timezone: "Europe/Berlin",
    source: "datacenter",
  });
  assertEquals(resolveEffectiveServerTimezone(server, orgEnforce, dcEnforce), {
    timezone: "Europe/Berlin",
    source: "datacenter",
  });
  assertEquals(resolveEffectiveServerTimezone(server, orgEnforce, dc), {
    timezone: "UTC",
    source: "organization",
  });
  assertEquals(resolveEffectiveServerTimezone(server, org, dc), {
    timezone: "America/Chicago",
    source: "server",
  });
  assertEquals(resolveEffectiveServerTimezone({}, org, dc), {
    timezone: null,
    source: null,
  });
  assertEquals(resolveEffectiveServerTimezone({}, {}, dc), {
    timezone: null,
    source: null,
  });
});

test("resolveServerResponseTimezone falls back to daemon-reported zone", () => {
  assertEquals(
    resolveServerResponseTimezone(
      { timezone: null, source: null },
      "Europe/Berlin",
    ),
    {
      timezone: "Europe/Berlin",
      source: null,
    },
  );
  assertEquals(
    resolveServerResponseTimezone({ timezone: null, source: null }, "  "),
    {
      timezone: null,
      source: null,
    },
  );
  assertEquals(
    resolveServerResponseTimezone(
      { timezone: "America/Chicago", source: "server" },
      "Europe/Berlin",
    ),
    { timezone: "America/Chicago", source: "server" },
  );
  assertEquals(
    resolveServerResponseTimezone(
      resolveEffectiveServerTimezone(
        {},
        { defaultServerTimezone: "UTC", enforceServerTimezone: false },
        {
          defaultServerTimezone: "Europe/Berlin",
          enforceServerTimezone: false,
        },
      ),
      "Europe/Berlin",
    ),
    { timezone: "Europe/Berlin", source: null },
  );
});

test("parseServerIps and serverIpsEquals", () => {
  const ips = parseServerIps([
    { address: "10.0.0.1", version: 4, scope: "private" },
    { address: "", version: 4, scope: "private" },
    { address: "203.0.113.10", version: 4, scope: "public" },
    { address: "2001:db8::1", version: 6, scope: "public" },
  ]);
  assertEquals(ips, [
    { address: "10.0.0.1", version: 4, scope: "private" },
    { address: "2001:db8::1", version: 6, scope: "public" },
    { address: "203.0.113.10", version: 4, scope: "public" },
  ]);
  assertEquals(parseServerIps([]), []);
  assertEquals(parseServerIps(undefined), undefined);
  assertEquals(
    parseServerIps([
      {
        address: "10.0.0.5",
        version: 4,
        scope: "private",
        cidr: "10.0.0.5/24",
      },
    ]),
    [
      {
        address: "10.0.0.5",
        version: 4,
        scope: "private",
        cidr: "10.0.0.0/24",
      },
    ],
  );
  assertEquals(serverIpsEquals(ips, ips), true);
  assertEquals(
    serverIpsEquals(ips, [
      ...(ips ?? []),
      { address: "203.0.113.11", version: 4, scope: "public" },
    ]),
    false,
  );
});

test("ipsFromDaemonPresence reads resources.ips only", () => {
  assertEquals(
    ipsFromDaemonPresence({
      resources: {
        ips: [
          {
            address: "10.0.0.4",
            version: 4,
            scope: "private",
            interface: "eth0",
          },
        ],
      },
    }),
    [{ address: "10.0.0.4", version: 4, scope: "private", interface: "eth0" }],
  );
  assertEquals(ipsFromDaemonPresence({}), undefined);
  assertEquals(ipsFromDaemonPresence({ ips: [] }), undefined);
});

test("reportedIpsFromServerMetadata prefers resources.ips and falls back to leftover top-level ips", () => {
  assertEquals(
    reportedIpsFromServerMetadata({
      resources: {
        ips: [
          {
            address: "10.0.0.4",
            version: 4,
            scope: "private",
            interface: "eth0",
          },
        ],
      },
      ips: [{ address: "203.0.113.10", version: 4, scope: "public" }],
    }),
    [{ address: "10.0.0.4", version: 4, scope: "private", interface: "eth0" }],
  );
  assertEquals(
    reportedIpsFromServerMetadata({
      ips: [
        {
          address: "10.0.0.10",
          version: 4,
          scope: "private",
          cidr: "10.0.0.10/24",
        },
      ],
    }),
    [
      {
        address: "10.0.0.10",
        version: 4,
        scope: "private",
        cidr: "10.0.0.0/24",
      },
    ],
  );
  assertEquals(reportedIpsFromServerMetadata({}), undefined);
  assertEquals(reportedIpsFromServerMetadata({ resources: {} }), undefined);
});

test("resourcesFromDaemonPresence reads resources only", () => {
  assertEquals(
    resourcesFromDaemonPresence({
      resources: {
        cpus: [{ cores: { total: 8 }, threads: { total: 16 } }],
      },
      inventory: { cpuCores: 2, cpuThreads: 4 },
    }),
    { cpus: [{ cores: { total: 8 }, threads: { total: 16 } }] },
  );
  assertEquals(
    resourcesFromDaemonPresence({
      inventory: {
        cpuCores: 4,
        cpuThreads: 8,
        memoryTotalBytes: 1024,
        swapTotalBytes: 0,
      },
    }),
    undefined,
  );
  assertEquals(
    resourcesFromDaemonPresence({
      resources: {
        cpus: [{ cores: { total: 2 } }],
        ips: [{ address: "10.0.0.8", version: 4, scope: "private" }],
      },
      ips: [{ address: "203.0.113.10", version: 4, scope: "public" }],
    }),
    {
      cpus: [{ cores: { total: 2 } }],
      ips: [{ address: "10.0.0.8", version: 4, scope: "private" }],
    },
  );
});

test("os columns round-trip Raspberry Pi OS onto os_id", () => {
  const columns = osColumnsFromMetadata({
    family: "linux",
    id: "debian",
    variant: "raspberry-pi-os",
    version: "12.11",
    architecture: "aarch64",
  });
  assertEquals(columns.osId, "raspberry-pi-os");
  assertEquals(osMetadataFromColumns(columns), {
    family: "linux",
    id: "raspberry-pi-os",
    variant: "raspberry-pi-os",
    version: "12.11",
    architecture: "aarch64",
  });
});

test("os columns map raspbian ID onto os_id raspberry-pi-os", () => {
  const columns = osColumnsFromMetadata({
    family: "linux",
    id: "raspbian",
    version: "11",
  });
  assertEquals(columns.osId, "raspberry-pi-os");
  assertEquals(osMetadataFromColumns(columns)?.variant, "raspberry-pi-os");
});

test("parseNtpServersColumn accepts object arrays and string arrays", () => {
  assertEquals(
    parseNtpServersColumn([
      { host: "time.cloudflare.com" },
      { host: "pool.ntp.org", fallback: true },
    ]),
    [{ host: "time.cloudflare.com" }, { host: "pool.ntp.org", fallback: true }],
  );
  assertEquals(parseNtpServersColumn(["a.example", "b.example"]), [
    { host: "a.example" },
    { host: "b.example" },
  ]);
});

test("timeSyncColumnPatch does not rewrite last-sync on every synced heartbeat", () => {
  const current = {
    timezone: "UTC",
    isTimeSyncEnabled: true,
    ntpServers: [{ host: "a.example" }],
    ntpLastSyncedAt: "2026-01-01T00:00:00.000Z",
  };
  assertEquals(
    timeSyncColumnPatch(
      { timezone: "UTC", ntpEnabled: true, ntpSynced: true },
      current,
      "2026-08-17T12:00:00.000Z",
    ),
    null,
  );
  assertEquals(
    timeSyncColumnPatch(
      { ntpSynced: false },
      current,
      "2026-08-17T12:00:00.000Z",
    ),
    {
      ntpLastSyncedAt: null,
    },
  );
  assertEquals(
    timeSyncFromColumns({
      timezone: "UTC",
      isTimeSyncEnabled: true,
      ntpServers: [
        { host: "a.example" },
        {
          host: "b.example",
          fallback: true,
        },
      ],
      ntpLastSyncedAt: "2026-01-01T00:00:00.000Z",
    }),
    {
      timezone: "UTC",
      ntpEnabled: true,
      ntpSynced: true,
      ntpServers: ["a.example"],
      fallbackNtpServers: ["b.example"],
      lastSyncedAt: "2026-01-01T00:00:00.000Z",
    },
  );
});

test("parseServerHostResources keeps ips including interface", () => {
  assertEquals(
    parseServerHostResources({
      cpus: [{ cores: { total: 2 } }],
      ips: [
        {
          address: "10.0.0.5",
          version: 4,
          scope: "private",
          interface: "enp1s0",
        },
      ],
    }),
    {
      cpus: [{ cores: { total: 2 } }],
      ips: [
        {
          address: "10.0.0.5",
          version: 4,
          scope: "private",
          interface: "enp1s0",
        },
      ],
    },
  );
});

test("parseServerRuntimeMetadata keeps well-formed areas and drops the rest", () => {
  assertEquals(
    parseServerRuntimeMetadata({
      php: {
        series: ["8.4", "8.3", "8.4", "nonsense"],
        extensions: { "8.4": ["intl", "REDIS", "bad name"], x: ["intl"] },
      },
      node: { series: ["24"] },
      lsphp: { series: [] },
      bogus: { series: ["1"] },
    }),
    {
      php: { series: ["8.3", "8.4"], extensions: { "8.4": ["intl", "redis"] } },
      node: { series: ["24"] },
    },
  );
});

test("parseServerRuntimeMetadata degrades to undefined rather than throwing", () => {
  // A host reporting nonsense must degrade to "unknown inventory" — which the
  // prepare gate treats as "will be installed" — not to a hard failure that
  // would take the server offline for every deploy.
  assertEquals(parseServerRuntimeMetadata(null), undefined);
  assertEquals(parseServerRuntimeMetadata("php"), undefined);
  assertEquals(parseServerRuntimeMetadata({ php: "yes" }), undefined);
  assertEquals(parseServerRuntimeMetadata({}), undefined);
});

test("redactServerOptions strips secret-bearing keys and nothing else", () => {
  // `managedMonitor` held a sealed ProxySQL monitor password before the
  // credential moved to the `monitor` table. `server.options` is returned by
  // the server routes and cached in Redis, so a row that still carries it must
  // be scrubbed at every boundary.
  assertEquals(REDACTED_SERVER_OPTION_KEYS.includes("managedMonitor"), true);
  // Typed as the opaque jsonb it really is. `redactServerOptions` is declared
  // `<T>(value: T) => T`, so passing the literal inline would pin `T` to a
  // shape that still requires the very key this asserts was stripped.
  const stored: Record<string, unknown> = {
    timezone: "UTC",
    sshPort: 2222,
    managedMonitor: {
      username: "tp_monitor_0123456789ab",
      passwordSealed: "tpsecret.v1.deadbeef",
    },
  };
  assertEquals(redactServerOptions(stored), { timezone: "UTC", sshPort: 2222 });
});

test("redactServerOptions passes through anything with nothing to strip", () => {
  const clean = { timezone: "UTC" };
  // Same reference — the common path must not allocate a copy per row.
  assertEquals(redactServerOptions(clean) === clean, true);
  assertEquals(redactServerOptions(null), null);
  assertEquals(redactServerOptions(undefined), undefined);
  assertEquals(redactServerOptions("nope"), "nope");
  assertEquals(redactServerOptions([1, 2]), [1, 2]);
});

test("parseServerOptions never surfaces a secret-bearing key", () => {
  // Second line of defence: even unredacted jsonb cannot reach a response
  // through the parsed shape, because the parser is an allowlist.
  const parsed = parseServerOptions({
    timezone: "UTC",
    managedMonitor: { username: "x", passwordSealed: "tpsecret.v1.y" },
  });
  assertEquals(parsed, { timezone: "UTC" });
  assertEquals(JSON.stringify(parsed).includes("passwordSealed"), false);
});

test("parseServerHardwareProfile parses cpuModel and cpu overrides", () => {
  assertEquals(
    parseServerHardwareProfile({
      cpuModel: "  Intel Xeon Gold 6338  ",
      cpuTdpWattsOverride: 215,
      cpuTjMaxCelsiusOverride: 100,
    }),
    {
      cpuModel: "Intel Xeon Gold 6338",
      cpuTdpWattsOverride: 215,
      cpuTjMaxCelsiusOverride: 100,
    },
  );
});

test("parseServerHardwareProfile drops out-of-range cpu overrides", () => {
  assertEquals(
    parseServerHardwareProfile({
      cpuTdpWattsOverride: -5,
      cpuTjMaxCelsiusOverride: 999,
    }),
    undefined,
  );
  assertEquals(
    parseServerHardwareProfile({ cpuTdpWattsOverride: 0 }),
    undefined,
  );
});

test("parseServerHardwareProfile keeps an explicit null cpu override", () => {
  assertEquals(parseServerHardwareProfile({ cpuTdpWattsOverride: null }), {
    cpuTdpWattsOverride: null,
  });
});

test("mergeServerHardwareProfile sets and clears cpu overrides without bumping generation", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const set = mergeServerHardwareProfile(
    undefined,
    {
      cpuTdpWattsOverride: 200,
      cpuTjMaxCelsiusOverride: 95,
    },
    now,
  );
  assertEquals(set.identityChanged, false);
  assertEquals(set.profile?.cpuTdpWattsOverride, 200);
  assertEquals(set.profile?.cpuTjMaxCelsiusOverride, 95);
  assertEquals(set.profile?.generation, undefined);

  const cleared = mergeServerHardwareProfile(
    set.profile,
    {
      cpuTdpWattsOverride: null,
    },
    now,
  );
  assertEquals(cleared.identityChanged, false);
  assertEquals(cleared.profile?.cpuTdpWattsOverride, undefined);
  assertEquals(cleared.profile?.cpuTjMaxCelsiusOverride, 95);
});

test("parseServerHardwareProfile parses topology-id fields and the monitored-NIC list", () => {
  assertEquals(
    parseServerHardwareProfile({
      nicSlotDeviceIds: ["  eth-topo-1  ", "eth-topo-2", "", "eth-topo-1", 7],
      hostingFilesystemId: "fs-topo-1",
    }),
    {
      nicSlotDeviceIds: ["eth-topo-1", "eth-topo-2"],
      hostingFilesystemId: "fs-topo-1",
    },
  );
  assertEquals(
    parseServerHardwareProfile({ nicSlotDeviceIds: "eth-topo-1" }),
    undefined,
  );
});

test("parseServerHardwareProfile ignores pre-list nicSlot1DeviceId/nicSlot2DeviceId keys", () => {
  assertEquals(
    parseServerHardwareProfile({
      nicSlot1DeviceId: "  eth-topo-1  ",
      nicSlot2DeviceId: "eth-topo-2",
    }),
    undefined,
  );
  assertEquals(
    parseServerHardwareProfile({
      nicSlot1DeviceId: null,
      nicSlot2DeviceId: "eth-topo-2",
    }),
    undefined,
  );
  assertEquals(
    parseServerHardwareProfile({
      nicSlotDeviceIds: ["eth-topo-1"],
      nicSlot1DeviceId: "eth-topo-2",
    }),
    { nicSlotDeviceIds: ["eth-topo-1"] },
  );
});

test("mergeServerHardwareProfile bumps generation when topology-id fields or the monitored-NIC list change", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const set = mergeServerHardwareProfile(
    undefined,
    {
      nicSlotDeviceIds: ["eth-topo-1", "eth-topo-2"],
      hostingFilesystemId: "fs-topo-1",
    },
    now,
  );
  assertEquals(set.identityChanged, true);
  assertEquals(set.profile?.generation, 1);
  assertEquals(set.profile?.generationAppliedAt, now);
  assertEquals(set.profile?.nicSlotDeviceIds, ["eth-topo-1", "eth-topo-2"]);
  assertEquals(set.profile?.hostingFilesystemId, "fs-topo-1");

  // Same membership, same order — idempotent.
  const same = mergeServerHardwareProfile(
    set.profile,
    { nicSlotDeviceIds: ["eth-topo-1", "eth-topo-2"] },
    "2026-01-01T12:00:00.000Z",
  );
  assertEquals(same.identityChanged, false);
  assertEquals(same.profile?.generation, 1);

  // Reordering is an identity change: slot position keys the stored series.
  const reordered = mergeServerHardwareProfile(
    set.profile,
    { nicSlotDeviceIds: ["eth-topo-2", "eth-topo-1"] },
    "2026-01-01T13:00:00.000Z",
  );
  assertEquals(reordered.identityChanged, true);
  assertEquals(reordered.profile?.generation, 2);

  const later = "2026-01-02T00:00:00.000Z";
  const auto = mergeServerHardwareProfile(reordered.profile, {
    nicSlotDeviceIds: null,
  }, later);
  assertEquals(auto.identityChanged, true);
  assertEquals(auto.profile?.generation, 3);
  assertEquals(auto.profile?.generationAppliedAt, later);
  assertEquals("nicSlotDeviceIds" in (auto.profile ?? {}), false);

  // Clearing an already-auto server is a no-op.
  const stillAuto = mergeServerHardwareProfile(auto.profile, {
    nicSlotDeviceIds: [],
  }, later);
  assertEquals(stillAuto.identityChanged, false);
  assertEquals(stillAuto.profile?.generation, 3);
});

test("mergeServerHardwareProfile does not bump generation for hostingPath/drivetempEnabled (topology-id case alongside)", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const merged = mergeServerHardwareProfile(
    undefined,
    {
      hostingPath: "/srv/data",
      drivetempEnabled: true,
    },
    now,
  );
  assertEquals(merged.identityChanged, false);
  assertEquals(merged.profile?.generation, undefined);
  assertEquals(merged.profile?.hostingPath, "/srv/data");
  assertEquals(merged.profile?.drivetempEnabled, true);
});

test("resolveEffectiveCpuThermalLimits: override-only (no cpuModel)", () => {
  assertEquals(
    resolveEffectiveCpuThermalLimits({
      cpuTdpWattsOverride: 300,
      cpuTjMaxCelsiusOverride: 90,
    }),
    { tdpWatts: 300, tjMaxCelsius: 90, source: "override" },
  );
});

test("resolveEffectiveCpuThermalLimits: catalog-only, exact model match", () => {
  assertEquals(
    resolveEffectiveCpuThermalLimits({ cpuModel: "AMD EPYC 7763" }),
    {
      tdpWatts: 280,
      tjMaxCelsius: 95,
      source: "catalog-exact",
    },
  );
});

test("resolveEffectiveCpuThermalLimits: catalog-only, family regex fallback", () => {
  assertEquals(
    resolveEffectiveCpuThermalLimits({ cpuModel: "AMD EPYC 9999" }),
    {
      tdpWatts: 200,
      tjMaxCelsius: 95,
      source: "catalog-family",
    },
  );
});

test("resolveEffectiveCpuThermalLimits: mixed override+catalog fills only the overridden field", () => {
  assertEquals(
    resolveEffectiveCpuThermalLimits({
      cpuModel: "AMD EPYC 7763",
      cpuTdpWattsOverride: 240,
    }),
    { tdpWatts: 240, tjMaxCelsius: 95, source: "override" },
  );
});

test("resolveEffectiveCpuThermalLimits: neither override nor recognized cpuModel", () => {
  assertEquals(
    resolveEffectiveCpuThermalLimits({ cpuModel: "Totally Unknown Silicon" }),
    {
      tdpWatts: null,
      tjMaxCelsius: null,
      source: "none",
    },
  );
  assertEquals(resolveEffectiveCpuThermalLimits(undefined), {
    tdpWatts: null,
    tjMaxCelsius: null,
    source: "none",
  });
});
