# switchyard-multica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript CLI that publishes an Agent Switchyard skill source to Multica, appends it to existing agents, syncs it explicitly to local runtime skill directories, and verifies content-level consistency.

**Architecture:** The CLI is a small command router over focused library modules. Multica integration goes only through the installed `multica` CLI, with capability probing before write operations. File operations are isolated behind source collection, manifest, target resolution, and marker/backup helpers so dangerous writes are testable without touching real Multica or real HOME during normal tests.

**Tech Stack:** Node.js 20+, TypeScript, commander, vitest, Node built-ins (`child_process`, `fs/promises`, `crypto`, `path`, `os`).

---

## File Structure

- Create `package.json`: npm scripts, bin entry, dependencies.
- Create `tsconfig.json`: strict TypeScript config.
- Create `.gitignore`: dependency/build/runtime ignores.
- Create `README.md`: usage, safety model, common failure modes.
- Create `src/cli.ts`: command registration and top-level error handling.
- Create `src/lib/errors.ts`: typed user-facing errors and exit code mapping.
- Create `src/lib/hash.ts`: sha256 helpers.
- Create `src/lib/diff.ts`: manifest/file diff types.
- Create `src/lib/manifest.ts`: manifest generation and validation.
- Create `src/lib/skill-source.ts`: safe source collection with whitelist/exclusion/path checks.
- Create `src/lib/local-targets.ts`: default target paths and override parsing.
- Create `src/lib/multica-cli.ts`: subprocess wrapper for `multica`.
- Create `src/lib/capability-probe.ts`: help-based capability detection.
- Create `src/lib/bind-resolver.ts`: skill/agent resolution and skill merge helpers.
- Create `src/commands/inspect.ts`: read-only Multica inspection.
- Create `src/commands/publish.ts`: skill create/update/upsert with dry-run.
- Create `src/commands/bind.ts`: append skill to existing agents with dry-run.
- Create `src/commands/verify.ts`: content-level Multica verification.
- Create `src/commands/sync-local.ts`: explicit local sync with backup/marker/dry-run/force.
- Create `test/fixtures/agent-switchyard-skill/`: minimal valid skill fixture.
- Create `test/*.test.ts`: unit tests that do not touch real Multica.

## Commit Strategy

Use small commits:

1. `chore: scaffold switchyard-multica project`
2. `feat: collect and hash switchyard skill source`
3. `feat: add multica cli probing wrapper`
4. `feat: implement inspect command`
5. `feat: implement publish and verify`
6. `feat: implement bind command`
7. `feat: implement sync-local command`
8. `docs: document switchyard-multica usage`

Do not commit until each task's tests pass.

---

### Task 1: Scaffold Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/cli.ts`
- Create: `src/lib/errors.ts`
- Test: no test yet; build must pass after this task.

- [ ] **Step 1: Create npm package metadata**

Create `package.json`:

```json
{
  "name": "switchyard-multica",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "switchyard-multica": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "MULTICA_INTEGRATION=1 vitest run test/integration",
    "check": "npm run build && npm test"
  },
  "dependencies": {
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.15",
    "typescript": "^5.5.4",
    "vitest": "^2.0.5"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create ignore file**

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
.DS_Store
*.log
.env
.switchyard-multica-manifest.json
```

- [ ] **Step 4: Add shared error types**

Create `src/lib/errors.ts`:

```ts
export class UserError extends Error {
  constructor(message: string, public readonly exitCode = 1) {
    super(message);
    this.name = "UserError";
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
```

- [ ] **Step 5: Add initial CLI entrypoint**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { formatUnknownError, UserError } from "./lib/errors.js";

const program = new Command();

program
  .name("switchyard-multica")
  .description("Publish and verify Agent Switchyard skills for Multica")
  .version("0.1.0");

program
  .command("inspect")
  .description("Inspect Multica config, skills, agents, and runtimes")
  .option("--json", "Output JSON")
  .action(async () => {
    console.log("inspect command is registered");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const exitCode = error instanceof UserError ? error.exitCode : 1;
  console.error(formatUnknownError(error));
  process.exit(exitCode);
});
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
npm install
```

Expected: `node_modules/` and `package-lock.json` are created.

- [ ] **Step 7: Build**

Run:

```bash
npm run build
```

Expected: TypeScript exits successfully and writes `dist/cli.js`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/cli.ts src/lib/errors.ts
git commit -m "chore: scaffold switchyard-multica project"
```

---

### Task 2: Skill Source Collection, Hashing, and Manifest

**Files:**
- Create: `src/lib/hash.ts`
- Create: `src/lib/manifest.ts`
- Create: `src/lib/skill-source.ts`
- Create: `src/lib/diff.ts`
- Create: `test/fixtures/agent-switchyard-skill/SKILL.md`
- Create: `test/fixtures/agent-switchyard-skill/references/templates.md`
- Create: `test/fixtures/agent-switchyard-skill/scripts/init-harness.sh`
- Test: `test/skill-source.test.ts`
- Test: `test/manifest.test.ts`

- [ ] **Step 1: Write failing tests for source collection**

Create `test/skill-source.test.ts`:

