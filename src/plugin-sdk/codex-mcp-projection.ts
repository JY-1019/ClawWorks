// Private helper surface for the bundled Codex plugin. Mirrors the Codex CLI
// runtime's user-mcp-server projection so the bundled Codex app-server harness
// can attach the same user `mcp.servers` entries to its thread config without
// deep-importing core helpers.

export {
  buildCodexUserMcpServersThreadConfigPatch,
  // The same projection's name set, so the bundle half of one thread config can
  // judge namespace collisions against the servers that will really arrive.
  resolveCodexEmittedUserMcpServerNames,
} from "../agents/cli-runner/bundle-mcp-codex.js";
