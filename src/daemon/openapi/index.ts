import { authPaths, authSchemas } from "./auth.ts";
import { caPaths } from "./ca.ts";
import { executionLogPaths, executionLogSchemas } from "./execution-logs.ts";
import { hostPaths, hostSchemas } from "./host.ts";
import { metricsPaths, metricsSchemas } from "./metrics.ts";
import { readinessPaths, readinessSchemas } from "./readiness.ts";
import { versionPaths, versionSchemas } from "./version.ts";
import { websocketPaths } from "./websocket.ts";

/** Hand-authored OpenAPI 3.1 spec for documented daemon REST/WS routes. */
export function getDaemonOpenApiSpec(serverUrl: string): object {
  return {
    openapi: "3.1.0",
    info: {
      title: "TurboPanel Daemon API",
      version: "0.1.0",
    },
    servers: [{ url: serverUrl }],
    tags: [
      {
        name: "Authentication",
        description:
          "Daemon enrollment and session token issuance (Ed25519 challenge-response)",
      },
      {
        name: "Daemon",
        description: "Readiness, platform CA, version, and WebSocket upgrade",
      },
    ],
    "x-tagGroups": [
      { name: "Authentication", tags: ["Authentication"] },
      { name: "Daemon", tags: ["Daemon"] },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description:
            "Short-lived daemon JWT for authenticated daemon API and WebSocket access. " +
            "Send as `Authorization: Bearer <daemon-jwt>`.",
        },
      },
      schemas: {
        ...authSchemas,
        ...readinessSchemas,
        ...versionSchemas,
        ...metricsSchemas,
        ...executionLogSchemas,
        ...hostSchemas,
      },
    },
    paths: {
      ...authPaths,
      ...readinessPaths,
      ...caPaths,
      ...versionPaths,
      ...websocketPaths,
      ...metricsPaths,
      ...executionLogPaths,
      ...hostPaths,
    },
  };
}