```ts
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectSkillSource } from "../src/lib/skill-source.js";

async function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "switchyard-skill-"));
  await mkdir(join(root, "references"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), "# Skill\n");
  await writeFile(join(root, "references", "templates.md"), "template\n");
  await writeFile(join(root, "scripts", "init-harness.sh"), "#!/bin/sh\n");
  await writeFile(join(root, ".DS_Store"), "ignored");
  await writeFile(join(root, ".env"), "SECRET=1");
  await writeFile(join(root, "scripts", "token"), "secret");
  await writeFile(join(root, ".git", "config"), "ignored");
  await writeFile(join(root, "node_modules", "x"), "ignored");
  return root;
}

describe("collectSkillSource", () => {
  it("collects only SKILL.md, references, scripts, and generated manifest", async () => {
    const root = await fixtureRoot();
    const result = await collectSkillSource(root, "agent-switchyard");
    expect(result.files.map((f) => f.path).sort()).toEqual([
      ".switchyard-multica-manifest.json",
      "SKILL.md",
      "references/templates.md",
      "scripts/init-harness.sh"
    ]);
  });

  it("fails when SKILL.md is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "switchyard-no-skill-"));
    await expect(collectSkillSource(root, "agent-switchyard")).rejects.toThrow("SKILL.md");
  });

  it("does not follow symlinks", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "outside.txt"), "outside");
    await symlink(join(root, "outside.txt"), join(root, "references", "linked.md"));
    const result = await collectSkillSource(root, "agent-switchyard");
    expect(result.files.some((f) => f.path === "references/linked.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing manifest test**

Create `test/manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createManifest } from "../src/lib/manifest.js";

describe("createManifest", () => {
  it("records tool, skill name, source path, file hashes, and sizes", () => {
    const manifest = createManifest({
      skillName: "agent-switchyard",
      sourcePath: "/tmp/source",
      files: [{ path: "SKILL.md", content: "# Skill\n", size: 8, sha256: "abc" }]
    });

    expect(manifest.tool).toBe("switchyard-multica");
    expect(manifest.skillName).toBe("agent-switchyard");
    expect(manifest.files).toEqual([{ path: "SKILL.md", sha256: "abc", size: 8 }]);
  });
});
```

- [ ] **Step 3: Run tests to verify failures**

Run:

```bash
npm test -- test/skill-source.test.ts test/manifest.test.ts
```

Expected: FAIL because modules do not exist.

- [ ] **Step 4: Implement hash helper**

Create `src/lib/hash.ts`:

```ts
import { createHash } from "node:crypto";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
```

- [ ] **Step 5: Implement manifest helper**

Create `src/lib/manifest.ts`:

```ts
export const MANIFEST_PATH = ".switchyard-multica-manifest.json";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface SwitchyardMulticaManifest {
  tool: "switchyard-multica";
  toolVersion: string;
  skillName: string;
  sourcePath: string;
  generatedAt: string;
  files: ManifestFile[];
}

export function createManifest(input: {
  skillName: string;
  sourcePath: string;
  files: Array<ManifestFile & { content?: string }>;
  generatedAt?: string;
  toolVersion?: string;
}): SwitchyardMulticaManifest {
  return {
    tool: "switchyard-multica",
    toolVersion: input.toolVersion ?? "0.1.0",
    skillName: input.skillName,
    sourcePath: input.sourcePath,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    files: input.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size
    }))
  };
}
```

- [ ] **Step 6: Implement diff types**

Create `src/lib/diff.ts`:

```ts
export type DiffKind =
  | "missing_remote"
  | "extra_remote"
  | "content_mismatch"
  | "metadata_mismatch"
  | "agent_not_bound";

export interface FileRecord {
  path: string;
  sha256: string;
  size: number;
}

export interface DiffRecord {
  kind: DiffKind;
  path?: string;
  message: string;
  local?: FileRecord;
  remote?: FileRecord;
}

export function diffFileRecords(local: FileRecord[], remote: FileRecord[]): DiffRecord[] {
  const diffs: DiffRecord[] = [];
  const remoteByPath = new Map(remote.map((file) => [file.path, file]));
  const localByPath = new Map(local.map((file) => [file.path, file]));

  for (const localFile of local) {
    const remoteFile = remoteByPath.get(localFile.path);
    if (!remoteFile) {
      diffs.push({ kind: "missing_remote", path: localFile.path, message: "Remote file is missing", local: localFile });
    } else if (remoteFile.sha256 !== localFile.sha256) {
      diffs.push({
        kind: "content_mismatch",
        path: localFile.path,
        message: "Remote file hash differs",
        local: localFile,
        remote: remoteFile
      });
    }
  }

  for (const remoteFile of remote) {
    if (!localByPath.has(remoteFile.path)) {
      diffs.push({ kind: "extra_remote", path: remoteFile.path, message: "Remote has an extra file", remote: remoteFile });
    }
  }

  return diffs;
}
```

- [ ] **Step 7: Implement source collection**

Create `src/lib/skill-source.ts`:

```ts
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { UserError } from "./errors.js";
import { sha256 } from "./hash.js";
import { createManifest, MANIFEST_PATH, type ManifestFile } from "./manifest.js";

const MAX_FILE_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 8 * 1024 * 1024;
const MAX_FILE_COUNT = 128;
const ALLOWED_ROOTS = new Set(["references", "scripts"]);
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
  files: SkillSourceFile[];
  manifest: ReturnType<typeof createManifest>;
}

function normalizeRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath).split(sep).join("/");
  if (!rel || rel.startsWith("../") || rel === ".." || rel.includes("/../") || rel.startsWith("/")) {
    throw new UserError(`Refusing path outside source root: ${absolutePath}`);
  }
  return rel;
}

function isBlockedPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? "";
  if (parts.includes(".git") || parts.includes("node_modules")) return true;
  if (BLOCKED_NAMES.has(base)) return true;
  if (base.endsWith(".tmp") || base.endsWith(".bak") || base.endsWith("~")) return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

function isAllowed(rel: string): boolean {
  if (rel === "SKILL.md") return true;
  const [first] = rel.split("/");
  return ALLOWED_ROOTS.has(first ?? "");
}

async function walk(root: string, dir: string, out: SkillSourceFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(dir, entry.name);
    const rel = normalizeRelative(root, absolute);
    if (isBlockedPath(rel)) continue;

    const info = await lstat(absolute);
    if (info.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, out);
      continue;
    }
    if (!entry.isFile() || !isAllowed(rel)) continue;
    if (info.size > MAX_FILE_SIZE) throw new UserError(`File exceeds 1 MiB limit: ${rel}`);

    const content = await readFile(absolute, "utf8");
    out.push({ path: rel, content, size: Buffer.byteLength(content), sha256: sha256(content) });
  }
}

export async function collectSkillSource(sourceDir: string, skillName: string): Promise<SkillSource> {
  const root = resolve(sourceDir);
  const rootInfo = await stat(root).catch(() => {
    throw new UserError(`Source directory does not exist: ${sourceDir}`);
  });
  if (!rootInfo.isDirectory()) throw new UserError(`Source is not a directory: ${sourceDir}`);

  await stat(resolve(root, "SKILL.md")).catch(() => {
    throw new UserError(`Source directory must contain SKILL.md: ${sourceDir}`);
  });

  const files: SkillSourceFile[] = [];
  await walk(root, root, files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (files.length > MAX_FILE_COUNT) throw new UserError(`Source contains more than ${MAX_FILE_COUNT} publishable files`);
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) throw new UserError("Source publishable files exceed 8 MiB total size");

  const manifest = createManifest({ skillName, sourcePath: root, files });
  const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
  files.push({
    path: MANIFEST_PATH,
    content: manifestContent,
    size: Buffer.byteLength(manifestContent),
    sha256: sha256(manifestContent)
  });

  return { root, skillName, files, manifest };
}
```

- [ ] **Step 8: Run tests**

Run:

```bash
npm test -- test/skill-source.test.ts test/manifest.test.ts
```

Expected: PASS.

- [ ] **Step 9: Build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/hash.ts src/lib/manifest.ts src/lib/diff.ts src/lib/skill-source.ts test/skill-source.test.ts test/manifest.test.ts
git commit -m "feat: collect and hash switchyard skill source"
```

---

### Task 3: Multica CLI Wrapper and Capability Probe

**Files:**
- Create: `src/lib/multica-cli.ts`
- Create: `src/lib/capability-probe.ts`
- Test: `test/multica-cli.test.ts`

- [ ] **Step 1: Write failing wrapper tests**

Create `test/multica-cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseJsonOutput } from "../src/lib/multica-cli.js";

describe("parseJsonOutput", () => {
  it("parses JSON output", () => {
    expect(parseJsonOutput("[{\"name\":\"agent-switchyard\"}]", "skill list")).toEqual([{ name: "agent-switchyard" }]);
  });

  it("throws a readable error for non-JSON output", () => {
    expect(() => parseJsonOutput("not json", "skill list")).toThrow("Expected JSON from multica skill list");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- test/multica-cli.test.ts
```

Expected: FAIL because `multica-cli.ts` does not exist.

- [ ] **Step 3: Implement CLI wrapper**

Create `src/lib/multica-cli.ts`:

```ts
import { spawn } from "node:child_process";
import { UserError } from "./errors.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MulticaRunner {
  run(args: string[]): Promise<CommandResult>;
  json<T>(args: string[], label: string): Promise<T>;
}

export function parseJsonOutput<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new UserError(`Expected JSON from multica ${label}, got: ${stdout.slice(0, 300)}`);
  }
}

export class MulticaCli implements MulticaRunner {
  constructor(private readonly bin = "multica") {}

  async run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") reject(new UserError("multica CLI not found in PATH"));
        else reject(error);
      });
      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });
    });
  }

  async json<T>(args: string[], label: string): Promise<T> {
    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new UserError(`multica ${label} failed: ${result.stderr || result.stdout}`);
    }
    return parseJsonOutput<T>(result.stdout, label);
  }
}
```

- [ ] **Step 4: Implement capability probe**

Create `src/lib/capability-probe.ts`:

