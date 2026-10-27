import { NextResponse } from "next/server";
import { resetStore } from "@/lib/store";
export async function POST() {
  try { return NextResponse.json({ message: "Escenario demo restablecido.", store: await resetStore() }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo reiniciar el escenario." }, { status: 409 }); }
}
