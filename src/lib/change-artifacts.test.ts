import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactError, createDemoArtifact, MAX_DIFF_BYTES, prepareWorkspace, snapshotSource, validateDiff } from "./change-artifacts";

const temporaryRoots: string[] = [];
async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-artifact-test-"));
  temporaryRoots.push(root);
  for (const name of ["package.json", "package-lock.json", "tsconfig.json", "next.config.ts", "next-env.d.ts", "eslint.config.mjs"]) await writeFile(path.join(root, name), "{}\n");
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  await writeFile(path.join(root, "src", "lib", "base.ts"), "export const base = 1;\n");
  return root;
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function newFileDiff(file: string, source = "export const value = 42;\n", mode = "100644") {
  const sourceLines = source.replace(/\n$/, "").split("\n");
  return [
    `diff --git a/${file} b/${file}`,
    `new file mode ${mode}`,
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${sourceLines.length} @@`,
    ...sourceLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

describe("proposal change artifacts", () => {
  it("validates and applies a real new-file diff only in a disposable workspace", async () => {
    const root = await fixtureRoot();
    const artifact = await createDemoArtifact(root);
    expect(artifact.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.validation.status).toBe("VALID");
    const workspace = await prepareWorkspace(artifact, root);
    const sourceFile = artifact.changedFiles.find((file) => file.endsWith("-value-label.ts"))!;
    expect(await readFile(path.join(workspace.path, ...sourceFile.split("/")), "utf8")).toContain("formatValueLabel");
    await expect(lstat(path.join(root, ...sourceFile.split("/")))).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
    await expect(lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal, sensitive paths, symlink modes, and malformed hunks", () => {
    const base = new Map<string, Buffer>();
    expect(() => validateDiff(newFileDiff("../.env"), base)).toThrow(ArtifactError);
    expect(() => validateDiff(newFileDiff("src/lib/.env.local.ts"), base)).toThrow(ArtifactError);
    expect(() => validateDiff(newFileDiff("src/lib/link.ts", "target\n", "120000"), base)).toThrow(ArtifactError);
    expect(() => validateDiff(newFileDiff("src/lib/bad.ts").replace("+1,1 @@", "+1,2 @@"), base)).toThrow(/conteos del hunk/);
  });

  it("rejects changed context as a base conflict and oversized diffs", () => {
    const patch = ["diff --git a/src/lib/base.ts b/src/lib/base.ts", "index 1111111..2222222 100644", "--- a/src/lib/base.ts", "+++ b/src/lib/base.ts", "@@ -1 +1 @@", "-export const base = 1;", "+export const base = 2;", ""].join("\n");
    expect(() => validateDiff(patch, new Map([["src/lib/base.ts", Buffer.from("export const base = 999;\n")]]))).toThrow(/no coincide con el contexto/);
    expect(() => validateDiff("x".repeat(MAX_DIFF_BYTES + 1), new Map())).toThrow(/64 KiB/);
  });

  it("detects a changed base version before workspace preparation", async () => {
    const root = await fixtureRoot();
    const artifact = await createDemoArtifact(root);
    await writeFile(path.join(root, "src", "lib", "base.ts"), "export const base = 2;\n");
    await expect(prepareWorkspace(artifact, root)).rejects.toMatchObject({ code: "BASE_CONFLICT" });
  });

  it("rejects symlinks in the copied base snapshot", async (ctx) => {
    const root = await fixtureRoot();
    const outside = path.join(root, "outside.ts");
    await writeFile(outside, "export const secret = false;\n");
    try { await symlink(outside, path.join(root, "src", "lib", "escape.ts")); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip("El sistema no permite crear symlinks para esta prueba.");
      throw error;
    }
    await expect(snapshotSource(root)).rejects.toMatchObject({ code: "SYMLINK" });
  });

  it("rejects a symlink or junction at the source root before traversing outside the repository", async (ctx) => {
    const root = await fixtureRoot();
    const external = path.join(root, "external-source");
    await mkdir(external);
    await writeFile(path.join(external, "leaked.ts"), "export const outside = true;\n");
    await rm(path.join(root, "src"), { recursive: true, force: true });
    try { await symlink(external, path.join(root, "src"), "junction"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) ctx.skip("El sistema no permite crear una junction para esta prueba.");
      throw error;
    }
    await expect(snapshotSource(root)).rejects.toMatchObject({ code: "SYMLINK" });
  });
});
