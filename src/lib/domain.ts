export type Event = { id: string; runId: string; agent: string; segment: string; action: string; outcome: string; at: string };
export type Report = { id: string; title: string; category: string; severity: string; frequency: number; confidence: number; status: string; evidence: string };
export type ProposalPriority = "Alta" | "Media" | "Baja";
export type ProposalStatus = "PROPOSED" | "PENDING_APPROVAL" | "APPROVED" | "INVALID" | "RUNNING" | "FAILED" | "VALIDATED" | "REJECTED";
export type ArtifactValidationStatus = "VALID" | "INVALID" | "CONFLICT" | "PASSED" | "FAILED";
export type ArtifactCommand = "install" | "test" | "typecheck" | "lint" | "build" | "smoke";
export type ArtifactCheck = { command: ArtifactCommand; status: "PASSED" | "FAILED" | "NOT_RUN"; exitCode: number | null; durationMs: number; stdout: string; stderr: string; stage: string; outputTruncated?: boolean };
export type ArtifactValidation = { status: ArtifactValidationStatus; errors: string[]; checkedAt: string; checks?: ArtifactCheck[]; appliedHash?: string };
export type ChangeArtifact = { baseVersion: string; baseHash: string; diff: string; changedFiles: string[]; hash: string; acceptanceCriteria: string[]; source: "DEMO_FIXTURE"; validation: ArtifactValidation };
export type Proposal = { id: string; title: string; problem: string; evidence: string; priority: ProposalPriority; status: ProposalStatus; createdAt: string; artifact: ChangeArtifact };
export type Run = { id: string; projectId: string; version: string; seed: number; agents: number; status: string; createdAt: string; metrics: { visitors: number; signups: number; activated: number; converted: number; retained: number; errors: number; satisfaction: number; revenue: number } };
export type Project = { id: string; name: string; idea: string; audience: string; problem: string; value: string; thesis: { summary: string; features: string[]; hypotheses: string[]; risks: string[] }; specification: string[]; version: string; createdAt: string };
export type Job = { id: string; type: "SIMULATION" | "IMPLEMENTATION"; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"; progress: number; payload: Record<string, unknown>; idempotencyKey: string; attempts: number; maxAttempts: number; createdAt: string; updatedAt: string; startedAt?: string; finishedAt?: string; error?: string; result?: Record<string, unknown> };
export type Store = { projects: Project[]; runs: Run[]; events: Event[]; reports: Report[]; proposals: Proposal[]; jobs: Job[]; activity: { id: string; text: string; at: string }[] };

export function metricsFromEvents(events: Event[]) {
  const people = new Map<string, Set<string>>();
  for (const e of events) { if (!people.has(e.agent)) people.set(e.agent, new Set()); if (e.outcome === "success") people.get(e.agent)!.add(e.action); }
  const n = people.size;
  const count = (action: string) => [...people.values()].filter((s) => s.has(action)).length;
  const visitors = count("visit"), signups = count("signup"), activated = count("activate"), converted = count("premium"), retained = count("return");
  return { visitors, signups, activated, converted, retained, errors: events.filter((e) => e.outcome === "error").length, satisfaction: n ? Math.round(events.reduce((s, e) => s + (e.outcome === "success" ? 4 : e.outcome === "error" ? 1 : 3), 0) / events.length * 20) / 20 : 0, revenue: converted * 8 };
}

export function seededEvents(runId: string, count: number, seed: number, market: { latency: number; errors: number; onboarding: number; price: number }, now = new Date()) {
  let x = seed >>> 0;
  const rand = () => { x = (1664525 * x + 1013904223) >>> 0; return x / 4294967296; };
  const segments = ["Usuario nuevo", "Frecuente", "Impaciente", "Sensible al precio", "Explorador", "Dificultades de usabilidad", "Busca función específica"];
  const events: Event[] = [];
  for (let i = 0; i < count; i++) {
    const agent = `Agente ${String(i + 1).padStart(2, "0")}`; const segment = segments[i % segments.length]; const time = new Date(now.getTime() + i * 1300);
    const add = (action: string, outcome: string) => events.push({ id: `${runId}-${i}-${action}`, runId, agent, segment, action, outcome, at: time.toISOString() });
    add("visit", "success");
    const signupP = Math.max(.25, .88 - market.onboarding * .1 - market.errors * .2 - market.latency * .025);
    if (rand() > signupP) { add("signup", "abandoned"); continue; } add("signup", "success");
    if (rand() < market.errors * .13) { add("activate", "error"); continue; }
    if (rand() < Math.max(.25, .87 - market.onboarding * .1)) { add("activate", "success"); add("task", "success"); }
    else { add("activate", "abandoned"); continue; }
    const sensitive = segment === "Sensible al precio";
    if (rand() < (sensitive ? .52 - market.price * .12 : .24 - market.price * .035)) add("premium", "success");
    if (rand() > market.latency * .08 + market.errors * .04) add("return", "success");
    add("feedback", rand() < .7 ? "success" : "friction");
  }
  return events;
}

export function groupFeedback(events: Event[]): Report[] {
  const failures = new Set(events.filter((e) => e.outcome === "error").map((e) => e.agent)).size;
  const abandonment = new Set(events.filter((e) => e.outcome === "abandoned").map((e) => e.agent)).size;
  const reports: Report[] = [];
  if (failures) reports.push({ id: "report-errors", title: "Fallas durante el flujo principal", category: "Errores funcionales", severity: failures > 4 ? "Alta" : "Media", frequency: failures, confidence: Math.min(96, 55 + failures * 6), status: "Abierto", evidence: `${failures} eventos de error observados en la simulación.` });
  if (abandonment) reports.push({ id: "report-onboarding", title: "Abandono durante el onboarding", category: "Fricción en onboarding", severity: abandonment > 5 ? "Alta" : "Media", frequency: abandonment, confidence: Math.min(90, 50 + abandonment * 4), status: "Abierto", evidence: `${abandonment} agentes no completaron el registro o la activación.` });
  return reports;
}
