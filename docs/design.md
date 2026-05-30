# switchyard-multica v0.1 设计规格

日期：2026-05-26

## 1. 项目定位

`switchyard-multica` 是 Agent Switchyard skill source 到 Multica workspace 和本地 runtime skill 目录的适配器。

项目目录：

```text
/Users/jacobwu/Documents/02-当前项目/GitHub仓库/agent-switchyard-multica-adapter
```

CLI 名称：

```bash
switchyard-multica
```

它是：

- Agent Switchyard skill 的 Multica 发布器。
- Agent Switchyard skill 的本地 runtime 同步器。
- Multica 当前 workspace / runtime / agent / skill 关系的只读检查工具。

它不是：

- Agent Switchyard 本体。
- Multica runtime provider。
- 通用 Multica SDK。
- Docker 或 self-host server 管理工具。
- 直接调用 Multica HTTP API 的工具。

第一版必须只通过 `multica` CLI 对接 Multica，不得直接调用 Multica HTTP API。

## 2. 第一版目标

第一版必须支持：

1. 从本地 Agent Switchyard skill source 目录读取：
   - `SKILL.md`
   - `references/**`
   - `scripts/**`
2. 发布或更新到当前 `multica` CLI 登录的 workspace。
3. 把 skill 追加绑定到已有 Multica agents。
4. 显式同步到本地 runtime skill 目录。
5. 校验 Multica 内容和本地 source 是否一致。
6. 只读检查当前 Multica workspace、runtimes、agents、skills 关系。

第一版不得：

1. 自动创建 agents。
2. 默认同步本地 runtime 目录。
3. 默认 prune 远端多余 skill files。
4. 上传疑似密钥文件。
5. 读取 source root 外文件。
6. 修改当前 Agent Switchyard 工作区。

## 3. 前置设计审计结论

### 3.1 原设计必须修正的问题

原设计存在以下风险，正式实现必须修正：

- 不得假设 `multica skill create`、`multica skill update`、`multica skill files upsert`、`multica agent skills set`、`multica runtime list` 等命令必然存在。
- `publish`、`bind`、`sync-local` 必须支持 `--dry-run`。
- `publish` 必须有强文件边界，拒绝 symlink、路径逃逸、疑似密钥和异常大文件。
- `sync-local` 不能简单备份后覆盖。必须引入 marker 接管机制。
- `verify` 不能只输出通过或失败，必须输出文件级差异类型。
- 必须引入 manifest，帮助发布、校验和本地同步审计。
- `inspect` 在 CLI 能力缺失时必须进入 degraded mode，不得整体崩溃。

### 3.2 保留的设计

保留以下方向：

- 独立开源项目，不改当前 Agent Switchyard repo。
- Node.js + TypeScript CLI。
- 默认只通过 `multica` CLI 对接。
- 命令包括 `publish`、`bind`、`sync-local`、`verify`、`inspect`。
- 第一版不自动创建 agents。
- 第一版不做 prune。
- 默认只收集 `SKILL.md`、`references/**`、`scripts/**`。

## 4. 项目结构

目标结构：

```text
agent-switchyard-multica-adapter/
  README.md
  package.json
  tsconfig.json
  docs/
    design.md
  src/
    cli.ts
    commands/
      publish.ts
      bind.ts
      sync-local.ts
      verify.ts
      inspect.ts
    lib/
      capability-probe.ts
      multica-cli.ts
      skill-source.ts
      manifest.ts
      local-targets.ts
      bind-resolver.ts
      diff.ts
      hash.ts
      errors.ts
  test/
    fixtures/
      agent-switchyard-skill/
    skill-source.test.ts
    manifest.test.ts
    local-targets.test.ts
    bind-resolver.test.ts
    sync-local.test.ts
    multica-cli.test.ts
```

## 5. Multica CLI 探测

实现必须在执行相关操作前探测真实 CLI surface。

至少探测：

```bash
multica --help
multica skill --help
multica agent --help
multica runtime --help
multica skill create --help
multica skill update --help
multica skill get --help
multica skill list --help
multica skill files --help
multica skill files upsert --help
multica agent list --help
multica agent skills --help
multica agent skills list --help
multica agent skills set --help
multica runtime list --help
```

探测结果必须形成 capability map。

规则：

