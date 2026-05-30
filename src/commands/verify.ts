import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { diffFileRecords, type DiffRecord, type FileRecord } from "../lib/diff.js";
import { UserError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { MANIFEST_PATH, type SwitchyardMulticaManifest } from "../lib/manifest.js";
import { collectSkillSource } from "../lib/skill-source.js";
import type { MulticaRunner } from "../lib/multica-cli.js";

interface MulticaSkillSummary {
  id: string;
  name: string;
}

interface MulticaSkillFile {
  path: string;
  content?: string;
  sha256?: string;
  size?: number;
}

interface MulticaSkillDetail {
  id: string;
  name: string;
  content?: string;
  files?: MulticaSkillFile[];
}

type VerificationLevel = "content" | "manifest-only" | "unavailable";
const REMOTE_CONTENT_UNAVAILABLE_SHA = "<remote-content-unavailable>";
const REMOTE_CONTENT_UNAVAILABLE_SIZE = -1;

interface VerifyPayload {
  ok: boolean;
  skillName: string;
  skillId: string;
  degraded: boolean;
  verificationLevel: VerificationLevel;
  diffCount: number;
  diffs: DiffRecord[];
  notes: string[];
}

export interface VerifyOptions {
  source?: string;
  skillName?: string;
  agent?: string;
  json?: boolean;
  output?: (text: string) => void;
}

function emit(options: VerifyOptions, text: string): void {
  (options.output ?? console.log)(text);
}

function resolveVerifyInput(options: VerifyOptions): { source: string; skillName: string } {
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

function localRecords(manifest: SwitchyardMulticaManifest): FileRecord[] {
  return manifest.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    size: file.size
  }));
}

function normalizeSkillList(value: unknown): MulticaSkillSummary[] {
  if (!Array.isArray(value)) throw new UserError("Expected array from multica skill list");
  return value.flatMap((skill) => {
    if (skill === null || typeof skill !== "object") return [];
    const record = skill as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.name === "string"
      ? [{ id: record.id, name: record.name }]
      : [];
  });
}

function recordFromContent(path: string, content: string): FileRecord {
  return {
    path,
    sha256: sha256(content),
    size: Buffer.byteLength(content)
  };
}

interface RemoteRecords {
  records: FileRecord[];
  contentUnavailablePaths: string[];
}

function recordFromRemoteFile(file: MulticaSkillFile): { record: FileRecord; contentUnavailable: boolean } | undefined {
  if (file.path === MANIFEST_PATH) return undefined;
  if (typeof file.sha256 === "string" && typeof file.size === "number") {
    return {
      record: {
        path: file.path,
        sha256: file.sha256,
        size: file.size
      },
      contentUnavailable: false
    };
  }
  if (typeof file.content === "string") {
    return {
      record: recordFromContent(file.path, file.content),
      contentUnavailable: false
    };
  }
  return {
    record: {
      path: file.path,
      sha256: REMOTE_CONTENT_UNAVAILABLE_SHA,
      size: REMOTE_CONTENT_UNAVAILABLE_SIZE
    },
    contentUnavailable: true
  };
}

function remoteContentRecords(detail: MulticaSkillDetail): RemoteRecords {
  const records: FileRecord[] = [];
  const contentUnavailablePaths: string[] = [];
  if (typeof detail.content === "string") records.push(recordFromContent("SKILL.md", detail.content));

  for (const file of detail.files ?? []) {
    const result = recordFromRemoteFile(file);
    if (result !== undefined) {
      records.push(result.record);
      if (result.contentUnavailable) contentUnavailablePaths.push(result.record.path);
    }
  }

  return {
    records: records.sort((a, b) => a.path.localeCompare(b.path)),
    contentUnavailablePaths
  };
}

function manifestFromRemote(detail: MulticaSkillDetail): SwitchyardMulticaManifest | undefined {
  const manifestFile = detail.files?.find((file) => file.path === MANIFEST_PATH);
  if (manifestFile?.content === undefined) return undefined;

  try {
    const parsed = JSON.parse(manifestFile.content) as unknown;
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.tool !== "switchyard-multica" || !Array.isArray(record.files)) return undefined;

    const files = record.files.flatMap((file): SwitchyardMulticaManifest["files"] => {
      if (file === null || typeof file !== "object") return [];
      const fileRecord = file as Record<string, unknown>;
      return typeof fileRecord.path === "string" &&
        typeof fileRecord.sha256 === "string" &&
        typeof fileRecord.size === "number"
        ? [{ path: fileRecord.path, sha256: fileRecord.sha256, size: fileRecord.size }]
        : [];
    });

    return {
      tool: "switchyard-multica",
      toolVersion: typeof record.toolVersion === "string" ? record.toolVersion : "unknown",
      skillName: typeof record.skillName === "string" ? record.skillName : "",
      sourcePath: typeof record.sourcePath === "string" ? record.sourcePath : "",
      generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
      files
    };
  } catch {
    return undefined;
  }
}

