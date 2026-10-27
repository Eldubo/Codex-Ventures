import Docker from "dockerode";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ArtifactCheck, ArtifactCommand } from "./domain";
import type { PreparedWorkspace } from "./change-artifacts";

export type SandboxAvailability = { available: boolean; reason?: string };
export type SandboxCommand = ArtifactCommand;
export type SandboxRequest = { workspaceId: string; files: string[]; commands: SandboxCommand[]; timeoutMs: number };
export type SandboxStage = "validation" | "availability" | "workspace" | "create" | "inspect" | "upload" | "attach" | "start" | "install" | "test" | "typecheck" | "lint" | "build" | "smoke" | "wait" | "cleanup" | "complete";
export type SandboxExecution = { executed: boolean; status: "COMPLETED" | "FAILED" | "TIMEOUT" | "UNAVAILABLE" | "REJECTED"; stdout: string; stderr: string; exitCode: number | null; durationMs: number; reason: string; stage: SandboxStage; checks: ArtifactCheck[]; dockerError?: { message: string; statusCode?: number } };
export interface SandboxExecutor { checkAvailability(): Promise<SandboxAvailability>; execute(request: SandboxRequest, workspace?: PreparedWorkspace): Promise<SandboxExecution>; }

export const SANDBOX_IMAGE = "codex-ventures-sandbox:node24-1";
const MAX_CAPTURE = 64 * 1024;
const MAX_TIMEOUT = 120_000;
const blockedSegments = new Set([".git", ".data", "node_modules", ".next", ".env"]);

export function validateSandboxRequest(request: SandboxRequest): string | undefined {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.workspaceId)) return "Workspace ID inválido.";
  if (request.files.length > 20 || new Set(request.files).size !== request.files.length || request.commands.length < 1 || request.commands.length > 5) return "El job excede los límites del sandbox.";
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > MAX_TIMEOUT) return "Timeout fuera del límite permitido.";
  const allowed = new Set<SandboxCommand>(["install", "test", "typecheck", "lint", "build", "smoke"]);
  if (request.commands.some((command) => !allowed.has(command)) || new Set(request.commands).size !== request.commands.length) return "Comando no permitido o repetido.";
  if (request.commands.includes("smoke") ? request.commands.length !== 1 || request.files.length !== 0 : request.commands.join(",") !== "install,test,typecheck,lint") return "La secuencia de comandos no coincide con la política permitida.";
  if (request.files.some((value) => !/^src\/lib\/[A-Za-z0-9._/-]+\.tsx?$/.test(value) || value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase().startsWith(".env")))) return "El sandbox solo acepta archivos fuente permitidos bajo src/lib.";
  for (const value of request.files) {
    if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes("\\") || value.includes(":")) return "Se rechazó una ruta absoluta o no válida.";
    const segments = value.split("/");
    if (segments.some((part) => !part || part === "." || part === ".." || blockedSegments.has(part.toLowerCase()) || part.toLowerCase().startsWith(".env"))) return "Se rechazó una ruta fuera de la lista permitida.";
    if (path.posix.normalize(value) !== value) return "La ruta no está normalizada.";
  }
  return undefined;
}

function dockerClient(): Docker {
  // Only connect to the machine-local engine. Never honor DOCKER_HOST or a TCP/SSH endpoint.
  if (process.platform === "win32") return new Docker({ socketPath: "//./pipe/docker_engine" });
  if (process.platform === "linux" || process.platform === "darwin") return new Docker({ socketPath: "/var/run/docker.sock" });
  throw new Error("Plataforma sin transporte Docker local permitido.");
}

function boundedCapture(stream: NodeJS.ReadableStream, max = MAX_CAPTURE) {
  const out: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on("data", (chunk: Buffer) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = max - size;
    if (available > 0) { const piece = buffer.subarray(0, available); out.push(piece); size += piece.length; }
    if (buffer.length > available) truncated = true;
  });
  const raw = () => Buffer.concat(out).toString("utf8") + (truncated ? "\n[output truncated]" : "");
  return { raw, text: () => redactOutput(raw()) };
}

