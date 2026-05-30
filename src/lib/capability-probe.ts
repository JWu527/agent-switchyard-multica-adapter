import { UserError } from "./errors.js";
import type { MulticaRunner } from "./multica-cli.js";

const CAPABILITY_HELP_COMMANDS = [
  ["multica", ["--help"]],
  ["skill", ["skill", "--help"]],
  ["agent", ["agent", "--help"]],
  ["runtime", ["runtime", "--help"]],
  ["skillCreate", ["skill", "create", "--help"]],
  ["skillUpdate", ["skill", "update", "--help"]],
  ["skillGet", ["skill", "get", "--help"]],
  ["skillList", ["skill", "list", "--help"]],
  ["skillFiles", ["skill", "files", "--help"]],
  ["skillFilesUpsert", ["skill", "files", "upsert", "--help"]],
  ["agentList", ["agent", "list", "--help"]],
  ["agentSkills", ["agent", "skills", "--help"]],
  ["agentSkillsList", ["agent", "skills", "list", "--help"]],
  ["agentSkillsSet", ["agent", "skills", "set", "--help"]],
  ["runtimeList", ["runtime", "list", "--help"]]
] as const;

export type CapabilityKey = (typeof CAPABILITY_HELP_COMMANDS)[number][0];

export type CapabilityMap = {
  [key in CapabilityKey]: boolean;
} & {
  missing: string[];
};

function helpCommand(args: readonly string[]): string {
  return ["multica", ...args].join(" ");
}

const HELP_COMMAND_BY_KEY = Object.fromEntries(
  CAPABILITY_HELP_COMMANDS.map(([key, args]) => [key, helpCommand(args)])
) as Record<CapabilityKey, string>;

async function hasHelp(runner: MulticaRunner, args: readonly string[]): Promise<boolean> {
  const result = await runner.run([...args]);
  return result.exitCode === 0;
}

export async function probeCapabilities(
  runner: MulticaRunner,
  keys?: readonly CapabilityKey[]
): Promise<CapabilityMap> {
  const capabilities: Partial<Record<CapabilityKey, boolean>> = {};
  const missing: string[] = [];
  const requested = new Set<CapabilityKey>(keys ?? CAPABILITY_HELP_COMMANDS.map(([key]) => key));

  for (const [key, args] of CAPABILITY_HELP_COMMANDS) {
    if (!requested.has(key)) {
      capabilities[key] = false;
      continue;
    }

    const ok = await hasHelp(runner, args);
    capabilities[key] = ok;
    if (!ok) missing.push(HELP_COMMAND_BY_KEY[key]);
  }

  return { ...capabilities, missing } as CapabilityMap;
}

export function requireCapabilities(map: CapabilityMap, required: readonly CapabilityKey[]): void {
  const missing = required.filter((key) => !map[key]).map((key) => HELP_COMMAND_BY_KEY[key]);

  if (missing.length > 0) {
    throw new UserError(
      `Missing required Multica CLI capabilities: ${missing.join(", ")}. Please upgrade or check your Multica CLI installation.`
    );
  }
}
