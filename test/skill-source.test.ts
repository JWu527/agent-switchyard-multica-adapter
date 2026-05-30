import { mkdtempSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANIFEST_PATH } from "../src/lib/manifest.js";
import { collectSkillSource } from "../src/lib/skill-source.js";

async function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "switchyard-skill-"));
  await mkdir(join(root, "references", "nested"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "# Skill\n");
  await writeFile(join(root, "references", "templates.md"), "template\n");
  await writeFile(join(root, "references", "nested", "guide.md"), "guide\n");
  await writeFile(join(root, "scripts", "init-harness.sh"), "#!/bin/sh\n");
  await writeFile(join(root, "README.md"), "ignored\n");
  await writeFile(join(root, ".DS_Store"), "ignored");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, "scripts", "token"), "secret");
  await writeFile(join(root, "references", "secret.pem"), "secret");
  await writeFile(join(root, "references", "draft.tmp"), "ignored");
  await writeFile(join(root, ".git", "config"), "ignored");
  await writeFile(join(root, "node_modules", "x"), "ignored");
  return root;
}

describe("collectSkillSource", () => {
  it("collects only SKILL.md, references, scripts, and generated manifest", async () => {
    const root = await fixtureRoot();

    const result = await collectSkillSource(root, "agent-switchyard");

    expect(result.files.map((file) => file.path).sort()).toEqual([
      MANIFEST_PATH,
      "SKILL.md",
      "references/nested/guide.md",
      "references/templates.md",
      "scripts/init-harness.sh"
    ]);
    expect(result.files.find((file) => file.path === "SKILL.md")).toMatchObject({
      content: "# Skill\n",
      size: 8,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("fails when SKILL.md is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-no-skill-"));

    await expect(collectSkillSource(root, "agent-switchyard")).rejects.toThrow("SKILL.md");
  });

  it("does not follow symlinks by default", async () => {
    const root = await fixtureRoot();
    const outside = join(tmpdir(), `switchyard-outside-${Date.now()}.md`);
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "references", "linked.md"));

    const result = await collectSkillSource(root, "agent-switchyard");

    expect(result.files.some((file) => file.path === "references/linked.md")).toBe(false);
  });

  it("rejects a symlinked SKILL.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-symlinked-skill-"));
    await mkdir(join(root, "references"), { recursive: true });
    const outside = join(tmpdir(), `switchyard-outside-skill-${Date.now()}.md`);
    await writeFile(outside, "# Outside\n");
    await symlink(outside, join(root, "SKILL.md"));

    await expect(collectSkillSource(root, "agent-switchyard")).rejects.toThrow(
      "Refusing symlinked source file: SKILL.md"
    );
  });

  it("rejects source root escape through a symlinked source directory", async () => {
    const realRoot = await fixtureRoot();
    const linkRoot = `${realRoot}-link`;
    await symlink(realRoot, linkRoot);

    await expect(collectSkillSource(linkRoot, "agent-switchyard")).rejects.toThrow(
      "Refusing symlinked source root"
    );
  });

  it("rejects caller-provided source paths containing traversal segments", async () => {
    const root = await fixtureRoot();
    const parent = dirname(root);
    const traversalRoot = `${parent}/../${basename(parent)}/${basename(root)}`;

    await expect(collectSkillSource(traversalRoot, "agent-switchyard")).rejects.toThrow(
      "Refusing source path containing traversal"
    );
  });

  it("does not descend into unpublishable top-level directories", async () => {
    const root = await fixtureRoot();
    const privateDir = join(root, "dist", ".venv", "private");
    await mkdir(privateDir, { recursive: true });
    await writeFile(join(privateDir, "secret.md"), "secret");
    await chmod(privateDir, 0o000);

    try {
      const result = await collectSkillSource(root, "agent-switchyard");

      expect(result.files.map((file) => file.path)).not.toContain("dist/.venv/private/secret.md");
    } finally {
      await chmod(privateDir, 0o700).catch(() => undefined);
    }
  });

  it("excludes sensitive filenames case-insensitively under allowed roots", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "references", ".env.local"), "secret");
    await writeFile(join(root, "scripts", "TOKEN"), "secret");
    await writeFile(join(root, "references", "secret.PEM"), "secret");
    await writeFile(join(root, "references", "aws_credentials.json"), "secret");
    await writeFile(join(root, "references", ".npmrc"), "secret");
    await writeFile(join(root, "references", "safe.md"), "safe\n");

    const result = await collectSkillSource(root, "agent-switchyard");
    const paths = result.files.map((file) => file.path);

    expect(paths).toContain("references/safe.md");
    for (const sensitivePath of [
      "references/.env.local",
      "scripts/TOKEN",
      "references/secret.PEM",
      "references/aws_credentials.json",
      "references/.npmrc"
    ]) {
      expect(paths).not.toContain(sensitivePath);
    }
  });

  it("enforces file count, single file size, and total size limits", async () => {
    const tooMany = mkdtempSync(join(tmpdir(), "switchyard-too-many-"));
    await mkdir(join(tooMany, "references"), { recursive: true });
    await writeFile(join(tooMany, "SKILL.md"), "# Skill\n");
    for (let index = 0; index < 128; index += 1) {
      await writeFile(join(tooMany, "references", `${index}.md`), "x");
    }
    await expect(collectSkillSource(tooMany, "agent-switchyard")).rejects.toThrow(
      "more than 128 publishable source files"
    );

    const tooLarge = mkdtempSync(join(tmpdir(), "switchyard-too-large-"));
    await mkdir(join(tooLarge, "references"), { recursive: true });
    await writeFile(join(tooLarge, "SKILL.md"), "# Skill\n");
    await writeFile(join(tooLarge, "references", "large.md"), "x".repeat(1024 * 1024 + 1));
    await expect(collectSkillSource(tooLarge, "agent-switchyard")).rejects.toThrow(
      "exceeds 1 MiB"
    );

    const tooLargeTotal = mkdtempSync(join(tmpdir(), "switchyard-too-large-total-"));
    await mkdir(join(tooLargeTotal, "references"), { recursive: true });
    await writeFile(join(tooLargeTotal, "SKILL.md"), "# Skill\n");
    for (let index = 0; index < 9; index += 1) {
      await writeFile(join(tooLargeTotal, "references", `${index}.md`), "x".repeat(1024 * 1024));
    }
    await expect(collectSkillSource(tooLargeTotal, "agent-switchyard")).rejects.toThrow(
      "exceed 8 MiB"
    );
  });
});
