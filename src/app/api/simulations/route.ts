import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Job } from "@/lib/domain";
import { updateStore } from "@/lib/store";

const schema = z.object({
  projectId: z.string().min(1),
  agents: z.number().int().min(5).max(250).default(35),
  seed: z.number().int().default(74121),
  market: z.object({
    latency: z.number().min(0).max(10).default(2), errors: z.number().min(0).max(5).default(1),
    onboarding: z.number().min(0).max(5).default(2), price: z.number().min(0).max(5).default(1),
  }).default({ latency: 2, errors: 1, onboarding: 2, price: 1 }),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Parámetros de simulación inválidos.", details: parsed.error.flatten() }, { status: 400 });
  const headerKey = req.headers.get("idempotency-key");
  if (headerKey && (headerKey.length < 8 || headerKey.length > 128)) return NextResponse.json({ error: "Idempotency-Key debe tener entre 8 y 128 caracteres." }, { status: 400 });
  const key = headerKey ?? randomUUID();
  const now = new Date().toISOString();
  const { result } = await updateStore((s) => {
    const prior = s.jobs.find((job) => job.type === "SIMULATION" && job.idempotencyKey === key);
    if (prior) return { job: structuredClone(prior), duplicate: true, missingProject: false };
    if (!s.projects.some((project) => project.id === parsed.data.projectId)) return { duplicate: false, missingProject: true };
    const job: Job = {
      id: randomUUID(), type: "SIMULATION", status: "QUEUED", progress: 0,
      payload: parsed.data, idempotencyKey: key, attempts: 0, maxAttempts: 3,
      createdAt: now, updatedAt: now,
    };
    s.jobs.unshift(job);
    s.activity.unshift({ id: randomUUID(), text: `Simulación encolada · ${parsed.data.agents} agentes · seed ${parsed.data.seed}`, at: now });
    return { job, duplicate: false, missingProject: false };
  });
  if (result.missingProject) return NextResponse.json({ error: "Proyecto inexistente." }, { status: 404 });
  return NextResponse.json({ job: result.job, duplicate: result.duplicate, notice: "Ejecución sintética determinista; no representa usuarios reales." }, { status: result.duplicate ? 200 : 202 });
}
