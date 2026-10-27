import { randomUUID } from "node:crypto";
import { groupFeedback, metricsFromEvents, seededEvents, type ArtifactCheck, type ArtifactValidation, type Job } from "./domain";
import { publishJob } from "./job-events";
import { readStore, updateStore } from "./store";
import { ArtifactError, createDemoProposal, prepareWorkspace } from "./change-artifacts";
import { sandboxExecutor, type SandboxExecution } from "./sandbox";

const MAX_ATTEMPTS = 3;
type WorkerGlobal = typeof globalThis & { __codexVenturesWorker?: boolean; __codexVenturesBusy?: boolean; __codexVenturesTick?: NodeJS.Timeout };

class ImplementationFailure extends Error {
  constructor(message: string, public readonly proposalStatus: "INVALID" | "FAILED", public readonly validation: ArtifactValidation, public readonly details: Record<string, unknown>) { super(message); }
}

export async function recoverInterruptedJobs() {
  const before = await readStore();
  if (!before.jobs.some((job) => job.status === "RUNNING")) return;
  const { result } = await updateStore((s) => {
    const recovered: Job[] = [];
    for (const job of s.jobs) if (job.status === "RUNNING") {
      const exhausted = job.attempts >= job.maxAttempts;
      job.status = exhausted ? "FAILED" : "QUEUED";
      if (!exhausted) job.progress = 0;
      job.error = exhausted
        ? "El proceso se reinició y el job ya había agotado sus intentos; requiere reintento manual."
        : "El proceso se reinició mientras el job estaba activo; se reencoló para recuperarlo.";
      job.updatedAt = new Date().toISOString();
      if (exhausted) {
        job.finishedAt = job.updatedAt;
        if (job.type === "IMPLEMENTATION") {
          const proposal = s.proposals.find((item) => item.id === String(job.payload.proposalId ?? ""));
          if (proposal && proposal.status !== "REJECTED") proposal.status = "FAILED";
        }
      }
      recovered.push(job);
    }
    return recovered;
  });
  for (const job of result) publishJob(job);
}

async function claimJob(): Promise<Job | undefined> {
  const snapshot = await readStore();
  if (!snapshot.jobs.some((job) => job.status === "QUEUED" && job.attempts < job.maxAttempts)) return undefined;
  const { result } = await updateStore((s) => {
    const job = s.jobs.find((candidate) => candidate.status === "QUEUED" && candidate.attempts < candidate.maxAttempts);
    if (!job) return undefined;
    job.status = "RUNNING"; job.progress = 5; job.error = undefined; job.attempts += 1;
    job.startedAt ??= new Date().toISOString(); job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  });
  if (result) publishJob(result);
  return result;
}

async function setProgress(jobId: string, progress: number) {
  const { result } = await updateStore((s) => {
    const job = s.jobs.find((j) => j.id === jobId);
    if (!job || job.status !== "RUNNING") return undefined;
    job.progress = progress; job.updatedAt = new Date().toISOString();
    return structuredClone(job);
  });
  if (result) publishJob(result);
}

async function runSimulation(job: Job) {
  const { projectId, agents, seed, market } = job.payload as { projectId: string; agents: number; seed: number; market: { latency: number; errors: number; onboarding: number; price: number } };
  const snapshot = await readStore();
  const project = snapshot.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("El proyecto asociado al job ya no existe.");
  await setProgress(job.id, 25);
  const events = seededEvents(job.id, agents, seed, market);
  const metrics = metricsFromEvents(events);
  await setProgress(job.id, 70);
  const reports = groupFeedback(events);
  const candidateProposals = await Promise.all(reports.map((report) => createDemoProposal({
    id: `${job.id}-proposal-${report.id}`,
    title: `Investigar: ${report.title.toLowerCase()}`,
    problem: `${report.title} puede bloquear el valor principal del producto.`,
    evidence: report.evidence,
    priority: report.severity === "Alta" ? "Alta" : "Media",
  })));
  const { result } = await updateStore((s) => {
    if (s.runs.some((run) => run.id === job.id)) return { runId: job.id, metrics, events: events.length, reports: reports.length };
    s.events.push(...events);
    s.runs.unshift({ id: job.id, projectId, version: project.version, seed, agents, status: "COMPLETED", createdAt: job.createdAt, metrics });
    s.reports = [...reports.map((report) => ({ ...report, id: `${job.id}-${report.id}` })), ...s.reports].slice(0, 50);
    for (const proposal of candidateProposals) {
      const duplicate = s.proposals.some((item) => item.evidence === proposal.evidence && item.status !== "REJECTED");
      if (!duplicate) s.proposals.unshift(proposal);
    }
    s.activity.unshift({ id: randomUUID(), text: `Simulación completada · ${agents} agentes · seed ${seed}`, at: new Date().toISOString() });
    return { runId: job.id, metrics, events: events.length, reports: reports.length };
  });
  return result;
}

