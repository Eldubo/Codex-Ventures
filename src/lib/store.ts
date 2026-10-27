import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { groupFeedback, metricsFromEvents, seededEvents, type Store } from "./domain";
import { createDemoProposal, upgradeProposal } from "./change-artifacts";

export interface WorkspaceRepository {
  read(): Promise<Store>;
  update<T>(fn: (store: Store) => T | Promise<T>): Promise<{ store: Store; result: T }>;
  reset(): Promise<Store>;
}

const dataDir = process.env.CODEX_VENTURES_DATA_DIR ? path.resolve(process.env.CODEX_VENTURES_DATA_DIR) : path.join(process.cwd(), ".data");
const file = path.join(dataDir, "codex-ventures.json");
const projectId = "demo-habits";
let writeTail: Promise<void> = Promise.resolve();

async function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const previous = writeTail;
  let release!: () => void;
  writeTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); } finally { release(); }
}

async function atomicWrite(store: Store) {
  await mkdir(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await rename(tmp, file);
}

export async function seedStore(): Promise<Store> {
  const now = new Date().toISOString();
  const events = seededEvents("demo-run-01", 35, 74121, { latency: 2, errors: 1, onboarding: 2, price: 1 }, new Date("2026-10-26T12:00:00.000Z"));
  const metrics = metricsFromEvents(events);
  const reports = groupFeedback(events);
  const proposal = await createDemoProposal({ id: "proposal-demo", title: "Agregar una etiqueta de valor comprobable", problem: "Fixture de aceptación para probar el flujo completo de propuesta, diff y validación aislada", evidence: `${reports.find((r) => r.category === "Fricción en onboarding")?.frequency ?? 0} de 35 agentes abandonaron durante registro o activación; muestra sintética pequeña.`, priority: "Baja" });
  return {
    projects: [{ id: projectId, name: "DevHabit", idea: "Una app minimalista para sostener hábitos de desarrollo y aprender en sesiones cortas.", audience: "Desarrolladores independientes y equipos pequeños", problem: "Los objetivos de aprendizaje y práctica se diluyen entre tareas y herramientas.", value: "Convertir una intención diaria en una rutina breve y visible.", thesis: { summary: "DevHabit ayuda a desarrolladores a construir constancia con hábitos pequeños, seguimiento claro y recordatorios sin ruido.", features: ["Rutina diaria de 10 minutos", "Seguimiento semanal", "Recordatorios configurables"], hypotheses: ["La rutina corta mejora la activación inicial", "El progreso semanal impulsa el retorno"], risks: ["Fatiga por notificaciones", "Retención baja después de la primera semana"] }, specification: ["Como usuario quiero crear un hábito con una meta diaria para comenzar rápido.", "Como usuario quiero ver mi racha semanal para entender mi progreso.", "Criterio: completar la acción diaria actualiza el progreso una sola vez por día."], version: "v1.0", createdAt: now }],
    runs: [{ id: "demo-run-01", projectId, version: "v1.0", seed: 74121, agents: 35, status: "COMPLETED", createdAt: "2026-10-26T12:00:00.000Z", metrics }],
    events,
    reports,
    proposals: [proposal],
    jobs: [],
    activity: [{ id: "activity-demo", text: "Demo sintética cargada · 35 agentes · seed 74121", at: now }],
  };
}

export async function resetStore(): Promise<Store> {
  return serialized(async () => {
    const current = await readStore();
    if (current.jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) throw new Error("No se puede reiniciar mientras haya jobs activos.");
    const initial = await seedStore();
    await atomicWrite(initial);
    return initial;
  });
}

export async function readStore(): Promise<Store> {
  await mkdir(dataDir, { recursive: true });
  try {
    const store = JSON.parse(await readFile(file, "utf8")) as Store;
    store.jobs ??= [];
    let migrated = false;
    for (let index = 0; index < store.proposals.length; index++) {
      const proposal = store.proposals[index]!;
      if (!(proposal as Partial<typeof proposal>).artifact) {
        store.proposals[index] = await upgradeProposal(proposal);
        migrated = true;
      }
    }
    if (migrated) await atomicWrite(store);
    return store;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const initial = await seedStore();
    try { await writeFile(file, JSON.stringify(initial, null, 2), { encoding: "utf8", flag: "wx" }); }
    catch (createError) { if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError; }
    return JSON.parse(await readFile(file, "utf8")) as Store;
  }
}

export async function updateStore<T>(fn: (store: Store) => T | Promise<T>): Promise<{ store: Store; result: T }> {
  return serialized(async () => {
    const store = await readStore();
    const result = await fn(store);
    await atomicWrite(store);
    return { store, result };
  });
}

export const jsonWorkspaceRepository = { read: readStore, update: updateStore, reset: resetStore } satisfies WorkspaceRepository;
