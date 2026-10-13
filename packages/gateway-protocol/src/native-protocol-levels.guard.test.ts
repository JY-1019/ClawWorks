// Gateway Protocol tests cover native protocol levels.guard behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./version.js";

/**
 * Cross-language guard for Gateway protocol version constants.
 *
 * Native Swift/Kotlin clients and dev smoke scripts cannot derive these values
 * from TypeScript at runtime, so this test keeps checked-in generated constants
 * and connect payloads aligned with the package source of truth.
 */

/** Min/max protocol pair expected in every native client surface. */
type ProtocolLevels = {
  min: number;
  max: number;
};

const expectedLevels: ProtocolLevels = {
  min: MIN_CLIENT_PROTOCOL_VERSION,
  max: PROTOCOL_VERSION,
};

/** Reads a repo-relative source file used by a native protocol guard. */
async function readRepoFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

/** Extracts one integer constant and reports the owning file on drift. */
function extractInteger(
  content: string,
  pattern: RegExp,
  relativePath: string,
  label: string,
): number {
  const match = pattern.exec(content);
  if (!match) {
    throw new Error(
      `${relativePath}: missing ${label}; keep native Gateway protocol levels in sync with packages/gateway-protocol/src/version.ts.`,
    );
  }
  return Number.parseInt(match[1], 10);
}

/** Compares native min/max values to the TypeScript version constants. */
function assertLevelsMatch(relativePath: string, actual: ProtocolLevels): void {
  if (actual.min === expectedLevels.min && actual.max === expectedLevels.max) {
    return;
  }
  throw new Error(
    `${relativePath}: Gateway protocol level mismatch: expected min=${expectedLevels.min} max=${expectedLevels.max} from packages/gateway-protocol/src/version.ts, got min=${actual.min} max=${actual.max}. Update the native constants/generated artifacts before shipping.`,
  );
}

/** Asserts a compatibility pattern exists in generated/native source text. */
function assertPattern(
  content: string,
  relativePath: string,
  pattern: RegExp,
  message: string,
): void {
  if (pattern.test(content)) {
    return;
  }
  throw new Error(`${relativePath}: ${message}`);
}

function extractSwiftDeclaration(
  content: string,
  relativePath: string,
  kind: "enum" | "struct",
  name: string,
): string {
  const declaration = `public ${kind} ${name}:`;
  const start = content.indexOf(declaration);
  if (start < 0) {
    throw new Error(`${relativePath}: missing Swift ${kind} for ${name}.`);
  }
  const end = content.indexOf("\n}\n", start);
  if (end < 0) {
    throw new Error(`${relativePath}: unterminated Swift ${kind} for ${name}.`);
  }
  return content.slice(start, end);
}

function stringLiteralUnionValues(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }
  const candidate = schema as { anyOf?: unknown; oneOf?: unknown };
  const branches = candidate.oneOf ?? candidate.anyOf;
  if (!Array.isArray(branches) || branches.length < 2) {
    return undefined;
  }

  const values: string[] = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== "object" || !("const" in branch)) {
      return undefined;
    }
    const value = branch.const;
    if (typeof value !== "string") {
      return undefined;
    }
    values.push(value);
  }
  return new Set(values).size === values.length ? values : undefined;
}

