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
