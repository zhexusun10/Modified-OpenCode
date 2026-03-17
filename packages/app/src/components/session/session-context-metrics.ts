import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

export type SessionContextStage = "plan" | "execute"

export type SessionContextMetricsContext = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  usage: number | null
}

type Metrics = {
  totalCost: number
  context: SessionContextMetricsContext | undefined
  stages: Record<SessionContextStage, SessionContextMetricsContext | undefined>
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const stage = (msg: AssistantMessage): SessionContextStage | undefined => {
  if (msg.mode.endsWith("_planner")) return "plan"
  if (msg.mode.endsWith("_executor")) return "execute"
}

const lastAssistantWithTokens = (messages: Message[], name?: SessionContextStage) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    if (name && stage(msg) !== name) continue
    return msg
  }
}

const buildContext = (
  message: AssistantMessage | undefined,
  providers: Provider[],
): SessionContextMetricsContext | undefined => {
  if (!message) return
  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.providerID,
    modelLabel: model?.name ?? message.modelID,
    limit,
    input: message.tokens.input,
    output: message.tokens.output,
    reasoning: message.tokens.reasoning,
    cacheRead: message.tokens.cache.read,
    cacheWrite: message.tokens.cache.write,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  return {
    totalCost,
    context: buildContext(lastAssistantWithTokens(messages), providers),
    stages: {
      plan: buildContext(lastAssistantWithTokens(messages, "plan"), providers),
      execute: buildContext(lastAssistantWithTokens(messages, "execute"), providers),
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
