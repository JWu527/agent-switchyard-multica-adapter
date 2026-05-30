import { afterEach, describe, expect, it, vi } from "vitest";
import { runBind } from "../src/commands/bind.js";
import {
  mergeSkillIds,
  resolveAgent,
  resolveSkill,
  type AgentLike,
  type SkillLike
} from "../src/lib/bind-resolver.js";
import { UserError } from "../src/lib/errors.js";
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

const AGENTS: AgentLike[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Hermes" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Codex" }
];

const SKILLS: SkillLike[] = [
  { id: "skill-other", name: "other-skill" },
  { id: "skill-target", name: "agent-switchyard" }
];

function commandString(args: string[]): string {
  return ["multica", ...args].join(" ");
}

function argsKey(args: string[]): string {
  return JSON.stringify(args);
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

function fail(stderr: string, stdout = ""): CommandResult {
  return { stdout, stderr, exitCode: 1, signal: null };
}

function isHelpArgs(args: string[]): boolean {
  return args.at(-1) === "--help";
}

function startsWithArgs(args: string[], prefix: string[]): boolean {
  return prefix.every((value, index) => args[index] === value);
}

function countCallsStartingWith(calls: string[][], prefix: string[]): number {
  return calls.filter((args) => startsWithArgs(args, prefix) && !isHelpArgs(args)).length;
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
      throw new Error(`unexpected json command: ${commandString(args)}`);
    }

    const response = this.jsonResponses.get(key);
    if (typeof response === "function") {
      return (response as (args: string[]) => T)(args);
    }

    return response as T;
  }
}

function setJsonResponse(runner: FakeMulticaRunner, args: string[], response: unknown): void {
  runner.jsonResponses.set(argsKey(args), response);
}

function configureSkillList(runner: FakeMulticaRunner, skills: unknown[]): void {
  setJsonResponse(runner, ["skill", "list", "--output", "json"], skills);
}

function configureAgentList(runner: FakeMulticaRunner, agents: unknown[]): void {
  setJsonResponse(runner, ["agent", "list", "--output", "json"], agents);
}

function configureAgentSkills(runner: FakeMulticaRunner, agentId: string, responses: unknown[]): void {
  let readCount = 0;
  setJsonResponse(runner, ["agent", "skills", "list", agentId, "--output", "json"], () => {
    const response = responses[Math.min(readCount, responses.length - 1)];
    readCount += 1;
    return response;
  });
}

function configureAgentSkillsSet(runner: FakeMulticaRunner, agentId: string, skillIds: string[]): void {
  setJsonResponse(
    runner,
    ["agent", "skills", "set", agentId, "--skill-ids", skillIds.join(","), "--output", "json"],
    { ok: true }
  );
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAgent", () => {
  it("resolves UUID selectors by id", () => {
    expect(resolveAgent(AGENTS, "11111111-1111-4111-8111-111111111111")).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Hermes"
    });
  });

  it("resolves UUIDv7 selectors by id", () => {
    const uuidV7Agent = { id: "018f6a2b-3c4d-7e5f-8123-456789abcdef", name: "Future" };

    expect(resolveAgent([...AGENTS, uuidV7Agent], uuidV7Agent.id)).toEqual(uuidV7Agent);
  });

  it("resolves non-UUID selectors by exact name", () => {
    expect(resolveAgent(AGENTS, "Codex")).toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Codex"
    });
  });

  it("throws on duplicate names and lists candidate ids", () => {
    expect(() =>
      resolveAgent(
        [...AGENTS, { id: "33333333-3333-4333-8333-333333333333", name: "Codex" }],
        "Codex"
      )
    ).toThrow(/Multiple agents match name "Codex".*22222222-2222-4222-8222-222222222222.*33333333-3333-4333-8333-333333333333.*Use an id/s);
  });

  it("throws clearly when an agent selector is missing", () => {
    expect(() => resolveAgent(AGENTS, "Missing")).toThrow('Agent not found by exact name: "Missing"');
  });

  it("throws clearly when a target-name agent entry is malformed", () => {
    expect(() => resolveAgent([...AGENTS, { name: "Codex" }], "Codex")).toThrow(
      'Malformed multica agent list entry for "Codex": missing non-empty string id'
    );
  });
});

