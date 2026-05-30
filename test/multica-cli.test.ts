import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { probeCapabilities, requireCapabilities } from "../src/lib/capability-probe.js";
import { UserError } from "../src/lib/errors.js";
import { MulticaCli, parseJsonOutput, type CommandResult, type MulticaRunner } from "../src/lib/multica-cli.js";

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

class FakeHelpRunner implements MulticaRunner {
  readonly calls: string[] = [];

  constructor(private readonly supportedHelpCommands: Set<string>) {}

  async run(args: string[]): Promise<CommandResult> {
    const command = commandString(args);
    this.calls.push(command);

    if (this.supportedHelpCommands.has(command)) {
      return { stdout: `${command} help`, stderr: "", exitCode: 0, signal: null };
    }

    return { stdout: `unknown command: ${command}`, stderr: "not supported", exitCode: 2, signal: null };
  }

  async json<T>(): Promise<T> {
    throw new Error("FakeHelpRunner.json should not be called by capability probing");
  }
}

describe("parseJsonOutput", () => {
  it("parses JSON output", () => {
    expect(parseJsonOutput('[{"name":"agent-switchyard"}]', "skill list")).toEqual([
      { name: "agent-switchyard" }
    ]);
  });

  it("throws a readable UserError for non-JSON output", () => {
    expect(() => parseJsonOutput("not json", "skill list")).toThrow(UserError);
    expect(() => parseJsonOutput("not json", "skill list")).toThrow(
      "Expected JSON from multica skill list"
    );
  });
});

describe("MulticaCli", () => {
  it("json throws a UserError that preserves stderr and stdout when the command exits nonzero", async () => {
    class NonzeroCli extends MulticaCli {
      async run(args: string[]): Promise<CommandResult> {
        expect(args).toEqual(["skill", "list", "--output", "json"]);
        return { stdout: "partial stdout", stderr: "auth failed", exitCode: 17, signal: null };
      }
    }

    try {
      await new NonzeroCli("unused").json(["skill", "list", "--output", "json"], "skill list");
      throw new Error("Expected json() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UserError);
      expect((error as Error).message).toContain("auth failed");
      expect((error as Error).message).toContain("partial stdout");
      expect((error as Error).message).toContain("exit code 17");
    }
  });

  it("returns a clear failure and terminates the child when the command times out", async () => {
    class TimeoutChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      killedWith: NodeJS.Signals | undefined;

      kill(signal?: NodeJS.Signals): boolean {
        this.killedWith = signal;
        return true;
      }
    }

    let child: TimeoutChild | undefined;
    const cli = new MulticaCli("fake-multica-timeout", {
      timeoutMs: 5,
      spawn: () => {
        child = new TimeoutChild();
        return child;
      }
    });

    const result = await cli.run(["skill", "list"]);

    expect(child?.killedWith).toBe("SIGTERM");
    expect(result).toMatchObject({
      stdout: "",
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true
    });
    expect(result.stderr).toContain("timed out after 5ms");
  });

  it("reports signal-terminated json commands without disguising them as exit code 1", async () => {
    class SignaledChild extends EventEmitter {
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();

      kill(): boolean {
        return true;
      }
    }

    const cli = new MulticaCli("fake-multica-signal", {
      spawn: () => {
        const child = new SignaledChild();
        child.stderr.end("terminated externally");
        setImmediate(() => child.emit("close", null, "SIGTERM"));
        return child;
      }
    });

    await expect(cli.json(["skill", "list"], "skill list")).rejects.toThrow(
      "terminated by signal SIGTERM"
    );
    await expect(cli.json(["skill", "list"], "skill list")).rejects.not.toThrow("exit code 1");
  });

  it("reports a missing multica executable as a UserError", async () => {
    const cli = new MulticaCli(`definitely-missing-multica-${Date.now()}`);

    await expect(cli.run(["--help"])).rejects.toMatchObject({
      name: "UserError",
      message: expect.stringContaining("multica CLI not found in PATH")
    });
  });
});

describe("probeCapabilities", () => {
  it("uses help commands and reports missing CLI surfaces as user-facing commands", async () => {
    const supported = new Set(
      HELP_COMMANDS.filter(
        (command) =>
          command !== "multica skill files upsert --help" &&
          command !== "multica agent skills set --help" &&
          command !== "multica runtime list --help"
      )
    );
    const runner = new FakeHelpRunner(supported);

    const capabilities = await probeCapabilities(runner);

    expect(runner.calls).toEqual(HELP_COMMANDS);
    expect(capabilities.skillFilesUpsert).toBe(false);
    expect(capabilities.agentSkillsSet).toBe(false);
    expect(capabilities.runtimeList).toBe(false);
    expect(capabilities.skill).toBe(true);
    expect(capabilities.agentSkills).toBe(true);
    expect(capabilities.missing).toEqual([
      "multica skill files upsert --help",
      "multica agent skills set --help",
      "multica runtime list --help"
    ]);
  });
});

describe("requireCapabilities", () => {
  it("throws a useful UserError for missing required capabilities", async () => {
    const supported = new Set(
      HELP_COMMANDS.filter((command) => command !== "multica skill files upsert --help")
    );
    const capabilities = await probeCapabilities(new FakeHelpRunner(supported));

    expect(() => requireCapabilities(capabilities, ["skillFilesUpsert"])).toThrow(UserError);
    expect(() => requireCapabilities(capabilities, ["skillFilesUpsert"])).toThrow(
      "multica skill files upsert --help"
    );
    expect(() => requireCapabilities(capabilities, ["skillFilesUpsert"])).toThrow(
      "upgrade or check your Multica CLI"
    );
  });
});