```ts
import type { MulticaRunner } from "./multica-cli.js";

export interface CapabilityMap {
  multica: boolean;
  skillList: boolean;
  skillGet: boolean;
  skillCreate: boolean;
  skillUpdate: boolean;
  skillFilesUpsert: boolean;
  agentList: boolean;
  agentSkillsList: boolean;
  agentSkillsSet: boolean;
  runtimeList: boolean;
  missing: string[];
}

async function hasHelp(runner: MulticaRunner, args: string[]): Promise<boolean> {
  const result = await runner.run([...args, "--help"]);
  return result.exitCode === 0;
}

export async function probeCapabilities(runner: MulticaRunner): Promise<CapabilityMap> {
  const entries: Array<[keyof Omit<CapabilityMap, "missing">, string[]]> = [
    ["multica", ["--help"]],
    ["skillList", ["skill", "list"]],
    ["skillGet", ["skill", "get"]],
    ["skillCreate", ["skill", "create"]],
    ["skillUpdate", ["skill", "update"]],
    ["skillFilesUpsert", ["skill", "files", "upsert"]],
    ["agentList", ["agent", "list"]],
    ["agentSkillsList", ["agent", "skills", "list"]],
    ["agentSkillsSet", ["agent", "skills", "set"]],
    ["runtimeList", ["runtime", "list"]]
  ];

  const map = {} as CapabilityMap;
  const missing: string[] = [];
  for (const [key, args] of entries) {
    const ok = key === "multica" ? (await runner.run(["--help"])).exitCode === 0 : await hasHelp(runner, args);
    map[key] = ok;
    if (!ok) missing.push(args.join(" "));
  }
  map.missing = missing;
  return map;
}

export function requireCapabilities(map: CapabilityMap, required: Array<keyof Omit<CapabilityMap, "missing">>): void {
  const missing = required.filter((key) => !map[key]).map(String);
  if (missing.length > 0) {
    throw new Error(`Missing required Multica CLI capabilities: ${missing.join(", ")}`);
  }
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- test/multica-cli.test.ts
npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/multica-cli.ts src/lib/capability-probe.ts test/multica-cli.test.ts
git commit -m "feat: add multica cli probing wrapper"
```

---

### Task 4: Inspect Command

**Files:**
- Modify: `src/cli.ts`
- Create: `src/commands/inspect.ts`

- [ ] **Step 1: Implement inspect command**

Create `src/commands/inspect.ts`:

```ts
import type { MulticaRunner } from "../lib/multica-cli.js";
import { probeCapabilities } from "../lib/capability-probe.js";

export interface InspectOptions {
  json?: boolean;
  skillName?: string;
}

async function safeJson<T>(runner: MulticaRunner, args: string[], label: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await runner.json<T>(args, label) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runInspect(runner: MulticaRunner, options: InspectOptions): Promise<void> {
  const capabilities = await probeCapabilities(runner);
  const config = await runner.run(["config", "show"]);
  const skills = capabilities.skillList ? await safeJson<unknown[]>(runner, ["skill", "list", "--output", "json"], "skill list") : { ok: false as const, error: "skill list unavailable" };
  const agents = capabilities.agentList ? await safeJson<unknown[]>(runner, ["agent", "list", "--output", "json"], "agent list") : { ok: false as const, error: "agent list unavailable" };
  const runtimes = capabilities.runtimeList ? await safeJson<unknown[]>(runner, ["runtime", "list", "--output", "json"], "runtime list") : { ok: false as const, error: "runtime list unavailable" };

  const payload = { capabilities, config: config.stdout, skills, agents, runtimes, skillName: options.skillName };
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Multica config:");
  console.log(config.stdout.trim());
  console.log("");
  console.log(`Capabilities: ${capabilities.missing.length === 0 ? "complete" : "degraded"}`);
  if (capabilities.missing.length > 0) console.log(`Missing: ${capabilities.missing.join(", ")}`);
  console.log("");
  console.log(`Skills: ${skills.ok ? skills.value.length : skills.error}`);
  console.log(`Agents: ${agents.ok ? agents.value.length : agents.error}`);
  console.log(`Runtimes: ${runtimes.ok ? runtimes.value.length : runtimes.error}`);
  console.log("");
  console.log("Hints:");
  console.log("- If the UI shows an empty agent list, check whether CLI workspace and browser workspace match.");
  console.log("- If runtimes are online but no agents exist, create agents in Multica or use an explicit agent bootstrap outside this v0.1 tool.");
}
```

- [ ] **Step 2: Wire inspect into CLI**

Modify `src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { runInspect } from "./commands/inspect.js";
import { formatUnknownError, UserError } from "./lib/errors.js";
import { MulticaCli } from "./lib/multica-cli.js";

const program = new Command();
const runner = new MulticaCli();

program
  .name("switchyard-multica")
  .description("Publish and verify Agent Switchyard skills for Multica")
  .version("0.1.0");

program
  .command("inspect")
  .description("Inspect Multica config, skills, agents, and runtimes")
  .option("--skill-name <name>", "Target skill name")
  .option("--json", "Output JSON")
  .action(async (options) => runInspect(runner, options));

program.parseAsync(process.argv).catch((error: unknown) => {
  const exitCode = error instanceof UserError ? error.exitCode : 1;
  console.error(formatUnknownError(error));
  process.exit(exitCode);
});
```

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke test**

Run:

```bash
node dist/cli.js inspect --json
```

Expected in a machine with Multica configured: JSON containing `capabilities`, `config`, `skills`, `agents`, and `runtimes`. If Multica is unavailable, command reports readable errors or degraded capability data.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/commands/inspect.ts
git commit -m "feat: implement inspect command"
```

---

### Task 5: Publish and Verify Commands

**Files:**
- Create: `src/commands/publish.ts`
- Create: `src/commands/verify.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Define Multica skill types inside publish command**

Create `src/commands/publish.ts`:

