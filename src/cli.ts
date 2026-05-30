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
