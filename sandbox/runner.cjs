/* eslint-disable @typescript-eslint/no-require-imports */
// Fixed command dispatcher. It never evaluates proposal content or invokes a shell.
const { spawn } = require("node:child_process");
const { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

let commands = (process.argv[2] || "").split(",").filter(Boolean);
const checks = new Map([
  ["install", ["ci", "--offline", "--ignore-scripts", "--cache", "/tmp/npm-cache", "--audit=false", "--fund=false"]],
  ["test", ["test"]],
  ["typecheck", ["run", "typecheck"]],
  ["lint", ["run", "lint"]],
  ["build", ["run", "build"]],
]);
const allowedChecks = ["install", "test", "typecheck", "lint"];
const isSmoke = commands.length === 1 && commands[0] === "smoke";
if (commands.length === 1 && commands[0] === "prepare") {
  let input = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    input = Buffer.concat([input, Buffer.from(chunk)]);
    const newline = input.indexOf(10);
    if (newline < 0) {
      if (input.length > 28 * 1024 * 1024) failInput("workspace payload exceeds the size limit.");
      return;
    }
    process.stdin.pause();
    let payload;
    try { payload = JSON.parse(input.subarray(0, newline).toString("utf8")); }
    catch { failInput(`invalid workspace payload (bytes=${newline}, prefix=${input.subarray(0, Math.min(newline, 4)).toString("hex")}).`); return; }
    commands = payload.commands;
    if (!Array.isArray(commands) || commands.join(",") !== allowedChecks.join(",") || !Array.isArray(payload.files) || payload.files.length > 400) { failInput("sandbox command sequence or file list is not allowlisted."); return; }
    let total = 0;
    const rootFiles = new Set(["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", "eslint.config.mjs"]);
    for (const file of payload.files) {
      if (!file || typeof file.path !== "string" || !(rootFiles.has(file.path) || /^src\/[A-Za-z0-9._\[\]-]+(?:\/[A-Za-z0-9._\[\]-]+)*$/.test(file.path))
        || file.path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase().startsWith(".env") || part.toLowerCase() === "node_modules")
        || typeof file.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) { failInput("workspace file rejected by runner policy."); return; }
      const contents = Buffer.from(file.content, "base64");
      if (contents.length > 1024 * 1024 || contents.toString("base64") !== file.content) { failInput("workspace file exceeds limits or has invalid encoding."); return; }
      total += contents.length;
      if (total > 20 * 1024 * 1024) { failInput("workspace exceeds the size limit."); return; }
      try {
        const destination = path.join("/workspace", file.path);
        mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
        writeFileSync(destination, contents, { mode: 0o644, flag: "wx" });
      } catch { failInput("workspace file could not be created."); return; }
    }
    runChecks(commands);
  });
} else if (isSmoke) {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    writeFileSync("/workspace/sandbox-smoke.txt", `uid=${uid}\n`);
    process.stdout.write(`sandbox-ready uid=${uid}\n`);
    if (uid === 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`sandbox smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write("La imagen solo permite smoke o prepare.\n");
  process.exit(64);
}

function failInput(message) {
  process.stderr.write(`${message}\n`);
  process.exit(64);
}

function runChecks(steps) {
  const imageLock = "/opt/codex/app/package-lock.json";
  const workspaceLock = "/workspace/package-lock.json";
  if (!existsSync(imageLock) || !existsSync(workspaceLock)
    || createHash("sha256").update(readFileSync(imageLock)).digest("hex") !== createHash("sha256").update(readFileSync(workspaceLock)).digest("hex")) {
    process.stderr.write("sandbox dependency lock mismatch; rebuild the trusted image.\n");
    process.exit(78);
  } else {
    try { cpSync("/opt/codex/npm-cache", "/tmp/npm-cache", { recursive: true, errorOnExist: false, force: true }); }
    catch (error) { process.stderr.write(`sandbox dependency cache unavailable: ${error.message}\n`); process.exit(79); }
    runNext(steps, 0);
  }
}

function runNext(steps, index) {
  if (index >= steps.length) return;
  const name = steps[index];
  const args = checks.get(name);
  if (!args) { process.stderr.write("sandbox command not allowlisted.\n"); process.exit(64); return; }
  process.stdout.write(`sandbox:running:${name}\n`);
  const started = Date.now();
  let reported = false;
  const captured = { stdout: [], stderr: [], stdoutBytes: 0, stderrBytes: 0, outputTruncated: false };
  const append = (field, bytesField, chunk) => {
    const buffer = Buffer.from(chunk);
    const room = Math.max(0, 3072 - captured[bytesField]);
    if (room) { const part = buffer.subarray(0, room); captured[field].push(part); captured[bytesField] += part.length; }
    if (buffer.length > room) captured.outputTruncated = true;
  };
  const child = spawn("npm", args, {
    cwd: "/workspace",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME: "/tmp", CI: "true", npm_config_update_notifier: "false" },
  });
  child.stdout.on("data", (chunk) => append("stdout", "stdoutBytes", chunk));
  child.stderr.on("data", (chunk) => append("stderr", "stderrBytes", chunk));
  child.once("error", () => report(127));
  child.once("close", (code) => {
    report(code ?? 1);
  });
  function report(code) {
    if (reported) return;
    reported = true;
    const result = {
      command: name,
      status: code === 0 ? "PASSED" : "FAILED",
      exitCode: code,
      durationMs: Date.now() - started,
      stdout: Buffer.concat(captured.stdout).toString("utf8"),
      stderr: Buffer.concat(captured.stderr).toString("utf8"),
      outputTruncated: captured.outputTruncated,
    };
    process.stdout.write(`sandbox-result:${Buffer.from(JSON.stringify(result)).toString("base64")}\n`, () => {
      if (code !== 0) { process.exit(code); return; }
      if (index + 1 >= steps.length) { process.exit(0); return; }
      runNext(steps, index + 1);
    });
  }
}
