import { spawn } from "node:child_process";
import { UserError } from "./errors.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MulticaRunner {
  run(args: string[]): Promise<CommandResult>;
  json<T>(args: string[], label: string): Promise<T>;
}

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
  const parts = [`multica ${label} failed with exit code ${result.exitCode}`];
  if (result.stderr.trim().length > 0) parts.push(`stderr: ${outputPreview(result.stderr, 1000)}`);
  if (result.stdout.trim().length > 0) parts.push(`stdout: ${outputPreview(result.stdout, 1000)}`);
  if (parts.length === 1) parts.push("no output from command");
  return parts.join("\n");
}

export class MulticaCli implements MulticaRunner {
  constructor(private readonly bin = "multica") {}

  async run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error.code === "ENOENT") {
          reject(new UserError(`multica CLI not found in PATH (tried ${this.bin})`));
          return;
        }
        reject(error);
      });

      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });
    });
  }

  async json<T>(args: string[], label: string): Promise<T> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new UserError(commandFailureMessage(label, result));
    }
    return parseJsonOutput<T>(result.stdout, label);
  }
}
