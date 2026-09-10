import { assert } from "@std/assert";
import { join } from "@std/path";
import { it } from "@std/testing/bdd";
import { DEFAULT_DUCKDB_LIB_DIR, DEFAULT_METRICS_DIR } from "./server-paths.ts";

/**
 * Co-located daemon checkout (`../turbopaneld` next to this repo). CI only checks
 * out turbopanel/turbopanel, so the unit template may be absent there.
 */
function resolveDaemonRepoRoot(): string {
  const override = Deno.env.get("TURBOPANEL_DAEMON_REPO")?.trim();
  if (override) return override;
  return new URL("../../turbopaneld", import.meta.url).pathname;
}

function instanceLaunchUnitPath(): string {
  return join(
    resolveDaemonRepoRoot(),
    "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
}

/** Read a file from the co-located daemon checkout; null when absent (CI). */
async function readDaemonFile(relPath: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(join(resolveDaemonRepoRoot(), relPath));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return null;
  }
}

function extractAllowNetFlag(command: string): string | null {
  const match = /--allow-net=([^\s]+)/.exec(command);
  return match?.[1] ?? null;
}

function extractPathListFlag(command: string, flag: string): string[] {
  const match = new RegExp(`--${flag}=([^\\s]+)`).exec(command);
  return match?.[1].split(",") ?? [];
}

async function readCompileTasks(): Promise<Record<string, string>> {
  const denoJsonPath = new URL("../deno.json", import.meta.url);
  const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath));
  const tasks: Record<string, string> = {};
  for (const taskName of ["compile", "compile:dev"]) {
    const task = denoJson.tasks?.[taskName];
    assert(typeof task === "string", `deno.json must define tasks.${taskName}`);
    tasks[taskName] = task;
  }
  return tasks;
}

/**
 * The template's `ExecStart=` lines (deno-run + compiled branches), with
 * Jinja expressions collapsed (`{{ var }}` → `{{var}}`) so flag values
 * tokenize on whitespace like real command lines.
 */
async function readUnitExecStartLines(): Promise<string[] | null> {
  try {
    const serviceUnit = await Deno.readTextFile(instanceLaunchUnitPath());
    return serviceUnit
      .split("\n")
      .filter((line) => line.startsWith("ExecStart="))
      .map((line) => line.replaceAll(/\{\{\s*([^}]*?)\s*\}\}/g, "{{$1}}"));
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return null;
  }
}

it("compile tasks grant FFI for the DuckDB native addon", async () => {
  // `@duckdb/node-api` loads a native `.node` addon: `deno compile` bundles it
  // from the npm cache and self-extracts at runtime, but loading it requires
  // FFI permission. Unscoped: the extraction path is a per-binary temp dir.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    assert(
      /(^|\s)--allow-ffi(\s|$)/.test(task),
      `${taskName} must include --allow-ffi for the DuckDB native addon`,
    );
  }
});

it("compile tasks grant the metrics state tree", async () => {
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    for (const flag of ["allow-read", "allow-write"]) {
      const paths = extractPathListFlag(task, flag);
      assert(
        paths.includes(DEFAULT_METRICS_DIR),
        `${taskName} --${flag} must include ${DEFAULT_METRICS_DIR} (DuckDB metrics store)`,
      );
    }
  }
});

it("compile tasks carry no ClickHouse grants", async () => {
  // The metrics store is moving to embedded DuckDB; the compiled instance
  // must not retain network reachability to the retired ClickHouse HTTP port.
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    const allowNet = extractAllowNetFlag(task);
    assert(allowNet, `${taskName} must include --allow-net`);
    assert(
      !allowNet.split(",").includes("127.0.0.1:8123"),
      `${taskName} --allow-net must not include the ClickHouse HTTP port 127.0.0.1:8123`,
    );
    assert(
      !task.includes("TURBOPANEL_CLICKHOUSE"),
      `${taskName} must not reference TURBOPANEL_CLICKHOUSE`,
    );
  }
});

it("instance unit ExecStart drops ClickHouse and grants DuckDB needs", async () => {
  const execStartLines = await readUnitExecStartLines();
  if (execStartLines === null) return; // standalone CI: daemon checkout absent
  assert(execStartLines.length > 0, "unit template must define ExecStart lines");

  for (const line of execStartLines) {
    assert(
      !line.includes("clickhouse_http_port"),
      "turbopanel-instance.service.j2 ExecStart must not reference clickhouse_http_port",
    );
  }

  // Source mode (`deno run`) loads the DuckDB addon from Deno's npm cache
  // (real files, `$ORIGIN` finds libduckdb.so) but still needs FFI permission
  // and the metrics tree. The compiled branch bakes its flags at compile time.
  const denoRunLines = execStartLines.filter((line) => line.includes(" run "));
  assert(denoRunLines.length > 0, "unit template must keep deno-run branches");
  for (const line of denoRunLines) {
    assert(
      /(^|\s)--allow-ffi(\s|$)/.test(line),
      "deno-run ExecStart must include --allow-ffi for the DuckDB native addon",
    );
    for (const flag of ["allow-read", "allow-write"]) {
      const paths = extractPathListFlag(line, flag);
      assert(
        paths.includes("{{turbopanel_metrics_dir}}"),
        `deno-run ExecStart --${flag} must include {{ turbopanel_metrics_dir }}`,
      );
    }
  }
});

