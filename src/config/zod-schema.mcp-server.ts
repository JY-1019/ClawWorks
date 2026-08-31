// One `mcp.servers` entry, in a leaf both the config schema and the Control UI
// can import.
//
// Its own module because the Control UI's JSON import validates a pasted snippet
// against the SAME schema the config save uses — and pulling that from
// `zod-schema.ts` would drag the agent schemas, fs-safe initialization, and the
// Node built-in shims behind it into the browser's initial bundle for a screen
// most sessions never open.
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Expected http:// or https:// URL");

const McpOAuthClientMetadataUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/";
  }, "Expected https:// URL with a non-root pathname");

/** One `mcp.servers` entry. Exported so the Control UI's JSON import can refuse a
 * snippet the config save would reject, while the form is still open. */
export const McpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    cwd: z.string().optional(),
    workingDirectory: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z
      .union([z.literal("stdio"), z.literal("sse"), z.literal("streamable-http")])
      .optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    connectTimeout: z.number().finite().positive().optional(),
    connect_timeout: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    timeout: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    supports_parallel_tool_calls: z.boolean().optional(),
    auth: z.literal("oauth").optional(),
    oauth: z
      .object({
        scope: z.string().trim().min(1).optional(),
        redirectUrl: HttpUrlSchema.optional(),
        clientMetadataUrl: McpOAuthClientMetadataUrlSchema.optional(),
      })
      .strict()
      .optional(),
    sslVerify: z.boolean().optional(),
    ssl_verify: z.boolean().optional(),
    clientCert: z.string().optional(),
    client_cert: z.string().optional(),
    clientKey: z.string().optional(),
    client_key: z.string().optional(),
    toolFilter: z
      .object({
        include: z.array(z.string().trim().min(1)).min(1).optional(),
        exclude: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .strict()
      .optional(),
    codex: z
      .object({
        agents: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
          )
          .min(1)
          .optional(),
        defaultToolsApprovalMode: z.enum(["auto", "prompt", "approve"]).optional(),
        default_tools_approval_mode: z.enum(["auto", "prompt", "approve"]).optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((data, ctx) => {
    // transport "stdio" requires a non-empty command — URL-only servers must use "sse" or "streamable-http"
    if (
      data.transport === "stdio" &&
      (typeof data.command !== "string" || data.command.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"stdio" transport requires a non-empty command',
        path: ["transport"],
      });
    }
  })
  .catchall(z.unknown());