1. 所有 Multica 写操作必须先确认对应 CLI 能力存在。
2. 不得硬编码未经探测的子命令为必然可用。
3. 如果当前 Multica CLI 不支持某能力，写命令必须清晰失败。
4. 失败信息必须说明缺失能力和建议用户升级或检查 Multica CLI。
5. 不得假装成功。
6. 不得静默跳过。
7. `inspect` 可以 degraded mode 输出已有信息和缺失能力。

## 6. Source 文件收集规则

`publish`、`verify`、`sync-local` 只允许读取：

```text
SKILL.md
references/**
scripts/**
```

必须排除或拒绝：

```text
.git/**
node_modules/**
.DS_Store
*.tmp
*.bak
*~
.env
*.pem
*.key
id_rsa
id_ed25519
credentials
token
secret
```

实现要求：

1. 默认不跟随 symlink。
2. 文件路径必须是 source root 下的相对路径。
3. 拒绝绝对路径。
4. 拒绝包含 `..` 的路径。
5. 拒绝解析后逃逸 source root 的路径。
6. 拒绝 source root 外的文件。
7. 建议限制单文件最大 1 MiB。
8. 建议限制总大小最大 8 MiB。
9. 建议限制文件数最大 128。
10. 超限必须失败。

发布前必须输出：

- 待上传文件清单。
- 文件数量。
- 总大小。
- 每个文件 sha256。

## 7. Manifest

工具必须生成 manifest。

本地 manifest 文件名：

```text
.switchyard-multica-manifest.json
```

远端 supporting file 路径：

```text
.switchyard-multica-manifest.json
```

manifest 内容至少包括：

```json
{
  "tool": "switchyard-multica",
  "toolVersion": "0.1.0",
  "skillName": "agent-switchyard",
  "sourcePath": "...",
  "generatedAt": "...",
  "files": [
    {
      "path": "SKILL.md",
      "sha256": "...",
      "size": 1234
    }
  ]
}
```

用途：

1. `publish` 时记录本地文件集合。
2. `verify` 时辅助比较。
3. `sync-local` 后记录同步状态。
4. 当 Multica CLI 不支持读取远端文件内容时，用 manifest 做辅助一致性校验。

如果只能用 manifest 校验，`verify` 必须清楚标注验证等级为 degraded，不得声称完成内容级完整校验。

## 8. 命令规格

### 8.1 publish

命令：

```bash
switchyard-multica publish \
  --source <dir> \
  --skill-name agent-switchyard \
  [--dry-run] \
  [--json]
```

环境变量兜底：

```text
SWITCHYARD_SKILL_SOURCE
SWITCHYARD_SKILL_NAME
```

行为：

1. 探测所需 Multica CLI 能力。
2. 校验 source 目录。
3. 校验 `SKILL.md` 存在。
4. 按白名单收集文件。
5. 生成 manifest。
6. 输出待上传文件清单、数量、总大小和 sha256。
7. 如果 skill 存在，执行 update。
8. 如果 skill 不存在，执行 create。
9. 对 supporting files 执行 upsert。
10. 第一版不删除远端多余文件。

`--dry-run` 必须输出：

- 将读取哪些本地文件。
- 将 create 还是 update skill。
- 将上传或更新哪些远端文件。
- 文件数量、总大小和 sha256。
- 不得修改 Multica workspace。

失败条件：

- 找不到 `multica` CLI。
- Multica CLI 未登录或 token 无效。
- 当前 CLI 缺少必要子命令。
- source 不合法。
- 文件越界、超限、疑似密钥或 symlink。
- Multica CLI 返回非零 exit code。

### 8.2 bind

命令：

```bash
switchyard-multica bind \
  --skill-name agent-switchyard \
  --agent <name-or-id> \
  [--agent <name-or-id>] \
  [--dry-run] \
  [--json]
```

行为：

1. 探测所需 Multica CLI 能力。
2. resolve skill。
3. resolve agent。
4. 读取 agent 当前 skills。
5. 合并目标 skill。
6. 调用 `multica agent skills set` 写回完整 skill ID 列表。
7. read-back verify。
8. 输出变更前和变更后 skills。

规则：

- UUID 按 ID 匹配。
- 非 UUID 按名称精确匹配。
- 名称重复必须报错并列出候选 ID。
- agent 找不到必须报错。
- skill 找不到必须提示先执行 `publish`。
- 不得删除已有 skills。
- 已绑定目标 skill 时不重复添加。
- read-back verify 不一致必须报错。

`--dry-run` 必须输出：

- 将绑定哪些 agent。
- 每个 agent 当前已有 skills。
- 合并后的 skills。
- 预计调用的 `agent skills set` 参数。
- 不得修改 Multica workspace。

