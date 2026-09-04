// Acme order tracker — the MCP server the ClawWorks enterprise tutorial governs.
//
// It exists so the tutorial's `returns.lookup` step has a real MCP surface to
// attach: two read-only tools over an in-memory order book, no external service,
// no credentials. Substitute any other MCP server once you know the shape.
//
// Streamable HTTP, stateless: every POST builds its own server + transport, which
// is the SDK's documented pattern for a server that keeps no session state. The
// tutorial registers it as `transport: "streamable-http"`, the spelling both the
// embedded runtime and Codex dial the same way.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 9700);
const MCP_PATH = "/mcp";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dates are offsets from "now", not literals: a tutorial pinned to fixed dates
 * would answer "delivered 8 months ago" a year from now and quietly break the
 * refund-window question it exists to demonstrate.
 */
const ORDERS = {
  1043: {
    customer: "Dana Whitfield",
    status: "delivered",
    placedDaysAgo: 11,
    deliveredDaysAgo: 6,
    total: 129.0,
    currency: "USD",
    items: [{ sku: "AC-GRINDER-01", name: "Acme burr grinder", quantity: 1, price: 129.0 }],
    carrier: "Northwind Post",
    tracking: "NW7781204553",
  },
  1044: {
    customer: "Priya Raman",
    status: "in_transit",
    placedDaysAgo: 4,
    shippedDaysAgo: 3,
    total: 45.5,
    currency: "USD",
    items: [{ sku: "AC-FILTER-06", name: "Filter papers (200)", quantity: 2, price: 22.75 }],
    carrier: "Northwind Post",
    tracking: "NW7781209911",
  },
  1051: {
    customer: "Marc Oliveira",
    status: "delivered",
    placedDaysAgo: 101,
    deliveredDaysAgo: 96,
    total: 310.0,
    currency: "USD",
    items: [{ sku: "AC-ESPRESSO-11", name: "Acme espresso machine", quantity: 1, price: 310.0 }],
    carrier: "Cormorant Freight",
    tracking: "CF44120388",
  },
};

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function orderRecord(orderId) {
  const order = ORDERS[orderId];
  if (!order) {
    return null;
  }
  return {
    orderId,
    customer: order.customer,
    status: order.status,
    placedAt: isoDaysAgo(order.placedDaysAgo),
    ...(order.deliveredDaysAgo === undefined
      ? {}
      : {
          deliveredAt: isoDaysAgo(order.deliveredDaysAgo),
          daysSinceDelivery: order.deliveredDaysAgo,
        }),
    total: order.total,
    currency: order.currency,
    items: order.items,
  };
}

function shipmentRecord(orderId) {
  const order = ORDERS[orderId];
  if (!order) {
    return null;
  }
  const shippedDaysAgo = order.shippedDaysAgo ?? order.deliveredDaysAgo + 2;
  const checkpoints = [
    { at: isoDaysAgo(shippedDaysAgo), location: "Acme fulfilment, Leeds", event: "Picked up" },
    {
      at: isoDaysAgo(shippedDaysAgo - 1),
      location: "Northwind hub, Manchester",
      event: "In transit",
    },
  ];
  if (order.deliveredDaysAgo !== undefined) {
    checkpoints.push({
      at: isoDaysAgo(order.deliveredDaysAgo),
      location: "Delivery address",
      event: "Delivered, signed for",
    });
  }
  return {
    orderId,
    carrier: order.carrier,
    trackingNumber: order.tracking,
    status: order.status,
    checkpoints,
  };
}

/** MCP results travel as text; the JSON body is what the model reads. */
function jsonResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function notFound(orderId) {
  return jsonResult({
    error: "order_not_found",
    orderId,
    knownOrderIds: Object.keys(ORDERS),
  });
}

function buildMcpServer() {
  const server = new McpServer(
    { name: "acme-tracker", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "order_status",
    {
      title: "Order status",
      description:
        "Look up one Acme order: its status, when it was placed and delivered, the line items, and the order total.",
      inputSchema: { orderId: z.string().describe("Acme order id, for example 1043") },
    },
    async ({ orderId }) => {
      const record = orderRecord(orderId.trim());
      return record ? jsonResult(record) : notFound(orderId);
    },
  );

  server.registerTool(
    "shipment_track",
    {
      title: "Shipment tracking",
      description: "Carrier, tracking number, and the scan history for one Acme order's shipment.",
      inputSchema: { orderId: z.string().describe("Acme order id, for example 1044") },
    },
    async ({ orderId }) => {
      const record = shipmentRecord(orderId.trim());
      return record ? jsonResult(record) : notFound(orderId);
    },
  );

  return server;
}

const http = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, orders: Object.keys(ORDERS).length }));
    return;
  }

  if (path !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no route at ${path}; MCP is served at ${MCP_PATH}` }));
    return;
  }

  void (async () => {
    // One server + transport per request. In stateless mode nothing is carried
    // between calls, so sharing them across concurrent requests would let two
    // callers collide on the same request ids.
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[acme-tracker] request failed:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      }
    }
  })();
});

http.listen(PORT, "0.0.0.0", () => {
  console.log(`[acme-tracker] MCP streamable-http on http://0.0.0.0:${PORT}${MCP_PATH}`);
});
