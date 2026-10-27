import Docker from "dockerode";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DockerSandboxExecutor, validateSandboxRequest, type SandboxRequest } from "./sandbox";

describe("Docker sandbox policy", () => {
  const request: SandboxRequest = { workspaceId: "smoke-test", files: [], commands: ["smoke"], timeoutMs: 15_000 };

  it("rejects untrusted paths and invalid command combinations", () => {
    expect(validateSandboxRequest({ ...request, files: ["../secret"], commands: ["install", "test", "typecheck", "lint"] })).toBeTypeOf("string");
    expect(validateSandboxRequest({ ...request, files: ["C:/secret"], commands: ["install", "test", "typecheck", "lint"] })).toBeTypeOf("string");
    expect(validateSandboxRequest({ ...request, commands: ["smoke", "test"] as never })).toBeTypeOf("string");
  });

  it("keeps the image entrypoint contract and security settings on Docker create failures", async () => {
    const dockerError = Object.assign(new Error("daemon rejected secret=do-not-leak"), { statusCode: 500 });
    const createContainer = vi.fn().mockRejectedValue(dockerError);
    const docker = {
      ping: vi.fn().mockResolvedValue("OK"),
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      createContainer,
    } as unknown as Docker;

    const result = await new DockerSandboxExecutor(docker).execute(request);
    const options = createContainer.mock.calls[0][0];
    expect(options.Cmd).toEqual(["smoke"]);
    expect(options.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 2 * 1024 * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
    });
    expect(options.HostConfig.Tmpfs["/workspace"]).toContain("size=1g");
    expect(options.HostConfig.Tmpfs["/workspace"]).toContain("mode=0755");
    expect(options.HostConfig.Tmpfs["/workspace"]).toContain("exec");
    expect(options.User).toBe("10001:10001");
    expect(result).toMatchObject({ status: "FAILED", stage: "create", exitCode: null, dockerError: { statusCode: 500 } });
    expect(result.stderr).toContain("daemon rejected secret=[redacted]");
    expect(result.stderr).not.toContain("do-not-leak");
  });

  it("reports a real Docker wait timeout and kills the container", async () => {
    let resolveWait!: (value: { StatusCode: number }) => void;
    const waitResult = new Promise<{ StatusCode: number }>((resolve) => { resolveWait = resolve; });
    const attached = new PassThrough();
    const hostConfig = {
      NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
      Memory: 2 * 1024 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 128,
      Tmpfs: {
        "/workspace": "rw,exec,nosuid,nodev,size=1g,uid=10001,gid=10001,mode=0755",
        "/tmp": "rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0700",
        "/home/sandbox": "rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=0700",
      },
      Privileged: false, PortBindings: {}, Devices: [], Binds: [], Mounts: [],
    };
    const container = {
      inspect: vi.fn().mockResolvedValue({ Config: { User: "10001:10001" }, HostConfig: hostConfig, Mounts: [] }),
      attach: vi.fn().mockResolvedValue(attached), start: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn(() => waitResult),
      kill: vi.fn(() => { resolveWait({ StatusCode: 137 }); return Promise.resolve(); }),
      remove: vi.fn().mockResolvedValue(undefined),
      modem: { demuxStream: vi.fn() },
    };
    const docker = {
      ping: vi.fn().mockResolvedValue("OK"),
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
      createContainer: vi.fn().mockResolvedValue(container),
    } as unknown as Docker;

    const result = await new DockerSandboxExecutor(docker).execute({ ...request, timeoutMs: 1000 });
    expect(result).toMatchObject({ executed: true, status: "TIMEOUT", exitCode: null, stage: "smoke" });
    expect(container.kill).toHaveBeenCalledWith({ signal: "SIGKILL" });
    expect(container.remove).toHaveBeenCalledWith({ force: true, v: true });
  }, 5000);

  it("runs the isolated smoke container when local Docker and the pinned image are available", async (ctx) => {
    const executor = new DockerSandboxExecutor();
    const availability = await executor.checkAvailability();
    if (!availability.available) ctx.skip(availability.reason);
    const result = await executor.execute(request);
    expect(result, `Diagnóstico del sandbox: ${JSON.stringify(result)}`).toMatchObject({ executed: true, status: "COMPLETED" });
    expect(result.stdout, `Diagnóstico del sandbox: ${JSON.stringify(result)}`).toContain("sandbox-ready uid=10001");
  }, 30_000);
});
