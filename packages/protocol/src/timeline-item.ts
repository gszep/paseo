import { z } from "zod";
import { PluginIdSchema } from "./plugin-config.js";
import { TOOL_CALL_ICON_NAMES } from "./agent-types.js";
import type {
  AgentTimelineItem,
  ToolCallDetail,
  ToolCallTimelineItem,
  JsonValue,
} from "./agent-types.js";

// WebSocket payloads have already crossed JSON serialization. Keeping this as
// unknown avoids zod-aot's recursive z.json() object-codegen regression.
export const JsonWireValueSchema = z.unknown() as z.ZodType<JsonValue>;

const UnknownValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
]);
const NonNullUnknownSchema = z.union([
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
]);
const WorktreeSetupCommandSnapshotSchema = z.object({
  index: z.number().int().positive(),
  command: z.string(),
  cwd: z.string(),
  log: z.string().optional().default(""),
  status: z.enum(["running", "completed", "failed"]),
  exitCode: z.number().nullable(),
  durationMs: z.number().nonnegative().optional(),
});
export const WorktreeSetupDetailPayloadSchema = z.object({
  type: z.literal("worktree_setup"),
  worktreePath: z.string(),
  branchName: z.string(),
  log: z.string(),
  commands: z.array(WorktreeSetupCommandSnapshotSchema),
  truncated: z.boolean().optional(),
});
export const ToolCallDetailPayloadSchema: z.ZodType<ToolCallDetail, unknown> = z.discriminatedUnion(
  "type",
  [
    WorktreeSetupDetailPayloadSchema,
    z.object({
      type: z.literal("shell"),
      command: z.string(),
      cwd: z.string().optional(),
      output: z.string().optional(),
      exitCode: z.number().nullable().optional(),
    }),
    z.object({
      type: z.literal("read"),
      filePath: z.string(),
      content: z.string().optional(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    }),
    z.object({
      type: z.literal("edit"),
      filePath: z.string(),
      oldString: z.string().optional(),
      newString: z.string().optional(),
      unifiedDiff: z.string().optional(),
    }),
    z.object({ type: z.literal("write"), filePath: z.string(), content: z.string().optional() }),
    z.object({
      type: z.literal("search"),
      query: z.string(),
      toolName: z.enum(["search", "grep", "glob", "web_search"]).optional(),
      content: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      webResults: z.array(z.object({ title: z.string(), url: z.string() })).optional(),
      annotations: z.array(z.string()).optional(),
      numFiles: z.number().optional(),
      numMatches: z.number().optional(),
      durationMs: z.number().optional(),
      durationSeconds: z.number().optional(),
      truncated: z.boolean().optional(),
      mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    }),
    z.object({
      type: z.literal("fetch"),
      url: z.string(),
      prompt: z.string().optional(),
      result: z.string().optional(),
      code: z.number().optional(),
      codeText: z.string().optional(),
      bytes: z.number().optional(),
      durationMs: z.number().optional(),
    }),
    z.object({
      type: z.literal("sub_agent"),
      subAgentType: z.string().optional(),
      description: z.string().optional(),
      childSessionId: z.string().optional(),
      log: z.string(),
      // Compat cruft for clients <= 0.1.65-beta.3 that required this field. Producers still
      // emit `[]`; nothing reads it. Drop the field (and the `[]` emissions) once those
      // clients are no longer in the field.
      actions: z
        .array(
          z.object({
            index: z.number().int().positive(),
            toolName: z.string(),
            summary: z.string().optional(),
          }),
        )
        .optional(),
    }),
    z.object({
      type: z.literal("plain_text"),
      label: z.string().optional(),
      text: z.string().optional(),
      icon: z.enum(TOOL_CALL_ICON_NAMES).optional(),
    }),
    z.object({ type: z.literal("plan"), text: z.string() }),
    z.object({ type: z.literal("unknown"), input: UnknownValueSchema, output: UnknownValueSchema }),
  ],
);
const ToolCallBasePayloadSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  detail: ToolCallDetailPayloadSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const ToolCallTimelineItemPayloadSchema: z.ZodType<ToolCallTimelineItem, unknown> =
  z.discriminatedUnion("status", [
    ToolCallBasePayloadSchema.extend({ status: z.literal("running"), error: z.null() }),
    ToolCallBasePayloadSchema.extend({ status: z.literal("completed"), error: z.null() }),
    ToolCallBasePayloadSchema.extend({ status: z.literal("failed"), error: NonNullUnknownSchema }),
    ToolCallBasePayloadSchema.extend({ status: z.literal("canceled"), error: z.null() }),
  ]);
// zod-aot 0.20.4 miscompiles this as a nested discriminated union by omitting
// the inner tool_call branch from the generated outer dispatch.
export const AgentTimelineItemPayloadSchema: z.ZodType<AgentTimelineItem, unknown> = z.union([
  z.object({
    type: z.literal("user_message"),
    text: z.string(),
    messageId: z.string().optional(),
    clientMessageId: z.string().optional(),
  }),
  z.object({
    type: z.literal("assistant_message"),
    text: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({ type: z.literal("reasoning"), text: z.string() }),
  ToolCallTimelineItemPayloadSchema,
  z.object({
    type: z.literal("todo"),
    items: z.array(
      z.object({
        text: z.string(),
        completed: z.boolean(),
        id: z.string().optional(),
        status: z.enum(["pending", "in_progress", "completed"]).optional(),
        activeForm: z.string().optional(),
      }),
    ),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({
    type: z.literal("notification"),
    level: z.enum(["info", "warning", "error"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("compaction"),
    status: z.enum(["loading", "completed"]),
    trigger: z.enum(["auto", "manual"]).optional(),
    preTokens: z.number().optional(),
  }),
  z.object({
    type: z.literal("plugin"),
    id: z.string(),
    pluginId: PluginIdSchema,
    kind: z.string(),
    version: z.number(),
    data: JsonWireValueSchema,
  }),
]);