### 8.3 sync-local

命令：

```bash
switchyard-multica sync-local \
  --source <dir> \
  --skill-name agent-switchyard \
  --target openclaw \
  [--target hermes] \
  [--target-dir openclaw=/custom/path] \
  [--dry-run] \
  [--force] \
  [--json]
```

默认 target：

```text
openclaw -> ~/.openclaw/skills/agent-switchyard
hermes   -> ~/.hermes/skills/agent-switchyard
codex    -> ${CODEX_HOME:-~/.codex}/skills/agent-switchyard
claude   -> ~/.claude/skills/agent-switchyard
```

这些路径只是默认推断路径，不代表 runtime 一定会加载成功。

规则：

1. 必须显式传 `--target`。
2. 默认不得覆盖已有非空目录。
3. 如果目标目录已有内容但没有 `.switchyard-multica.json` marker，必须失败。
4. 如果 marker 存在但 `skillName`、`sourcePath` 或 `target` 不匹配，必须失败。
5. 用户显式传 `--force` 才允许首次接管已有非空目录。
6. `--force` 不得跳过备份。
7. `--force` 不得跳过 hash verify。
8. 每次同步前必须备份旧目录。
9. 同步后必须做 hash verify。
10. 同步后必须写入或更新 marker。

备份路径：

```text
~/.switchyard-multica/backups/<timestamp>/<target>/agent-switchyard
```

marker 文件：

```text
.switchyard-multica.json
```

marker 内容：

```json
{
  "managedBy": "switchyard-multica",
  "skillName": "agent-switchyard",
  "sourcePath": "...",
  "target": "openclaw",
  "targetDir": "...",
  "lastSyncAt": "...",
  "sourceHash": "...",
  "files": []
}
```

`--dry-run` 必须输出：

- 将写入哪些本地目录。
- 目标目录是否存在。
- 目标目录是否非空。
- 是否存在 marker。
- marker 是否匹配。
- 是否会覆盖已有目录。
- 是否需要 `--force`。
- 预计备份路径。
- 将写入哪些文件。
- 不得修改本机 runtime 目录。

### 8.4 verify

命令：

```bash
switchyard-multica verify \
  --source <dir> \
  --skill-name agent-switchyard \
  [--agent <name-or-id>] \
  [--json]
```

行为：

1. 探测所需 Multica CLI 能力。
2. 读取本地 source manifest。
3. 读取远端 skill。
4. 比对 `SKILL.md`。
5. 比对 `references/**` 和 `scripts/**` 文件列表。
6. 比对每个文件 sha256。
7. 如果传了 `--agent`，检查这些 agents 是否绑定目标 skill。

不得修改任何内容。

必须区分并输出：

- `missing_remote`：本地有，远端没有。
- `extra_remote`：远端有，本地没有。
- `content_mismatch`：两边都有但 sha256 不同。
- `metadata_mismatch`：可选，例如 executable bit 不一致。
- `agent_not_bound`：指定 agent 未绑定目标 skill。

`extra_remote` 第一版必须视为差异，默认非零退出。不得静默忽略。

如果 Multica CLI 无法读取远端文件内容，只能读取 manifest，则必须：

- 输出 degraded verify。
- 说明无法完成完整内容级校验。
- 仍用 manifest 报告可判断的差异。

### 8.5 inspect

命令：

```bash
switchyard-multica inspect \
  [--skill-name agent-switchyard] \
  [--json]
```

`inspect` 是只读命令，不得修改任何内容。

默认输出人类可读信息。

必须展示：

1. 当前 `multica config`。
2. 当前 workspace。
3. skills 列表。
4. agents 列表。
5. agents 与 skills 绑定关系。
6. runtimes 列表。
7. runtime provider/status/workspace。
8. 常见问题提示。

常见问题提示至少包括：

- CLI workspace 和浏览器 workspace 可能不一致。
- runtime online 但没有对应 agent。
- agent 没有绑定目标 skill。
- Multica CLI 缺少某些能力。

如果某些 CLI 能力不可用，`inspect` 应输出 degraded mode，而不是崩溃。

## 9. 错误处理

错误必须用户可读。

常见错误：

- `multica` CLI 不存在：提示安装或检查 PATH。
- 未登录：提示运行 `multica login`。
- workspace 未设置：提示运行 `multica config set workspace_id <id>`。
- CLI 子命令不存在：说明缺失命令。
- 非 JSON 输出：保留 stderr/stdout 摘要。
- exit code 非 0：保留 stderr，返回非零。
- agent 名称重复：列出候选 ID。
- source 不合法：说明具体文件或路径。
- sync-local 目标目录非空且无 marker：提示使用 `--force` 接管。

