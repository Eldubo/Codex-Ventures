import { NextRequest, NextResponse } from "next/server";
import { readStore } from "@/lib/store";
export async function GET(req: NextRequest) {
  const limit = Math.max(1, Math.min(100, Number(req.nextUrl.searchParams.get("limit") ?? 25) || 25));
  const store = await readStore();
  return NextResponse.json({ jobs: store.jobs.slice(0, limit) });
}
