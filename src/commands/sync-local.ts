import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { UserError } from "../lib/errors.js";
import { sha256 } from "../lib/hash.js";
import { parseTargetDirOverrides, resolveTargetDir, validateSkillNameSegment } from "../lib/local-targets.js";
import { collectSkillSource, type SkillSource, type SkillSourceFile } from "../lib/skill-source.js";

const MARKER = ".switchyard-multica.json";
const MANAGED_BY = "switchyard-multica";

interface FileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface TargetState {
  exists: boolean;
  isDirectory: boolean;
  nonEmpty: boolean;
}

interface MarkerRead {
  exists: boolean;
  marker?: Record<string, unknown>;
  invalidReason?: string;
}

interface TargetPlan {
  target: string;
  targetDir: string;
  exists: boolean;
  nonEmpty: boolean;
  markerExists: boolean;
  markerMatches: boolean;
  markerMismatchReasons: string[];
  wouldOverwrite: boolean;
  forceRequired: boolean;
  backupDir: string;
  filesToWrite: string[];
}

interface ResolvedTarget {
  target: string;
  targetDir: string;
}

interface SyncLocalPayload {
  dryRun: boolean;
  skillName: string;
  sourcePath: string;
  sourceHash: string;
  targets: TargetPlan[];
}

export interface SyncLocalOptions {
  source?: string;
  skillName?: string;
  target?: string[] | string;
  targetDir?: string[] | string;
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  output?: (text: string) => void;
  homeDir?: string;
  timestamp?: string;
  now?: () => Date;
}

function emit(options: SyncLocalOptions, text: string): void {
  (options.output ?? console.log)(text);
}

function toArray(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}

function resolveSyncInput(options: SyncLocalOptions): { source: string; skillName: string; targets: string[] } {
  const source = options.source ?? process.env.SWITCHYARD_SKILL_SOURCE;
  const skillName = validateSkillNameSegment(options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard");
  const targets = toArray(options.target).map((target) => target.trim()).filter((target) => target.length > 0);

  if (source === undefined || source.trim().length === 0) {
    throw new UserError("Missing --source or SWITCHYARD_SKILL_SOURCE");
  }
  if (targets.length === 0) throw new UserError("sync-local requires at least one --target");

  const seenTargets = new Set<string>();
  for (const target of targets) {
    if (seenTargets.has(target)) throw new UserError(`Duplicate target: ${target}`);
    seenTargets.add(target);
  }

  return { source, skillName, targets };
}

function fileRecord(file: SkillSourceFile): FileRecord {
  return {
    path: file.path,
    size: file.size,
    sha256: file.sha256
  };
}

function sortedFileRecords(source: SkillSource): FileRecord[] {
  return source.files.map(fileRecord).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function sourceHash(files: FileRecord[]): string {
  return sha256(JSON.stringify(files.map((file) => [file.path, file.size, file.sha256])));
}

function defaultTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

function markerTimestampToDate(timestamp: string): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(timestamp);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
}

function syncClock(options: SyncLocalOptions): { backupTimestamp: string; lastSyncAt: string } {
  const injectedDate = options.timestamp === undefined ? undefined : markerTimestampToDate(options.timestamp);
  const date = injectedDate ?? options.now?.() ?? new Date();
  return {
    backupTimestamp: options.timestamp ?? defaultTimestamp(date),
    lastSyncAt: date.toISOString()
  };
}

async function readTargetState(targetDir: string): Promise<TargetState> {
  try {
    const info = await lstat(targetDir);
    if (!info.isDirectory()) return { exists: true, isDirectory: false, nonEmpty: true };
    return {
      exists: true,
      isDirectory: true,
      nonEmpty: (await readdir(targetDir)).length > 0
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, isDirectory: false, nonEmpty: false };
    }
    throw error;
  }
}

async function readMarker(targetDir: string): Promise<MarkerRead> {
  try {
    const content = await readFile(join(targetDir, MARKER), "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { exists: true, invalidReason: "marker is not an object" };
    }
    return { exists: true, marker: parsed as Record<string, unknown> };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false };
    }
    if (error instanceof SyntaxError) {
      return { exists: true, invalidReason: "marker is not valid JSON" };
    }
    throw error;
  }
}