function redactOutput(value: string, workspace?: string) {
  let output = workspace ? value.split(workspace).join("[workspace-temporal]") : value;
  output = output.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private-key-redacted]");
  output = output.replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/g, "[secret-redacted]");
  output = output.replace(/(password|passwd|token|secret|authorization|api[_-]?key)(\s*[=:]\s*)([^\s,;]+)/gi, "$1$2[redacted]");
  return output;
}

function diagnosticMessage(error: unknown, workspace?: string): { message: string; statusCode?: number } {
  const candidate = error as { message?: unknown; statusCode?: unknown };
  let message = typeof candidate?.message === "string" ? candidate.message : "Error no especificado del Docker Engine.";
  message = redactOutput(message, workspace);
  message = message.slice(0, 2000);
  return { message, ...(typeof candidate?.statusCode === "number" ? { statusCode: candidate.statusCode } : {}) };
}

function checksFromRunner(output: string, workspace?: string): ArtifactCheck[] {
  const checks: ArtifactCheck[] = [];
  for (const match of output.matchAll(/sandbox-result:([A-Za-z0-9+/=]+)/g)) {
    try {
      const parsed = JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as ArtifactCheck;
      if (["install", "test", "typecheck", "lint"].includes(parsed.command) && ["PASSED", "FAILED"].includes(parsed.status) && Number.isInteger(parsed.exitCode) && typeof parsed.durationMs === "number") checks.push({ ...parsed, stdout: redactOutput(parsed.stdout, workspace), stderr: redactOutput(parsed.stderr, workspace) });
    } catch { /* Invalid runner diagnostics are ignored; the Docker exit status remains authoritative. */ }
  }
  return checks;
}

export class DockerSandboxExecutor implements SandboxExecutor {
  constructor(private readonly docker: Docker = dockerClient(), private readonly image = SANDBOX_IMAGE) {}

  async checkAvailability(): Promise<SandboxAvailability> {
    try {
      await this.docker.ping();
      await this.docker.getImage(this.image).inspect();
      return { available: true };
    } catch {
      return { available: false, reason: "Docker Engine local o la imagen sandbox confiable no está disponible. Instale/inicie Docker y construya la imagen indicada en la documentación." };
    }
  }

