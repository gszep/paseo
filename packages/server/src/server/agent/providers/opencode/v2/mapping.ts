import type {
  AgentInfo,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import type { AgentMode, AgentModelDefinition, AgentUsage } from "../../../agent-sdk-types.js";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

export function modelsFromV2(models: ModelInfo[]): AgentModelDefinition[] {
  return models
    .filter((model) => model.enabled)
    .map((model) => ({
      provider: "opencode",
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      contextWindowMaxTokens: model.limit.context,
      metadata: {
        providerId: model.providerID,
        modelId: model.id,
        supportsAttachments: model.capabilities.input.includes("image"),
        supportsToolCall: model.capabilities.tools,
        contextWindowMaxTokens: model.limit.context,
      },
      thinkingOptions: model.variants.map((variant) => ({ id: variant.id, label: variant.id })),
    }));
}

export function modesFromV2(agents: AgentInfo[]): AgentMode[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({ id: agent.id, label: agent.name, description: agent.description }));
}

export function usageFromV2({
  session,
  history,
  models,
}: {
  session: SessionInfo;
  history: readonly SessionMessageInfo[];
  models: readonly ModelInfo[];
}): AgentUsage {
  const usage: AgentUsage = {
    inputTokens: session.tokens.input,
    outputTokens: session.tokens.output,
    cachedInputTokens: session.tokens.cache.read,
    totalCostUsd: session.cost,
  };
  // Match native contextUsage: session.tokens is cumulative spend, and a
  // completed compaction invalidates earlier measurements. An unresolved revert
  // boundary cannot establish which measurements are still in context.
  const boundary = session.revert?.messageID;
  const end = boundary ? history.findIndex((message) => message.id === boundary) : history.length;
  for (let index = end - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.type === "compaction" && message.status === "completed") break;
    if (message.type !== "assistant" || message.tokens === undefined) continue;
    const { input, output, reasoning, cache } = message.tokens;
    // Native output is visibleOutputTokens; reasoning and cache are disjoint.
    const tokens = input + output + reasoning + cache.read + cache.write;
    if (!Number.isFinite(tokens) || tokens <= 0) break;
    usage.contextWindowUsedTokens = tokens;
    const model = models.find(
      (candidate) =>
        candidate.providerID === message.model.providerID && candidate.id === message.model.id,
    );
    if (model && Number.isFinite(model.limit.context) && model.limit.context > 0)
      usage.contextWindowMaxTokens = model.limit.context;
    break;
  }
  return usage;
}
