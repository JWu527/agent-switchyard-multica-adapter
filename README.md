# switchyard-multica

`switchyard-multica` 是一个很小的本地适配器：把 Agent Switchyard skill source 发布到当前 Multica workspace，并且可以把同一份 skill source 显式同步到本机几个常见 runtime 的 skill 目录。

它的边界同样重要：

- 不是 Agent Switchyard 本体。
- 不是 Multica runtime provider。
- 不是 Multica SDK。
- 不是 Docker 或 self-host 管理器。
- 不是直接 HTTP API 工具。

它只通过本机已安装的 `multica` CLI 探测、发布、绑定和校验 Multica workspace；本地 runtime 同步也必须由用户显式指定目标。

## Requirements

- Node.js 20+
- `multica` CLI 在 `PATH` 中
- 已执行 `multica login`
- CLI 当前 profile 已选择正确的 Multica workspace

本仓库本地开发使用：

```bash
npm install
npm run build
node dist/cli.js --help
```

如果你把包 link 到本机，也可以直接使用 `switchyard-multica` 命令。

## Quick Start

下面用 `/path/to/agent-switchyard/skill/agent-switchyard` 代表 Agent Switchyard skill source 目录。这个目录必须包含 `SKILL.md`。

也可以用环境变量减少重复参数：

```bash
export SWITCHYARD_SKILL_SOURCE=/path/to/agent-switchyard/skill/agent-switchyard
export SWITCHYARD_SKILL_NAME=agent-switchyard
```

检查当前 Multica CLI 状态、skills、agents、runtimes 和可用能力：

```bash
switchyard-multica inspect
```

发布前先 dry run：

```bash
switchyard-multica publish \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard \
  --dry-run
```

确认计划后发布或更新 skill：

```bash
switchyard-multica publish \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard
```

校验远端 Multica skill 内容和本地 source 是否一致：

```bash
switchyard-multica verify \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard
```

把 skill 追加绑定到已有 agents。先 dry run：

```bash
switchyard-multica bind \
  --skill-name agent-switchyard \
  --agent "Hermes Switchyard Lab" \
  --agent "OpenClaw Switchyard Lab" \
  --dry-run
```

确认后执行绑定：

```bash
switchyard-multica bind \
  --skill-name agent-switchyard \
  --agent "Hermes Switchyard Lab" \
  --agent "OpenClaw Switchyard Lab"
```

显式同步到本机 runtime skill 目录。先 dry run：

```bash
switchyard-multica sync-local \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard \
  --target openclaw \
  --target hermes \
  --dry-run
```

确认目标目录、备份路径和 marker 状态后执行：

```bash
switchyard-multica sync-local \
  --source /path/to/agent-switchyard/skill/agent-switchyard \
  --skill-name agent-switchyard \
  --target openclaw \
  --target hermes
```

所有命令都支持 `--json`，便于把结果交给脚本或其他 agent 读取。

## Safety Model

Multica 相关动作只通过 `multica` CLI 完成。工具会先探测 CLI 能力；如果当前 CLI 缺少必要子命令，写操作会失败，`inspect` 会尽量输出 degraded 诊断而不是直接崩溃。

`publish`、`bind`、`sync-local` 都支持 `--dry-run`：

- `publish --dry-run` 只读取本地 source 并输出将要创建或更新的 skill、文件列表和 hash。
- `bind --dry-run` 只读取 skill、agent 和 agent skills，输出将要传给 `multica agent skills set` 的完整 skill ID 列表。
- `sync-local --dry-run` 只检查目标目录和 marker，输出将要写入的文件与备份路径。

`publish` 的上传范围是白名单：

- 读取 `SKILL.md`、`references/**`、`scripts/**`。
- 自动生成并上传 `.switchyard-multica-manifest.json`。
- 跳过 `.git`、`node_modules`、明显的密钥/凭据/临时/备份文件。
- 拒绝 symlink source root、symlink `SKILL.md` 和 source root 逃逸。
- v0.1 不 prune 远端多余文件。

`bind` 会保护 agent 现有 skills。因为 `multica agent skills set` 是替换式 API，工具会执行 read -> merge -> set -> read-back verify，而不是只写入新 skill。