```ts
import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { collectSkillSource } from "../lib/skill-source.js";
import type { MulticaRunner } from "../lib/multica-cli.js";
import { UserError } from "../lib/errors.js";

interface MulticaSkill {
  id: string;
  name: string;
}

export interface PublishOptions {
  source?: string;
  skillName?: string;
  dryRun?: boolean;
  json?: boolean;
}

function resolvePublishInput(options: PublishOptions): { source: string; skillName: string } {
  const source = options.source ?? process.env.SWITCHYARD_SKILL_SOURCE;
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";
  if (!source) throw new UserError("Missing --source or SWITCHYARD_SKILL_SOURCE");
  return { source, skillName };
}

export async function runPublish(runner: MulticaRunner, options: PublishOptions): Promise<void> {
  const { source, skillName } = resolvePublishInput(options);
  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "skillCreate", "skillUpdate", "skillFilesUpsert"]);

  const sourceBundle = await collectSkillSource(source, skillName);
  const skills = await runner.json<MulticaSkill[]>(["skill", "list", "--output", "json"], "skill list");
  const existing = skills.find((skill) => skill.name === skillName);
  const supportingFiles = sourceBundle.files.filter((file) => file.path !== "SKILL.md");

  const plan = {
    action: existing ? "update" : "create",
    skillName,
    skillId: existing?.id,
    fileCount: sourceBundle.files.length,
    totalSize: sourceBundle.files.reduce((sum, file) => sum + file.size, 0),
    files: sourceBundle.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  };

  if (options.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  let skillId = existing?.id;
  const skillContent = sourceBundle.files.find((file) => file.path === "SKILL.md")?.content;
  if (!skillContent) throw new UserError("Collected source is missing SKILL.md");

  if (skillId) {
    await runner.json(["skill", "update", skillId, "--name", skillName, "--content", skillContent, "--output", "json"], "skill update");
  } else {
    const created = await runner.json<MulticaSkill>(["skill", "create", "--name", skillName, "--content", skillContent, "--output", "json"], "skill create");
    skillId = created.id;
  }

  for (const file of supportingFiles) {
    await runner.json(["skill", "files", "upsert", skillId, "--path", file.path, "--content", file.content, "--output", "json"], "skill files upsert");
  }

  console.log(JSON.stringify({ ...plan, skillId, dryRun: false }, null, 2));
}
```

- [ ] **Step 2: Implement verify command skeleton**

Create `src/commands/verify.ts`:

```ts
import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { diffFileRecords } from "../lib/diff.js";
import { sha256 } from "../lib/hash.js";
import { collectSkillSource } from "../lib/skill-source.js";
import type { MulticaRunner } from "../lib/multica-cli.js";
import { UserError } from "../lib/errors.js";

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

interface MulticaSkillSummary {
  id: string;
  name: string;
}

export interface VerifyOptions {
  source?: string;
  skillName?: string;
  json?: boolean;
}

export async function runVerify(runner: MulticaRunner, options: VerifyOptions): Promise<void> {
  const source = options.source ?? process.env.SWITCHYARD_SKILL_SOURCE;
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";
  if (!source) throw new UserError("Missing --source or SWITCHYARD_SKILL_SOURCE");

  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "skillGet"]);

  const local = await collectSkillSource(source, skillName);
  const skills = await runner.json<MulticaSkillSummary[]>(["skill", "list", "--output", "json"], "skill list");
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) throw new UserError(`Skill not found in Multica: ${skillName}. Run publish first.`);

  const detail = await runner.json<MulticaSkillDetail>(["skill", "get", skill.id, "--output", "json"], "skill get");
  const remoteFiles = [
    ...(detail.content ? [{ path: "SKILL.md", content: detail.content }] : []),
    ...(detail.files ?? [])
  ].map((file) => {
    const content = file.content ?? "";
    return {
      path: file.path,
      sha256: file.sha256 ?? sha256(content),
      size: file.size ?? Buffer.byteLength(content)
    };
  });

  const diffs = diffFileRecords(local.files.map(({ path, sha256, size }) => ({ path, sha256, size })), remoteFiles);
  const result = { skillName, skillId: skill.id, diffCount: diffs.length, diffs };
  console.log(JSON.stringify(result, null, 2));
  if (diffs.length > 0) throw new UserError(`Verification failed with ${diffs.length} difference(s)`);
}
```

- [ ] **Step 3: Wire publish and verify into CLI**

Modify `src/cli.ts` to import and register:

```ts
import { runPublish } from "./commands/publish.js";
import { runVerify } from "./commands/verify.js";
```

Add commands:

```ts
program
  .command("publish")
  .description("Publish or update an Agent Switchyard skill in Multica")
  .requiredOption("--source <dir>", "Agent Switchyard skill source directory")
  .option("--skill-name <name>", "Skill name", "agent-switchyard")
  .option("--dry-run", "Print planned writes without modifying Multica")
  .option("--json", "Output JSON")
  .action(async (options) => runPublish(runner, options));

program
  .command("verify")
  .description("Verify Multica skill content against local source")
  .requiredOption("--source <dir>", "Agent Switchyard skill source directory")
  .option("--skill-name <name>", "Skill name", "agent-switchyard")
  .option("--json", "Output JSON")
  .action(async (options) => runVerify(runner, options));
```

- [ ] **Step 4: Build**

Run:

```bash
npm run build
```

Expected: PASS. If TypeScript reports dynamic `require`, replace it with the ESM `sha256` import before continuing.

- [ ] **Step 5: Manual dry-run**

Run:

```bash
node dist/cli.js publish --source /Users/jacobwu/Documents/02-当前项目/agent-switchyard/skill/agent-switchyard --skill-name agent-switchyard --dry-run
```

