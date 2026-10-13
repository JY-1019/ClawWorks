import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerEnterpriseCli } from "./enterprise-cli.js";

describe("enterprise CLI help", () => {
  it("warns that tree removal permanently deletes live data", () => {
    const program = new Command().name("openclaw");
    registerEnterpriseCli(program);
    const enterprise = program.commands.find((command) => command.name() === "enterprise");
    const trees = enterprise?.commands.find((command) => command.name() === "trees");
    const remove = trees?.commands.find((command) => command.name() === "remove");

    expect(remove?.description()).toContain("Permanently remove");
    expect(remove?.description()).toContain("back up state first");
  });
});
