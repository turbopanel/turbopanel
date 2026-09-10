import { assertEquals } from "@std/assert";
import { parseDockerRunImportRequest } from "./routes-helpers.ts";

/** See the note in `src/lib/docker-run/option-registry.test.ts`. */
const test = Deno.test.bind(Deno);

test("a minimal body parses to defaults", () => {
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: "docker run nginx",
    }),
    {
      serviceName: "web",
      argv: "docker run nginx",
      projectId: null,
    },
  );
});

test("argv may be an array of strings", () => {
  const parsed = parseDockerRunImportRequest({
    serviceName: "web",
    argv: ["docker", "run", "nginx"],
  });
  assertEquals(parsed?.argv, ["docker", "run", "nginx"]);
});

test("a service name that is not a Compose key is refused", () => {
  for (const serviceName of ["", "has space", "has/slash", "a".repeat(64)]) {
    assertEquals(
      parseDockerRunImportRequest({ serviceName, argv: "docker run nginx" }),
      null,
      serviceName,
    );
  }
});

test("a malformed argv is refused rather than coerced", () => {
  assertEquals(
    parseDockerRunImportRequest({ serviceName: "web", argv: 42 }),
    null,
  );
  assertEquals(
    parseDockerRunImportRequest({ serviceName: "web", argv: ["ok", 7] }),
    null,
  );
  assertEquals(parseDockerRunImportRequest({ serviceName: "web" }), null);
});

test("an oversized paste is refused before the lexer sees it", () => {
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: "x".repeat(16_385),
    }),
    null,
  );
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: new Array(513).fill("x"),
    }),
    null,
  );
});

test("projectId is kept only when it is a non-empty string", () => {
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: "docker run nginx",
      projectId: "11111111-1111-4111-8111-111111111111",
    })?.projectId,
    "11111111-1111-4111-8111-111111111111",
  );
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: "docker run nginx",
      projectId: "",
    })?.projectId,
    null,
  );
  assertEquals(
    parseDockerRunImportRequest({
      serviceName: "web",
      argv: "docker run nginx",
      projectId: 7,
    }),
    null,
  );
});