describe("native Gateway protocol levels", () => {
  it("match the TypeScript source of truth", async () => {
    if (MIN_CLIENT_PROTOCOL_VERSION > PROTOCOL_VERSION) {
      throw new Error(
        `packages/gateway-protocol/src/version.ts: MIN_CLIENT_PROTOCOL_VERSION (${MIN_CLIENT_PROTOCOL_VERSION}) must not exceed PROTOCOL_VERSION (${PROTOCOL_VERSION}).`,
      );
    }

    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);
    assertLevelsMatch(swiftGeneratedPath, {
      min: extractInteger(
        swiftGenerated,
        /public let GATEWAY_MIN_PROTOCOL_VERSION = (\d+)/,
        swiftGeneratedPath,
        "GATEWAY_MIN_PROTOCOL_VERSION",
      ),
      max: extractInteger(
        swiftGenerated,
        /public let GATEWAY_PROTOCOL_VERSION = (\d+)/,
        swiftGeneratedPath,
        "GATEWAY_PROTOCOL_VERSION",
      ),
    });

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt";
    const android = await readRepoFile(androidPath);
    assertLevelsMatch(androidPath, {
      min: extractInteger(
        android,
        /const val GATEWAY_MIN_PROTOCOL_VERSION = (\d+)/,
        androidPath,
        "GATEWAY_MIN_PROTOCOL_VERSION",
      ),
      max: extractInteger(
        android,
        /const val GATEWAY_PROTOCOL_VERSION = (\d+)/,
        androidPath,
        "GATEWAY_PROTOCOL_VERSION",
      ),
    });
  });

  it("uses the min constant for native connect compatibility ranges", async () => {
    const swiftConnectFiles = [
      "apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayChannel.swift",
      "apps/macos/Sources/OpenClawMacCLI/WizardCommand.swift",
    ];
    for (const relativePath of swiftConnectFiles) {
      const content = await readRepoFile(relativePath);
      assertPattern(
        content,
        relativePath,
        /"minProtocol": ProtoAnyCodable\(GATEWAY_MIN_PROTOCOL_VERSION\)/,
        "connect params must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /"maxProtocol": ProtoAnyCodable\(GATEWAY_PROTOCOL_VERSION\)/,
        "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
      );
    }

    const androidPath = "apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt";
    const android = await readRepoFile(androidPath);
    assertPattern(
      android,
      androidPath,
      /put\("minProtocol", JsonPrimitive\(GATEWAY_MIN_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_MIN_PROTOCOL_VERSION as minProtocol.",
    );
    assertPattern(
      android,
      androidPath,
      /put\("maxProtocol", JsonPrimitive\(GATEWAY_PROTOCOL_VERSION\)\)/,
      "connect params must advertise GATEWAY_PROTOCOL_VERSION as maxProtocol.",
    );
  });

  it("uses the TypeScript source of truth for dev Gateway smoke scripts", async () => {
    const devScripts = ["scripts/dev/gateway-smoke.ts", "scripts/dev/ios-node-e2e.ts"];
    for (const relativePath of devScripts) {
      const content = await readRepoFile(relativePath);
      assertPattern(
        content,
        relativePath,
        /MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must import/use MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /PROTOCOL_VERSION/,
        "connect params must import/use PROTOCOL_VERSION as maxProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /minProtocol:\s*MIN_CLIENT_PROTOCOL_VERSION/,
        "connect params must advertise MIN_CLIENT_PROTOCOL_VERSION as minProtocol.",
      );
      assertPattern(
        content,
        relativePath,
        /maxProtocol:\s*PROTOCOL_VERSION/,
        "connect params must advertise PROTOCOL_VERSION as maxProtocol.",
      );
    }
  });

  it("emits named string-literal unions as Swift enums", async () => {
    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);

    for (const [name, schema] of Object.entries(ProtocolSchemas)) {
      const values = stringLiteralUnionValues(schema);
      if (!values) {
        continue;
      }

      const enumSource = extractSwiftDeclaration(swiftGenerated, swiftGeneratedPath, "enum", name);
      for (const value of values) {
        assertPattern(
          enumSource,
          swiftGeneratedPath,
          new RegExp(`= ${JSON.stringify(value)}$`, "m"),
          `${name} must include the ${JSON.stringify(value)} literal.`,
        );
      }
    }
  });

  it("emits guarded enterprise Swift models with compatible defaults", async () => {
    const swiftGeneratedPath =
      "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift";
    const swiftGenerated = await readRepoFile(swiftGeneratedPath);
    const expectations: Array<[structName: string, field: string, pattern: RegExp]> = [
      ["EnterpriseBundlesPreviewParams", "content", /public let content: String/],
      [
        "EnterpriseBundlesPreviewResult",
        "typed trees",
        /public let trees: \[EnterpriseBundlePreviewTree\]\?/,
      ],
      ["EnterpriseBundlesPreviewResult", "review token default", /reviewtoken: String\? = nil/],
      [
        "EnterpriseBundlesPreviewResult",
        "missing MCP servers",
        /public let missingmcpservers: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesPreviewResult",
        "removed foundations",
        /public let removedfoundations: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesPreviewResult",
        "replaced foundations",
        /public let replacedfoundations: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesPreviewResult",
        "shadowed foundations",
        /public let shadowedfoundations: \[String\]\?/,
      ],
      ["EnterpriseTreesImportParams", "format", /public let format: AnyCodable/],
      ["EnterpriseTreeImportError", "fingerprint default", /fingerprint: String\? = nil/],
      [
        "EnterpriseTreesListResult",
        "historyOnlyTreeIds default",
        /historyonlytreeids: \[String\]\? = nil/,
      ],
      ["EnterpriseTreesImportParams", "createOnly", /createonly: Bool\? = nil/],
      ["EnterpriseTreesImportParams", "expectedHash", /expectedhash: String\? = nil/],
      ["EnterpriseBundlesImportParams", "createOnly", /createonly: Bool\? = nil/],
      ["EnterpriseBundlesImportParams", "expectedHash", /expectedhash: String\? = nil/],
      ["EnterpriseBundlesImportParams", "review token", /public let reviewtoken: String/],
      [
        "EnterpriseBundlesImportResult",
        "typed trees",
        /public let trees: \[EnterpriseBundleTree\]\?/,
      ],
      [
        "EnterpriseBundlesImportResult",
        "missing MCP servers",
        /public let missingmcpservers: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesImportResult",
        "removed foundations",
        /public let removedfoundations: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesImportResult",
        "replaced foundations",
        /public let replacedfoundations: \[String\]\?/,
      ],
      [
        "EnterpriseBundlesImportResult",
        "shadowed foundations",
        /public let shadowedfoundations: \[String\]\?/,
      ],
      ["EnterpriseBundlesExportParams", "treeId", /public let treeid: String/],
      [
        "EnterpriseBundlesExportResult",
        "typed skipped foundations",
        /public let skippedfoundations: \[EnterpriseBundleSkippedFoundation\]\?/,
      ],
      [
        "EnterpriseTreesImportResult",
        "warnings default",
        /warnings: \[EnterpriseTreeImportIssue\]\? = nil/,
      ],
      [
        "EnterpriseTreesGetResult",
        "warnings default",
        /warnings: \[EnterpriseTreeImportIssue\]\? = nil/,
      ],
      ["EnterpriseTreesGetResult", "importError default", /importerror: String\? = nil/],
      [
        "EnterpriseTreesGetResult",
        "importErrorFingerprint default",
        /importerrorfingerprint: String\? = nil/,
      ],
      ["EnterpriseTreesRemoveParams", "expectedHash", /expectedhash: String\? = nil/],
      [
        "EnterpriseTreesRemoveParams",
        "expectedInvalidFingerprint",
        /expectedinvalidfingerprint: String\? = nil/,
      ],
      ["EnterpriseTreesRemoveResult", "reason default", /reason: String\? = nil/],
      ["EnterpriseRunDetail", "sessionId default", /sessionid: String\? = nil/],
      ["EnterpriseRunsResumeParams", "sessionId default", /sessionid: String\? = nil/],
      [
        "EnterpriseRunDetail",
        "resumeRefusalReason default",
        /resumerefusalreason: AnyCodable\? = nil/,
      ],
    ];
    for (const [structName, field, pattern] of expectations) {
      const source = extractSwiftDeclaration(
        swiftGenerated,
        swiftGeneratedPath,
        "struct",
        structName,
      );
      assertPattern(source, swiftGeneratedPath, pattern, `${structName} must expose ${field}.`);
    }
  });
});
