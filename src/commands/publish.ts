import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { UserError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { collectSkillSource, type SkillSource, type SkillSourceFile } from "../lib/skill-source.js";
import type { MulticaRunner } from "../lib/multica-cli.js";

interface MulticaSkill {
  id: string;
  name: string;
}

type PublishAction = "create" | "update";

interface PublishPlan {
  dryRun: boolean;
  action: PublishAction;
  skillName: string;
  skillId?: string;
  fileCount: number;
  totalSize: number;
  sourceHash: string;
  localFiles: FilePlanEntry[];
  remoteFilesToUpsert: FilePlanEntry[];
}

type PublishOutput = PublishPlan & {
  preflight?: PublishPlan;
};

interface FilePlanEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface PublishOptions {
  source?: string;
  skillName?: string;
  dryRun?: boolean;
  json?: boolean;
  output?: (text: string) => void;
}

function emit(options: PublishOptions, text: string): void {
  (options.output ?? console.log)(text);
}

function resolvePublishInput(options: PublishOptions): { source: string; skillName: string } {
  const source = options.source ?? process.env.SWITCHYARD_SKILL_SOURCE;
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";

  if (source === undefined || source.trim().length === 0) {
    throw new UserError("Missing --source or SWITCHYARD_SKILL_SOURCE");
  }
  if (skillName.trim().length === 0) {
    throw new UserError("Missing --skill-name or SWITCHYARD_SKILL_NAME");
  }

  return { source, skillName };
}

function fileEntry(file: SkillSourceFile): FilePlanEntry {
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256
  };
}

function sourceHash(files: FilePlanEntry[]): string {
  return sha256(JSON.stringify(files.map((file) => [file.path, file.size, file.sha256])));
}

function findSkillContent(source: SkillSource): string {
  const skillFile = source.files.find((file) => file.path === "SKILL.md");
  if (skillFile === undefined) throw new UserError("Collected source is missing SKILL.md");
  return skillFile.content;
}

function supportingFiles(source: SkillSource): SkillSourceFile[] {
  return source.files.filter((file) => file.path !== "SKILL.md");
}

function buildPlan(input: {
  source: SkillSource;
  skillName: string;
  existing?: MulticaSkill;
  dryRun: boolean;
}): PublishPlan {
  const localFiles = input.source.files.map(fileEntry);
  const remoteFilesToUpsert = supportingFiles(input.source).map(fileEntry);

  return {
    dryRun: input.dryRun,
    action: input.existing === undefined ? "create" : "update",
    skillName: input.skillName,
    skillId: input.existing?.id,
    fileCount: input.source.files.length,
    totalSize: input.source.files.reduce((sum, file) => sum + file.size, 0),
    sourceHash: sourceHash(localFiles),
    localFiles,
    remoteFilesToUpsert
  };
}

function humanPlanText(plan: PublishPlan, title: string): string {
  return [
    `${title}: ${plan.action} ${plan.skillName}`,
    ...(plan.skillId === undefined ? [] : [`Skill ID: ${plan.skillId}`]),
    `Files read: ${plan.fileCount}`,
    `Total size: ${plan.totalSize} bytes`,
    `Source sha256: ${plan.sourceHash}`,
    "Local files:",
    ...plan.localFiles.map((file) => `  - ${file.path} (${file.size} bytes, ${file.sha256})`),
    "Remote files to upsert:",
    ...plan.remoteFilesToUpsert.map((file) => `  - ${file.path} (${file.size} bytes, ${file.sha256})`)
  ].join("\n");
}

function outputPlan(plan: PublishOutput, options: PublishOptions, title?: string): void {
  if (options.json) {
    emit(options, JSON.stringify(plan, null, 2));
    return;
  }

  emit(options, humanPlanText(plan, title ?? `Publish ${plan.dryRun ? "dry run" : "result"}`));
}

async function listSkills(runner: MulticaRunner): Promise<MulticaSkill[]> {
  const skills = await runner.json<unknown>(["skill", "list", "--output", "json"], "skill list");
  if (!Array.isArray(skills)) throw new UserError("Expected array from multica skill list");
  return skills.flatMap((skill) => {
    if (skill === null || typeof skill !== "object") return [];
    const record = skill as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

function skillIdFromCreateResponse(value: unknown, skillName: string): string {
  if (value === null || typeof value !== "object") {
    throw new UserError(`multica skill create did not return an object with a non-empty skill id for ${skillName}`);
  }

  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new UserError(`multica skill create did not return a non-empty skill id for ${skillName}`);
  }

  return id;
}

async function upsertSupportingFiles(
  runner: MulticaRunner,
  skillId: string,
  files: SkillSourceFile[]
): Promise<void> {
  for (const file of files) {
    await runner.json(
      ["skill", "files", "upsert", skillId, "--path", file.path, "--content", file.content, "--output", "json"],
      "skill files upsert"
    );
  }
}

export async function runPublish(runner: MulticaRunner, options: PublishOptions): Promise<void> {
  const { source, skillName } = resolvePublishInput(options);
  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "skillCreate", "skillUpdate", "skillFilesUpsert"]);

  const sourceBundle = await collectSkillSource(source, skillName);
  const skills = await listSkills(runner);
  const existing = skills.find((skill) => skill.name === skillName);
  const plan = buildPlan({
    source: sourceBundle,
    skillName,
    existing,
    dryRun: options.dryRun === true
  });

  if (options.dryRun) {
    outputPlan(plan, options);
    return;
  }

  if (!options.json) {
    outputPlan(plan, options, "Publish preflight");
  }

  const skillContent = findSkillContent(sourceBundle);
  let skillId = existing?.id;

  if (skillId === undefined) {
    const created = await runner.json<unknown>(
      ["skill", "create", "--name", skillName, "--content", skillContent, "--output", "json"],
      "skill create"
    );
    skillId = skillIdFromCreateResponse(created, skillName);
  } else {
    await runner.json(
      ["skill", "update", skillId, "--name", skillName, "--content", skillContent, "--output", "json"],
      "skill update"
    );
  }

  if (skillId === undefined || skillId.trim().length === 0) {
    throw new UserError("Multica skill create/update did not return a skill id");
  }

  await upsertSupportingFiles(runner, skillId, supportingFiles(sourceBundle));
  outputPlan({ ...plan, dryRun: false, skillId, preflight: plan }, options);
}
