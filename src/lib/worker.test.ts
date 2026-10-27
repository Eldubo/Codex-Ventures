import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Job } from "./domain";
import { validateSandboxRequest, type SandboxRequest } from "./sandbox";

describe("local durable worker", () => {
  let tempDir = "";
  let previousDataDir: string | undefined;
  let store: typeof import("./store");
  let worker: typeof import("./worker");

  beforeAll(async () => {
    previousDataDir = process.env.CODEX_VENTURES_DATA_DIR;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-ventures-worker-"));
    process.env.CODEX_VENTURES_DATA_DIR = tempDir;
    store = await import("./store");
    worker = await import("./worker");
    await store.resetStore();
  });

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.CODEX_VENTURES_DATA_DIR;
    else process.env.CODEX_VENTURES_DATA_DIR = previousDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serializes concurrent JSON updates without losing entries", async () => {
    await Promise.all(Array.from({ length: 16 }, (_, i) => store.updateStore((s) => {
      s.activity.unshift({ id: `parallel-${i}`, text: `parallel ${i}`, at: new Date().toISOString() });
    })));
    const result = await store.readStore();
    expect(result.activity.filter((event) => event.id.startsWith("parallel-")).length).toBe(16);
  });

  it("recovers interrupted jobs to the queue after a process restart", async () => {
    const now = new Date().toISOString();
    const job: Job = { id: "interrupted", type: "SIMULATION", status: "RUNNING", progress: 45, payload: {}, idempotencyKey: "interrupted-key", attempts: 1, maxAttempts: 3, createdAt: now, updatedAt: now, startedAt: now };
    await store.updateStore((s) => { s.jobs.unshift(job); });
    await worker.recoverInterruptedJobs();
    const recovered = (await store.readStore()).jobs.find((item) => item.id === job.id);
    expect(recovered?.status).toBe("QUEUED");
    expect(recovered?.error).toContain("se reinició");
    await store.updateStore((s) => { s.jobs.find((item) => item.id === job.id)!.status = "CANCELLED"; });
  });

  it("marks interrupted jobs failed when the retry budget is exhausted", async () => {
    const now = new Date().toISOString();
    const job: Job = { id: "exhausted", type: "SIMULATION", status: "RUNNING", progress: 80, payload: {}, idempotencyKey: "exhausted-key", attempts: 3, maxAttempts: 3, createdAt: now, updatedAt: now, startedAt: now };
    await store.updateStore((s) => { s.jobs.unshift(job); });
    await worker.recoverInterruptedJobs();
    const failed = (await store.readStore()).jobs.find((item) => item.id === job.id);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.finishedAt).toBeTruthy();
    expect(failed?.error).toContain("agotado sus intentos");
  });

  it("runs and persists a queued simulation exactly once", async () => {
    const now = new Date().toISOString();
    const job: Job = { id: "simulation-1", type: "SIMULATION", status: "QUEUED", progress: 0, payload: { projectId: "demo-habits", agents: 35, seed: 324, market: { latency: 1, errors: 1, onboarding: 1, price: 1 } }, idempotencyKey: "simulation-key-324", attempts: 0, maxAttempts: 3, createdAt: now, updatedAt: now };
    await store.updateStore((s) => { s.jobs.unshift(job); });
    await worker.processNextJob();
    await worker.processNextJob();
    const result = await store.readStore();
    expect(result.jobs.find((item) => item.id === job.id)?.status).toBe("SUCCEEDED");
    expect(result.runs.filter((run) => run.id === job.id)).toHaveLength(1);
    expect(result.events.filter((event) => event.runId === job.id).length).toBeGreaterThan(0);
  });

  it("refuses an implementation job whose approved artifact hash does not match", async () => {
    const now = new Date().toISOString();
    const job: Job = { id: "implementation", type: "IMPLEMENTATION", status: "QUEUED", progress: 0, payload: { proposalId: "proposal-demo", artifactHash: "wrong-hash" }, idempotencyKey: "implementation:proposal-demo", attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now };
    await store.updateStore((s) => { s.proposals[0].status = "APPROVED"; s.jobs.unshift(job); });
    await worker.processNextJob();
    const result = await store.readStore();
    expect(result.jobs.find((item) => item.id === job.id)?.status).toBe("FAILED");
    expect(result.jobs.find((item) => item.id === job.id)?.error).toContain("Artefacto inválido");
    expect(result.proposals.find((item) => item.id === "proposal-demo")?.status).toBe("INVALID");
  });

  it("rejects sandbox path traversal, secret files and unapproved commands", () => {
    const base: SandboxRequest = { workspaceId: "review-123", files: ["src/lib/value-label.ts"], commands: ["install", "test", "typecheck", "lint"], timeoutMs: 30000 };
    expect(validateSandboxRequest(base)).toBeUndefined();
    expect(validateSandboxRequest({ ...base, files: ["../../.env"] })).toContain("src/lib");
    expect(validateSandboxRequest({ ...base, files: [".git/config"] })).toContain("src/lib");
    expect(validateSandboxRequest({ ...base, commands: ["powershell" as never] })).toContain("no permitido");
  });
});
