import { mkdtempSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSyncLocal } from "../src/commands/sync-local.js";
import { MANIFEST_PATH } from "../src/lib/manifest.js";

const MARKER_PATH = ".switchyard-multica.json";

async function skillFixture(content = "# Skill\n") {
  const root = mkdtempSync(join(tmpdir(), "switchyard-sync-source-"));
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), content);
  await writeFile(join(root, "references", "guide.md"), "guide\n");
  await writeFile(join(root, "scripts", "install.sh"), "#!/bin/sh\n");
  return root;
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), "switchyard-sync-home-"));
}

function captureOutput() {
  const lines: string[] = [];
  return {
    lines,
    output: (text: string) => {
      lines.push(text);
    }
  };
}

function parseJsonOutput(lines: string[]) {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("runSyncLocal", () => {
  it("requires at least one explicit target", async () => {
    const source = await skillFixture();

    await expect(runSyncLocal({ source, skillName: "agent-switchyard" })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("sync-local requires at least one --target")
    });
  });

  it("dry-runs without creating target or backup directories", async () => {
    const source = await skillFixture();
    const homeDir = tempHome();
    const targetDir = join(homeDir, "custom-openclaw");
    const { lines, output } = captureOutput();

    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["openclaw"],
      targetDir: [`openclaw=${targetDir}`],
      homeDir,
      timestamp: "20260530T010203Z",
      dryRun: true,
      json: true,
      output
    });

    const payload = parseJsonOutput(lines);
    expect(payload).toMatchObject({ dryRun: true });
    expect(payload.targets).toEqual([
      expect.objectContaining({
        target: "openclaw",
        targetDir,
        exists: false,
        nonEmpty: false,
        markerExists: false,
        markerMatches: false,
        wouldOverwrite: false,
        forceRequired: false,
        backupDir: join(homeDir, ".switchyard-multica", "backups", "20260530T010203Z", "openclaw", "agent-switchyard")
      })
    ]);
    expect((payload.targets as Array<{ filesToWrite: string[] }>)[0].filesToWrite).toEqual([
      MANIFEST_PATH,
      "SKILL.md",
      "references/guide.md",
      "scripts/install.sh"
    ]);
    await expect(readdir(targetDir)).rejects.toThrow();
    await expect(readdir(join(homeDir, ".switchyard-multica"))).rejects.toThrow();
  });

  it("refuses a non-empty unmanaged target unless force is set", async () => {
    const source = await skillFixture();
    const homeDir = tempHome();
    const targetDir = join(homeDir, "openclaw-target");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "local-only.md"), "keep me\n");

    await expect(
      runSyncLocal({
        source,
        skillName: "agent-switchyard",
        target: ["openclaw"],
        targetDir: [`openclaw=${targetDir}`],
        homeDir,
        timestamp: "20260530T010204Z"
      })
    ).rejects.toThrow("non-empty and unmanaged");

    await expect(readFile(join(targetDir, "local-only.md"), "utf8")).resolves.toBe("keep me\n");
    await expect(readdir(join(homeDir, ".switchyard-multica"))).rejects.toThrow();
  });

  it("backs up and takes over a non-empty unmanaged target when force is set", async () => {
    const source = await skillFixture();
    const homeDir = tempHome();
    const targetDir = join(homeDir, "openclaw-target");
    const backupDir = join(homeDir, ".switchyard-multica", "backups", "20260530T010205Z", "openclaw", "agent-switchyard");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "local-only.md"), "old\n");

    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["openclaw"],
      targetDir: [`openclaw=${targetDir}`],
      homeDir,
      timestamp: "20260530T010205Z",
      force: true,
      json: true,
      output: () => undefined
    });

    await expect(readFile(join(backupDir, "local-only.md"), "utf8")).resolves.toBe("old\n");
    await expect(readFile(join(targetDir, "local-only.md"), "utf8")).rejects.toThrow();
    await expect(readFile(join(targetDir, "SKILL.md"), "utf8")).resolves.toBe("# Skill\n");
    const marker = await readJson(join(targetDir, MARKER_PATH));
    expect(marker).toMatchObject({
      managedBy: "switchyard-multica",
      skillName: "agent-switchyard",
      sourcePath: source,
      target: "openclaw",
      targetDir,
      lastSyncAt: "2026-05-30T01:02:05.000Z"
    });
    expect(marker.sourceHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(marker.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "SKILL.md" })]));
  });

  it("refuses marker mismatches by default and force takes over with backup", async () => {
    const source = await skillFixture();
    const homeDir = tempHome();
    const targetDir = join(homeDir, "codex-target");
    const backupDir = join(homeDir, ".switchyard-multica", "backups", "20260530T010206Z", "codex", "agent-switchyard");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "SKILL.md"), "# Old\n");
    await writeFile(
      join(targetDir, MARKER_PATH),
      `${JSON.stringify({
        managedBy: "switchyard-multica",
        skillName: "other-skill",
        sourcePath: source,
        target: "codex",
        targetDir
      })}\n`
    );

    await expect(
      runSyncLocal({
        source,
        skillName: "agent-switchyard",
        target: ["codex"],
        targetDir: [`codex=${targetDir}`],
        homeDir,
        timestamp: "20260530T010206Z"
      })
    ).rejects.toThrow("marker mismatch");

    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["codex"],
      targetDir: [`codex=${targetDir}`],
      homeDir,
      timestamp: "20260530T010206Z",
      force: true,
      json: true,
      output: () => undefined
    });

    await expect(readFile(join(backupDir, "SKILL.md"), "utf8")).resolves.toBe("# Old\n");
    const marker = await readJson(join(targetDir, MARKER_PATH));
    expect(marker).toMatchObject({ skillName: "agent-switchyard", sourcePath: source, target: "codex" });
  });

  it("writes source files, marker, and generated manifest, then verifies hashes", async () => {
    const source = await skillFixture();
    const homeDir = tempHome();
    const targetDir = join(homeDir, "hermes-target");

    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["hermes"],
      targetDir: [`hermes=${targetDir}`],
      homeDir,
      timestamp: "20260530T010207Z",
      json: true,
      output: () => undefined
    });

    await expect(readFile(join(targetDir, "SKILL.md"), "utf8")).resolves.toBe("# Skill\n");
    await expect(readFile(join(targetDir, "references", "guide.md"), "utf8")).resolves.toBe("guide\n");
    const manifest = await readJson(join(targetDir, MANIFEST_PATH));
    expect(manifest).toMatchObject({
      tool: "switchyard-multica",
      skillName: "agent-switchyard",
      sourcePath: source
    });
    const marker = await readJson(join(targetDir, MARKER_PATH));
    expect(marker).toMatchObject({
      managedBy: "switchyard-multica",
      skillName: "agent-switchyard",
      sourcePath: source,
      target: "hermes",
      targetDir
    });
  });

  it("backs up an existing matching managed target before updating it", async () => {
    const source = await skillFixture("# Old Skill\n");
    const homeDir = tempHome();
    const targetDir = join(homeDir, "claude-target");
    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["claude"],
      targetDir: [`claude=${targetDir}`],
      homeDir,
      timestamp: "20260530T010208Z",
      json: true,
      output: () => undefined
    });

    await writeFile(join(source, "SKILL.md"), "# New Skill\n");
    const backupDir = join(homeDir, ".switchyard-multica", "backups", "20260530T010209Z", "claude", "agent-switchyard");
    await runSyncLocal({
      source,
      skillName: "agent-switchyard",
      target: ["claude"],
      targetDir: [`claude=${targetDir}`],
      homeDir,
      timestamp: "20260530T010209Z",
      json: true,
      output: () => undefined
    });

    await expect(readFile(join(backupDir, "SKILL.md"), "utf8")).resolves.toBe("# Old Skill\n");
    await expect(readFile(join(targetDir, "SKILL.md"), "utf8")).resolves.toBe("# New Skill\n");
    const marker = await readJson(join(targetDir, MARKER_PATH));
    expect(marker).toMatchObject({ lastSyncAt: "2026-05-30T01:02:09.000Z" });
  });
});
