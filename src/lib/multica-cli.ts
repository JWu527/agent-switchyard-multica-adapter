import { spawn as nodeSpawn } from "node:child_process";
import { UserError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const TIMEOUT_SIGNAL: NodeJS.Signals = "SIGTERM";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
  timeoutMs?: number;
}

export interface MulticaRunner {
  run(args: string[]): Promise<CommandResult>;
  json<T>(args: string[], label: string): Promise<T>;
}

interface StreamLike {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
}

interface ChildProcessLike {
  stdout: StreamLike;
  stderr: StreamLike;
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  once(event: "close", listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnCommand = (bin: string, args: string[]) => ChildProcessLike;

export interface MulticaCliOptions {
  timeoutMs?: number;
  spawn?: SpawnCommand;
}

const defaultSpawn: SpawnCommand = (bin, args) =>
  nodeSpawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

function outputPreview(output: string, maxLength: number): string {
  const trimmed = output.trim();
  if (trimmed.length === 0) return "empty output";
  return trimmed.slice(0, maxLength);
}

export function parseJsonOutput<T = unknown>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new UserError(`Expected JSON from multica ${label}, got: ${outputPreview(stdout, 300)}`);
  }
}

function commandFailureMessage(label: string, result: CommandResult): string {
  const parts = [];
  if (result.timedOut) {
    const timeoutMs = result.timeoutMs === undefined ? "the configured timeout" : `${result.timeoutMs}ms`;
    parts.push(`multica ${label} timed out after ${timeoutMs}`);
  } else if (result.signal !== null) {
    parts.push(`multica ${label} terminated by signal ${result.signal}`);
  } else if (result.exitCode !== null) {
    parts.push(`multica ${label} failed with exit code ${result.exitCode}`);
  } else {
    parts.push(`multica ${label} failed without an exit code or signal`);
  }

  if (result.stderr.trim().length > 0) parts.push(`stderr: ${outputPreview(result.stderr, 1000)}`);
  if (result.stdout.trim().length > 0) parts.push(`stdout: ${outputPreview(result.stdout, 1000)}`);
  if (parts.length === 1) parts.push("no output from command");
  return parts.join("\n");
}

export class MulticaCli implements MulticaRunner {
  private readonly timeoutMs: number;
  private readonly spawnCommand: SpawnCommand;

  constructor(private readonly bin = "multica", options: MulticaCliOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.spawnCommand = options.spawn ?? defaultSpawn;
  }

  async run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnCommand(this.bin, args);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const command = [this.bin, ...args].join(" ");

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill(TIMEOUT_SIGNAL);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          stderr += `${stderr.length > 0 ? "\n" : ""}Failed to terminate timed out multica process: ${message}`;
        }

        const timeoutMessage = `${command} timed out after ${this.timeoutMs}ms`;
        resolve({
          stdout,
          stderr: `${stderr}${stderr.length > 0 ? "\n" : ""}${timeoutMessage}`,
          exitCode: null,
          signal: TIMEOUT_SIGNAL,
          timedOut: true,
          timeoutMs: this.timeoutMs
        });
      }, this.timeoutMs);

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error.code === "ENOENT") {
          reject(new UserError(`multica CLI not found in PATH (tried ${this.bin})`));
          return;
        }
        reject(error);
      });

      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve({ stdout, stderr, exitCode, signal });
      });
    });
  }

  async json<T>(args: string[], label: string): Promise<T> {
    const result = await this.run(args);
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut === true) {
      throw new UserError(commandFailureMessage(label, result));
    }
    return parseJsonOutput<T>(result.stdout, label);
  }
}
