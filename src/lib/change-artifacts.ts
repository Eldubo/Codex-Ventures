import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeArtifact, Proposal, ProposalPriority } from "./domain";

export const MAX_DIFF_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 400;
const ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", "eslint.config.mjs"] as const;
const SECRET_PATH = /(^|\/)(\.env($|\.)|.*(secret|credential|private[-_]?key|\.pem$|\.p12$))/i;

export type BaseSnapshot = { hash: string; files: Map<string, Buffer> };
export type PreparedWorkspace = { path: string; baseHash: string; appliedHash: string; files: Map<string, Buffer>; dispose: () => Promise<void> };
export class ArtifactError extends Error {
  constructor(public readonly code: "INVALID_DIFF" | "INVALID_PATH" | "OVERSIZED" | "SYMLINK" | "BASE_CONFLICT" | "HASH_MISMATCH" | "WORKSPACE", message: string) { super(message); }
}

function demoDiff(baseHash: string) {
  const stem = `demo-${baseHash.slice(0, 16)}-value-label`;
  const sourcePath = `src/lib/${stem}.ts`;
  const testPath = `src/lib/${stem}.test.ts`;
  return [
    `diff --git a/${sourcePath} b/${sourcePath}`,
    "new file mode 100644",
    "index 0000000..2fdf19c",
    "--- /dev/null",
    `+++ b/${sourcePath}`,
    "@@ -0,0 +1,4 @@",
    "+export function formatValueLabel(value: number): string {",
    '+  if (!Number.isFinite(value)) throw new Error("value must be finite");',
    '+  return `Valor: ${value}`;',
    "+}",
    `diff --git a/${testPath} b/${testPath}`,
    "new file mode 100644",
    "index 0000000..88407ad",
    "--- /dev/null",
    `+++ b/${testPath}`,
    "@@ -0,0 +1,9 @@",
    '+import { describe, expect, it } from "vitest";',
    `+import { formatValueLabel } from "./${stem}";`,
    "+",
    '+describe("formatValueLabel", () => {',
    '+  it("formats finite values and rejects invalid numbers", () => {',
    '+    expect(formatValueLabel(42)).toBe("Valor: 42");',
    '+    expect(() => formatValueLabel(Number.NaN)).toThrow("value must be finite");',
    "+  });",
    "+});",
    "",
  ].join("\n");
}

export function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }

function safeRelativePath(relative: string): boolean {
  if (relative.length > 200 || !/^src\/lib\/[A-Za-z0-9._/-]+\.tsx?$/.test(relative) || path.posix.normalize(relative) !== relative || SECRET_PATH.test(relative)) return false;
  const denied = new Set([".git", ".data", ".next", "node_modules"]);
  return relative.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !denied.has(part.toLowerCase()) && !part.toLowerCase().startsWith(".env"));
}

function containsSecret(diff: string) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|(?:password|passwd|token|api[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/i.test(diff);
}

function hashFiles(files: Map<string, Buffer>) {
  const hash = createHash("sha256");
  for (const [name, contents] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update("\0").update(contents).update("\0");
  }
  return hash.digest("hex");
}

export async function snapshotSource(root = process.cwd()): Promise<BaseSnapshot> {
  const base = path.resolve(root);
  const files = new Map<string, Buffer>();
  let total = 0;
  const addFile = async (absolute: string, relative: string) => {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new ArtifactError("SYMLINK", `El snapshot contiene un symlink no permitido: ${relative}`);
    if (!info.isFile()) throw new ArtifactError("INVALID_PATH", `El snapshot contiene una entrada no regular: ${relative}`);
    if (info.size > MAX_FILE_BYTES) throw new ArtifactError("OVERSIZED", `Archivo base demasiado grande: ${relative}`);
    if (!safeSnapshotPath(relative)) throw new ArtifactError("INVALID_PATH", `Ruta base no permitida: ${relative}`);
    total += info.size;
    if (total > MAX_SNAPSHOT_BYTES || files.size >= MAX_SNAPSHOT_FILES) throw new ArtifactError("OVERSIZED", "El snapshot supera los límites configurados.");
    files.set(relative, await readFile(absolute));
  };
  for (const name of ROOT_FILES) await addFile(path.join(base, name), name);
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(absolute, entry.name);
      const childRelative = `${relative}/${entry.name}`;
      const info = await lstat(child);
      if (info.isSymbolicLink()) throw new ArtifactError("SYMLINK", `El snapshot contiene un symlink no permitido: ${childRelative}`);
      if (info.isDirectory()) await visit(child, childRelative);
      else await addFile(child, childRelative);
    }
  };
  await visit(path.join(base, "src"), "src");
  return { hash: hashFiles(files), files };
}

