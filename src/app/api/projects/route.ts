import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateStore } from "@/lib/store";
const schema = z.object({ name: z.string().trim().min(2).max(60), idea: z.string().trim().min(12).max(1200), audience: z.string().max(200).default("Por validar"), problem: z.string().max(300).default("Por validar"), value: z.string().max(300).default("Por validar") });
export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Revisá el nombre y la idea (mínimo 12 caracteres).", details: parsed.error.flatten() }, { status: 400 });
  const project = { id: randomUUID(), ...parsed.data, thesis: { summary: parsed.data.idea, features: ["Flujo principal de valor", "Seguimiento del progreso", "Preferencias del usuario"], hypotheses: ["El usuario completará una acción principal en la primera sesión", "El valor frecuente impulsará el retorno"], risks: ["La propuesta todavía requiere validación con personas reales"] }, specification: ["Como usuario quiero completar la tarea principal con pocos pasos.", "Como usuario quiero entender el valor y el progreso desde el panel.", "Criterio: el flujo principal conserva su estado y muestra confirmación."], version: "v1.0", createdAt: new Date().toISOString() };
  await updateStore((s) => { s.projects.unshift(project); s.activity.unshift({ id: randomUUID(), text: `Proyecto creado · ${project.name}`, at: new Date().toISOString() }); });
  return NextResponse.json(project, { status: 201 });
}
