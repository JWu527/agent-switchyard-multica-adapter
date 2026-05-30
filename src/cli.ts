#!/usr/bin/env node
import { Command } from "commander";
import { runInspect } from "./commands/inspect.js";
import { runPublish } from "./commands/publish.js";
import { runVerify } from "./commands/verify.js";
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

program
  .command("publish")
  .description("Publish or update an Agent Switchyard skill in Multica")
  .option("--source <dir>", "Agent Switchyard skill source directory")
  .option("--skill-name <name>", "Skill name")
  .option("--dry-run", "Print planned writes without modifying Multica")
  .option("--json", "Output JSON")
  .action(async (options) => runPublish(runner, options));

program
  .command("verify")
  .description("Verify Multica skill content against local source")
  .option("--source <dir>", "Agent Switchyard skill source directory")
  .option("--skill-name <name>", "Skill name")
  .option("--agent <name-or-id>", "Agent binding check (implemented by the bind/resolver task)")
  .option("--json", "Output JSON")
  .action(async (options) => runVerify(runner, options));

program.parseAsync(process.argv).catch((error: unknown) => {
  const exitCode = error instanceof UserError ? error.exitCode : 1;
  console.error(formatUnknownError(error));
  process.exit(exitCode);
});
