import { NextRequest } from "next/server";
import type { Job } from "@/lib/domain";
import { subscribeJob } from "@/lib/job-events";
import { readStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const buffered: { id: string; job: Job }[] = [];
  let ready = false;
  let deliver: ((update: { id: string; job: Job }) => void) | undefined;
  const unsubscribe = subscribeJob(id, (update) => { if (!ready) buffered.push(update); else deliver?.(update); });
  let cancelStream = () => unsubscribe();
  const store = await readStore();
  const initial = store.jobs.find((job) => job.id === id);
  if (!initial) { unsubscribe(); return Response.json({ error: "Job inexistente." }, { status: 404 }); }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (job: Job, eventId = `${Date.now()}`) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`id: ${eventId}\nevent: job\ndata: ${JSON.stringify(job)}\n\n`));
        if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) { cleanup(); controller.close(); }
      };
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keep-alive\n\n")); }, 15000);
      const abort = () => cleanup();
      function cleanup() { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); req.signal.removeEventListener("abort", abort); }
      cancelStream = cleanup;
      req.signal.addEventListener("abort", abort, { once: true });
      deliver = (update) => send(update.job, update.id);
      send(initial);
      ready = true;
      const rank = (job: Job) => job.status === "QUEUED" ? 0 : job.status === "RUNNING" ? 1 : 2;
      for (const update of buffered.splice(0)) {
        const newer = update.job.updatedAt > initial.updatedAt || (update.job.updatedAt === initial.updatedAt && (rank(update.job) > rank(initial) || update.job.progress > initial.progress));
        if (newer) send(update.job, update.id);
      }
    },
    cancel() { cancelStream(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