Expected: JSON plan with `action`, `fileCount`, `totalSize`, and file hashes. No Multica writes occur.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/commands/publish.ts src/commands/verify.ts
git commit -m "feat: implement publish and verify"
```

---

### Task 6: Bind Resolver and Bind Command

**Files:**
- Create: `src/lib/bind-resolver.ts`
- Create: `src/commands/bind.ts`
- Modify: `src/cli.ts`
- Test: `test/bind-resolver.test.ts`

- [ ] **Step 1: Write resolver tests**

Create `test/bind-resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeSkillIds, resolveAgent } from "../src/lib/bind-resolver.js";

const agents = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Hermes", skills: [] },
  { id: "22222222-2222-4222-8222-222222222222", name: "Codex", skills: [] }
];

describe("resolveAgent", () => {
  it("resolves by UUID", () => {
    expect(resolveAgent(agents, agents[0].id)?.name).toBe("Hermes");
  });

  it("resolves by exact name", () => {
    expect(resolveAgent(agents, "Codex")?.id).toBe(agents[1].id);
  });

  it("throws on duplicate names", () => {
    expect(() => resolveAgent([...agents, { id: "33333333-3333-4333-8333-333333333333", name: "Codex", skills: [] }], "Codex")).toThrow("Multiple agents");
  });
});