describe("resolveSkill", () => {
  it("resolves skills by exact name", () => {
    expect(resolveSkill(SKILLS, "agent-switchyard")).toEqual({
      id: "skill-target",
      name: "agent-switchyard"
    });
  });

  it("tells the user to publish first when a skill is missing", () => {
    expect(() => resolveSkill(SKILLS, "missing-skill")).toThrow(
      'Skill not found in Multica: "missing-skill". Run publish first.'
    );
  });

  it("throws clearly when a target-name skill entry is malformed", () => {
    expect(() => resolveSkill([...SKILLS, { name: "agent-switchyard" }], "agent-switchyard")).toThrow(
      'Malformed multica skill list entry for "agent-switchyard": missing non-empty string id'
    );
  });
});

describe("mergeSkillIds", () => {
  it("appends without duplicating and never removes existing ids", () => {
    expect(mergeSkillIds(["existing-a", "existing-b"], "target")).toEqual([
      "existing-a",
      "existing-b",
      "target"
    ]);
    expect(mergeSkillIds(["existing-a", "target", "existing-b"], "target")).toEqual([
      "existing-a",
      "target",
      "existing-b"
    ]);
  });
});

describe("runBind", () => {
  it("requires at least one agent selector", async () => {
    const runner = new FakeMulticaRunner();

    await expect(runBind(runner, { skillName: "agent-switchyard" })).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("At least one --agent is required")
    });
    expect(runner.calls).toEqual([]);
  });

  it("fails before reads or writes when a required bind capability is missing", async () => {
    const runner = new FakeMulticaRunner(
      HELP_COMMANDS.filter((command) => command !== "multica agent skills set --help")
    );

    await expect(
      runBind(runner, { skillName: "agent-switchyard", agent: ["Hermes"] })
    ).rejects.toThrow("multica agent skills set --help");

    expect(runner.calls).toHaveLength(HELP_COMMANDS.length);
    expect(countCallsStartingWith(runner.calls, ["skill", "list"])).toBe(0);
    expect(countCallsStartingWith(runner.calls, ["agent", "skills", "set"])).toBe(0);
  });

  it("dry-runs with current skills, merged skills, and planned set args without writing", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [[{ id: "existing-a", name: "Existing A" }]]);
    const { lines } = captureLogs();

    await runBind(runner, {
      skillName: "agent-switchyard",
      agent: ["Hermes"],
      dryRun: true,
      json: true
    });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({
      dryRun: true,
      skillName: "agent-switchyard",
      skillId: "skill-target"
    });
    expect(payload.changes).toEqual([
      expect.objectContaining({
        agent: { id: AGENTS[0].id, name: "Hermes" },
        beforeSkillIds: ["existing-a"],
        afterSkillIds: ["existing-a", "skill-target"],
        setArgs: [
          "agent",
          "skills",
          "set",
          AGENTS[0].id,
          "--skill-ids",
          "existing-a,skill-target",
          "--output",
          "json"
        ]
      })
    ]);
    expect(countCallsStartingWith(runner.calls, ["agent", "skills", "set"])).toBe(0);
  });

  it("sets the full merged skill id list and verifies read-back exactly", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[1].id, [
      [{ id: "existing-a", name: "Existing A" }, { id: "existing-b", name: "Existing B" }],
      [
        { id: "existing-a", name: "Existing A" },
        { id: "existing-b", name: "Existing B" },
        { id: "skill-target", name: "agent-switchyard" }
      ]
    ]);
    configureAgentSkillsSet(runner, AGENTS[1].id, ["existing-a", "existing-b", "skill-target"]);
    const { lines } = captureLogs();

    await runBind(runner, {
      skillName: "agent-switchyard",
      agent: ["22222222-2222-4222-8222-222222222222"],
      json: true
    });

    const payload = parseOnlyJsonLine(lines);
    expect(payload).toMatchObject({ dryRun: false });
    expect(runner.calls).toContainEqual([
      "agent",
      "skills",
      "set",
      AGENTS[1].id,
      "--skill-ids",
      "existing-a,existing-b,skill-target",
      "--output",
      "json"
    ]);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        beforeSkillIds: ["existing-a", "existing-b"],
        afterSkillIds: ["existing-a", "existing-b", "skill-target"],
        readBackSkillIds: ["existing-a", "existing-b", "skill-target"]
      })
    ]);
  });

  it("does not write any agents when a later selector is invalid", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [
      [{ id: "existing-a", name: "Existing A" }],
      [
        { id: "existing-a", name: "Existing A" },
        { id: "skill-target", name: "agent-switchyard" }
      ]
    ]);
    configureAgentSkillsSet(runner, AGENTS[0].id, ["existing-a", "skill-target"]);

    await expect(
      runBind(runner, { skillName: "agent-switchyard", agent: ["Hermes", "Missing"], json: true })
    ).rejects.toThrow('Agent not found by exact name: "Missing"');

    expect(countCallsStartingWith(runner.calls, ["agent", "skills", "set"])).toBe(0);
  });

  it("accepts reordered read-back skill ids when the set of ids matches", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [
      [{ id: "existing-a", name: "Existing A" }, { id: "existing-b", name: "Existing B" }],
      [
        { id: "skill-target", name: "agent-switchyard" },
        { id: "existing-b", name: "Existing B" },
        { id: "existing-a", name: "Existing A" }
      ]
    ]);
    configureAgentSkillsSet(runner, AGENTS[0].id, ["existing-a", "existing-b", "skill-target"]);
    const { lines } = captureLogs();

    await runBind(runner, { skillName: "agent-switchyard", agent: ["Hermes"], json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        afterSkillIds: ["existing-a", "existing-b", "skill-target"],
        readBackSkillIds: ["skill-target", "existing-b", "existing-a"]
      })
    ]);
  });

  it("does not duplicate an already-bound skill or delete existing skills", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [
      [
        { id: "existing-a", name: "Existing A" },
        { id: "skill-target", name: "agent-switchyard" },
        { id: "existing-b", name: "Existing B" }
      ],
      [
        { id: "existing-a", name: "Existing A" },
        { id: "skill-target", name: "agent-switchyard" },
        { id: "existing-b", name: "Existing B" }
      ]
    ]);
    configureAgentSkillsSet(runner, AGENTS[0].id, ["existing-a", "skill-target", "existing-b"]);
    const { lines } = captureLogs();

    await runBind(runner, { skillName: "agent-switchyard", agent: ["Hermes"], json: true });

    const payload = parseOnlyJsonLine(lines);
    expect(payload.changes).toEqual([
      expect.objectContaining({
        alreadyBound: true,
        beforeSkillIds: ["existing-a", "skill-target", "existing-b"],
        afterSkillIds: ["existing-a", "skill-target", "existing-b"]
      })
    ]);
    expect(runner.calls).toContainEqual([
      "agent",
      "skills",
      "set",
      AGENTS[0].id,
      "--skill-ids",
      "existing-a,skill-target,existing-b",
      "--output",
      "json"
    ]);
  });

  it("throws when read-back differs from the expected full skill id list", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [
      [{ id: "existing-a", name: "Existing A" }],
      [
        { id: "skill-target", name: "agent-switchyard" },
        { id: "unexpected-z", name: "Unexpected Z" }
      ]
    ]);
    configureAgentSkillsSet(runner, AGENTS[0].id, ["existing-a", "skill-target"]);

    await expect(
      runBind(runner, { skillName: "agent-switchyard", agent: ["Hermes"], json: true })
    ).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringMatching(/Read-back verification failed for agent Hermes.*missing: existing-a.*extra: unexpected-z/s)
    });
  });

  it("does not create agents when an agent selector is missing", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);

    await expect(
      runBind(runner, { skillName: "agent-switchyard", agent: ["Missing"] })
    ).rejects.toThrow('Agent not found by exact name: "Missing"');

    expect(countCallsStartingWith(runner.calls, ["agent", "create"])).toBe(0);
    expect(countCallsStartingWith(runner.calls, ["agent", "skills", "set"])).toBe(0);
  });

  it("prints useful human output", async () => {
    const runner = new FakeMulticaRunner();
    configureSkillList(runner, SKILLS);
    configureAgentList(runner, AGENTS);
    configureAgentSkills(runner, AGENTS[0].id, [[{ id: "existing-a", name: "Existing A" }]]);
    const { lines } = captureLogs();

    await runBind(runner, {
      skillName: "agent-switchyard",
      agent: ["Hermes"],
      dryRun: true
    });

    const output = lines.join("\n");
    expect(output).toContain("Bind dry run: agent-switchyard");
    expect(output).toContain("Agent Hermes");
    expect(output).toContain("Before skills: existing-a");
    expect(output).toContain("After skills: existing-a, skill-target");
    expect(output).toContain("Planned set: multica agent skills set");
  });
});
