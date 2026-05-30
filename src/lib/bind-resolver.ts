import { UserError } from "./errors.js";

export interface AgentLike {
  id: string;
  name: string;
}

export interface SkillLike {
  id: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function candidateList(candidates: readonly AgentLike[] | readonly SkillLike[]): string {
  return candidates.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ");
}

export function isUuidSelector(selector: string): boolean {
  return UUID_RE.test(selector);
}

export function resolveAgent(agents: readonly unknown[], selector: string): AgentLike {
  if (isUuidSelector(selector)) {
    for (const agent of agents) {
      if (!isRecord(agent) || agent.id !== selector) continue;
      if (!nonEmptyString(agent.name)) {
        throw new UserError(`Malformed multica agent list entry for id "${selector}": missing non-empty string name`);
      }
      return { id: selector, name: agent.name };
    }

    throw new UserError(`Agent not found by id: "${selector}"`);
  }

  const matches: AgentLike[] = [];
  for (const agent of agents) {
    if (!isRecord(agent) || agent.name !== selector) continue;
    if (!nonEmptyString(agent.id)) {
      throw new UserError(`Malformed multica agent list entry for "${selector}": missing non-empty string id`);
    }
    matches.push({ id: agent.id, name: selector });
  }

  if (matches.length === 0) throw new UserError(`Agent not found by exact name: "${selector}"`);
  if (matches.length > 1) {
    throw new UserError(
      `Multiple agents match name "${selector}". Candidates: ${candidateList(matches)}. Use an id.`
    );
  }

  return matches[0];
}

export function resolveSkill(skills: readonly unknown[], skillName: string): SkillLike {
  const matches: SkillLike[] = [];
  for (const skill of skills) {
    if (!isRecord(skill) || skill.name !== skillName) continue;
    if (!nonEmptyString(skill.id)) {
      throw new UserError(`Malformed multica skill list entry for "${skillName}": missing non-empty string id`);
    }
    matches.push({ id: skill.id, name: skillName });
  }

  if (matches.length === 0) {
    throw new UserError(`Skill not found in Multica: "${skillName}". Run publish first.`);
  }
  if (matches.length > 1) {
    throw new UserError(
      `Multiple skills match name "${skillName}". Candidates: ${candidateList(matches)}`
    );
  }

  return matches[0];
}

export function mergeSkillIds(existing: readonly string[], targetSkillId: string): string[] {
  return existing.includes(targetSkillId) ? [...existing] : [...existing, targetSkillId];
}