function hasRemoteRecordForEveryLocal(local: FileRecord[], remote: FileRecord[]): boolean {
  const remotePaths = new Set(remote.map((file) => file.path));
  return local.every((file) => remotePaths.has(file.path));
}

function mergeManifestWithObservedExtraFiles(manifestRecords: FileRecord[], observedRecords: FileRecord[]): FileRecord[] {
  const manifestPaths = new Set(manifestRecords.map((file) => file.path));
  const extras = observedRecords.filter((file) => !manifestPaths.has(file.path));
  return [...manifestRecords, ...extras].sort((a, b) => a.path.localeCompare(b.path));
}

function outputPayload(payload: VerifyPayload, options: VerifyOptions): void {
  if (options.json) {
    emit(options, JSON.stringify(payload, null, 2));
    return;
  }

  const lines = [
    `Verify ${payload.ok ? "success" : "failed"}: ${payload.skillName}`,
    `Skill ID: ${payload.skillId}`,
    `Verification level: ${payload.verificationLevel}${payload.degraded ? " (degraded)" : ""}`,
    `Differences: ${payload.diffCount}`,
    ...payload.notes.map((note) => `Note: ${note}`),
    ...payload.diffs.map((diff) => `  - ${diff.kind}: ${diff.path}`)
  ];
  emit(options, lines.join("\n"));
}

function failureMessage(payload: VerifyPayload): string {
  if (payload.verificationLevel === "unavailable") {
    return "Verification failed: remote file content is unavailable and no readable remote manifest is available.";
  }
  if (payload.degraded) {
    return `Verification failed in degraded manifest-only mode with ${payload.diffCount} difference(s)`;
  }
  return `Verification failed with ${payload.diffCount} difference(s)`;
}

export async function runVerify(runner: MulticaRunner, options: VerifyOptions): Promise<void> {
  if (options.agent !== undefined && options.agent.trim().length > 0) {
    throw new UserError(
      "Agent binding verification is implemented by the bind/resolver task; omit --agent for content verification in Task 5."
    );
  }

  const { source, skillName } = resolveVerifyInput(options);
  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "skillGet"]);

  const local = await collectSkillSource(source, skillName);
  const localFileRecords = localRecords(local.manifest);
  const skills = normalizeSkillList(await runner.json<unknown>(["skill", "list", "--output", "json"], "skill list"));
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (skill === undefined) throw new UserError(`Skill not found in Multica: ${skillName}. Run publish first.`);

  const detail = await runner.json<MulticaSkillDetail>(["skill", "get", skill.id, "--output", "json"], "skill get");
  const content = remoteContentRecords(detail);
  const remoteManifest = manifestFromRemote(detail);
  const canVerifyContent =
    content.contentUnavailablePaths.length === 0 && hasRemoteRecordForEveryLocal(localFileRecords, content.records);

  let verificationLevel: VerificationLevel;
  let remoteRecords: FileRecord[];
  const notes: string[] = [];

  if (content.contentUnavailablePaths.length > 0) {
    notes.push("Some remote file entries had path only; content hashes are unavailable for those paths.");
  }

  if (canVerifyContent) {
    verificationLevel = "content";
    remoteRecords = content.records;
  } else if (remoteManifest !== undefined) {
    verificationLevel = "manifest-only";
    remoteRecords = mergeManifestWithObservedExtraFiles(localRecords(remoteManifest), content.records);
    notes.push("Remote file content is unavailable; using remote manifest only.");
  } else {
    verificationLevel = "unavailable";
    remoteRecords = content.records;
    notes.push("Remote file content is unavailable and no readable remote manifest was found.");
  }

  const diffs = diffFileRecords(localFileRecords, remoteRecords);
  const payload: VerifyPayload = {
    ok: diffs.length === 0 && verificationLevel !== "unavailable",
    skillName,
    skillId: skill.id,
    degraded: verificationLevel !== "content",
    verificationLevel,
    diffCount: diffs.length,
    diffs,
    notes
  };

  outputPayload(payload, options);

  if (!payload.ok) {
    throw new UserError(failureMessage(payload));
  }
}
