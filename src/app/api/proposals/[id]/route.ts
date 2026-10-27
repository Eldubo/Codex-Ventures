import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Job } from "../../../../lib/domain";
import { validateArtifactAgainstBase } from "../../../../lib/change-artifacts";
import { readStore, updateStore } from "../../../../lib/store";

const schema = z.object({ action: z.enum(["approve", "reject"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Acción inválida." }, { status: 400 });
  const { id } = await params;
  const current = (await readStore()).proposals.find((proposal) => proposal.id === id);
  if (!current) return NextResponse.json({ error: "Propuesta inexistente." }, { status: 404 });

  if (parsed.data.action === "approve") {
    if (current.status !== "PENDING_APPROVAL") return NextResponse.json({ error: "Solo se pueden aprobar propuestas pendientes de aprobación." }, { status: 409 });
    const validation = await validateArtifactAgainstBase(current.artifact);
    if (validation.status !== "VALID") {
      await updateStore((store) => {
        const proposal = store.proposals.find((item) => item.id === id);
        if (proposal?.status === "PENDING_APPROVAL" && proposal.artifact.hash === current.artifact.hash) {
          proposal.status = "INVALID";
          proposal.artifact.validation = validation;
          store.activity.unshift({ id: randomUUID(), text: `Propuesta invalidada por conflicto o diff inválido · ${proposal.id}`, at: validation.checkedAt });
        }
      });
      return NextResponse.json({ error: "La propuesta no pasó la validación del diff o su versión base cambió.", validation }, { status: 409 });
    }
    const { result } = await updateStore((store) => {
      const proposal = store.proposals.find((item) => item.id === id);
      if (!proposal) return { status: 404 as const, error: "Propuesta inexistente." };
      if (proposal.status !== "PENDING_APPROVAL" || proposal.artifact.hash !== current.artifact.hash) return { status: 409 as const, error: "La propuesta cambió o ya fue revisada." };
      const idempotencyKey = `implementation:${proposal.id}:${proposal.artifact.hash}`;
      const existing = store.jobs.find((job) => job.idempotencyKey === idempotencyKey);
      if (existing) return { status: 409 as const, error: "Ya existe un job para este artefacto." };
      const now = new Date().toISOString();
      proposal.status = "APPROVED";
      proposal.artifact.validation = validation;
      const job: Job = { id: randomUUID(), type: "IMPLEMENTATION", status: "QUEUED", progress: 0, payload: { proposalId: proposal.id, artifactHash: proposal.artifact.hash }, idempotencyKey, attempts: 0, maxAttempts: 1, createdAt: now, updatedAt: now };
      store.jobs.unshift(job);
      store.activity.unshift({ id: randomUUID(), text: `Propuesta aprobada y job aislado encolado · ${proposal.id}`, at: now });
      return { status: 202 as const, proposal: structuredClone(proposal), job };
    });
    return NextResponse.json(result, { status: result.status });
  }

  const { result } = await updateStore((store) => {
    const proposal = store.proposals.find((item) => item.id === id);
    if (!proposal) return { status: 404 as const, error: "Propuesta inexistente." };
    if (proposal.status !== "PROPOSED" && proposal.status !== "PENDING_APPROVAL") return { status: 409 as const, error: "La propuesta ya no puede rechazarse en este estado." };
    const now = new Date().toISOString();
    proposal.status = "REJECTED";
    store.activity.unshift({ id: randomUUID(), text: `Propuesta rechazada · ${proposal.title}`, at: now });
    return { status: 200 as const, proposal: structuredClone(proposal) };
  });
  return NextResponse.json(result, { status: result.status });
}
