export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./src/lib/worker");
    await startWorker();
  }
}