function safeSnapshotPath(relative: string) {
  return ROOT_FILES.includes(relative as (typeof ROOT_FILES)[number]) || (relative.startsWith("src/") && !SECRET_PATH.test(relative) && !relative.split("/").some((part) => part === "." || part === ".." || part.toLowerCase().startsWith(".env")));
}

type HunkLine = { kind: "context" | "add" | "remove"; value: string };
type ParsedFile = { oldPath: string | null; newPath: string | null; hunks: { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: HunkLine[] }[] };

function parseUnifiedDiff(diff: string): ParsedFile[] {
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) throw new ArtifactError("OVERSIZED", "El diff supera 64 KiB.");
  if (diff.includes("\0") || diff.includes("\r")) throw new ArtifactError("INVALID_DIFF", "El diff contiene caracteres no permitidos.");
  if (containsSecret(diff)) throw new ArtifactError("INVALID_DIFF", "El diff contiene material que parece ser un secreto.");
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: ParsedFile[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    const header = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(lines[cursor++] ?? "");
    if (!header || header[1] !== header[2]) throw new ArtifactError("INVALID_DIFF", "Cabecera unified diff inválida o rename no permitido.");
    const headerPath = header[1]!;
    let newFile = false; let deletedFile = false;
    while (cursor < lines.length && !lines[cursor]!.startsWith("--- ")) {
      const meta = lines[cursor++]!;
      if (meta === "new file mode 100644") newFile = true;
      else if (meta === "deleted file mode 100644") deletedFile = true;
      else if (/^index [0-9a-f]{7,64}\.{2}[0-9a-f]{7,64}( 100644)?$/i.test(meta)) continue;
      else throw new ArtifactError("INVALID_DIFF", "Metadatos de diff no permitidos (incluye modos/symlinks). ");
    }
    const oldHeader = /^--- (?:a\/([^\s]+)|\/dev\/null)$/.exec(lines[cursor++] ?? "");
    const newHeader = /^\+\+\+ (?:b\/([^\s]+)|\/dev\/null)$/.exec(lines[cursor++] ?? "");
    if (!oldHeader || !newHeader) throw new ArtifactError("INVALID_DIFF", "Cabeceras ---/+++ inválidas.");
    const oldPath = oldHeader[1] ?? null; const newPath = newHeader[1] ?? null;
    if ((oldPath ?? newPath) !== headerPath || (newFile !== (oldPath === null)) || (deletedFile !== (newPath === null)) || (newFile && deletedFile)) throw new ArtifactError("INVALID_DIFF", "Las rutas de la cabecera no coinciden o el modo de archivo es inconsistente.");
    const target = newPath ?? oldPath;
    if (!target || !safeRelativePath(target)) throw new ArtifactError("INVALID_PATH", "El diff apunta a una ruta fuera de src/lib o sensible.");
    const hunks: ParsedFile["hunks"] = [];
    while (cursor < lines.length && lines[cursor]!.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[cursor++]!);
      if (!match) throw new ArtifactError("INVALID_DIFF", "Cabecera de hunk inválida.");
      const hunk = { oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1), newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] as HunkLine[] };
      let oldSeen = 0; let newSeen = 0;
      while (cursor < lines.length && !lines[cursor]!.startsWith("@@ ") && !lines[cursor]!.startsWith("diff --git ")) {
        const line = lines[cursor++]!;
        if (line.startsWith("\\")) throw new ArtifactError("INVALID_DIFF", "Marcadores especiales de newline no están permitidos.");
        const marker = line[0];
        if (marker === " ") { hunk.lines.push({ kind: "context", value: line.slice(1) }); oldSeen++; newSeen++; }
        else if (marker === "+") { hunk.lines.push({ kind: "add", value: line.slice(1) }); newSeen++; }
        else if (marker === "-") { hunk.lines.push({ kind: "remove", value: line.slice(1) }); oldSeen++; }
        else throw new ArtifactError("INVALID_DIFF", "Línea de hunk malformada.");
      }
      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) throw new ArtifactError("INVALID_DIFF", "Los conteos del hunk no coinciden con su contenido.");
      hunks.push(hunk);
    }
    if (!hunks.length) throw new ArtifactError("INVALID_DIFF", "Cada archivo debe contener al menos un hunk.");
    files.push({ oldPath, newPath, hunks });
  }
  const paths = files.map((file) => file.newPath ?? file.oldPath!);
  if (!files.length || new Set(paths.map((file) => file.toLowerCase())).size !== files.length) throw new ArtifactError("INVALID_DIFF", "Diff vacío o rutas duplicadas/collisionantes.");
  return files;
}

