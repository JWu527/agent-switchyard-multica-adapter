import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { mergeSkillIds, resolveAgent, resolveSkill, type AgentLike, type SkillLike } from "../lib/bind-resolver.js";
import { UserError } from "../lib/errors.js";
import type { MulticaRunner } from "../lib/multica-cli.js";

interface SkillBinding {
  id: string;
  name?: string;
}

interface BindChange {
  agent: AgentLike;
  beforeSkills: SkillBinding[];
  beforeSkillIds: string[];
  afterSkillIds: string[];
  alreadyBound: boolean;
  setArgs: string[];
  readBackSkillIds?: string[];
}

interface BindPayload {
  dryRun: boolean;
  skillName: string;
  skillId: string;
  changes: BindChange[];
}

export interface BindOptions {
  skillName?: string;
  agent?: string[] | string;
  dryRun?: boolean;
  json?: boolean;
  output?: (text: string) => void;
}

function emit(options: BindOptions, text: string): void {
  (options.output ?? console.log)(text);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function listFromJson(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new UserError(`Expected array from multica ${label}`);
  return value;
}

function resolveBindInput(options: BindOptions): { skillName: string; agentSelectors: string[] } {
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";
  const rawSelectors = Array.isArray(options.agent)
    ? options.agent
    : options.agent === undefined
      ? []
      : [options.agent];
  const agentSelectors = rawSelectors.map((selector) => selector.trim()).filter((selector) => selector.length > 0);

  if (skillName.trim().length === 0) {
    throw new UserError("Missing --skill-name or SWITCHYARD_SKILL_NAME");
  }
  if (agentSelectors.length === 0) throw new UserError("At least one --agent is required");

  return { skillName, agentSelectors };
}

function normalizeAgentSkillEntry(entry: unknown, agent: AgentLike, index: number): SkillBinding {
  if (nonEmptyString(entry)) return { id: entry };
  if (!isRecord(entry) || !nonEmptyString(entry.id)) {
    throw new UserError(
      `Malformed multica agent skills list entry for agent ${agent.name} at index ${index}: missing non-empty string id`
    );
  }

  return {
    id: entry.id,
    name: nonEmptyString(entry.name) ? entry.name : undefined
  };
}

function normalizeAgentSkills(value: unknown, agent: AgentLike): SkillBinding[] {
  if (!Array.isArray(value)) throw new UserError(`Expected array from multica agent skills list for agent ${agent.name}`);
  return value.map((entry, index) => normalizeAgentSkillEntry(entry, agent, index));
}

function skillIds(skills: readonly SkillBinding[]): string[] {
  return skills.map((skill) => skill.id);
}

function setArgs(agentId: string, skillIdList: readonly string[]): string[] {
  return ["agent", "skills", "set", agentId, "--skill-ids", skillIdList.join(","), "--output", "json"];
}

function formatSkillIds(ids: readonly string[]): string {
  return ids.length === 0 ? "(none)" : ids.join(", ");
}

function diffSkillIdMultiset(expected: readonly string[], actual: readonly string[]): { missing: string[]; extra: string[] } {
  const counts = new Map<string, number>();
  for (const id of expected) counts.set(id, (counts.get(id) ?? 0) + 1);

  const extra: string[] = [];
  for (const id of actual) {
    const count = counts.get(id) ?? 0;
    if (count === 0) {
      extra.push(id);
      continue;
    }
    if (count === 1) {
      counts.delete(id);
    } else {
      counts.set(id, count - 1);
    }
  }

  const missing = [...counts.entries()].flatMap(([id, count]) => Array.from({ length: count }, () => id));
  return { missing: missing.sort(), extra: extra.sort() };
}

function assertMatchingReadBack(agent: AgentLike, expected: readonly string[], actual: readonly string[]): void {
  const diff = diffSkillIdMultiset(expected, actual);
  if (diff.missing.length > 0 || diff.extra.length > 0) {
    throw new UserError(
      [
        `Read-back verification failed for agent ${agent.name}: expected ${formatSkillIds(expected)}, got ${formatSkillIds(actual)}`,
        `missing: ${formatSkillIds(diff.missing)}`,
        `extra: ${formatSkillIds(diff.extra)}`
      ].join("; ")
    );
  }
}

function outputPayload(payload: BindPayload, options: BindOptions): void {
  if (options.json) {
    emit(options, JSON.stringify(payload, null, 2));
    return;
  }

  const lines = [
    `Bind ${payload.dryRun ? "dry run" : "result"}: ${payload.skillName}`,
    `Skill ID: ${payload.skillId}`,
    ...payload.changes.flatMap((change) => [
      `Agent ${change.agent.name} (${change.agent.id})${change.alreadyBound ? " already bound" : ""}`,
      `  Before skills: ${formatSkillIds(change.beforeSkillIds)}`,
      `  After skills: ${formatSkillIds(change.afterSkillIds)}`,
      `  Planned set: multica ${change.setArgs.join(" ")}`,
      ...(change.readBackSkillIds === undefined
        ? []
        : [`  Read-back skills: ${formatSkillIds(change.readBackSkillIds)}`])
    ])
  ];
  emit(options, lines.join("\n"));
}

export async function runBind(runner: MulticaRunner, options: BindOptions): Promise<void> {
  const { skillName, agentSelectors } = resolveBindInput(options);
  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "agentList", "agentSkillsList", "agentSkillsSet"]);

  const skillList = listFromJson(
    await runner.json<unknown>(["skill", "list", "--output", "json"], "skill list"),
    "skill list"
  );
  const skill: SkillLike = resolveSkill(skillList, skillName);

  const agentList = listFromJson(
    await runner.json<unknown>(["agent", "list", "--output", "json"], "agent list"),
    "agent list"
  );
  const targetAgents = agentSelectors.map((selector) => resolveAgent(agentList, selector));
  const changes: BindChange[] = [];

  for (const agent of targetAgents) {
    const beforeSkills = normalizeAgentSkills(
      await runner.json<unknown>(["agent", "skills", "list", agent.id, "--output", "json"], "agent skills list"),
      agent
    );
    const beforeSkillIds = skillIds(beforeSkills);
    const afterSkillIds = mergeSkillIds(beforeSkillIds, skill.id);
    changes.push({
      agent,
      beforeSkills,
      beforeSkillIds,
      afterSkillIds,
      alreadyBound: beforeSkillIds.includes(skill.id),
      setArgs: setArgs(agent.id, afterSkillIds)
    });
  }

  for (const change of changes) {
    if (!options.dryRun) {
      await runner.json<unknown>(change.setArgs, "agent skills set");
      const readBackSkills = normalizeAgentSkills(
        await runner.json<unknown>(["agent", "skills", "list", change.agent.id, "--output", "json"], "agent skills list"),
        change.agent
      );
      const readBackSkillIds = skillIds(readBackSkills);
      assertMatchingReadBack(change.agent, change.afterSkillIds, readBackSkillIds);
      change.readBackSkillIds = readBackSkillIds;
    }
  }

  outputPayload(
    {
      dryRun: options.dryRun === true,
      skillName,
      skillId: skill.id,
      changes
    },
    options
  );
}
