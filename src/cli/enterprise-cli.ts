import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
// Commander registration for ClawWorks enterprise workflow management.
import { InvalidArgumentError, type Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  enterpriseBundleExportCommand,
  enterpriseBundleImportCommand,
  enterprisePolicyCompileCommand,
  enterpriseRunsListCommand,
  enterpriseRunsShowCommand,
  enterpriseTreesExportCommand,
  enterpriseTreesImportCommand,
  enterpriseTreesListCommand,
  enterpriseTreesRemoveCommand,
  enterpriseTreesValidateCommand,
} from "../commands/enterprise.js";
import { getRuntimeConfig } from "../config/io.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { resolveCommandConfigWithSecrets } from "./command-config-resolution.js";
import { getModelsCommandSecretTargetIds } from "./command-secret-targets.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

// A usable --model override is provider/model with both sides present. Strip any
// trailing @profile the resolver would peel off FIRST: "openai/@work" splits to
// model "openai/" (empty model), which selection silently replaces with the agent
// default instead of honoring the override.
function isProviderModelRef(raw: string): boolean {
  const { model } = splitTrailingAuthProfile(raw);
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1;
}

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

  const bundle = enterprise
    .command("bundle")
    .description("Export/import self-contained workflow bundles (trees + inlined knowledge)");
  bundle
    .command("export")
    .description("Export a tree and everything it references as a portable bundle")
    .argument("<treeId>", "Tree id (see enterprise trees list)")
    .option("--out <file>", "Write to a file instead of stdout")
    .option("--format <format>", "Output format: yaml or json")
    .action(async (treeId: string, opts: { out?: string; format?: string }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await enterpriseBundleExportCommand(treeId, defaultRuntime, opts);
      });
    });
  bundle
    .command("import")
    .description("Validate and import a workflow bundle file (trees + knowledge)")
    .argument("<file>", "Bundle file (.yaml/.yml/.json)")
    .action(async (file: string) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        enterpriseBundleImportCommand(file, defaultRuntime);
      });
    });
  applyParentDefaultHelpAction(bundle);

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

  const policy = enterprise
    .command("policy")
    .description("Author governance policies from plain-language intent");
  policy
    .command("compile")
    .description("Compile a plain-language governance intent into a policy for review")
    .argument(
      "<intent>",
      "Governance intent, e.g. 'require approval before the issue-refund action'",
    )
    .option("--model <ref>", "Model ref to use (provider/model); defaults to the agent's model")
    .option("--json", "Emit the raw policy JSON on stdout for scripting")
    .action(async (intent: string, opts: { model?: string; json?: boolean }) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // Reject a blank intent BEFORE resolving credentials or paying for a model
        // call: `compile "$UNSET"` must not silently draft an unrelated policy.
        if (!intent.trim()) {
          defaultRuntime.error("Provide a non-empty governance intent to compile.");
          defaultRuntime.exit(1);
          return;
        }
        // Any provided --model must be a full provider/model ref. A blank,
        // whitespace-only, or partial value (e.g. "openai/") would otherwise fall
        // through to the agent default and send the intent to a different provider
        // than the operator asked for, so reject every provided non-ref up front.
        if (opts.model !== undefined && !isProviderModelRef(opts.model)) {
          defaultRuntime.error(
            `Invalid --model "${opts.model}". Use "<provider>/<model>", e.g. openai/gpt-5.5.`,
          );
          defaultRuntime.exit(1);
          return;
        }
        // Resolve managed SecretRefs and the configured default agent the same way
        // the local model-run commands do, so provider auth and model selection work.
        const { effectiveConfig } = await resolveCommandConfigWithSecrets({
          config: getRuntimeConfig(),
          commandName: "enterprise policy compile",
          targetIds: getModelsCommandSecretTargetIds(),
          runtime: defaultRuntime,
          autoEnable: true,
        });
        await enterprisePolicyCompileCommand(intent, defaultRuntime, {
          ...opts,
          cfg: effectiveConfig,
          agentId: resolveDefaultAgentId(effectiveConfig),
        });
      });
    });
  applyParentDefaultHelpAction(policy);

  applyParentDefaultHelpAction(enterprise);
}
