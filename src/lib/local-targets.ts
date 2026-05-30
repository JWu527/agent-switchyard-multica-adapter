import { join } from "node:path";
import { UserError } from "./errors.js";

export type LocalTarget = "openclaw" | "hermes" | "codex" | "claude";

const LOCAL_TARGETS = new Set<string>(["openclaw", "hermes", "codex", "claude"]);

export function isLocalTarget(target: string): target is LocalTarget {
  return LOCAL_TARGETS.has(target);
}

export function parseTargetDirOverrides(values: string[] = []): Partial<Record<LocalTarget, string>> {
  const overrides: Partial<Record<LocalTarget, string>> = {};

  for (const value of values) {
    const index = value.indexOf("=");
    const key = index >= 0 ? value.slice(0, index) : "";
    const path = index >= 0 ? value.slice(index + 1) : "";

    if (index <= 0 || path.trim().length === 0) {
      throw new UserError(`Invalid --target-dir value: ${value}`);
    }
    if (!isLocalTarget(key)) {
      throw new UserError(`Unknown --target-dir target: ${key}`);
    }

    overrides[key] = path;
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

  const override = overrides[target];
  if (override !== undefined) return override;

  switch (target) {
    case "openclaw":
      return join(home, ".openclaw", "skills", skillName);
    case "hermes":
      return join(home, ".hermes", "skills", skillName);
    case "codex":
      return join(env.CODEX_HOME?.trim() || join(home, ".codex"), "skills", skillName);
    case "claude":
      return join(home, ".claude", "skills", skillName);
  }
}
