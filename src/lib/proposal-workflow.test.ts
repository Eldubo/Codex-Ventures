import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { DockerSandboxExecutor } from "./sandbox";

describe("proposal approval and isolated validation", () => {
  let tempDir = "";
  let previousDataDir: string | undefined;
  let store: typeof import("./store");
  let worker: typeof import("./worker");
  let patchProposal: typeof import("../app/api/proposals/[id]/route").PATCH;

  beforeAll(async () => {
    previousDataDir = process.env.CODEX_VENTURES_DATA_DIR;
    tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-proposal-flow-"));
    process.env.CODEX_VENTURES_DATA_DIR = tempDir;
    [store, worker, { PATCH: patchProposal }] = await Promise.all([
      import("./store"),
      import("./worker"),
      import("../app/api/proposals/[id]/route"),
    ]);
  });

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.CODEX_VENTURES_DATA_DIR;
    else process.env.CODEX_VENTURES_DATA_DIR = previousDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function review(id: string, action: "approve" | "reject") {
    const request = new NextRequest(`http://localhost/api/proposals/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    return patchProposal(request, { params: Promise.resolve({ id }) });
  }

  it("rejects proposal state transitions and duplicate approvals", async () => {
    await store.resetStore();
    const rejected = await review("proposal-demo", "reject");
    expect(rejected.status).toBe(200);
    expect((await review("proposal-demo", "approve")).status).toBe(409);
    expect((await store.readStore()).jobs).toHaveLength(0);

    await store.resetStore();
    expect((await review("proposal-demo", "approve")).status).toBe(202);
    expect((await review("proposal-demo", "approve")).status).toBe(409);
    const snapshot = await store.readStore();
    expect(snapshot.jobs.filter((job) => job.type === "IMPLEMENTATION")).toHaveLength(1);
    expect(snapshot.proposals[0]?.status).toBe("APPROVED");
    await store.updateStore((state) => { state.jobs[0]!.status = "CANCELLED"; });
  });

  it("marks tampered or base-conflicted artifacts INVALID without enqueueing a job", async () => {
    await store.resetStore();
    await store.updateStore((snapshot) => { snapshot.proposals[0]!.artifact.baseHash = "0".repeat(64); });
    const response = await review("proposal-demo", "approve");
    expect(response.status).toBe(409);
    let snapshot = await store.readStore();
    expect(snapshot.proposals[0]?.status).toBe("INVALID");
    expect(snapshot.proposals[0]?.artifact.validation.status).toBe("CONFLICT");
    expect(snapshot.jobs).toHaveLength(0);

    await store.resetStore();
    await store.updateStore((current) => { current.proposals[0]!.artifact.diff += "tamper"; });
    expect((await review("proposal-demo", "approve")).status).toBe(409);
    snapshot = await store.readStore();
    expect(snapshot.proposals[0]?.status).toBe("INVALID");
    expect(snapshot.proposals[0]?.artifact.validation.status).toBe("INVALID");
  });

  it("approves, installs, tests, and records a proposal entirely in a disposable Docker workspace", async (ctx) => {
    const availability = await new DockerSandboxExecutor().checkAvailability();
    if (!availability.available) ctx.skip(availability.reason);
    await store.resetStore();
    const beforeFiles = await readdir(os.tmpdir());
    const beforeWorkspaces = new Set(beforeFiles.filter((name) => name.startsWith("codex-ventures-proposal-")));
    expect((await review("proposal-demo", "approve")).status).toBe(202);
    expect(await worker.processNextJob()).toBe(true);

    const after = await store.readStore();
    const proposal = after.proposals.find((item) => item.id === "proposal-demo")!;
    const job = after.jobs.find((item) => item.type === "IMPLEMENTATION")!;
    expect(proposal.status, `Diagnóstico del job aislado: ${JSON.stringify(job)}`).toBe("VALIDATED");
    expect(proposal.artifact.validation.status).toBe("PASSED");
    expect(proposal.artifact.validation.checks?.map((check) => check.command)).toEqual(["install", "test", "typecheck", "lint"]);
    expect(proposal.artifact.validation.checks?.every((check) => check.status === "PASSED" && check.exitCode === 0)).toBe(true);
    expect(job.status).toBe("SUCCEEDED");
    expect(job.result?.appliedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(job.result?.diff).toBe(proposal.artifact.diff);
    expect((job.result?.execution as { stdout: string }).stdout).toContain("value-label.test.ts");
    const afterFiles = await readdir(os.tmpdir());
    expect(afterFiles.filter((name) => name.startsWith("codex-ventures-proposal-") && !beforeWorkspaces.has(name))).toEqual([]);
  }, 180_000);
});
