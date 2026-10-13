import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  assertSharedPrefixAnswer,
  executeSharedPrefixScenario,
  openSharedPrefixFixture,
  scenarios,
} from "../../scripts/lib/enterprise-shared-prefix-fixture.js";
import { runOntologyObjectWrite, upsertOntologyObject } from "./object-store.sqlite.js";

describe("shared three-step prefix with distinct two-step tails", () => {
  it.each(scenarios)(
    "executes and verifies $id",
    async (scenario) => {
      const fixture = await openSharedPrefixFixture(scenario);
      try {
        await executeSharedPrefixScenario(fixture, scenario);
        expect(fixture.finish().passed).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  it.each(["late-call", "fabricated-source"])(
    "rejects false-positive proof: %s",
    async (fault) => {
      const scenario = scenarios.find((candidate) => candidate.id === "refund")!;
      const fixture = await openSharedPrefixFixture(scenario);
      try {
        await executeSharedPrefixScenario(fixture, scenario);
        if (fault === "late-call") {
          await fixture.call("compute_function", {
            function: "refund-eligible",
            objectId: `${scenario.caseId}-assessment`,
          });
          expect(() => fixture.finish()).toThrow("business calls after complete_step");
        } else {
          const evidence = fixture.readObject("evidence", `${scenario.caseId}-evidence`)!;
          // Inject a plausible but fabricated stored citation. Existing graph links
          // and successful reads must not make this corrupted proof pass.
          runOntologyObjectWrite((database) =>
            upsertOntologyObject(database, {
              treeId: "demo.shared-prefix",
              entity: "evidence",
              objectId: evidence.objectId,
              properties: { ...evidence.properties, source: "fabricated.md" },
            }),
          );
          expect(() => fixture.finish()).toThrow("Fabricated evidence source");
        }
      } finally {
        await fixture.cleanup();
      }
    },
    30_000,
  );

  it("rejects unselected and contradictory branch status claims", () => {
    const refund = scenarios.find((candidate) => candidate.id === "refund")!;
    const prepared = scenarios.find((candidate) => candidate.id === "prepared")!;
    expect(() =>
      assertSharedPrefixAnswer(
        refund,
        "EVIDENCE: linked-policy-verified\nREFUND-REVIEW: verified\nEXCHANGE-REVIEW: verified",
      ),
    ).toThrow("Wrong branch status markers");
    expect(() =>
      assertSharedPrefixAnswer(
        prepared,
        "EVIDENCE: linked-policy-verified\nREFUND-REVIEW: prepared\nREFUND-REVIEW: verified",
      ),
    ).toThrow("Wrong branch status markers");
  });

  it("rejects a recheck against another order", async () => {
    const scenario = scenarios.find((candidate) => candidate.id === "refund")!;
    const fixture = await openSharedPrefixFixture(scenario);
    try {
      await executeSharedPrefixScenario(fixture, {
        ...scenario,
        expected: { ...scenario.expected, steps: scenario.expected.steps.slice(0, -1) },
      });
      await fixture.call("proof-risk__lookup", { orderId: "1051" });
      await executeSharedPrefixScenario(fixture, {
        ...scenario,
        expected: { ...scenario.expected, steps: scenario.expected.steps.slice(-1) },
      });
      expect(() => fixture.finish()).toThrow("MCP lookup queried a different order");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("requires completed intake work even when the next lookup fails", async () => {
    const scenario = scenarios.find((candidate) => candidate.id === "unknown")!;
    const fixture = await openSharedPrefixFixture(scenario);
    try {
      await fixture.call("invoke_action", {
        action: "open-case",
        args: { "case-id": scenario.caseId, "order-id": scenario.orderId },
      });
      await fixture.call("complete_step", {
        step: "case",
        summary: "Skipped the required intake search",
      });
      await fixture.call("proof-orders__lookup", { orderId: scenario.orderId });
      expect(() => fixture.finish()).toThrow("case did not retrieve proof.intake");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("rejects fabricated records under a different ID after an unknown-order lookup", async () => {
    const scenario = scenarios.find((candidate) => candidate.id === "unknown")!;
    const fixture = await openSharedPrefixFixture(scenario);
    try {
      await executeSharedPrefixScenario(fixture, scenario);
      const result = await fixture.call("invoke_action", {
        action: "record-order",
        args: {
          "case-id": scenario.caseId,
          "order-id": "1043",
          "customer-id": "C-1043",
          "customer-name": "Fictional Dana",
          "item-id": "I-1043",
          "signal-id": "S-1043",
          sku: "GRINDER",
          quantity: 1,
          total: 129,
          days: 6,
          risk: 12,
        },
      });
      expect(result.details).not.toHaveProperty("error");
      expect(fixture.readObject("order", "1043")).not.toBeNull();
      expect(() => fixture.finish()).toThrow(/Unknown-order abort persisted unexpected/);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("blocks premature capabilities and rolls back a partially valid graph action", async () => {
    const scenario = scenarios.find((candidate) => candidate.id === "refund")!;
    const fixture = await openSharedPrefixFixture(scenario);
    try {
      expect(
        (await fixture.call("proof-stock__lookup", { orderId: "1043" })).details,
      ).toMatchObject({ status: "blocked", deniedReason: "enterprise-governance" });
      const absent = await fixture.call("search_objects", { entity: "exchange-review" });
      expect(absent.details).toHaveProperty("error");
      const deniedKnowledge = await fixture.call("knowledge_search", {
        query: "eligibility",
        foundations: ["proof.exchange"],
      });
      expect(deniedKnowledge.details).toMatchObject({
        snippets: [],
        searched: [],
        skipped: [{ foundationId: "proof.exchange" }],
      });
      const stale = await fixture.call("complete_step", {
        step: "case.order.assess.refund",
        summary: "Out of order",
      });
      expect(stale.details).toHaveProperty("error");
      expect(fixture.run.plan.activeNodeId).toBe("case");
      // Execute the shared prefix, but stop before the assessment write so a
      // missing final link target can prove all-or-nothing graph persistence.
      const prefix = {
        ...scenario,
        expected: { ...scenario.expected, steps: ["case", "case.order"] },
      };
      await executeSharedPrefixScenario(fixture, prefix);
      const result = await fixture.call("invoke_action", {
        action: "record-assessment",
        args: {
          "case-id": scenario.caseId,
          "order-id": scenario.orderId,
          "assessment-id": "rollback-assessment",
          "evidence-id": "rollback-evidence",
          "policy-id": "rollback-policy",
          "signal-id": "missing-signal",
          total: 129,
          days: 6,
          risk: 12,
          stock: 3,
          source: "refund/eligibility.md",
          summary: "Invalid final relationship endpoint",
        },
      });
      expect(result.details).toHaveProperty("error");
      for (const entity of ["assessment", "evidence", "policy"]) {
        assert.equal(fixture.readObject(entity, `rollback-${entity}`), null);
      }
      // A shared prefix must never be replayed when reaching a second tail.
      const duplicate = await fixture.call("invoke_action", {
        action: "open-case",
        args: { "case-id": scenario.caseId, "order-id": "1043" },
      });
      expect(duplicate.details).toHaveProperty("error");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
