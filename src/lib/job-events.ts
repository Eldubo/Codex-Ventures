import { EventEmitter } from "node:events";
import type { Job } from "./domain";

type JobUpdate = { id: string; job: Job };
const globalEvents = globalThis as typeof globalThis & { __codexJobEmitter?: EventEmitter; __codexJobSequence?: number };
const emitter = globalEvents.__codexJobEmitter ??= new EventEmitter();
emitter.setMaxListeners(250);

export function publishJob(job: Job) {
  const sequence = globalEvents.__codexJobSequence = (globalEvents.__codexJobSequence ?? 0) + 1;
  const update: JobUpdate = { id: `${Date.now()}-${sequence}`, job: structuredClone(job) };
  emitter.emit(`job:${job.id}`, update);
}

export function subscribeJob(jobId: string, listener: (update: JobUpdate) => void): () => void {
  emitter.on(`job:${jobId}`, listener);
  return () => { emitter.off(`job:${jobId}`, listener); };
}