function applyFilePatch(base: Buffer | undefined, patch: ParsedFile): Buffer | undefined {
  const originalPath = patch.oldPath;
  if (patch.oldPath === null && base !== undefined) throw new ArtifactError("BASE_CONFLICT", "El archivo nuevo ya existe en la versión base.");
  if (patch.oldPath !== null && base === undefined) throw new ArtifactError("BASE_CONFLICT", "El archivo requerido no existe en la versión base.");
  const text = base?.toString("utf8") ?? "";
  if (base && Buffer.from(text, "utf8").compare(base) !== 0) throw new ArtifactError("INVALID_DIFF", "El archivo contiene bytes no UTF-8.");
  const terminated = !base || text.endsWith("\n");
  const originalLines = text ? text.split("\n") : [];
  if (text.endsWith("\n")) originalLines.pop();
  let baseCursor = 0;
  const output: string[] = [];
  for (const hunk of patch.hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < baseCursor || start > originalLines.length) throw new ArtifactError("BASE_CONFLICT", "El hunk se superpone o excede la versión base.");
    output.push(...originalLines.slice(baseCursor, start));
    baseCursor = start;
    for (const line of hunk.lines) {
      if (line.kind === "add") output.push(line.value);
      else {
        if (originalLines[baseCursor] !== line.value) throw new ArtifactError("BASE_CONFLICT", `El contenido de ${originalPath ?? "archivo"} no coincide con el contexto del diff.`);
        if (line.kind === "context") output.push(line.value);
        baseCursor++;
      }
    }
  }
  output.push(...originalLines.slice(baseCursor));
  if (patch.newPath === null) return undefined;
  const applied = Buffer.from(output.join("\n") + (terminated ? "\n" : ""), "utf8");
  if (applied.byteLength > MAX_FILE_BYTES) throw new ArtifactError("OVERSIZED", `El archivo aplicado supera ${MAX_FILE_BYTES} bytes.`);
  return applied;
}

export function validateDiff(diff: string, baseFiles: Map<string, Buffer>) {
  const parsed = parseUnifiedDiff(diff);
  const updated = new Map(baseFiles);
  for (const patch of parsed) {
    const pathName = patch.newPath ?? patch.oldPath!;
    if (patch.oldPath !== null && patch.oldPath !== pathName) throw new ArtifactError("INVALID_PATH", "Renames no permitidos.");
    if ([...updated.keys()].some((existing) => existing !== pathName && existing.toLowerCase() === pathName.toLowerCase())) throw new ArtifactError("BASE_CONFLICT", "La ruta colisiona con el nombre de un archivo existente en Windows.");
    const applied = applyFilePatch(updated.get(pathName), patch);
    if (applied === undefined) updated.delete(pathName); else updated.set(pathName, applied);
  }
  return { changedFiles: parsed.map((file) => file.newPath ?? file.oldPath!).sort(), files: updated, appliedHash: hashFiles(updated) };
}

export async function createDemoArtifact(root = process.cwd()): Promise<ChangeArtifact> {
  const base = await snapshotSource(root);
  const diff = demoDiff(base.hash);
  const checked = validateDiff(diff, base.files);
  return {
    baseVersion: `sha256:${base.hash}`,
    baseHash: base.hash,
    diff,
    changedFiles: checked.changedFiles,
    hash: sha256(diff),
    acceptanceCriteria: ["formatValueLabel devuelve 'Valor: 42' para el valor 42", "rechaza valores no finitos", "npm test, typecheck y lint pasan en el workspace aislado"],
    source: "DEMO_FIXTURE",
    validation: { status: "VALID", errors: [], checkedAt: new Date().toISOString() },
  };
}

export async function createDemoProposal(input: { id: string; title: string; problem: string; evidence: string; priority: ProposalPriority }, root = process.cwd()): Promise<Proposal> {
  return {
    ...input,
    title: `DEMO FIXTURE · ${input.title}`,
    problem: `${input.problem} (propuesta demostrativa con diff fixture determinístico; no es una solución generada por IA).`,
    status: "PENDING_APPROVAL",
    createdAt: new Date().toISOString(),
    artifact: await createDemoArtifact(root),
  };
}

