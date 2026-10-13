// Local stdio MCP fixtures. Separate processes model independently attached services.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const role = process.argv[2];
if (!["orders", "risk", "stock"].includes(role)) {
  throw new Error("Usage: node mcp.mjs orders|risk|stock");
}
const fixtures = JSON.parse(readFileSync(new URL("./records.json", import.meta.url), "utf8"));
const server = new McpServer({ name: `proof-${role}`, version: "1.0.0" });
server.registerTool(
  "lookup",
  {
    description: `Read fictional ${role} facts by orderId. Unknown orders return an error; never fabricate them.`,
    inputSchema: { orderId: z.string() },
  },
  async ({ orderId }) => {
    const record = Object.hasOwn(fixtures, orderId) ? fixtures[orderId][role] : undefined;
    return {
      ...(record ? {} : { isError: true }),
      content: [
        { type: "text", text: JSON.stringify(record ?? { error: "order_not_found", orderId }) },
      ],
    };
  },
);
await server.connect(new StdioServerTransport());