`sync-local` 只会写用户显式传入的 `--target` 或 `--target-dir`：

- 必须至少传一个 `--target`。
- 非空且没有 `.switchyard-multica.json` marker 的目录默认拒绝写入。
- marker 存在但 `skillName`、`sourcePath`、`target` 或 `targetDir` 不匹配时默认拒绝写入。
- `--force` 可以接管不匹配或非空未管理目录，但不会跳过备份或 hash verify。
- 写入前会备份已有目标目录到 `~/.switchyard-multica/backups/<timestamp>/<target>/<skillName>`。
- 写入后会做 hash verify，并更新 `.switchyard-multica.json` marker。

普通 `npm test` 和 `npm run check` 不会触碰真实 Multica workspace，也不会写真实 OpenClaw/Hermes/Codex/Claude runtime 目录。

## Local Targets

`sync-local --target` 支持这些默认目标：

| target | inferred path |
| --- | --- |
| `openclaw` | `~/.openclaw/skills/<skillName>` |
| `hermes` | `~/.hermes/skills/<skillName>` |
| `codex` | `${CODEX_HOME:-~/.codex}/skills/<skillName>` |
| `claude` | `~/.claude/skills/<skillName>` |

这些是基于本机惯例推断的路径，只代表文件同步目标，不保证对应 runtime 一定会加载该目录。不同安装方式可能有不同 skill 路径；用 `--target-dir target=/absolute/path` 可以覆盖默认路径。

## Verify Behavior

`verify` 会比较本地 manifest 和远端 Multica skill，差异类型包括：

- `missing_remote`：本地有，远端没有。
- `extra_remote`：远端有，本地没有。
- `content_mismatch`：两边都有但 sha256 或 size 不一致。
- `agent_not_bound`：指定 agent 没有绑定目标 skill。

v0.1 中 `extra_remote` 也会被视为失败，因为第一版不默认 prune，不能静默忽略远端残留文件。

如果 Multica CLI 能返回远端文件内容或 hash，`verify` 使用 `content` 级校验。如果远端只能读到 `.switchyard-multica-manifest.json`，会进入 degraded `manifest-only` 校验，并在输出里标注 degraded。如果既没有远端内容也没有可读 manifest，则校验不可用并失败。

`verify --agent <name-or-id>` 会额外做只读绑定校验，可重复传入多个 agent。它会读取 `agent list` 和每个 agent 的 `agent skills list`；如果目标 skill id 不在 agent 当前 skills 里，输出 `agent_not_bound` 并失败。`verify --agent` 不会调用 `agent skills set` 或其他写命令。

## Common Issues

**Multica UI 里 agents 为空**

通常是浏览器 UI 和 `multica` CLI 当前 workspace 不一致。先运行：

```bash
switchyard-multica inspect
```

确认 CLI 看到的 workspace、agents 和 skills。

**提示 CLI capability missing**

当前 `multica` CLI 缺少该命令需要的子命令或输出能力。先用 `inspect` 看 degraded 诊断，再确认 CLI 版本、登录状态和 workspace 配置。

**verify 报 `extra_remote`**

远端 skill 里有本地 source 已经没有的文件。v0.1 不 prune，所以会报告并失败；需要人工判断是否重新发布、等待后续 `--prune` 能力，或在 Multica 侧清理。

**Hermes 和 OpenClaw 本地路径不同**

`sync-local` 的默认路径只是常见用户级目录。Multica workspace skill 注入、Hermes 本地 skill、OpenClaw 本地 skill 是不同层面的东西；本地同步成功不等于 Multica runtime 已加载。

**担心 `agent skills set` 覆盖已有 skills**

这是 `multica agent skills set` 的 API 风险。本工具的 `bind` 会先读取已有 skills，合并目标 skill，再写回完整列表，最后再读一遍确认结果。

## Testing

普通本地验证：

```bash
npm test
npm run build
npm run check
```

`npm run check` 当前等价于：

```bash
npm run build && npm test
```

集成测试会访问当前真实 Multica workspace，只能显式启用，不属于普通测试或 `npm run check`：

```bash
MULTICA_INTEGRATION=1 npm run test:integration
```

集成测试也不应该默认 prune 远端文件，不应该自动创建 agents。
