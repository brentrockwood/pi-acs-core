import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { AcsConfig } from "./config.js";

export interface AuditEvent {
  event: string;
  session_id?: string;
  request_id?: string;
  method?: string;
  decision?: string;
  failure_kind?: string;
  message?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export class AuditSink {
  constructor(private readonly config: AcsConfig["audit"]) {}

  async write(event: AuditEvent): Promise<void> {
    if (!this.config.path) return;
    const record = {
      timestamp: new Date().toISOString(),
      ...event,
      ...(!this.config.includePayloads && "payload" in event ? { payload: "[omitted]" } : {}),
    };
    try {
      await mkdir(dirname(this.config.path), { recursive: true });
      await appendFile(this.config.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Audit recording is deliberately passive. Enforcement handlers record
      // their decision separately and must not change it because a sink fails.
    }
  }
}
