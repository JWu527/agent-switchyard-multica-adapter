import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { UserError } from "./errors.js";
import { sha256 } from "./hash.js";
import { createManifest, MANIFEST_PATH, type ManifestFile, type SwitchyardMulticaManifest } from "./manifest.js";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 8 * 1024 * 1024;
const MAX_FILE_COUNT = 128;
const ALLOWED_TOP_LEVEL_PATHS = new Set(["references", "scripts"]);
const BLOCKED_NAMES = new Set([
  ".DS_Store",
  ".env",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "token",
  "secret"
]);

export interface SkillSourceFile extends ManifestFile {
  content: string;
}

export interface SkillSource {
  root: string;
  skillName: string;
  manifest: SwitchyardMulticaManifest;
  files: SkillSourceFile[];
}

function relativePathInsideRoot(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).split(sep).join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../") || rel.includes("/../") || rel.startsWith("/")) {
    throw new UserError(`Refusing path outside source root: ${absolutePath}`);
  }
  return rel;
}

function isAllowedPath(rel: string): boolean {
  if (rel === "SKILL.md") return true;
  const [topLevel] = rel.split("/");
  return ALLOWED_TOP_LEVEL_PATHS.has(topLevel ?? "");
}

function isBlockedPath(rel: string): boolean {
  const parts = rel.split("/");
  const baseName = parts.at(-1) ?? "";

  if (parts.includes(".git") || parts.includes("node_modules")) return true;
  if (parts.some((part) => BLOCKED_NAMES.has(part))) return true;
  if (baseName.endsWith(".tmp") || baseName.endsWith(".bak") || baseName.endsWith("~")) return true;
  if (baseName.endsWith(".pem") || baseName.endsWith(".key")) return true;

  return false;
}

async function walkSource(root: string, directory: string, out: SkillSourceFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const rel = relativePathInsideRoot(root, absolutePath);

    if (isBlockedPath(rel)) continue;

    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) continue;

    if (info.isDirectory()) {
      await walkSource(root, absolutePath, out);
      continue;
    }

    if (!info.isFile() || !isAllowedPath(rel)) continue;
    if (info.size > MAX_FILE_SIZE) {
      throw new UserError(`File exceeds 1 MiB limit: ${rel}`);
    }

    const contentBuffer = await readFile(absolutePath);
    out.push({
      path: rel,
      content: contentBuffer.toString("utf8"),
      size: contentBuffer.byteLength,
      sha256: sha256(contentBuffer)
    });
  }
}

export async function collectSkillSource(sourceDir: string, skillName: string): Promise<SkillSource> {
  const root = resolve(sourceDir);
  const rootInfo = await lstat(root).catch(() => {
    throw new UserError(`Source directory does not exist: ${sourceDir}`);
  });

  if (rootInfo.isSymbolicLink()) {
    throw new UserError(`Refusing symlinked source root: ${sourceDir}`);
  }
  if (!rootInfo.isDirectory()) {
    throw new UserError(`Source is not a directory: ${sourceDir}`);
  }

  const skillFilePath = resolve(root, "SKILL.md");
  const skillFileInfo = await lstat(skillFilePath).catch(() => {
    throw new UserError(`Source directory must contain SKILL.md: ${sourceDir}`);
  });
  if (skillFileInfo.isSymbolicLink()) {
    throw new UserError("Refusing symlinked source file: SKILL.md");
  }
  if (!skillFileInfo.isFile()) {
    throw new UserError(`Source directory must contain SKILL.md: ${sourceDir}`);
  }

  const sourceFiles: SkillSourceFile[] = [];
  await walkSource(root, root, sourceFiles);
  sourceFiles.sort((a, b) => a.path.localeCompare(b.path));

  if (sourceFiles.length > MAX_FILE_COUNT) {
    throw new UserError(`Source contains more than ${MAX_FILE_COUNT} publishable source files`);
  }

  const totalSize = sourceFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    throw new UserError("Source publishable files exceed 8 MiB total size");
  }

  const manifest = createManifest({ skillName, sourcePath: root, files: sourceFiles });
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestFile: SkillSourceFile = {
    path: MANIFEST_PATH,
    content: manifestContent,
    size: Buffer.byteLength(manifestContent),
    sha256: sha256(manifestContent)
  };

  return {
    root,
    skillName,
    manifest,
    files: [...sourceFiles, manifestFile]
  };
}
