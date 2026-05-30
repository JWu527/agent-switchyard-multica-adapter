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
  files?: unknown;
}

function commandString(args: string[]): string {
  return ["multica", ...args].join(" ");
}

function argsKey(args: string[]): string {
  return JSON.stringify(args);
}

function setJsonResponse(runner: FakeMulticaRunner, args: string[], response: unknown): void {
  runner.jsonResponses.set(argsKey(args), response);
}

function startsWithArgs(args: string[], prefix: string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

function countCallsStartingWith(calls: string[][], prefix: string[]): number {
  return calls.filter((args) => startsWithArgs(args, prefix) && !isHelpArgs(args)).length;
}

function isHelpArgs(args: string[]): boolean {
  return args.at(-1) === "--help";
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

function fail(stderr: string, stdout = ""): CommandResult {
  return { stdout, stderr, exitCode: 1, signal: null };
}

class FakeMulticaRunner implements MulticaRunner {
  readonly calls: string[][] = [];
  readonly helpCommands: Set<string>;
  readonly jsonResponses = new Map<string, unknown>();

  constructor(helpCommands: string[] = HELP_COMMANDS) {
    this.helpCommands = new Set(helpCommands);
  }

  async run(args: string[]): Promise<CommandResult> {
    const command = commandString(args);
    this.calls.push([...args]);

    if (command.endsWith(" --help")) {
      return this.helpCommands.has(command) ? ok(`${command} help`) : fail("not supported");
    }

    return fail(`unexpected run command: ${command}`);
  }

  async json<T>(args: string[]): Promise<T> {
    const key = argsKey(args);
    this.calls.push([...args]);

    if (!this.jsonResponses.has(key)) {
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

      throw new Error(`unexpected json command: ${commandString(args)}`);
    }

    const response = this.jsonResponses.get(key);
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

async function argvFixture() {
  const root = mkdtempSync(join(tmpdir(), "switchyard-argv-fixture-"));
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "# Skill\nSecond line --not-a-flag\n");
  await writeFile(join(root, "references", "guide with spaces-and-dashes.md"), "guide\n--literal value\n");
  await writeFile(join(root, "scripts", "install tricky-name.sh"), "#!/bin/sh\necho \"hello --there\"\n");
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

function expectNoWrites(calls: string[][]): void {
  const writes = calls.filter(
    (args) =>
      !isHelpArgs(args) &&
      (startsWithArgs(args, ["skill", "create"]) ||
        startsWithArgs(args, ["skill", "update"]) ||
        startsWithArgs(args, ["skill", "files", "upsert"]) ||
        startsWithArgs(args, ["agent", "skills", "set"]))
  );
  expect(writes).toEqual([]);
}

function configureSkillList(runner: FakeMulticaRunner, skills: unknown[]): void {
  setJsonResponse(runner, ["skill", "list", "--output", "json"], skills);
}

function configureSkillGet(runner: FakeMulticaRunner, skillId: string, detail: SkillDetail): void {
  setJsonResponse(runner, ["skill", "get", skillId, "--output", "json"], detail);
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
    setJsonResponse(
      runner,
      ["skill", "create", "--name", "agent-switchyard", "--content", "# Skill\n", "--output", "json"],
      {
        id: "created-id",
        name: "agent-switchyard"
      }
    );
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "created-id", "--path", "references/guide.md", "--content", "guide\n", "--output", "json"],
      { ok: true }
    );
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "created-id", "--path", "scripts/install.sh", "--content", "#!/bin/sh\n", "--output", "json"],
      { ok: true }
    );
    const { lines } = captureLogs();

    await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ dryRun: false, action: "create", skillId: "created-id" });
    expect(runner.calls).toContainEqual(["skill", "create", "--name", "agent-switchyard", "--content", "# Skill\n", "--output", "json"]);
    expect(runner.calls.some((args) => args.some((arg) => arg.includes("delete")))).toBe(false);
    expect(runner.calls.some((args) => args.some((arg) => arg.includes("prune")))).toBe(false);
    expect(countCallsStartingWith(runner.calls, ["skill", "files", "upsert", "created-id"])).toBe(3);
    expect(runner.calls.some((args) => args.includes("--path") && args[args.indexOf("--path") + 1] === "SKILL.md")).toBe(false);
  });

  it("fails instead of creating a duplicate when exact-name skill list entry has no id", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ name: "agent-switchyard" }]);

    await expect(runPublish(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("Malformed multica skill list entry for agent-switchyard")
    });
    expect(countCallsStartingWith(runner.calls, ["skill", "create"])).toBe(0);
    expect(countCallsStartingWith(runner.calls, ["skill", "files", "upsert"])).toBe(0);
  });

  it("preserves argv boundaries for content and paths containing spaces, dashes, and newlines", async () => {
    const root = await argvFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, []);
    setJsonResponse(
      runner,
      [
        "skill",
        "create",
        "--name",
        "agent-switchyard",
        "--content",
        "# Skill\nSecond line --not-a-flag\n",
        "--output",
        "json"
      ],
      { id: "created-id", name: "agent-switchyard" }
    );
    setJsonResponse(
      runner,
      [
        "skill",
        "files",
        "upsert",
        "created-id",
        "--path",
        "references/guide with spaces-and-dashes.md",
        "--content",
        "guide\n--literal value\n",
        "--output",
        "json"
      ],
      { ok: true }
    );
    setJsonResponse(
      runner,
      [
        "skill",
        "files",
        "upsert",
        "created-id",
        "--path",
        "scripts/install tricky-name.sh",
        "--content",
        "#!/bin/sh\necho \"hello --there\"\n",
        "--output",
        "json"
      ],
      { ok: true }
    );
    const { lines } = captureLogs();

    await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });

    parseOnlyJsonLine(lines);
    expect(runner.calls).toContainEqual([
      "skill",
      "create",
      "--name",
      "agent-switchyard",
      "--content",
      "# Skill\nSecond line --not-a-flag\n",
      "--output",
      "json"
    ]);
    expect(runner.calls.some((args) => args.includes("--not-a-flag"))).toBe(false);
    expect(runner.calls).toContainEqual([
      "skill",
      "files",
      "upsert",
      "created-id",
      "--path",
      "references/guide with spaces-and-dashes.md",
      "--content",
      "guide\n--literal value\n",
      "--output",
      "json"
    ]);
  });

  it("throws a clear UserError when skill create returns no usable id", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, []);
    setJsonResponse(
      runner,
      ["skill", "create", "--name", "agent-switchyard", "--content", "# Skill\n", "--output", "json"],
      { name: "agent-switchyard" }
    );

    try {
      await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });
      throw new Error("Expected runPublish to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(UserError);
      expect((error as Error).message).toContain("multica skill create");
      expect((error as Error).message).toContain("agent-switchyard");
    }
    expect(countCallsStartingWith(runner.calls, ["skill", "files", "upsert"])).toBe(0);
  });

  it("prints the human preflight plan before non-dry-run writes", async () => {
    const root = await skillFixture();
    const events: string[] = [];
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, []);
    setJsonResponse(runner, ["skill", "create", "--name", "agent-switchyard", "--content", "# Skill\n", "--output", "json"], () => {
      events.push("write:skill-create");
      expect(events.some((event) => event.startsWith("output:"))).toBe(true);
      return {
        id: "created-id",
        name: "agent-switchyard"
      };
    });
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "created-id", "--path", "references/guide.md", "--content", "guide\n", "--output", "json"],
      { ok: true }
    );
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "created-id", "--path", "scripts/install.sh", "--content", "#!/bin/sh\n", "--output", "json"],
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
    setJsonResponse(
      runner,
      ["skill", "update", "existing-id", "--name", "agent-switchyard", "--content", "# Skill\n", "--output", "json"],
      { id: "existing-id", name: "agent-switchyard" }
    );
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "existing-id", "--path", "references/guide.md", "--content", "guide\n", "--output", "json"],
      { ok: true }
    );
    setJsonResponse(
      runner,
      ["skill", "files", "upsert", "existing-id", "--path", "scripts/install.sh", "--content", "#!/bin/sh\n", "--output", "json"],
      { ok: true }
    );
    const { lines } = captureLogs();

    await runPublish(runner, { source: root, skillName: "agent-switchyard", json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ action: "update", skillId: "existing-id" });
    expect(runner.calls).toContainEqual([
      "skill",
      "update",
      "existing-id",
      "--name",
      "agent-switchyard",
      "--content",
      "# Skill\n",
      "--output",
      "json"
    ]);
    expect(runner.calls.some((args) => startsWithArgs(args, ["skill", "create"]) && !isHelpArgs(args))).toBe(false);
    expect(countCallsStartingWith(runner.calls, ["skill", "files", "upsert", "existing-id"])).toBe(3);
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

  it("fails clearly when exact-name skill list entry has no id during verify", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ name: "agent-switchyard" }]);

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("Malformed multica skill list entry for agent-switchyard")
    });
    expect(countCallsStartingWith(runner.calls, ["skill", "get"])).toBe(0);
    expectNoWrites(runner.calls);
  });

  it("fails clearly when skill get files is not an array", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: { path: "references/guide.md", content: "guide\n" }
    });

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("Expected multica skill get files to be an array")
    });
    expectNoWrites(runner.calls);
  });

  it("fails clearly for malformed skill get file entries", async () => {
    const root = await skillFixture();
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, [{ id: "skill-id", name: "agent-switchyard" }]);
    configureSkillGet(runner, "skill-id", {
      id: "skill-id",
      name: "agent-switchyard",
      content: "# Skill\n",
      files: [null, { content: "orphan\n" }, "unexpected"]
    });

    await expect(runVerify(runner, { source: root, skillName: "agent-switchyard", json: true })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("Malformed multica skill get file entry")
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
    setJsonResponse(runner, ["skill", "get", "skill-id", "--output", "json"], (args: string[]) => {
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