## 10. 测试策略

普通测试不得依赖真实 Multica workspace。

真实集成测试必须显式开启：

```bash
MULTICA_INTEGRATION=1 npm run test:integration
```

单元测试必须覆盖：

### 10.1 skill-source

- 合法 source 可读取。
- 缺 `SKILL.md` 报错。
- 只收集 `SKILL.md`、`references/**`、`scripts/**`。
- 排除 `.git`、`node_modules`、临时文件、密钥文件。
- symlink 默认不跟随。
- path traversal 被拒绝。

### 10.2 local-targets

- `openclaw`、`hermes`、`codex`、`claude` 默认路径解析。
- `CODEX_HOME` 覆盖。
- `--target-dir` 覆盖。
- 未知 target 报错。

### 10.3 hash/manifest/diff

- 同内容 hash 相同。
- 文件列表差异可识别。
- `content_mismatch` 可识别。
- `extra_remote` 和 `missing_remote` 可识别。

### 10.4 bind resolver

- UUID 按 ID 匹配。
- 名称精确匹配。
- 名称重复时报错。
- 找不到时报错。
- read -> merge -> set -> read-back verify 逻辑正确。

### 10.5 sync-local

- 非空目录无 marker 默认失败。
- `--force` 可接管。
- 同步前创建备份。
- 同步后写 marker。
- hash verify 失败时报错。

### 10.6 multica-cli wrapper

- `multica` CLI 不存在时报错。
- 未登录时报错。
- 子命令不存在时报错。
- 非 JSON 输出处理。
- exit code 非 0 处理。
- stderr 保留为用户可读错误。

## 11. 集成测试

集成测试必须显式开启：

```bash
MULTICA_INTEGRATION=1 npm run test:integration
```

至少覆盖：

```bash
switchyard-multica inspect
switchyard-multica publish --dry-run
switchyard-multica publish
switchyard-multica verify
switchyard-multica bind --dry-run
switchyard-multica sync-local --dry-run
```

集成测试不得默认 prune 远端文件，不得自动创建 agents。

## 12. README 要求

README 必须说明：

- 项目解决什么问题。
- 和 Agent Switchyard、Multica、OpenClaw、Hermes 的关系。
- 安装方式。
- 前置条件：
  - Node.js
  - Multica CLI
  - 已 `multica login`
  - 已选择 workspace
- 快速开始：
  - `publish`
  - `bind`
  - `verify`
  - `sync-local`
  - `inspect`
- 常见问题：
  - UI 看不到 agents，多半是 CLI workspace 和浏览器 workspace 不一致。
  - verify 发现远端多文件，因为第一版不 prune。
  - Hermes 和 OpenClaw 的 skill 读取路径不同。
  - `multica agent skills set` 是替换式 API，所以本工具默认读取、合并、再写回。

## 13. 完成标准

第一版完成时必须满足：

1. 项目创建在：
   `/Users/jacobwu/Documents/02-当前项目/GitHub仓库/agent-switchyard-multica-adapter`
2. 不修改当前 Agent Switchyard 工作区。
3. `npm test` 通过。
4. `npm run build` 通过。
5. 普通测试不触碰真实 Multica workspace。
6. 所有写命令支持 `--dry-run`。
7. `--dry-run` 不修改 Multica workspace。
8. `--dry-run` 不修改本机 runtime 目录。
9. `publish` 不上传疑似密钥、symlink、source root 外文件。
10. `bind` 不删除 agent 已有 skills。
11. `sync-local` 对无 marker 非空目录默认失败。
12. `verify` 能输出内容级差异。
13. 集成测试显式启用后至少跑通：
    - `switchyard-multica inspect`
    - `switchyard-multica publish --dry-run`
    - `switchyard-multica publish`
    - `switchyard-multica verify`
    - `switchyard-multica bind --dry-run`
    - `switchyard-multica sync-local --dry-run`
14. 不自动创建 agents。
15. 不默认同步本地 runtime 目录。
16. 不默认 prune 远端文件。
17. 不上传 source root 外文件。

## 14. 后续版本预留

第一版不实现，但可预留：

- `--prune`
- `--prune-dry-run`
- `bootstrap-agents`
- 直接 HTTP API 模式
- GitHub Action
- npm package 发布
- standalone binary
