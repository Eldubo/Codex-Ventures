import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { publishJob } from "@/lib/job-events";
import { readStore, updateStore } from "@/lib/store";
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await readStore();
  const job = store.jobs.find((item) => item.id === id);
  if (!job) return NextResponse.json({ error: "Job inexistente." }, { status: 404 });
  return NextResponse.json({ job });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => null) as { action?: unknown } | null;
  if (body?.action !== "cancel") return NextResponse.json({ error: "Acción inválida." }, { status: 400 });
  const { id } = await params;
  const { result } = await updateStore((store) => {
    const job = store.jobs.find((item) => item.id === id);
    if (!job) return { status: 404 as const, error: "Job inexistente." };
    if (job.status !== "QUEUED") return { status: 409 as const, error: "Solo se pueden cancelar jobs que aún están en cola." };
    job.status = "CANCELLED"; job.updatedAt = new Date().toISOString(); job.finishedAt = job.updatedAt;
    store.activity.unshift({ id: randomUUID(), text: `Job cancelado · ${job.id}`, at: job.updatedAt });
    return { status: 200 as const, job: structuredClone(job) };
  });
  if (result.job) publishJob(result.job);
  return NextResponse.json(result, { status: result.status });
}
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { result } = await updateStore((store) => {
    const job = store.jobs.find((item) => item.id === id);
    if (!job) return { status: 404 as const, error: "Job inexistente." };
    if (job.status !== "FAILED") return { status: 409 as const, error: "Solo se puede reintentar un job fallido." };
    if (job.type === "IMPLEMENTATION") return { status: 409 as const, error: "Un artefacto de implementación fallido no se puede ejecutar de nuevo. Generá una propuesta nueva para evitar duplicados." };
    job.status = "QUEUED"; job.progress = 0; job.attempts = 0; job.error = undefined;
    job.startedAt = undefined; job.finishedAt = undefined; job.updatedAt = new Date().toISOString();
    store.activity.unshift({ id: randomUUID(), text: `Job reintentado manualmente · ${job.id}`, at: job.updatedAt });
    return { status: 202 as const, job: structuredClone(job) };
  });
  if (result.job) publishJob(result.job);
  return NextResponse.json(result, { status: result.status });
}
