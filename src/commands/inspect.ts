import { probeCapabilities, type CapabilityKey, type CapabilityMap } from "../lib/capability-probe.js";
import type { CommandResult, MulticaRunner } from "../lib/multica-cli.js";

export interface InspectOptions {
  json?: boolean;
  skillName?: string;
}

type SafeRunResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      workspace?: string;
    }
  | {
      ok: false;
      error: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    };

type SafeListResult =
  | {
      ok: true;
      count: number;
      result: unknown[];
    }
  | {
      ok: false;
      error: string;
      unavailable?: boolean;
    };

interface InspectPayload {
  capabilities: CapabilityMap;
  inspect: {
    missingCapabilities: string[];
  };
  config: SafeRunResult;
  skills: SafeListResult;
  agents: SafeListResult;
  agentSkillBindings: SafeListResult;
  runtimes: SafeListResult;
  skillName?: string;
  degraded: boolean;
  missingInformation: string[];
}

type InspectCapabilityKey = Extract<CapabilityKey, "skillList" | "agentList" | "agentSkillsList" | "runtimeList">;

const INSPECT_CAPABILITY_COMMANDS: Record<InspectCapabilityKey, string> = {
  skillList: "multica skill list --help",
  agentList: "multica agent list --help",
  agentSkillsList: "multica agent skills list --help",
  runtimeList: "multica runtime list --help"
};

const AGENT_BINDING_FIELD_KEYS = ["skills", "skillNames", "boundSkills", "skillBindings"] as const;
const BINDING_ENTRY_FIELD_KEYS = [
  "skill",
  "skillName",
  "name",
  "id",
  "skills",
  "skillNames",
  "boundSkills",
  "skillBindings"
] as const;

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function outputPreview(output: string): string | undefined {
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : undefined;
}

function commandFailed(result: CommandResult): boolean {
  return result.exitCode !== 0 || result.signal !== null || result.timedOut === true;
}

function runFailureMessage(label: string, result: CommandResult): string {
  const parts: string[] = [];
  if (result.timedOut) {
    parts.push(`multica ${label} timed out`);
  } else if (result.signal !== null) {
    parts.push(`multica ${label} terminated by signal ${result.signal}`);
  } else {
    parts.push(`multica ${label} failed with exit code ${result.exitCode}`);
  }

  const stderr = outputPreview(result.stderr);
  const stdout = outputPreview(result.stdout);
  if (stderr !== undefined) parts.push(`stderr: ${stderr}`);
  if (stdout !== undefined) parts.push(`stdout: ${stdout}`);
  return parts.join("; ");
}

function findWorkspace(value: unknown): string | undefined {
  if (typeof value === "string") return undefined;
  if (value === null || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["workspace", "currentWorkspace", "workspaceName", "current_workspace"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }

  for (const candidate of Object.values(record)) {
    const nested = findWorkspace(candidate);
    if (nested !== undefined) return nested;
  }

  return undefined;
}

function extractWorkspace(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const workspace = findWorkspace(parsed);
    if (workspace !== undefined) return workspace;
  } catch {
    // Plain text config output is expected on some CLI versions.
  }

  const match = trimmed.match(/(?:current\s+)?workspace\s*(?:=|:)\s*([^\n]+)/i);
  return match?.[1]?.trim();
}

async function safeRun(runner: MulticaRunner, args: string[], label: string): Promise<SafeRunResult> {
  try {
    const result = await runner.run(args);
    if (commandFailed(result)) {
      return {
        ok: false,
        error: runFailureMessage(label, result),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        signal: result.signal
      };
    }

    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      workspace: extractWorkspace(result.stdout)
    };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  }
}

function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

async function safeJsonArray(
  runner: MulticaRunner,
  args: string[],
  label: string
): Promise<SafeListResult> {
  try {
    const value = await runner.json<unknown>(args, label);
    if (!Array.isArray(value)) {
      return { ok: false, error: `Expected array from multica ${label}, got ${shapeOf(value)}` };
    }

    return { ok: true, count: value.length, result: value };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  }
}

function unavailable(error: string): SafeListResult {
  return { ok: false, error, unavailable: true };
}

