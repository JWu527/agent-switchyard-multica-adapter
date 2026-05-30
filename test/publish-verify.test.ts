import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPublish } from "../src/commands/publish.js";
import { runVerify } from "../src/commands/verify.js";
import { UserError } from "../src/lib/errors.js";
import { MANIFEST_PATH, type SwitchyardMulticaManifest } from "../src/lib/manifest.js";
import type { CommandResult, MulticaRunner } from "../src/lib/multica-cli.js";

const HELP_COMMANDS = [
  "multica --help",
  "multica skill --help",
  "multica agent --help",
  "multica runtime --help",
  "multica skill create --help",
  "multica skill update --help",
  "multica skill get --help",
  "multica skill list --help",
  "multica skill files --help",
  "multica skill files upsert --help",
  "multica agent list --help",
  "multica agent skills --help",
  "multica agent skills list --help",
  "multica agent skills set --help",
  "multica runtime list --help"
];

interface SkillSummary {
  id: string;
  name: string;
}

interface SkillDetail extends SkillSummary {
  content?: string;
  files?: Array<{
    path: string;
    content?: string;
    sha256?: string;
    size?: number;
  }>;
}

function commandString(args: string[]): string {
  return ["multica", ...args].join(" ");
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

function fail(stderr: string, stdout = ""): CommandResult {
  return { stdout, stderr, exitCode: 1, signal: null };
}

class FakeMulticaRunner implements MulticaRunner {
  readonly calls: string[] = [];
  readonly helpCommands: Set<string>;
  readonly jsonResponses = new Map<string, unknown>();

  constructor(helpCommands: string[] = HELP_COMMANDS) {
    this.helpCommands = new Set(helpCommands);
  }

  async run(args: string[]): Promise<CommandResult> {
    const command = commandString(args);
    this.calls.push(command);

    if (command.endsWith(" --help")) {
      return this.helpCommands.has(command) ? ok(`${command} help`) : fail("not supported");
    }

    return fail(`unexpected run command: ${command}`);
  }

  async json<T>(args: string[]): Promise<T> {
    const command = commandString(args);
    this.calls.push(command);

    if (!this.jsonResponses.has(command)) {
      if (
        args[0] === "skill" &&
        args[1] === "files" &&
        args[2] === "upsert" &&
        args.includes("--path") &&
        args[args.indexOf("--path") + 1] === MANIFEST_PATH
      ) {
        const content = args[args.indexOf("--content") + 1];
        expect(content).toContain('"tool": "switchyard-multica"');
        return { ok: true } as T;
      }

      throw new Error(`unexpected json command: ${command}`);
    }

    const response = this.jsonResponses.get(command);
    if (typeof response === "function") {
      return (response as (args: string[]) => T)(args);
    }

    return response as T;
  }
}

async function skillFixture() {
  const root = mkdtempSync(join(tmpdir(), "switchyard-publish-verify-"));
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "# Skill\n");
  await writeFile(join(root, "references", "guide.md"), "guide\n");
  await writeFile(join(root, "scripts", "install.sh"), "#!/bin/sh\n");
  return root;
}

function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((value = "") => {
    lines.push(String(value));
  });
  return { lines, spy };
}