function markerMismatchReasons(input: {
  markerRead: MarkerRead;
  skillName: string;
  sourcePath: string;
  target: string;
  targetDir: string;
}): string[] {
  if (!input.markerRead.exists) return [];
  if (input.markerRead.invalidReason !== undefined) return [input.markerRead.invalidReason];
  const marker = input.markerRead.marker;
  if (marker === undefined) return ["marker is missing"];

  const reasons: string[] = [];
  if (marker.managedBy !== MANAGED_BY) reasons.push("managedBy mismatch");
  if (marker.skillName !== input.skillName) reasons.push("skillName mismatch");
  if (marker.sourcePath !== input.sourcePath) reasons.push("sourcePath mismatch");
  if (marker.target !== input.target) reasons.push("target mismatch");
  if (marker.targetDir !== input.targetDir) reasons.push("targetDir mismatch");
  return reasons;
}

function safeTargetPath(targetDir: string, relativePath: string): string {
  const targetRoot = resolve(targetDir);
  const destination = resolve(targetRoot, relativePath);
  if (destination !== targetRoot && !destination.startsWith(`${targetRoot}${sep}`)) {
    throw new UserError(`Refusing to write outside target directory: ${relativePath}`);
  }
  return destination;
}

function assertPathInsideRoot(path: string, root: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new UserError(`${label} escapes expected root: ${resolvedPath}`);
  }
}

async function backupTarget(targetDir: string, backupDir: string): Promise<void> {
  await rm(backupDir, { recursive: true, force: true });
  await mkdir(dirname(backupDir), { recursive: true });
  await cp(targetDir, backupDir, { recursive: true, force: false, errorOnExist: true });
}