it("compiled instance branch vendors libduckdb.so on LD_LIBRARY_PATH", async () => {
  // `deno compile` self-extracts the bundled duckdb.node addon but not its
  // companion libduckdb.so, so the compiled ExecStart branch must point
  // LD_LIBRARY_PATH at the vendored directory — and the build flow must
  // actually populate that directory, or the service fails to start.
  const serviceUnit = await readDaemonFile(
    "orchestration/roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
  if (serviceUnit === null) return; // standalone CI: daemon checkout absent
  const collapsed = serviceUnit.replaceAll(/\{\{\s*([^}]*?)\s*\}\}/g, "{{$1}}");
  assert(
    collapsed.includes("Environment=LD_LIBRARY_PATH={{turbopanel_duckdb_lib_dir}}"),
    "compiled branch must put {{ turbopanel_duckdb_lib_dir }} on LD_LIBRARY_PATH",
  );
  assert(
    collapsed.includes("ExecStart={{turbopanel_instance_binary}}"),
    "compiled branch must exec the compiled instance binary",
  );

  // The unit's LD_LIBRARY_PATH default must resolve to the same vendored
  // directory the binary probes at runtime (server-paths.ts).
  const defaults = await readDaemonFile(
    "orchestration/roles/instance-launch/defaults/main.yml",
  );
  assert(defaults !== null, "instance-launch defaults must exist next to the unit template");
  assert(
    defaults.includes('turbopanel_duckdb_lib_dir: "{{ turbopanel_vendor_dir }}/duckdb/lib"'),
    "turbopanel_duckdb_lib_dir must default to <vendor>/duckdb/lib",
  );
  assert(
    defaults.includes('turbopanel_vendor_dir: "{{ turbopanel_install_root }}/vendor"'),
    "turbopanel_vendor_dir must default to <install root>/vendor",
  );
  assert(
    defaults.includes("turbopanel_install_root: /opt/turbopanel"),
    "turbopanel_install_root must default to /opt/turbopanel",
  );
  assert(
    DEFAULT_DUCKDB_LIB_DIR === "/opt/turbopanel/vendor/duckdb/lib",
    "server-paths DEFAULT_DUCKDB_LIB_DIR must match the unit's resolved LD_LIBRARY_PATH",
  );

  // Provisioning half of the contract: instance-build stages the
  // architecture-appropriate libduckdb.so into the vendored directory.
  const buildTasks = await readDaemonFile(
    "orchestration/roles/instance-build/tasks/main.yml",
  );
  assert(buildTasks !== null, "instance-build role must exist next to the unit template");
  assert(
    buildTasks.includes("{{ turbopanel_duckdb_lib_dir }}/libduckdb.so"),
    "instance-build must stage libduckdb.so into turbopanel_duckdb_lib_dir",
  );
});

it("instance --allow-net includes public Git provider APIs", async () => {
  const tasks = await readCompileTasks();
  const required = ["api.github.com:443", "gitlab.com:443"];

  for (const [taskName, task] of Object.entries(tasks)) {
    const allowNet = extractAllowNetFlag(task);
    assert(allowNet, `${taskName} must include --allow-net`);
    const hosts = allowNet.split(",");
    for (const host of required) {
      assert(
        hosts.includes(host),
        `${taskName} --allow-net must include ${host} for Git provider API calls`,
      );
    }
  }

  try {
    const serviceUnit = await Deno.readTextFile(instanceLaunchUnitPath());
    for (const host of required) {
      assert(
        serviceUnit.includes(host),
        `turbopanel-instance.service.j2 must allow ${host}`,
      );
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
});

it("self-hosted compile tasks do not grant Stripe", async () => {
  const tasks = await readCompileTasks();
  for (const [taskName, task] of Object.entries(tasks)) {
    const allowNet = extractAllowNetFlag(task);
    assert(allowNet, `${taskName} must include --allow-net`);
    const hosts = allowNet.split(",");
    assert(
      !hosts.some((host) =>
        host === "api.stripe.com:443" || host.startsWith("api.stripe.com")
      ),
      `${taskName} --allow-net must not include api.stripe.com`,
    );
    assert(
      !task.includes("api.stripe.com"),
      `${taskName} must not mention api.stripe.com`,
    );
  }
});

it("production compile excludes developer-only permissions and entry", async () => {
  const { compile: compileTask } = await readCompileTasks();
  assert(
    compileTask.endsWith(" src/deno.ts") || compileTask.includes(" src/deno.ts "),
    "production compile must target src/deno.ts",
  );
  assert(
    !compileTask.includes("src/deno-dev.ts"),
    "production compile must not target src/deno-dev.ts",
  );

  const allowNet = extractAllowNetFlag(compileTask);
  assert(allowNet, "compile task must include --allow-net");
  const netHosts = allowNet.split(",");
  assert(
    !netHosts.includes("127.0.0.1:4983"),
    "production compile must not allow Drizzle Studio :4983",
  );
  assert(
    !netHosts.includes("127.0.0.1:1025"),
    "production compile must not allow Mailpit SMTP :1025",
  );
  assert(
    !netHosts.includes("127.0.0.1:8123"),
    "production compile must not allow ClickHouse HTTP :8123",
  );

  const allowRun = /--allow-run=([^\s]+)/.exec(compileTask)?.[1] ?? "";
  for (const denied of ["git", "tar", "systemctl", "mkfifo"]) {
    assert(
      !allowRun.split(",").includes(denied),
      `production compile must not --allow-run=${denied}`,
    );
  }
});