function parseOnlyJsonLine(lines: string[]) {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function expectNoWrites(calls: string[]): void {
  const writes = calls.filter(
    (command) =>
      !command.endsWith(" --help") &&
      /\b(skill create|skill update|skill files upsert|agent skills set)\b/.test(command)
  );
  expect(writes).toEqual([]);
}

function configureSkillList(runner: FakeMulticaRunner, skills: SkillSummary[]): void {
  runner.jsonResponses.set("multica skill list --output json", skills);
}

function configureSkillGet(runner: FakeMulticaRunner, skillId: string, detail: SkillDetail): void {
  runner.jsonResponses.set(`multica skill get ${skillId} --output json`, detail);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runPublish", () => {
  it("dry-runs without writes and reports local files, supporting uploads, action, counts, sizes, and hashes", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, []);
    const { lines } = captureLogs();

    await runPublish(runner, {
      source: root,
      skillName: "agent-switchyard",
      dryRun: true,
      json: true
    });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({
      dryRun: true,
      action: "create",
      skillName: "agent-switchyard",
      fileCount: 4
    });
    expect(payload.totalSize).toEqual(expect.any(Number));
    expect(payload.sourceHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(payload.localFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "SKILL.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "references/guide.md" }),
      expect.objectContaining({ path: "scripts/install.sh" }),
      expect.objectContaining({ path: MANIFEST_PATH })
    ]));
    expect(payload.remoteFilesToUpsert).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "references/guide.md" }),
      expect.objectContaining({ path: "scripts/install.sh" }),
      expect.objectContaining({ path: MANIFEST_PATH })
    ]));
    expectNoWrites(runner.calls);
  });

  it("creates a missing skill and upserts supporting files without pruning extras", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "other-id", name: "other-skill" }]);
    runner.jsonResponses.set("multica skill create --name agent-switchyard --content # Skill\n --output json", {
      id: "created-id",
      name: "agent-switchyard"
    });
    runner.jsonResponses.set(
      "multica skill files upsert created-id --path references/guide.md --content guide\n --output json",
      { ok: true }
    );
    runner.jsonResponses.set(
      "multica skill files upsert created-id --path scripts/install.sh --content #!/bin/sh\n --output json",
      { ok: true }
    );
    const { lines } = captureLogs();

    await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ dryRun: false, action: "create", skillId: "created-id" });
    expect(runner.calls).toContain("multica skill create --name agent-switchyard --content # Skill\n --output json");
    expect(runner.calls.some((call) => call.includes("delete"))).toBe(false);
    expect(runner.calls.some((call) => call.includes("prune"))).toBe(false);
    expect(runner.calls.filter((call) => call.includes("skill files upsert created-id"))).toHaveLength(3);
    expect(runner.calls.some((call) => call.includes("--path SKILL.md"))).toBe(false);
  });

  it("prints the human preflight plan before non-dry-run writes", async () => {
    const root = await skillFixture();
    const events: string[] = [];
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, []);
    runner.jsonResponses.set("multica skill create --name agent-switchyard --content # Skill\n --output json", () => {
      events.push("write:skill-create");
      expect(events.some((event) => event.startsWith("output:"))).toBe(true);
      return {
        id: "created-id",
        name: "agent-switchyard"
      };
    });
    runner.jsonResponses.set(
      "multica skill files upsert created-id --path references/guide.md --content guide\n --output json",
      { ok: true }
    );
    runner.jsonResponses.set(
      "multica skill files upsert created-id --path scripts/install.sh --content #!/bin/sh\n --output json",
      { ok: true }
    );

    await runPublish(runner, {
      source: root,
      skillName: "agent-switchyard",
      output: (text) => events.push(`output:${text}`)
    });

    const firstOutputIndex = events.findIndex((event) => event.startsWith("output:"));
    const firstWriteIndex = events.indexOf("write:skill-create");
    expect(firstOutputIndex).toBeGreaterThanOrEqual(0);
    expect(firstOutputIndex).toBeLessThan(firstWriteIndex);
    expect(events[firstOutputIndex]).toContain("Files read: 4");
    expect(events[firstOutputIndex]).toContain("Remote files to upsert:");
  });

  it("updates an existing exact-name skill and upserts supporting files", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [
      { id: "almost-id", name: "agent-switchyard-old" },
      { id: "existing-id", name: "agent-switchyard" }
    ]);
    runner.jsonResponses.set(
      "multica skill update existing-id --name agent-switchyard --content # Skill\n --output json",
      { id: "existing-id", name: "agent-switchyard" }
    );
    runner.jsonResponses.set(
      "multica skill files upsert existing-id --path references/guide.md --content guide\n --output json",
      { ok: true }
    );
    runner.jsonResponses.set(
      "multica skill files upsert existing-id --path scripts/install.sh --content #!/bin/sh\n --output json",
      { ok: true }
    );
    const { lines } = captureLogs();

    await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ action: "update", skillId: "existing-id" });
    expect(runner.calls).toContain(
      "multica skill update existing-id --name agent-switchyard --content # Skill\n --output json"
    );
    expect(runner.calls.some((call) => call.includes("skill create") && !call.endsWith(" --help"))).toBe(false);
    expect(runner.calls.filter((call) => call.includes("skill files upsert existing-id"))).toHaveLength(3);
  });

  it("fails before writes when a required publish capability is missing", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner(
      HELP_COMMANDS.filter((command) => command !== "multica skill files upsert --help")
    );

    await expect(runPublish(runner, { source: root, skillName: "agent-switchyard" })).rejects.toThrow(
      "multica skill files upsert --help"
    );

    expectNoWrites(runner.calls);
  });
});