  async execute(request: SandboxRequest, managedWorkspace?: PreparedWorkspace): Promise<SandboxExecution> {
    const started = Date.now();
    const invalid = validateSandboxRequest(request);
    if (invalid) return { executed: false, status: "REJECTED", stdout: "", stderr: invalid, exitCode: null, durationMs: Date.now() - started, reason: invalid, stage: "validation", checks: [] };
    if (request.commands[0] === "smoke" ? Boolean(managedWorkspace) : !managedWorkspace || request.files.some((file) => !managedWorkspace.files.has(file))) return { executed: false, status: "REJECTED", stdout: "", stderr: "El workspace administrado no coincide con los archivos solicitados.", exitCode: null, durationMs: Date.now() - started, reason: "Workspace de sandbox inválido.", stage: "validation", checks: [] };
    if (this.image !== SANDBOX_IMAGE) return { executed: false, status: "REJECTED", stdout: "", stderr: "Imagen no permitida.", exitCode: null, durationMs: Date.now() - started, reason: "Imagen no permitida.", stage: "validation", checks: [] };
    const available = await this.checkAvailability();
    if (!available.available) return { executed: false, status: "UNAVAILABLE", stdout: "", stderr: available.reason ?? "Sandbox no disponible.", exitCode: null, durationMs: Date.now() - started, reason: available.reason ?? "Sandbox no disponible.", stage: "availability", checks: [] };

    let workspace: string | undefined = managedWorkspace?.path;
    let ownsWorkspace = false;
    let container: Docker.Container | undefined;
    let timedOut = false;
    let cleanupFailed = false;
    let stage: SandboxStage = "workspace";
    let execution: SandboxExecution;
    let timer: NodeJS.Timeout | undefined;
    const stdoutStream = new PassThrough(); const stderrStream = new PassThrough();
    const out = boundedCapture(stdoutStream); const err = boundedCapture(stderrStream);
    try {
      if (!workspace) { workspace = await mkdtemp(path.join(os.tmpdir(), "codex-ventures-sandbox-")); ownsWorkspace = true; }
      const resolvedWorkspace = path.resolve(workspace);
      const tempRoot = path.resolve(os.tmpdir());
      if (!resolvedWorkspace.startsWith(`${tempRoot}${path.sep}`) || !path.basename(resolvedWorkspace).startsWith("codex-ventures-")) throw new Error("Workspace fuera del directorio temporal administrado.");
      stage = "create";
      container = await this.docker.createContainer({
        Image: SANDBOX_IMAGE,
        User: "10001:10001",
        WorkingDir: "/workspace",
        // The image ENTRYPOINT already starts runner.cjs; Cmd supplies only its arguments.
        Cmd: [managedWorkspace ? "prepare" : "smoke"],
        AttachStdin: Boolean(managedWorkspace), OpenStdin: Boolean(managedWorkspace), StdinOnce: false,
        Labels: { "codex-ventures.managed": "true", "codex-ventures.workspace": request.workspaceId },
        HostConfig: {
          AutoRemove: false, NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"], Memory: 2 * 1024 * 1024 * 1024, NanoCpus: 1_000_000_000,
          PidsLimit: 128,
          Tmpfs: { "/workspace": "rw,exec,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755", "/tmp": "rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700", "/home/sandbox": "rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700" },
          LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
        },
      });
      stage = "inspect";
      const runtime = await container.inspect();
      const hostConfig = runtime.HostConfig;
      const runtimeMounts = hostConfig.Mounts ?? [];
      const secureRuntime = runtime.Config.User === "10001:10001"
        && hostConfig.NetworkMode === "none"
        && hostConfig.ReadonlyRootfs === true
        && hostConfig.CapDrop?.includes("ALL") === true
        && hostConfig.SecurityOpt?.includes("no-new-privileges:true") === true
        && hostConfig.Memory === 2 * 1024 * 1024 * 1024
        && hostConfig.NanoCpus === 1_000_000_000
        && hostConfig.PidsLimit === 128
        && hostConfig.Tmpfs?.["/workspace"] === "rw,exec,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755"
        && hostConfig.Tmpfs?.["/tmp"] === "rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700"
        && hostConfig.Tmpfs?.["/home/sandbox"] === "rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700"
        && hostConfig.Privileged !== true
        && Object.keys(hostConfig.PortBindings ?? {}).length === 0
        && (hostConfig.Devices ?? []).length === 0
        && (hostConfig.Binds ?? []).length === 0
        && runtimeMounts.length === 0;
      if (!secureRuntime) throw new Error("Docker inspect confirmó una configuración distinta a la política requerida (usuario, red, rootfs, capacidades, recursos o workspace).");
      stage = "attach";
      const attached = await container.attach({ stream: true, hijack: Boolean(managedWorkspace), stdin: Boolean(managedWorkspace), stdout: true, stderr: true });
      container.modem.demuxStream(attached, stdoutStream, stderrStream);
      const streamEnded = new Promise<void>((resolve) => {
        attached.once("end", resolve); attached.once("close", resolve); attached.once("error", resolve);
      });
      stage = "start";
      await container.start();
      const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => { timedOut = true; resolve("timeout"); void container?.kill({ signal: "SIGKILL" }).catch(() => undefined); }, request.timeoutMs); });
      let setupTimedOut = false;
      if (managedWorkspace) {
        const setup = (async () => {
          stage = "inspect";
          const running = await container!.inspect();
          const actualMounts = running.Mounts ?? [];
          const expectedMounts = new Set(["/workspace", "/tmp", "/home/sandbox"]);
          const mountsSecure = (running.HostConfig.Binds ?? []).length === 0
            && (running.HostConfig.Mounts ?? []).length === 0
            && (actualMounts.length === 0 || (actualMounts.length === expectedMounts.size
              && actualMounts.every((mount) => mount.Type === "tmpfs" && mount.RW === true && expectedMounts.has(mount.Destination))));
          if (!mountsSecure) {
            const summary = actualMounts.map(({ Type, Destination, RW }) => ({ Type, Destination, RW }));
            throw new Error(`Docker inspect no confirmó los mounts tmpfs restringidos: ${JSON.stringify(summary)}.`);
          }
          stage = "upload";
          let totalBytes = 0;
          const files = [...managedWorkspace.files.entries()].map(([name, contents]) => {
            if (contents.byteLength > 1024 * 1024) throw new Error("Archivo del workspace supera el límite permitido.");
            totalBytes += contents.byteLength;
            return { path: name, content: contents.toString("base64") };
          });
          if (totalBytes > 20 * 1024 * 1024 || files.length > 400) throw new Error("Workspace supera los límites de transferencia.");
          attached.write(`${JSON.stringify({ commands: request.commands, files })}\n`);
        })();
        const setupOutcome = await Promise.race([setup.then(() => "ready" as const), timeout]);
        setupTimedOut = setupOutcome === "timeout";
      }
      const timeoutStage = request.commands[0] === "smoke" ? "smoke" : stage;
      if (!setupTimedOut) stage = "wait";
      const completed = container.wait().then((value) => ({ result: "done" as const, code: Number(value.StatusCode ?? 1) }));
      const outcome = setupTimedOut ? "timeout" : await Promise.race([completed, timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === "timeout") await container.wait().catch(() => undefined);
      await Promise.race([streamEnded, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
      const exitCode = outcome === "timeout" ? null : outcome.code;
      const rawStdout = out.raw();
      const checks = checksFromRunner(rawStdout, workspace);
      const failedCheck = checks.find((check) => check.status === "FAILED");
      const runningStage = /sandbox:running:(install|test|typecheck|lint|build)/.exec(rawStdout)?.[1] as SandboxStage | undefined;
      const hasRunnerChecks = checks.length > 0;
      const stdout = request.commands[0] === "smoke" || !hasRunnerChecks ? out.text() : checks.map((check) => check.stdout).filter(Boolean).join("\n");
      const stderr = request.commands[0] === "smoke" || !hasRunnerChecks ? err.text() : checks.map((check) => check.stderr).filter(Boolean).join("\n");
      stage = timedOut ? runningStage ?? timeoutStage : failedCheck?.command ?? (request.commands[0] === "smoke" ? "smoke" : exitCode === 0 ? "complete" : checks.length === 0 ? "upload" : "wait");
      execution = { executed: true, status: timedOut ? "TIMEOUT" : exitCode === 0 ? "COMPLETED" : "FAILED", stdout, stderr, exitCode, durationMs: Date.now() - started, reason: timedOut ? `Se agotó el tiempo máximo durante ${stage}.` : exitCode === 0 ? "Ejecución aislada completada." : `El sandbox terminó con código ${exitCode}.`, stage, checks };
    } catch (error) {
      const dockerError = diagnosticMessage(error, workspace);
      execution = { executed: false, status: "FAILED", stdout: out.text(), stderr: `${err.text()}${dockerError.message}`, exitCode: null, durationMs: Date.now() - started, reason: `Falló la ejecución aislada en etapa ${stage}.`, stage, checks: checksFromRunner(out.raw(), workspace), dockerError };
    } finally {
      if (timer) clearTimeout(timer);
      if (container) try { await container.remove({ force: true, v: true }); } catch { cleanupFailed = true; }
      if (workspace && ownsWorkspace) try { await rm(workspace, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    if (cleanupFailed) return { ...execution, executed: false, status: "FAILED", stderr: `${execution.stderr}\nNo se pudo limpiar el contenedor o workspace temporal.`, reason: "Falló la limpieza obligatoria del sandbox.", stage: "cleanup" };
    return execution;
  }
}

export const sandboxExecutor: SandboxExecutor = new DockerSandboxExecutor();