async function runImplementation(job: Job) {
  const proposalId = String(job.payload.proposalId ?? "");
  const current = (await readStore()).proposals.find((proposal) => proposal.id === proposalId);
  if (!current || current.status !== "APPROVED" || !current.artifact || current.artifact.hash !== String(job.payload.artifactHash ?? "")) {
    const validation: ArtifactValidation = { status: "INVALID", errors: ["La propuesta o su hash no coincide con el job aprobado."], checkedAt: new Date().toISOString() };
    throw new ImplementationFailure("Artefacto inválido para el job aprobado.", "INVALID", validation, { validation });
  }
  let workspace;
  try { workspace = await prepareWorkspace(current.artifact); }
  catch (error) {
    const code = error instanceof ArtifactError ? error.code : "WORKSPACE";
    const status = code === "BASE_CONFLICT" ? "CONFLICT" : "INVALID";
    const validation: ArtifactValidation = { status, errors: [error instanceof Error ? error.message : "No se pudo preparar el workspace."], checkedAt: new Date().toISOString() };
    throw new ImplementationFailure(validation.errors[0]!, "INVALID", validation, { validation, artifactHash: current.artifact.hash });
  }
  let execution: SandboxExecution;
  try {
    await updateStore((store) => {
      const proposal = store.proposals.find((item) => item.id === proposalId);
      if (!proposal || proposal.status !== "APPROVED" || proposal.artifact.hash !== current.artifact.hash) throw new Error("La propuesta cambió antes de comenzar la ejecución.");
      proposal.status = "RUNNING";
      proposal.artifact.validation = { status: "VALID", errors: [], checkedAt: new Date().toISOString() };
      store.activity.unshift({ id: randomUUID(), text: `Ejecución aislada iniciada · ${proposal.id}`, at: new Date().toISOString() });
    });
    await setProgress(job.id, 20);
    execution = await sandboxExecutor.execute({ workspaceId: job.id, files: current.artifact.changedFiles, commands: ["install", "test", "typecheck", "lint"], timeoutMs: 120_000 }, workspace);
  } finally {
    await workspace.dispose();
  }
  const checks = execution.checks as ArtifactCheck[];
  const passed = execution.executed && execution.status === "COMPLETED" && execution.exitCode === 0
    && checks.length === 4 && checks.every((check, index) => check.command === ["install", "test", "typecheck", "lint"][index] && check.status === "PASSED" && check.exitCode === 0);
  const validation: ArtifactValidation = {
    status: passed ? "PASSED" : "FAILED",
    errors: passed ? [] : [execution.reason],
    checkedAt: new Date().toISOString(),
    checks,
    appliedHash: workspace.appliedHash,
  };
  const details = { artifactHash: current.artifact.hash, baseVersion: current.artifact.baseVersion, appliedHash: workspace.appliedHash, diff: current.artifact.diff, validation, execution };
  if (!passed) throw new ImplementationFailure(`Validación aislada fallida en ${execution.stage}: ${execution.reason}`, "FAILED", validation, details);
  return details;
}

export async function processNextJob() {
  const job = await claimJob();
  if (!job) return false;
  try {
    const result = job.type === "SIMULATION" ? await runSimulation(job) : await runImplementation(job);
    const { result: completed } = await updateStore((s) => {
      const current = s.jobs.find((j) => j.id === job.id)!;
      current.status = "SUCCEEDED"; current.progress = 100; current.result = result as Record<string, unknown>;
      current.updatedAt = new Date().toISOString(); current.finishedAt = current.updatedAt;
      if (current.type === "IMPLEMENTATION") {
        const proposal = s.proposals.find((item) => item.id === String(current.payload.proposalId ?? ""));
        if (proposal && proposal.status === "RUNNING" && proposal.artifact.hash === String(current.payload.artifactHash ?? "")) {
          proposal.status = "VALIDATED";
          proposal.artifact.validation = (result as { validation: ArtifactValidation }).validation;
        }
      }
      return structuredClone(current);
    });
    publishJob(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado del worker.";
    const { result: failed } = await updateStore((s) => {
      const current = s.jobs.find((j) => j.id === job.id)!;
      current.error = message; current.updatedAt = new Date().toISOString();
      if (error instanceof ImplementationFailure) current.result = error.details;
      const retryable = current.type === "SIMULATION" && current.attempts < current.maxAttempts;
      current.status = retryable ? "QUEUED" : "FAILED";
      if (!retryable) current.finishedAt = current.updatedAt;
      if (current.type === "IMPLEMENTATION" && !retryable) {
        const proposal = s.proposals.find((p) => p.id === String(current.payload.proposalId ?? ""));
        if (proposal && proposal.status !== "REJECTED") {
          proposal.status = error instanceof ImplementationFailure ? error.proposalStatus : "FAILED";
          if (error instanceof ImplementationFailure) proposal.artifact.validation = error.validation;
        }
      }
      s.activity.unshift({ id: randomUUID(), text: `Job ${retryable ? "reencolado" : "fallido"} · ${message}`, at: new Date().toISOString() });
      return structuredClone(current);
    });
    publishJob(failed);
  }
  return true;
}

async function tick() {
  const root = globalThis as WorkerGlobal;
  if (root.__codexVenturesBusy) return;
  root.__codexVenturesBusy = true;
  try {
    while (await processNextJob()) { /* serial worker drains the queue */ }
  } catch (error) {
    console.error("Codex-Ventures worker tick failed:", error instanceof Error ? error.message : "unknown error");
  } finally {
    root.__codexVenturesBusy = false;
  }
}

export async function startWorker() {
  const root = globalThis as WorkerGlobal;
  if (root.__codexVenturesWorker) return;
  root.__codexVenturesWorker = true;
  try { await recoverInterruptedJobs(); } catch (error) { console.error("Could not recover persisted jobs:", error instanceof Error ? error.message : "unknown error"); }
  void tick();
  root.__codexVenturesTick = setInterval(() => { void tick(); }, 1000);
  root.__codexVenturesTick.unref();
}

export const workerPolicy = { maxAttempts: MAX_ATTEMPTS, concurrency: 1, intervalMs: 1000 } as const;