async function writeSourceFiles(targetDir: string, source: SkillSource): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  for (const file of source.files) {
    const destination = safeTargetPath(targetDir, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
}

async function writeMarker(input: {
  targetDir: string;
  skillName: string;
  sourcePath: string;
  target: string;
  lastSyncAt: string;
  sourceHash: string;
  files: FileRecord[];
}): Promise<void> {
  const marker = {
    managedBy: MANAGED_BY,
    skillName: input.skillName,
    sourcePath: input.sourcePath,
    target: input.target,
    targetDir: input.targetDir,
    lastSyncAt: input.lastSyncAt,
    sourceHash: input.sourceHash,
    files: input.files
  };
  await writeFile(join(input.targetDir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

async function verifyTargetFiles(targetDir: string, files: readonly FileRecord[]): Promise<void> {
  for (const file of files) {
    const destination = safeTargetPath(targetDir, file.path);
    const content = await readFile(destination);
    const observed = {
      size: content.byteLength,
      sha256: sha256(content)
    };
    if (observed.size !== file.size || observed.sha256 !== file.sha256) {
      throw new UserError(`Hash verification failed for ${file.path} in ${targetDir}`);
    }
  }
}

async function buildTargetPlan(input: {
  target: string;
  targetDir: string;
  skillName: string;
  source: SkillSource;
  homeDir: string;
  backupTimestamp: string;
  files: FileRecord[];
}): Promise<TargetPlan> {
  const targetDir = input.targetDir;
  const state = await readTargetState(targetDir);
  const markerRead = state.isDirectory ? await readMarker(targetDir) : { exists: false };
  const mismatchReasons = markerMismatchReasons({
    markerRead,
    skillName: input.skillName,
    sourcePath: input.source.root,
    target: input.target,
    targetDir
  });
  const markerMatches = markerRead.exists && mismatchReasons.length === 0;
  const forceRequired = (state.nonEmpty && !markerRead.exists) || (markerRead.exists && !markerMatches);

  return {
    target: input.target,
    targetDir,
    exists: state.exists,
    nonEmpty: state.nonEmpty,
    markerExists: markerRead.exists,
    markerMatches,
    markerMismatchReasons: mismatchReasons,
    wouldOverwrite: state.exists,
    forceRequired,
    backupDir: backupPath(input.homeDir, input.backupTimestamp, input.target, input.skillName),
    filesToWrite: input.files.map((file) => file.path)
  };
}

function backupPath(homeDir: string, backupTimestamp: string, target: string, skillName: string): string {
  const root = join(homeDir, ".switchyard-multica", "backups");
  const path = join(root, backupTimestamp, target, skillName);
  assertPathInsideRoot(path, root, "Backup path");
  return path;
}

function resolveTargetDirectories(input: {
  targets: string[];
  skillName: string;
  homeDir: string;
  overrides: ReturnType<typeof parseTargetDirOverrides>;
}): ResolvedTarget[] {
  const seenTargetDirs = new Map<string, string>();
  const resolvedTargets: ResolvedTarget[] = [];

  for (const target of input.targets) {
    const targetDir = resolve(resolveTargetDir(target, input.skillName, input.overrides, input.homeDir));
    const existingTarget = seenTargetDirs.get(targetDir);
    if (existingTarget !== undefined) {
      throw new UserError(`Duplicate target directory: ${targetDir} for targets ${existingTarget} and ${target}`);
    }
    seenTargetDirs.set(targetDir, target);
    resolvedTargets.push({ target, targetDir });
  }

  return resolvedTargets;
}

function outputPayload(payload: SyncLocalPayload, options: SyncLocalOptions): void {
  if (options.json) {
    emit(options, JSON.stringify(payload, null, 2));
    return;
  }

  const lines = [
    `sync-local ${payload.dryRun ? "dry run" : "result"}: ${payload.skillName}`,
    `Source: ${payload.sourcePath}`,
    `Source sha256: ${payload.sourceHash}`,
    ...payload.targets.flatMap((target) => [
      `Target ${target.target}: ${target.targetDir}`,
      `  Exists: ${target.exists}`,
      `  Non-empty: ${target.nonEmpty}`,
      `  Marker: ${target.markerExists ? (target.markerMatches ? "matches" : "mismatch") : "missing"}`,
      `  Would overwrite: ${target.wouldOverwrite}`,
      `  Force required: ${target.forceRequired}`,
      `  Backup: ${target.backupDir}`,
      "  Files to write:",
      ...target.filesToWrite.map((file) => `    - ${file}`)
    ])
  ];
  emit(options, lines.join("\n"));
}

export async function runSyncLocal(options: SyncLocalOptions): Promise<void> {
  const { source, skillName, targets } = resolveSyncInput(options);
  const targetDirOverrides = parseTargetDirOverrides(toArray(options.targetDir));
  const sourceBundle = await collectSkillSource(source, skillName);
  const files = sortedFileRecords(sourceBundle);
  const hash = sourceHash(files);
  const homeDir = options.homeDir ?? homedir();
  const { backupTimestamp, lastSyncAt } = syncClock(options);
  const resolvedTargets = resolveTargetDirectories({ targets, skillName, homeDir, overrides: targetDirOverrides });

  const plans: TargetPlan[] = [];
  for (const resolvedTarget of resolvedTargets) {
    plans.push(await buildTargetPlan({
      target: resolvedTarget.target,
      targetDir: resolvedTarget.targetDir,
      skillName,
      source: sourceBundle,
      homeDir,
      backupTimestamp,
      files
    }));
  }

  const payload: SyncLocalPayload = {
    dryRun: options.dryRun === true,
    skillName,
    sourcePath: sourceBundle.root,
    sourceHash: hash,
    targets: plans
  };

  if (options.dryRun) {
    outputPayload(payload, options);
    return;
  }

  for (const plan of plans) {
    if (plan.exists) {
      const state = await readTargetState(plan.targetDir);
      if (!state.isDirectory) throw new UserError(`Target exists and is not a directory: ${plan.targetDir}`);
    }
    if (plan.forceRequired && !options.force) {
      if (plan.markerExists) {
        throw new UserError(
          `Target ${plan.targetDir} marker mismatch. Re-run with --force to take ownership. Reasons: ${plan.markerMismatchReasons.join(", ")}`
        );
      }
      throw new UserError(`Target ${plan.targetDir} is non-empty and unmanaged. Re-run with --force to take ownership.`);
    }
  }

  for (const plan of plans) {
    if (plan.exists) await backupTarget(plan.targetDir, plan.backupDir);
    await writeSourceFiles(plan.targetDir, sourceBundle);
    await writeMarker({
      targetDir: plan.targetDir,
      skillName,
      sourcePath: sourceBundle.root,
      target: plan.target,
      lastSyncAt,
      sourceHash: hash,
      files
    });
    await verifyTargetFiles(plan.targetDir, files);
  }

  outputPayload(payload, options);
}
