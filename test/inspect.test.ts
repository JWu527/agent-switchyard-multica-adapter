import { afterEach, describe, expect, it, vi } from "vitest";
import { runInspect } from "../src/commands/inspect.js";
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

function commandString(args: string[]): string {
  return ["multica", ...args].join(" ");
}

function ok(stdout = ""): CommandResult {
  return { stdout, stderr: "", exitCode: 0, signal: null };
}

function fail(stderr: string, stdout = ""): CommandResult {
  return { stdout, stderr, exitCode: 1, signal: null };
}

class FakeInspectRunner implements MulticaRunner {
  readonly calls: string[] = [];
  readonly helpCommands: Set<string>;
  readonly runResponses = new Map<string, CommandResult>();
  readonly jsonResponses = new Map<string, unknown>();
  readonly jsonFailures = new Map<string, Error>();

  constructor(helpCommands: string[] = HELP_COMMANDS) {
    this.helpCommands = new Set(helpCommands);
  }

  async run(args: string[]): Promise<CommandResult> {
    const command = commandString(args);
    this.calls.push(command);

    const configured = this.runResponses.get(command);
    if (configured !== undefined) return configured;

    if (command.endsWith(" --help")) {
      return this.helpCommands.has(command) ? ok(`${command} help`) : fail("not supported");
    }

    return fail(`unexpected run command: ${command}`);
  }

  async json<T>(args: string[]): Promise<T> {
    const command = commandString(args);
    this.calls.push(command);

    const failure = this.jsonFailures.get(command);
    if (failure !== undefined) throw failure;

    if (!this.jsonResponses.has(command)) {
      throw new Error(`unexpected json command: ${command}`);
    }

    return this.jsonResponses.get(command) as T;
  }
}

function captureLogs() {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((value = "") => {
    lines.push(String(value));
  });
  return { lines, spy };
}