describe("mergeSkillIds", () => {
  it("appends without duplicating", () => {
    expect(mergeSkillIds(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(mergeSkillIds(["a"], "b")).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Implement resolver**

Create `src/lib/bind-resolver.ts`:

```ts
import { UserError } from "./errors.js";

export interface AgentLike {
  id: string;
  name: string;
  skills?: Array<{ id: string; name: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveAgent(agents: AgentLike[], selector: string): AgentLike {
  if (UUID_RE.test(selector)) {
    const hit = agents.find((agent) => agent.id === selector);
    if (!hit) throw new UserError(`Agent not found by id: ${selector}`);
    return hit;
  }

  const matches = agents.filter((agent) => agent.name === selector);
  if (matches.length === 0) throw new UserError(`Agent not found by exact name: ${selector}`);
  if (matches.length > 1) {
    const choices = matches.map((agent) => `${agent.name} (${agent.id})`).join(", ");
    throw new UserError(`Multiple agents match name "${selector}". Use an id. Candidates: ${choices}`);
  }
  return matches[0];
}

export function mergeSkillIds(existing: string[], targetSkillId: string): string[] {
  return existing.includes(targetSkillId) ? existing : [...existing, targetSkillId];
}
```

- [ ] **Step 3: Implement bind command**

Create `src/commands/bind.ts`:

```ts
import { probeCapabilities, requireCapabilities } from "../lib/capability-probe.js";
import { mergeSkillIds, resolveAgent, type AgentLike } from "../lib/bind-resolver.js";
import { UserError } from "../lib/errors.js";
import type { MulticaRunner } from "../lib/multica-cli.js";

interface SkillSummary {
  id: string;
  name: string;
}

export interface BindOptions {
  skillName?: string;
  agent?: string[];
  dryRun?: boolean;
  json?: boolean;
}

export async function runBind(runner: MulticaRunner, options: BindOptions): Promise<void> {
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";
  const agentSelectors = options.agent ?? [];
  if (agentSelectors.length === 0) throw new UserError("At least one --agent is required");

  const capabilities = await probeCapabilities(runner);
  requireCapabilities(capabilities, ["skillList", "agentList", "agentSkillsList", "agentSkillsSet"]);

  const skills = await runner.json<SkillSummary[]>(["skill", "list", "--output", "json"], "skill list");
  const skill = skills.find((candidate) => candidate.name === skillName);
  if (!skill) throw new UserError(`Skill not found: ${skillName}. Run publish first.`);

  const agents = await runner.json<AgentLike[]>(["agent", "list", "--output", "json"], "agent list");
  const changes = [];

  for (const selector of agentSelectors) {
    const agent = resolveAgent(agents, selector);
    const currentSkills = await runner.json<SkillSummary[]>(["agent", "skills", "list", agent.id, "--output", "json"], "agent skills list");
    const beforeIds = currentSkills.map((entry) => entry.id);
    const afterIds = mergeSkillIds(beforeIds, skill.id);
    changes.push({ agent: { id: agent.id, name: agent.name }, before: currentSkills, afterIds });
    if (!options.dryRun) {
      await runner.json(["agent", "skills", "set", agent.id, "--skill-ids", afterIds.join(","), "--output", "json"], "agent skills set");
      const readBack = await runner.json<SkillSummary[]>(["agent", "skills", "list", agent.id, "--output", "json"], "agent skills list");
      const readBackIds = readBack.map((entry) => entry.id).sort();
      const expectedIds = [...afterIds].sort();
      if (JSON.stringify(readBackIds) !== JSON.stringify(expectedIds)) {
        throw new UserError(`Read-back verification failed for agent ${agent.name}`);
      }
    }
  }

  console.log(JSON.stringify({ skillName, skillId: skill.id, dryRun: Boolean(options.dryRun), changes }, null, 2));
}
```

- [ ] **Step 4: Wire bind into CLI**

Modify `src/cli.ts`:

```ts
import { runBind } from "./commands/bind.js";
```

Register:

```ts
program
  .command("bind")
  .description("Append a Multica skill to existing agents")
  .option("--skill-name <name>", "Skill name", "agent-switchyard")
  .option("--agent <name-or-id>", "Agent name or id", (value, previous: string[] = []) => [...previous, value], [])
  .option("--dry-run", "Print planned writes without modifying Multica")
  .option("--json", "Output JSON")
  .action(async (options) => runBind(runner, options));
```

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm test -- test/bind-resolver.test.ts
npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bind-resolver.ts src/commands/bind.ts src/cli.ts test/bind-resolver.test.ts
git commit -m "feat: implement bind command"
```

---

### Task 7: Local Targets and sync-local

**Files:**
- Create: `src/lib/local-targets.ts`
- Create: `src/commands/sync-local.ts`
- Modify: `src/cli.ts`
- Test: `test/local-targets.test.ts`
- Test: `test/sync-local.test.ts`

- [ ] **Step 1: Write local target tests**

Create `test/local-targets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveTargetDir } from "../src/lib/local-targets.js";

describe("resolveTargetDir", () => {
  it("resolves default openclaw and hermes paths", () => {
    expect(resolveTargetDir("openclaw", "agent-switchyard", {}, "/Users/test")).toBe("/Users/test/.openclaw/skills/agent-switchyard");
    expect(resolveTargetDir("hermes", "agent-switchyard", {}, "/Users/test")).toBe("/Users/test/.hermes/skills/agent-switchyard");
  });

  it("uses CODEX_HOME for codex", () => {
    expect(resolveTargetDir("codex", "agent-switchyard", {}, "/Users/test", { CODEX_HOME: "/tmp/codex" })).toBe("/tmp/codex/skills/agent-switchyard");
  });

  it("uses explicit override", () => {
    expect(resolveTargetDir("openclaw", "agent-switchyard", { openclaw: "/custom" }, "/Users/test")).toBe("/custom");
  });

  it("rejects unknown target", () => {
    expect(() => resolveTargetDir("bad", "agent-switchyard", {}, "/Users/test")).toThrow("Unknown target");
  });
});
```

- [ ] **Step 2: Implement local targets**

Create `src/lib/local-targets.ts`:

```ts
import { join } from "node:path";
import { UserError } from "./errors.js";

export type LocalTarget = "openclaw" | "hermes" | "codex" | "claude";

export function parseTargetDirOverrides(values: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const index = value.indexOf("=");
    if (index <= 0) throw new UserError(`Invalid --target-dir value: ${value}`);
    out[value.slice(0, index)] = value.slice(index + 1);
  }
  return out;
}

export function resolveTargetDir(
  target: string,
  skillName: string,
  overrides: Record<string, string>,
  home: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (overrides[target]) return overrides[target];
  switch (target) {
    case "openclaw":
      return join(home, ".openclaw", "skills", skillName);
    case "hermes":
      return join(home, ".hermes", "skills", skillName);
    case "codex":
      return join(env.CODEX_HOME || join(home, ".codex"), "skills", skillName);
    case "claude":
      return join(home, ".claude", "skills", skillName);
    default:
      throw new UserError(`Unknown target: ${target}`);
  }
}
```

- [ ] **Step 3: Implement sync-local command**

Create `src/commands/sync-local.ts`:

```ts
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { collectSkillSource } from "../lib/skill-source.js";
import { parseTargetDirOverrides, resolveTargetDir } from "../lib/local-targets.js";
import { UserError } from "../lib/errors.js";

const MARKER = ".switchyard-multica.json";

export interface SyncLocalOptions {
  source?: string;
  skillName?: string;
  target?: string[];
  targetDir?: string[];
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

async function isNonEmptyDir(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return true;
    const { readdir } = await import("node:fs/promises");
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

export async function runSyncLocal(options: SyncLocalOptions): Promise<void> {
  const source = options.source ?? process.env.SWITCHYARD_SKILL_SOURCE;
  const skillName = options.skillName ?? process.env.SWITCHYARD_SKILL_NAME ?? "agent-switchyard";
  if (!source) throw new UserError("Missing --source or SWITCHYARD_SKILL_SOURCE");
  const targets = options.target ?? [];
  if (targets.length === 0) throw new UserError("sync-local requires at least one --target");

  const sourceBundle = await collectSkillSource(source, skillName);
  const overrides = parseTargetDirOverrides(options.targetDir);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const plans = [];

  for (const target of targets) {
    const targetDir = resolveTargetDir(target, skillName, overrides, homedir());
    const markerPath = join(targetDir, MARKER);
    const hasContent = await isNonEmptyDir(targetDir);
    let marker: unknown = null;
    if (existsSync(markerPath)) marker = JSON.parse(await readFile(markerPath, "utf8"));
    const needsForce = hasContent && !marker;
    const backupDir = join(homedir(), ".switchyard-multica", "backups", timestamp, target, skillName);
    plans.push({ target, targetDir, hasContent, hasMarker: Boolean(marker), needsForce, backupDir, files: sourceBundle.files.map((file) => file.path) });

    if (options.dryRun) continue;
    if (needsForce && !options.force) throw new UserError(`Target ${targetDir} is non-empty and unmanaged. Re-run with --force to take ownership.`);
    if (hasContent) {
      await mkdir(backupDir, { recursive: true });
      await cp(targetDir, backupDir, { recursive: true, force: true });
    }
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });
    for (const file of sourceBundle.files) {
      const dest = join(targetDir, file.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, file.content);
    }
    await writeFile(join(targetDir, MARKER), JSON.stringify({
      managedBy: "switchyard-multica",
      skillName,
      sourcePath: sourceBundle.root,
      target,
      targetDir,
      lastSyncAt: new Date().toISOString(),
      sourceHash: sourceBundle.manifest.files.map((file) => file.sha256).join(":"),
      files: sourceBundle.manifest.files
    }, null, 2) + "\n");
  }

  console.log(JSON.stringify({ dryRun: Boolean(options.dryRun), plans }, null, 2));
}
```

- [ ] **Step 4: Wire sync-local into CLI**

Modify `src/cli.ts`:

```ts
import { runSyncLocal } from "./commands/sync-local.js";
```

Register:

```ts
program
  .command("sync-local")
  .description("Sync skill source into explicit local runtime skill directories")
  .requiredOption("--source <dir>", "Agent Switchyard skill source directory")
  .option("--skill-name <name>", "Skill name", "agent-switchyard")
  .option("--target <target>", "Local target", (value, previous: string[] = []) => [...previous, value], [])
  .option("--target-dir <target=path>", "Override target directory", (value, previous: string[] = []) => [...previous, value], [])
  .option("--dry-run", "Print planned writes without modifying local directories")
  .option("--force", "Take ownership of an existing non-empty target directory")
  .option("--json", "Output JSON")
  .action(async (options) => runSyncLocal(options));
```

- [ ] **Step 5: Run tests and build**

Run:

```bash
npm test -- test/local-targets.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/local-targets.ts src/commands/sync-local.ts src/cli.ts test/local-targets.test.ts
git commit -m "feat: implement sync-local command"
```

---

### Task 8: README and Integration Test Documentation

**Files:**
- Create: `README.md`
- Modify: `docs/design.md` only if implementation uncovered a spec correction.

- [ ] **Step 1: Create README**

Create `README.md`:

```md
# switchyard-multica

`switchyard-multica` publishes an Agent Switchyard skill source into the current Multica workspace and can explicitly sync that same skill into local runtime skill directories.

It is not Agent Switchyard, not a Multica runtime provider, and not a Multica SDK. It uses the installed `multica` CLI only.

## Requirements

- Node.js 20+
- Multica CLI in `PATH`
- `multica login`
- A selected Multica workspace

## Commands

Inspect current Multica state:

```bash
switchyard-multica inspect
```

Dry-run publish:

```bash
switchyard-multica publish \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard \
  --dry-run
```

Publish:

```bash
switchyard-multica publish \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard
```

Append the skill to existing agents:

```bash
switchyard-multica bind \
  --skill-name agent-switchyard \
  --agent "Hermes Switchyard Lab" \
  --agent "OpenClaw Switchyard Lab"
```

Verify Multica content:

```bash
switchyard-multica verify \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard
```

Explicitly sync local runtime directories:

```bash
switchyard-multica sync-local \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --target openclaw \
  --target hermes \
  --dry-run
```

## Safety Model

- `publish`, `bind`, and `sync-local` support `--dry-run`.
- `publish` only reads `SKILL.md`, `references/**`, and `scripts/**`.
- `publish` rejects symlinks, source-root escapes, and likely secret files.
- `bind` preserves existing agent skills and appends the target skill.
- `sync-local` requires explicit `--target`.
- `sync-local` refuses unmanaged non-empty directories unless `--force` is passed.
- `sync-local` backs up before writing.
- v0.1 does not prune remote extra files.

## Common Issues

If the Multica UI shows no agents but `switchyard-multica inspect` shows agents, check that the browser workspace and CLI workspace are the same.

If `verify` reports `extra_remote`, the remote skill contains files no longer present locally. v0.1 reports this as a difference but does not delete remote files.

If Hermes and OpenClaw behave differently, remember that Multica writes assigned workspace skills to provider-specific task workdirs. Local user-level skill directories are separate from Multica per-task injection.
```

- [ ] **Step 2: Run final checks**

Run:

```bash
npm run check
```

Expected: build and unit tests pass.

- [ ] **Step 3: Run local integration smoke tests only when explicitly allowed**

Only run when explicitly allowed:

```bash
MULTICA_INTEGRATION=1 npm run test:integration
```

Expected: integration tests run against the current Multica workspace. When integration tests are not present yet, do not add this command to `npm run check`; keep real-workspace checks as documented manual commands in `README.md`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document switchyard-multica usage"
```

---

## Self-Review Checklist

- Spec coverage:
  - CLI-only Multica integration: Tasks 3-6.
  - `--dry-run`: Tasks 5-7.
  - publish whitelist and exclusions: Task 2.
  - no prune: Task 5 and README.
  - content-level verify: Task 5.
  - manifest: Task 2.
  - bind read-merge-set-readback: Task 6.
  - sync-local marker/backup/force: Task 7.
  - inspect degraded mode: Task 4.
  - ordinary tests avoid real Multica: Tasks 2, 3, 6, 7.
- Placeholder scan: no deferred behavior is represented as a placeholder.
- Type consistency:
  - `MulticaRunner` is used by commands that invoke Multica.
  - `SkillSourceFile` carries `path`, `content`, `size`, `sha256`.
  - `ManifestFile` carries `path`, `size`, `sha256`.
  - `DiffRecord.kind` uses the spec's difference names.
