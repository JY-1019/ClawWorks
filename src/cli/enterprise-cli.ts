import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Commander registration for ClawWorks enterprise workflow management.
import { InvalidArgumentError, type Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  enterpriseRunsListCommand,
  enterpriseRunsShowCommand,
  enterpriseTreesExportCommand,
  enterpriseTreesImportCommand,
  enterpriseTreesListCommand,
  enterpriseTreesRemoveCommand,
  enterpriseTreesValidateCommand,
} from "../commands/enterprise.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

export function registerEnterpriseCli(program: Command) {
  const enterprise = program
    .command("enterprise")
    .description("Manage ClawWorks enterprise workflow trees and run traces")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/enterprise", "docs.openclaw.ai/cli/enterprise")}\n`,
    );

  const trees = enterprise.command("trees").description("Manage workflow tree definitions");
  trees
    .command("list")
    .description("List registered workflow trees (built-in and imported)")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseTreesListCommand(defaultRuntime, opts);
      });
    });
  trees
    .command("validate")
    .description("Validate a workflow tree definition file (.yaml/.yml/.json)")
    .argument("<file>", "Tree definition file")
    .action(async (file: string) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseTreesValidateCommand(file, defaultRuntime);
      });
    });
  trees
    .command("import")
    .description("Validate and import a workflow tree definition file")
    .argument("<file>", "Tree definition file")
    .action(async (file: string) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseTreesImportCommand(file, defaultRuntime);
      });
    });
  trees
    .command("export")
    .description("Export a registered workflow tree definition")
    .argument("<treeId>", "Tree id (see enterprise trees list)")
    .option("--out <file>", "Write to a file instead of stdout")
    .option("--format <format>", "Output format: yaml or json")
    .action(async (treeId: string, opts: { out?: string; format?: string }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseTreesExportCommand(treeId, defaultRuntime, opts);
      });
    });
  trees
    .command("remove")
    .description("Remove an imported workflow tree (built-ins reappear)")
    .argument("<treeId>", "Tree id")
    .action(async (treeId: string) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseTreesRemoveCommand(treeId, defaultRuntime);
      });
    });
  applyParentDefaultHelpAction(trees);

  const runs = enterprise.command("runs").description("Inspect enterprise run traces");
  runs
    .command("list")
    .description("List recent enterprise run executions")
    .option("--limit <n>", "Maximum executions to list", (value) => {
      const parsed = parseStrictPositiveInteger(value);
      if (parsed === undefined) {
        throw new InvalidArgumentError("--limit must be a positive integer.");
      }
      return parsed;
    })
    .option("--json", "Output JSON")
    .action(async (opts: { limit?: number; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseRunsListCommand(defaultRuntime, opts);
      });
    });
  runs
    .command("show")
    .description("Show the latest execution trace for a runId")
    .argument("<runId>", "Run id (see enterprise runs list)")
    .option("--json", "Output JSON")
    .action(async (runId: string, opts: { json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseRunsShowCommand(runId, defaultRuntime, opts);
      });
    });
  applyParentDefaultHelpAction(runs);

  applyParentDefaultHelpAction(enterprise);
}