function expectOnlyReadCommands(calls: string[]): void {
  const writeLooking = /\b(create|update|upsert|set|bind|publish|verify|sync-local)\b/;
  const unsafeCalls = calls.filter((command) => writeLooking.test(command) && !command.endsWith(" --help"));
  expect(unsafeCalls).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runInspect", () => {
  it("prints complete human output with config, workspace, list counts, and hints", async () => {
    const runner = new FakeInspectRunner();
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace","profile":"local"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [
      { name: "dev-agent", skills: ["agent-switchyard"] }
    ]);
    runner.jsonResponses.set("multica agent skills list --output json", [
      { agent: "dev-agent", skill: "agent-switchyard" }
    ]);
    runner.jsonResponses.set("multica runtime list --output json", [
      { name: "local-node", status: "online", workspace: "demo-workspace" }
    ]);
    const { lines } = captureLogs();

    await runInspect(runner, { skillName: "agent-switchyard" });

    const output = lines.join("\n");
    expect(runner.calls.slice(0, HELP_COMMANDS.length)).toEqual(HELP_COMMANDS);
    expect(output).toContain("Full capabilities: complete");
    expect(output).toContain("Inspect capabilities: complete");
    expect(output).toContain("Inspect status: complete");
    expect(output).toContain("Workspace: demo-workspace");
    expect(output).toContain("Skills: 1 available");
    expect(output).toContain("agent-switchyard");
    expect(output).toContain("Agents: 1 available");
    expect(output).toContain("Runtimes: 1 available");
    expect(output).toContain("CLI workspace and browser workspace may differ");
    expect(output).toContain("Runtime online but no agent");
    expect(output).toContain("Agent missing target skill");
    expect(output).toContain("Missing CLI capabilities");
    expect(output).not.toContain("Detected: target skill is not bound");
    expectOnlyReadCommands(runner.calls);
  });

  it("prints degraded human output when capabilities and list shapes are missing", async () => {
    const runner = new FakeInspectRunner(
      HELP_COMMANDS.filter(
        (command) =>
          command !== "multica skill list --help" && command !== "multica runtime list --help"
      )
    );
    runner.runResponses.set("multica config show", fail("config unavailable"));
    runner.jsonResponses.set("multica agent list --output json", { items: [] });
    runner.jsonResponses.set("multica agent skills list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { skillName: "agent-switchyard" });

    const output = lines.join("\n");
    expect(output).toContain("Full capabilities: degraded");
    expect(output).toContain("Inspect capabilities: degraded");
    expect(output).toContain("Inspect status: degraded");
    expect(output).toContain("multica skill list --help");
    expect(output).toContain("Config: unavailable");
    expect(output).toContain("Skills: unavailable");
    expect(output).toContain("Runtimes: unavailable");
    expect(output).toContain("Agents: error");
    expect(output).toContain("Expected array from multica agent list");
    expect(output).toContain("Multica CLI is missing some inspect capabilities");
    expectOnlyReadCommands(runner.calls);
  });

  it("prints structured JSON including degraded and missing information", async () => {
    const runner = new FakeInspectRunner();
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", []);
    runner.jsonResponses.set("multica agent skills list --output json", []);
    runner.jsonResponses.set("multica runtime list --output json", [{ name: "local", status: "online" }]);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]);
    expect(payload.skillName).toBe("agent-switchyard");
    expect(payload.capabilities.skillList).toBe(true);
    expect(payload.config).toMatchObject({ ok: true, workspace: "demo-workspace" });
    expect(payload.skills).toMatchObject({ ok: true, count: 1 });
    expect(payload.agents).toMatchObject({ ok: true, count: 0 });
    expect(payload.runtimes).toMatchObject({ ok: true, count: 1 });
    expect(payload.degraded).toBe(true);
    expect(payload.missingInformation).toContain("runtime online but no agents found");
    expect(payload.missingInformation).toContain("target skill is not bound to any discovered agent");
    expectOnlyReadCommands(runner.calls);
  });

  it("reports unknown target skill binding when binding list is unavailable and agents omit binding fields", async () => {
    const runner = new FakeInspectRunner(
      HELP_COMMANDS.filter((command) => command !== "multica agent skills list --help")
    );
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [{ name: "dev-agent" }]);
    runner.jsonResponses.set("multica runtime list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    const payload = JSON.parse(lines[0]);
    expect(payload.degraded).toBe(true);
    expect(payload.inspect.missingCapabilities).toContain("multica agent skills list --help");
    expect(payload.missingInformation).toContain("target skill binding status unavailable");
    expect(payload.missingInformation).not.toContain(
      "target skill is not bound to any discovered agent"
    );
    expect(runner.calls).not.toContain("multica agent skills list --output json");
    expectOnlyReadCommands(runner.calls);
  });

  it("reports unknown target skill binding when binding list schema is unrecognized", async () => {
    const runner = new FakeInspectRunner();
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [{ name: "dev-agent" }]);
    runner.jsonResponses.set("multica agent skills list --output json", [
      { relationship: { left: "dev-agent", right: "agent-switchyard" } }
    ]);
    runner.jsonResponses.set("multica runtime list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    const payload = JSON.parse(lines[0]);
    expect(payload.degraded).toBe(true);
    expect(payload.missingInformation).toContain("target skill binding status unavailable");
    expect(payload.missingInformation).not.toContain(
      "target skill is not bound to any discovered agent"
    );
    expectOnlyReadCommands(runner.calls);
  });

  it("recognizes target skill from array-valued binding fields", async () => {
    const runner = new FakeInspectRunner();
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [{ name: "dev-agent" }]);
    runner.jsonResponses.set("multica agent skills list --output json", [
      { agent: "dev-agent", skills: ["agent-switchyard"] }
    ]);
    runner.jsonResponses.set("multica runtime list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    const payload = JSON.parse(lines[0]);
    expect(payload.degraded).toBe(false);
    expect(payload.missingInformation).not.toContain("target skill binding status unavailable");
    expect(payload.missingInformation).not.toContain(
      "target skill is not bound to any discovered agent"
    );
    expectOnlyReadCommands(runner.calls);
  });

  it("recognizes target skill from nested binding arrays", async () => {
    const runner = new FakeInspectRunner();
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [{ name: "dev-agent" }]);
    runner.jsonResponses.set("multica agent skills list --output json", [
      { agent: "dev-agent", skillBindings: [{ skillName: "agent-switchyard" }] }
    ]);
    runner.jsonResponses.set("multica runtime list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    const payload = JSON.parse(lines[0]);
    expect(payload.degraded).toBe(false);
    expect(payload.missingInformation).not.toContain("target skill binding status unavailable");
    expect(payload.missingInformation).not.toContain(
      "target skill is not bound to any discovered agent"
    );
    expectOnlyReadCommands(runner.calls);
  });

  it("does not degrade inspect when only write capabilities are missing", async () => {
    const runner = new FakeInspectRunner(
      HELP_COMMANDS.filter(
        (command) =>
          command !== "multica skill create --help" &&
          command !== "multica skill update --help" &&
          command !== "multica skill files upsert --help" &&
          command !== "multica agent skills set --help"
      )
    );
    runner.runResponses.set("multica config show", ok('{"workspace":"demo-workspace"}'));
    runner.jsonResponses.set("multica skill list --output json", [{ name: "agent-switchyard" }]);
    runner.jsonResponses.set("multica agent list --output json", [
      { name: "dev-agent", skills: ["agent-switchyard"] }
    ]);
    runner.jsonResponses.set("multica agent skills list --output json", [
      { agent: "dev-agent", skill: "agent-switchyard" }
    ]);
    runner.jsonResponses.set("multica runtime list --output json", []);
    const { lines } = captureLogs();

    await runInspect(runner, { json: true, skillName: "agent-switchyard" });

    const payload = JSON.parse(lines[0]);
    expect(payload.capabilities.missing).toEqual([
      "multica skill create --help",
      "multica skill update --help",
      "multica skill files upsert --help",
      "multica agent skills set --help"
    ]);
    expect(payload.inspect.missingCapabilities).toEqual([]);
    expect(payload.degraded).toBe(false);
    expect(payload.missingInformation).toEqual([]);
    expectOnlyReadCommands(runner.calls);
  });
});