describe("runVerify", () => {
  it("succeeds when local and remote content match", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: [
        { path: "references/guide.md", content: "guide\n" },
        { path: "scripts/install.sh", content: "#!/bin/sh\n" }
      ]
    });
    const { lines } = captureLogs();

    await runVerify(runner, { source: root, skillName: "agent-switchyard", json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({
      ok: true,
      degraded: false,
      diffCount: 0,
      diffs: []
    });
    expectNoWrites(runner.calls);
  });

  it("reports missing_remote differences and exits nonzero after printing", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: [{ path: "scripts/install.sh", content: "#!/bin/sh\n" }]
    });
    const { lines } = captureLogs();

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toThrow(
      UserError
    );

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ ok: false, diffCount: 1 });
    expect(payload.diffs).toEqual([
      expect.objectContaining({ kind: "missing_remote", path: "references/guide.md" })
    ]);
    expectNoWrites(runner.calls);
  });

  it("reports extra_remote differences as failures", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: [
        { path: "references/guide.md", content: "guide\n" },
        { path: "references/extra.md", content: "extra\n" },
        { path: "scripts/install.sh", content: "#!/bin/sh\n" }
      ]
    });
    const { lines } = captureLogs();

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toThrow(
      "Verification failed"
    );

    const payload = parseOnlyJsonLine(lines);
    expect(payload.diffs).toEqual([
      expect.objectContaining({ kind: "extra_remote", path: "references/extra.md" })
    ]);
    expectNoWrites(runner.calls);
  });

  it("reports path-only remote extra files instead of hiding them", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: [
        { path: "references/guide.md", content: "guide\n" },
        { path: "references/path-only-extra.md" },
        { path: "scripts/install.sh", content: "#!/bin/sh\n" }
      ]
    });
    const { lines } = captureLogs();

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toThrow(
      "Verification failed"
    );

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({
      ok: false,
      degraded: true,
      diffCount: 1
    });
    expect(payload.diffs).toEqual([
      expect.objectContaining({ kind: "extra_remote", path: "references/path-only-extra.md" })
    ]);
    expect(payload.notes).toContain("Some remote file entries had path only; content hashes are unavailable for those paths.");
    expectNoWrites(runner.calls);
  });

  it("reports content_mismatch differences as failures", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Changed\n",
      files: [
        { path: "references/guide.md", content: "guide\n" },
        { path: "scripts/install.sh", content: "#!/bin/sh\n" }
      ]
    });
    const { lines } = captureLogs();

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toThrow(
      "Verification failed"
    );

    const payload = parseOnlyJsonLine(lines);
    expect(payload.diffs).toEqual([
      expect.objectContaining({ kind: "content_mismatch", path: "SKILL.md" })
    ]);
    expectNoWrites(runner.calls);
  });

  it("supports degraded manifest-only verification without claiming content-level success", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      files: [
        {
          path: MANIFEST_PATH,
          content: undefined,
          sha256: undefined,
          size: undefined
        }
      ]
    });
    runner.jsonResponses.set(`multica skill get skill-id --output json`, (args: string[]) => {
      void args;
      return {
        id: "skill-id",
        name: "agent-switchyard",
        files: [
          {
            path: MANIFEST_PATH,
            content: JSON.stringify({
              tool: "switchyard-multica",
              toolVersion: "0.1.0",
              skillName: "agent-switchyard",
              sourcePath: "/remote/source",
              generatedAt: "2026-05-30T00:00:00.000Z",
              files: [
                { path: "SKILL.md", sha256: "not-local", size: 8 },
                { path: "references/guide.md", sha256: "remote-guide", size: 6 },
                { path: "scripts/install.sh", sha256: "remote-script", size: 10 }
              ]
            } satisfies SwitchyardMulticaManifest)
          }
        ]
      };
    });
    const { lines } = captureLogs();

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toThrow(
      "degraded"
    );

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({
      ok: false,
      degraded: true,
      verificationLevel: "manifest-only"
    });
    expect(payload.notes).toContain("Remote file content is unavailable; using remote manifest only.");
    expect(payload.diffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "content_mismatch", path: "SKILL.md" })
    ]));
    expectNoWrites(runner.calls);
  });

  it("fails clearly for --agent until binding verification is implemented by the bind/resolver task", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();

    await expect(
      runVerify(runner, { source: root, skillName: "agent-switchyard", agent: "dev-agent" })
    ).rejects.toThrow("Agent binding verification is implemented by the bind/resolver task");

    expect(runner.calls).toEqual([]);
  });
});
