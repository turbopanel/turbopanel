import { assert } from "@std/assert";
import { it } from "@std/testing/bdd";

it("production Deno entry does not import developer modules", async () => {
  const entry = await Deno.readTextFile(new URL("./deno.ts", import.meta.url));
  assert(
    !entry.includes("developer/"),
    "src/deno.ts must not import developer modules",
  );
  assert(
    !entry.includes("registerVersionRoute"),
    "src/deno.ts must not register /api/daemon/v1/version",
  );
  assert(
    entry.includes("startDenoServer()"),
    "src/deno.ts must start the production server without a developer registrar",
  );
});

it("development Deno entry registers the developer surface", async () => {
  const entry = await Deno.readTextFile(new URL("./deno-dev.ts", import.meta.url));
  assert(entry.includes("registerDeveloperRoutes"));
  assert(entry.includes("registerVersionRoute"));
  assert(entry.includes("registerDevSyncRoutes"));
});

const HOSTED_BILLING_SURFACE = [
  "/webhook/billing/",
  "/client/billing/routes.ts",
  "/admin/tier-routes.ts",
  "/lib/billing/client.ts",
  "/client/openapi/billing.ts",
  "/client/openapi/workers.ts",
  "/admin/openapi/tiers.ts",
  "/admin/openapi/workers.ts",
] as const;

const VALUE_IMPORT_FROM =
  /(?:^|\n)[ \t]*(?:import|export)(?!\s+type\b)(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /(?:^|[^\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function isTypeOnlyNamedImport(statement: string): boolean {
  const named = /^\s*import\s*\{([^}]+)\}/.exec(statement);
  if (!named) return false;
  const bindings = named[1].split(",").map((part) => part.trim()).filter(
    Boolean,
  );
  return bindings.length > 0 &&
    bindings.every((binding) => binding.startsWith("type "));
}

async function walkValueImportGraph(entry: URL): Promise<string[]> {
  const visited = new Set<string>();
  const queue = [entry.href];
  while (queue.length > 0) {
    const href = queue.pop();
    if (!href || visited.has(href)) continue;
    visited.add(href);
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(href));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    const specifiers: string[] = [];
    for (const match of text.matchAll(VALUE_IMPORT_FROM)) {
      const statement = match[0];
      if (isTypeOnlyNamedImport(statement)) continue;
      specifiers.push(match[1]);
    }
    for (const match of text.matchAll(DYNAMIC_IMPORT)) {
      specifiers.push(match[1]);
    }
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      queue.push(new URL(specifier, href).href);
    }
  }
  return [...visited];
}

function hostedBillingHit(path: string): string | undefined {
  const url = path.startsWith("file:") ? new URL(path).pathname : path;
  return HOSTED_BILLING_SURFACE.find((fragment) => url.includes(fragment));
}

it("Deno production entry graph does not import hosted Stripe billing", async () => {
  const files = await walkValueImportGraph(
    new URL("./deno.ts", import.meta.url),
  );
  for (const file of files) {
    const hit = hostedBillingHit(file);
    assert(
      hit === undefined,
      `Deno production graph must not import ${hit} (reached ${file})`,
    );
    const text = await Deno.readTextFile(new URL(file));
    assert(
      !text.includes("api.stripe.com"),
      `${file} must not reference api.stripe.com`,
    );
  }
});

it("Deno development entry graph does not import hosted Stripe billing", async () => {
  const files = await walkValueImportGraph(
    new URL("./deno-dev.ts", import.meta.url),
  );
  for (const file of files) {
    const hit = hostedBillingHit(file);
    assert(
      hit === undefined,
      `Deno development graph must not import ${hit} (reached ${file})`,
    );
  }
});
