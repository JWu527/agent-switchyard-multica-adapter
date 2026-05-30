import { isAbsolute, join, resolve, sep } from "node:path";
import { UserError } from "./errors.js";

export type LocalTarget = "openclaw" | "hermes" | "codex" | "claude";

const LOCAL_TARGETS = new Set<string>(["openclaw", "hermes", "codex", "claude"]);

export function isLocalTarget(target: string): target is LocalTarget {
  return LOCAL_TARGETS.has(target);
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/).includes("..");
}

function assertInsideRoot(path: string, root: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new UserError(`${label} escapes expected root: ${resolvedPath}`);
  }
}

export function validateSkillNameSegment(skillName: string): string {
  const trimmed = skillName.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new UserError(`Invalid skill name: ${skillName}`);
  }
  return trimmed;
}

export function parseTargetDirOverrides(values: string[] = []): Partial<Record<LocalTarget, string>> {
  const overrides: Partial<Record<LocalTarget, string>> = {};

  for (const value of values) {
    const index = value.indexOf("=");
    const key = index >= 0 ? value.slice(0, index) : "";
    const path = index >= 0 ? value.slice(index + 1).trim() : "";

    if (index <= 0 || path.length === 0 || path.includes("\0") || !isAbsolute(path) || hasTraversalSegment(path)) {
      throw new UserError(`Invalid --target-dir value: ${value}`);
    }
    if (!isLocalTarget(key)) {
      throw new UserError(`Unknown --target-dir target: ${key}`);
    }

    overrides[key] = resolve(path);
  }

  return overrides;
}

export function resolveTargetDir(
  target: string,
  skillName: string,
  overrides: Partial<Record<LocalTarget, string>>,
  home: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "CODEX_HOME">> = process.env
): string {
  if (!isLocalTarget(target)) throw new UserError(`Unknown target: ${target}`);

  const safeSkillName = validateSkillNameSegment(skillName);
  const override = overrides[target];
  if (override !== undefined) return override;

  switch (target) {
    case "openclaw": {
      const root = join(home, ".openclaw", "skills");
      const path = join(root, safeSkillName);
      assertInsideRoot(path, root, "Default target path");
      return path;
    }
    case "hermes": {
      const root = join(home, ".hermes", "skills");
      const path = join(root, safeSkillName);
      assertInsideRoot(path, root, "Default target path");
      return path;
    }
    case "codex": {
      const root = join(env.CODEX_HOME?.trim() || join(home, ".codex"), "skills");
      const path = join(root, safeSkillName);
      assertInsideRoot(path, root, "Default target path");
      return path;
    }
    case "claude": {
      const root = join(home, ".claude", "skills");
      const path = join(root, safeSkillName);
      assertInsideRoot(path, root, "Default target path");
      return path;
    }
  }
}
