import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface AcsConfig {
  mode: "observe" | "enforce";
  startupPosture: "proceed" | "refuse";
  guardian: {
    url: string;
    connectTimeoutMs: number;
    maxResponseBytes: number;
    hmacKeyEnv?: string;
    keyId?: string;
  };
  audit: {
    path?: string;
    includePayloads: boolean;
  };
  agent: {
    id: string;
    name?: string;
    environment: "development" | "staging" | "production";
  };
}

export interface LoadedConfig {
  config: AcsConfig;
  path: string;
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown key(s): ${unknown.join(", ")}`);
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

export function parseConfig(value: unknown, cwd: string): AcsConfig {
  assertObject(value, "configuration");
  assertKeys(value, ["mode", "startupPosture", "guardian", "audit", "agent"], "configuration");

  const mode = value.mode ?? "observe";
  if (mode !== "observe" && mode !== "enforce") throw new Error("mode must be observe or enforce");
  const startupPosture = value.startupPosture ?? "proceed";
  if (startupPosture !== "proceed" && startupPosture !== "refuse") {
    throw new Error("startupPosture must be proceed or refuse");
  }

  assertObject(value.guardian, "guardian");
  assertKeys(
    value.guardian,
    ["url", "connectTimeoutMs", "maxResponseBytes", "hmacKeyEnv", "keyId"],
    "guardian",
  );
  if (typeof value.guardian.url !== "string") throw new Error("guardian.url is required");
  const url = new URL(value.guardian.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("guardian.url must use http or https");
  }
  if (url.username || url.password) throw new Error("guardian.url must not contain credentials");

  const hmacKeyEnv = value.guardian.hmacKeyEnv;
  const keyId = value.guardian.keyId;
  if (hmacKeyEnv !== undefined && (typeof hmacKeyEnv !== "string" || hmacKeyEnv.length === 0)) {
    throw new Error("guardian.hmacKeyEnv must be a non-empty environment variable name");
  }
  if (keyId !== undefined && (typeof keyId !== "string" || keyId.length === 0)) {
    throw new Error("guardian.keyId must be a non-empty string");
  }
  if ((hmacKeyEnv === undefined) !== (keyId === undefined)) {
    throw new Error("guardian.hmacKeyEnv and guardian.keyId must be configured together");
  }
  if (mode === "enforce" && value.startupPosture === undefined) {
    throw new Error("startupPosture must be explicit in enforce mode");
  }
  if (mode === "enforce" && hmacKeyEnv === undefined) {
    throw new Error("guardian.hmacKeyEnv and guardian.keyId are required in enforce mode");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (mode === "enforce" && url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    throw new Error("enforce mode requires https for non-loopback Guardian URLs");
  }

  const rawAudit = value.audit ?? {};
  assertObject(rawAudit, "audit");
  assertKeys(rawAudit, ["path", "includePayloads"], "audit");
  if (rawAudit.path !== undefined && typeof rawAudit.path !== "string") {
    throw new Error("audit.path must be a string");
  }
  if (rawAudit.includePayloads !== undefined && typeof rawAudit.includePayloads !== "boolean") {
    throw new Error("audit.includePayloads must be a boolean");
  }

  const rawAgent = value.agent ?? {};
  assertObject(rawAgent, "agent");
  assertKeys(rawAgent, ["id", "name", "environment"], "agent");
  const agentId = rawAgent.id ?? "pi-coding-agent";
  if (typeof agentId !== "string" || agentId.length === 0) throw new Error("agent.id must be non-empty");
  if (rawAgent.name !== undefined && typeof rawAgent.name !== "string") throw new Error("agent.name must be a string");
  const environment = rawAgent.environment ?? "development";
  if (!(["development", "staging", "production"] as const).includes(environment as never)) {
    throw new Error("agent.environment is invalid");
  }

  const auditPath = rawAudit.path === undefined
    ? undefined
    : isAbsolute(rawAudit.path) ? rawAudit.path : resolve(cwd, rawAudit.path);

  return {
    mode,
    startupPosture,
    guardian: {
      url: url.toString(),
      connectTimeoutMs: positiveInteger(value.guardian.connectTimeoutMs, 2_000, "guardian.connectTimeoutMs"),
      maxResponseBytes: positiveInteger(value.guardian.maxResponseBytes, 1_048_576, "guardian.maxResponseBytes"),
      ...(hmacKeyEnv === undefined ? {} : { hmacKeyEnv, keyId: keyId as string }),
    },
    audit: {
      ...(auditPath === undefined ? {} : { path: auditPath }),
      includePayloads: rawAudit.includePayloads === true,
    },
    agent: {
      id: agentId,
      ...(rawAgent.name === undefined ? {} : { name: rawAgent.name as string }),
      environment: environment as AcsConfig["agent"]["environment"],
    },
  };
}

export function findConfigPath(): string | undefined {
  const explicit = process.env.PI_ACS_CONFIG;
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
  const agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDirectory, "acs-core.json");
}

export function loadConfig(cwd = process.cwd()): LoadedConfig | undefined {
  const path = findConfigPath();
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return { config: parseConfig(parsed, cwd), path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.PI_ACS_CONFIG) return undefined;
    throw error;
  }
}