export async function validateArtifactAgainstBase(artifact: ChangeArtifact, root = process.cwd()) {
  try {
    if (artifact.validation.status !== "VALID") throw new ArtifactError("INVALID_DIFF", "El artefacto no está en estado VALID para aprobación.");
    const base = await snapshotSource(root);
    if (artifact.baseHash !== base.hash || artifact.baseVersion !== `sha256:${base.hash}`) throw new ArtifactError("BASE_CONFLICT", "La versión base cambió desde la creación de la propuesta.");
    if (sha256(artifact.diff) !== artifact.hash) throw new ArtifactError("HASH_MISMATCH", "El hash del diff no coincide con el artefacto almacenado.");
    if (artifact.source !== "DEMO_FIXTURE" || !Array.isArray(artifact.acceptanceCriteria) || artifact.acceptanceCriteria.length < 1 || artifact.acceptanceCriteria.length > 10 || artifact.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || criterion.length < 5 || criterion.length > 300)) throw new ArtifactError("INVALID_DIFF", "Metadatos del artefacto inválidos.");
    const checked = validateDiff(artifact.diff, base.files);
    if (JSON.stringify(checked.changedFiles) !== JSON.stringify([...artifact.changedFiles].sort())) throw new ArtifactError("HASH_MISMATCH", "La lista de archivos no coincide con el diff.");
    if (checked.changedFiles.length > 20) throw new ArtifactError("OVERSIZED", "El artefacto excede el máximo de archivos modificados.");
    return { status: "VALID" as const, errors: [], checkedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof ArtifactError) return { status: error.code === "BASE_CONFLICT" ? "CONFLICT" as const : "INVALID" as const, errors: [error.message], checkedAt: new Date().toISOString() };
    return { status: "INVALID" as const, errors: ["No se pudo validar el snapshot de origen."], checkedAt: new Date().toISOString() };
  }
}

export async function prepareWorkspace(artifact: ChangeArtifact, root = process.cwd()): Promise<PreparedWorkspace> {
  const base = await snapshotSource(root);
  if (artifact.baseHash !== base.hash || artifact.baseVersion !== `sha256:${base.hash}`) throw new ArtifactError("BASE_CONFLICT", "La versión base cambió desde la creación de la propuesta.");
  if (Buffer.byteLength(artifact.diff, "utf8") > MAX_DIFF_BYTES) throw new ArtifactError("OVERSIZED", "El diff supera 64 KiB.");
  if (sha256(artifact.diff) !== artifact.hash) throw new ArtifactError("HASH_MISMATCH", "El hash del diff no coincide con el artefacto almacenado.");
  const checked = validateDiff(artifact.diff, base.files);
  if (JSON.stringify(checked.changedFiles) !== JSON.stringify([...artifact.changedFiles].sort())) throw new ArtifactError("HASH_MISMATCH", "La lista de archivos no coincide con el diff.");
  if (artifact.source !== "DEMO_FIXTURE" || artifact.validation.status !== "VALID" || artifact.acceptanceCriteria.length < 1 || artifact.acceptanceCriteria.length > 10 || artifact.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || criterion.length < 5 || criterion.length > 300)) throw new ArtifactError("INVALID_DIFF", "Origen, criterios o estado del artefacto no ejecutable.");
  let workspace: string;
  try { workspace = await mkdtemp(path.join(os.tmpdir(), "codex-ventures-proposal-")); }
  catch { throw new ArtifactError("WORKSPACE", "No se pudo crear el workspace temporal."); }
  try {
    for (const [relative, contents] of base.files) {
      const destination = path.join(workspace, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents, { flag: "wx" });
    }
    for (const patch of parseUnifiedDiff(artifact.diff)) {
      const relative = patch.newPath ?? patch.oldPath!;
      const destination = path.join(workspace, ...relative.split("/"));
      const applied = applyFilePatch(base.files.get(relative), patch);
      if (applied === undefined) await rm(destination, { force: true });
      else {
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, applied, { flag: base.files.has(relative) ? "w" : "wx" });
      }
    }
    return { path: workspace, baseHash: base.hash, appliedHash: checked.appliedHash, files: checked.files, dispose: async () => { await rm(workspace, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("WORKSPACE", "No se pudo preparar el workspace aislado.");
  }
}

export async function upgradeProposal(proposal: Proposal, root = process.cwd()): Promise<Proposal> {
  if (proposal.artifact) return proposal;
  return {
    ...proposal,
    title: `DEMO FIXTURE · ${proposal.title}`,
    problem: `${proposal.problem} (migrada a fixture determinístico; no es una salida de IA).`,
    status: proposal.status === "PROPOSED" ? "PENDING_APPROVAL" : "INVALID",
    artifact: await createDemoArtifact(root),
  };
}
