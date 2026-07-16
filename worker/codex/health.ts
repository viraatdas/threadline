import { createServer, type Server } from "node:http";

import type { AnalysisRunnerHealth } from "../../lib/domain/contracts";

import type { StoreHealth, WorkerLogger } from "./types";

export interface WorkerHealthSnapshot {
  state: "starting" | "idle" | "processing" | "stopping" | "stopped";
  startedAt: string;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  inFlightJobId: string | null;
  database: StoreHealth;
  runner: AnalysisRunnerHealth;
}

export class WorkerHealth {
  private snapshot: WorkerHealthSnapshot;

  constructor(startedAt: Date) {
    this.snapshot = {
      state: "starting",
      startedAt: startedAt.toISOString(),
      lastPollAt: null,
      lastSuccessAt: null,
      inFlightJobId: null,
      database: { ok: false, detail: "Not checked yet." },
      runner: { ok: false, runner: "codex-cli", detail: "Not checked yet." },
    };
  }

  get(): WorkerHealthSnapshot {
    return structuredClone(this.snapshot);
  }

  dependencies(database: StoreHealth, runner: AnalysisRunnerHealth): void {
    this.snapshot = { ...this.snapshot, database, runner };
  }

  idle(polledAt: Date): void {
    this.snapshot = {
      ...this.snapshot,
      state: "idle",
      lastPollAt: polledAt.toISOString(),
      inFlightJobId: null,
    };
  }

  processing(jobId: string, polledAt: Date): void {
    this.snapshot = {
      ...this.snapshot,
      state: "processing",
      lastPollAt: polledAt.toISOString(),
      inFlightJobId: jobId,
    };
  }

  succeeded(at: Date): void {
    this.snapshot = {
      ...this.snapshot,
      state: "idle",
      lastSuccessAt: at.toISOString(),
      inFlightJobId: null,
    };
  }

  stopping(): void {
    this.snapshot = { ...this.snapshot, state: "stopping" };
  }

  stopped(): void {
    this.snapshot = { ...this.snapshot, state: "stopped", inFlightJobId: null };
  }
}

export function startHealthServer(
  port: number,
  health: WorkerHealth,
  logger: WorkerLogger,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const snapshot = health.get();
      const live = snapshot.state !== "stopped";
      const ready = live && snapshot.database.ok && snapshot.runner.ok;
      const pathname = request.url?.split("?", 1)[0];

      if (pathname === "/livez") {
        response.writeHead(live ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: live, state: snapshot.state }));
        return;
      }
      if (pathname === "/readyz") {
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: ready, database: snapshot.database, runner: snapshot.runner }));
        return;
      }
      if (pathname === "/healthz") {
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: ready, ...snapshot }));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });

    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.removeListener("error", reject);
      logger.info("health_server_started", { port });
      resolve(server);
    });
  });
}

export function closeHealthServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
