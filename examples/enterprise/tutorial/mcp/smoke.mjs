// Start server.mjs first, then run: node examples/enterprise/tutorial/mcp/smoke.mjs
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "tracker-smoke", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:9700/mcp")));
  for (const name of ["order_status", "shipment_track"]) {
    for (const orderId of [
      "1043",
      "1044",
      "1051",
      "9999",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      const result = await client.callTool({ name, arguments: { orderId } });
      assert.ok(!result.isError, `${name}(${orderId}): ${JSON.stringify(result.content)}`);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.orderId, orderId);
      if (["1043", "1044", "1051"].includes(orderId)) {
        assert.equal(payload.status, orderId === "1044" ? "in_transit" : "delivered");
        if (name === "order_status") {
          assert.equal(payload.total, { 1043: 129, 1044: 45.5, 1051: 310 }[orderId]);
        } else {
          assert.ok(payload.trackingNumber);
        }
      } else {
        assert.equal(payload.error, "order_not_found");
        assert.deepEqual(payload.knownOrderIds, ["1043", "1044", "1051"]);
      }
    }
  }
  console.log("14 tracker MCP checks passed");
} finally {
  await client.close();
}