function itemName(item: unknown): string | undefined {
  if (typeof item === "string" && item.trim().length > 0) return item;
  if (item === null || typeof item !== "object") return undefined;

  const record = item as Record<string, unknown>;
  for (const key of ["name", "displayName", "id", "slug", "agent", "skill", "runtime"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }

  return undefined;
}

function itemContainsSkill(item: unknown, skillName: string): boolean {
  if (typeof item === "string") return item === skillName;
  if (item === null || typeof item !== "object") return false;

  const record = item as Record<string, unknown>;
  for (const key of ["skill", "skillName", "name", "id"]) {
    if (record[key] === skillName) return true;
  }

  for (const key of ["skills", "skillNames", "boundSkills"]) {
    const value = record[key];
    if (Array.isArray(value) && value.some((entry) => itemContainsSkill(entry, skillName))) {
      return true;
    }
  }

  return false;
}

function agentRecordBindingStatus(item: unknown, skillName: string): boolean | undefined {
  if (item === null || typeof item !== "object") return undefined;

  const record = item as Record<string, unknown>;
  let sawBindingField = false;
  for (const key of AGENT_BINDING_FIELD_KEYS) {
    if (!(key in record)) continue;
    sawBindingField = true;
    const value = record[key];
    if (Array.isArray(value)) {
      if (value.some((entry) => itemContainsSkill(entry, skillName))) return true;
    } else if (itemContainsSkill(value, skillName)) {
      return true;
    }
  }

  return sawBindingField ? false : undefined;
}

function agentListBindingStatus(agents: SafeListResult, skillName: string): boolean | undefined {
  if (!agents.ok) return undefined;

  let sawExplicitBindingField = false;
  for (const agent of agents.result) {
    const status = agentRecordBindingStatus(agent, skillName);
    if (status === true) return true;
    if (status === false) sawExplicitBindingField = true;
  }

  return sawExplicitBindingField ? false : undefined;
}

function bindingEntryStatus(item: unknown, skillName: string): boolean | undefined {
  if (typeof item === "string") return item === skillName;
  if (item === null || typeof item !== "object") return undefined;

  const record = item as Record<string, unknown>;
  let sawBindingField = false;
  for (const key of BINDING_ENTRY_FIELD_KEYS) {
    if (!(key in record)) continue;
    sawBindingField = true;
    if (itemContainsSkill(record[key], skillName)) return true;
  }

  return sawBindingField ? false : undefined;
}

function bindingListStatus(bindings: SafeListResult, skillName: string): boolean | undefined {
  if (!bindings.ok) return undefined;
  if (bindings.result.length === 0) return false;

  let allEntriesParsed = true;
  for (const binding of bindings.result) {
    const status = bindingEntryStatus(binding, skillName);
    if (status === true) return true;
    if (status === undefined) allEntriesParsed = false;
  }

  return allEntriesParsed ? false : undefined;
}

function hasSkillBinding(skillName: string, agents: SafeListResult, bindings: SafeListResult): boolean | undefined {
  const bindingStatus = bindingListStatus(bindings, skillName);
  if (bindingStatus !== undefined) return bindingStatus;
  if (bindings.ok) return undefined;
  return agentListBindingStatus(agents, skillName);
}

function onlineRuntimeCount(runtimes: SafeListResult): number {
  if (!runtimes.ok) return 0;

  return runtimes.result.filter((runtime) => {
    if (runtime === null || typeof runtime !== "object") return false;
    const record = runtime as Record<string, unknown>;
    const status = record.status ?? record.state;
    return typeof status === "string" && status.toLowerCase() === "online";
  }).length;
}

function collectMissingInformation(payload: Omit<InspectPayload, "degraded" | "missingInformation">): string[] {
  const missing: string[] = [];

  if (payload.inspect.missingCapabilities.length > 0) {
    missing.push("Multica CLI is missing some inspect capabilities");
  }
  if (!payload.config.ok) missing.push("config/current workspace unavailable");
  if (!payload.skills.ok) missing.push("skills list unavailable");
  if (!payload.agents.ok) missing.push("agents list unavailable");
  if (!payload.agentSkillBindings.ok) missing.push("agent skill binding list unavailable");
  if (!payload.runtimes.ok) missing.push("runtimes list unavailable");

  if (payload.runtimes.ok && payload.agents.ok && onlineRuntimeCount(payload.runtimes) > 0 && payload.agents.count === 0) {
    missing.push("runtime online but no agents found");
  }

  if (payload.skillName !== undefined) {
    const binding = hasSkillBinding(payload.skillName, payload.agents, payload.agentSkillBindings);
    if (binding === false) {
      missing.push("target skill is not bound to any discovered agent");
    } else if (binding === undefined) {
      missing.push("target skill binding status unavailable");
    }
  }

  return missing;
}

function isDegraded(payload: Omit<InspectPayload, "degraded" | "missingInformation">, missingInformation: string[]): boolean {
  return (
    payload.inspect.missingCapabilities.length > 0 ||
    !payload.config.ok ||
    !payload.skills.ok ||
    !payload.agents.ok ||
    !payload.agentSkillBindings.ok ||
    !payload.runtimes.ok ||
    missingInformation.length > 0
  );
}

function inspectMissingCapabilities(capabilities: CapabilityMap): string[] {
  return (Object.keys(INSPECT_CAPABILITY_COMMANDS) as InspectCapabilityKey[])
    .filter((key) => !capabilities[key])
    .map((key) => INSPECT_CAPABILITY_COMMANDS[key]);
}

function formatItem(item: unknown): string {
  const name = itemName(item);
  if (name === undefined) return JSON.stringify(item);

  if (item === null || typeof item !== "object") return name;
  const record = item as Record<string, unknown>;
  const details = ["provider", "status", "state", "workspace"]
    .flatMap((key) => {
      const value = record[key];
      return typeof value === "string" && value.trim().length > 0 ? [`${key}: ${value}`] : [];
    })
    .join(", ");

  return details.length > 0 ? `${name} (${details})` : name;
}

function printList(label: string, result: SafeListResult): void {
  if (!result.ok) {
    const status = result.unavailable === true ? "unavailable" : "error";
    console.log(`${label}: ${status} (${result.error})`);
    return;
  }

  console.log(`${label}: ${result.count} available`);
  for (const item of result.result.slice(0, 20)) {
    console.log(`  - ${formatItem(item)}`);
  }
  if (result.result.length > 20) console.log(`  - ... ${result.result.length - 20} more`);
}

function printHuman(payload: InspectPayload): void {
  console.log("Multica inspect");
  console.log("");
  console.log("Multica config/current workspace:");
  if (payload.config.ok) {
    console.log(payload.config.stdout.trim().length > 0 ? payload.config.stdout.trim() : "(empty)");
  } else {
    console.log(`Config: unavailable (${payload.config.error})`);
  }
  console.log(`Workspace: ${payload.config.ok && payload.config.workspace ? payload.config.workspace : "unavailable"}`);
  console.log("");
  console.log(`Full capabilities: ${payload.capabilities.missing.length === 0 ? "complete" : "degraded"}`);
  if (payload.capabilities.missing.length > 0) {
    console.log(`Full missing: ${payload.capabilities.missing.join(", ")}`);
  }
  console.log(`Inspect capabilities: ${payload.inspect.missingCapabilities.length === 0 ? "complete" : "degraded"}`);
  if (payload.inspect.missingCapabilities.length > 0) {
    console.log(`Inspect missing: ${payload.inspect.missingCapabilities.join(", ")}`);
  }
  console.log(`Inspect status: ${payload.degraded ? "degraded" : "complete"}`);
  console.log("");
  printList("Skills", payload.skills);
  printList("Agents", payload.agents);
  printList("Agent skill bindings", payload.agentSkillBindings);
  printList("Runtimes", payload.runtimes);
  console.log("");
  console.log("Common hints:");
  console.log("- CLI workspace and browser workspace may differ; compare the workspace shown here with the Multica UI.");
  console.log("- Runtime online but no agent: create or select an agent before binding skills.");
  console.log("- Agent missing target skill: bind the target skill to the intended agent before using it.");
  console.log("- Missing CLI capabilities: upgrade or check your Multica CLI installation when capabilities are unavailable.");
  console.log("");
  console.log("Diagnostic hints:");
  if (payload.missingInformation.includes("Multica CLI is missing some inspect capabilities")) {
    console.log("- Detected: Multica CLI is missing some inspect capabilities; upgrade or check your CLI installation.");
  }
  if (payload.missingInformation.includes("runtime online but no agents found")) {
    console.log("- Detected: runtime is online but no agents were found.");
  }
  if (payload.missingInformation.includes("target skill is not bound to any discovered agent")) {
    console.log("- Detected: target skill is not bound to any discovered agent.");
  }
  if (payload.missingInformation.includes("target skill binding status unavailable")) {
    console.log("- Detected: target skill binding status is unavailable from the discovered CLI output.");
  }
  if (payload.missingInformation.length === 0) console.log("- No degraded diagnostics detected.");
}

export async function runInspect(runner: MulticaRunner, options: InspectOptions): Promise<void> {
  const capabilities = await probeCapabilities(runner);
  const inspect = { missingCapabilities: inspectMissingCapabilities(capabilities) };
  const config = await safeRun(runner, ["config", "show"], "config show");
  const skills = capabilities.skillList
    ? await safeJsonArray(runner, ["skill", "list", "--output", "json"], "skill list")
    : unavailable("multica skill list --help unavailable");
  const agents = capabilities.agentList
    ? await safeJsonArray(runner, ["agent", "list", "--output", "json"], "agent list")
    : unavailable("multica agent list --help unavailable");
  const agentSkillBindings = capabilities.agentSkillsList
    ? await safeJsonArray(runner, ["agent", "skills", "list", "--output", "json"], "agent skills list")
    : unavailable("multica agent skills list --help unavailable");
  const runtimes = capabilities.runtimeList
    ? await safeJsonArray(runner, ["runtime", "list", "--output", "json"], "runtime list")
    : unavailable("multica runtime list --help unavailable");

  const partialPayload = {
    capabilities,
    inspect,
    config,
    skills,
    agents,
    agentSkillBindings,
    runtimes,
    skillName: options.skillName
  };
  const missingInformation = collectMissingInformation(partialPayload);
  const payload: InspectPayload = {
    ...partialPayload,
    degraded: isDegraded(partialPayload, missingInformation),
    missingInformation
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  printHuman(payload);
}
