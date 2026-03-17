import type { DebugPart, Message, Part } from "@opencode-ai/sdk/v2/client"

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10
const zero = () => ({ system: 0, user: 0, assistant: 0, tool: 0 })

const charsFromUserPart = (part: Part) => {
  if (part.type === "text") return part.text.length
  if (part.type === "file") return part.source?.text.value.length ?? 0
  if (part.type === "agent") return part.source?.value.length ?? 0
  return 0
}

const charsFromAssistantPart = (part: Part) => {
  if (part.type === "text") return { assistant: part.text.length, tool: 0 }
  if (part.type === "reasoning") return { assistant: part.text.length, tool: 0 }
  if (part.type !== "tool") return { assistant: 0, tool: 0 }

  const input = Object.keys(part.state.input).length * 16
  if (part.state.status === "pending") return { assistant: 0, tool: input + part.state.raw.length }
  if (part.state.status === "completed") return { assistant: 0, tool: input + part.state.output.length }
  if (part.state.status === "error") return { assistant: 0, tool: input + part.state.error.length }
  return { assistant: 0, tool: input }
}

const chars = (value: unknown): number => {
  if (typeof value === "string") return value.length
  if (typeof value === "number" || typeof value === "boolean") return String(value).length
  if (value === null || value === undefined) return 0
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + chars(item), 0)
  if (typeof value !== "object") return 0
  return Object.entries(value).reduce((sum, [key, item]) => sum + key.length + chars(item), 0)
}

const merge = (
  acc: { system: number; user: number; assistant: number; tool: number },
  next: { system: number; user: number; assistant: number; tool: number },
) => ({
  system: acc.system + next.system,
  user: acc.user + next.user,
  assistant: acc.assistant + next.assistant,
  tool: acc.tool + next.tool,
})

const countPart = (role: unknown, value: unknown) => {
  if (typeof role !== "string") return zero()
  if (!value || typeof value !== "object") {
    if (role === "system") return { ...zero(), system: chars(value) }
    if (role === "user") return { ...zero(), user: chars(value) }
    if (role === "assistant") return { ...zero(), assistant: chars(value) }
    if (role === "tool") return { ...zero(), tool: chars(value) }
    return zero()
  }

  const item = value as Record<string, unknown>
  const type = typeof item.type === "string" ? item.type : undefined
  if (role === "tool") return { ...zero(), tool: chars(item) }
  if (role === "user") return { ...zero(), user: chars(item) }
  if (role === "system") return { ...zero(), system: chars(item) }
  if (role !== "assistant") return zero()
  if (type === "tool-call") return { ...zero(), tool: chars(item) }
  return { ...zero(), assistant: chars(item) }
}

const countMsg = (value: unknown) => {
  if (!value || typeof value !== "object") return zero()
  const msg = value as { role?: unknown; content?: unknown }
  const role = msg.role
  const content = msg.content
  if (!Array.isArray(content)) return countPart(role, content)
  return content.reduce((acc, item) => merge(acc, countPart(role, item)), zero())
}

const debug = (parts: Part[] | undefined): DebugPart | undefined =>
  parts?.find((part): part is DebugPart => part.type === "debug")

const build = (
  tokens: { system: number; user: number; assistant: number; tool: number; other: number },
  input: number,
) => {
  return [
    {
      key: "system",
      tokens: tokens.system,
    },
    {
      key: "user",
      tokens: tokens.user,
    },
    {
      key: "assistant",
      tokens: tokens.assistant,
    },
    {
      key: "tool",
      tokens: tokens.tool,
    },
    {
      key: "other",
      tokens: tokens.other,
    },
  ]
    .filter((x) => x.tokens > 0)
    .map((x) => ({
      key: x.key,
      tokens: x.tokens,
      width: toPercent(x.tokens, input),
      percent: toPercentLabel(x.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  input: number
  systemPrompt?: string
  messageID?: string
}) {
  if (!args.input) return []

  const req = args.messageID ? debug(args.parts[args.messageID])?.request : undefined
  if (req) {
    const counts = req.messages.reduce((acc, msg) => merge(acc, countMsg(msg)), {
      system: req.system.reduce((sum, item) => sum + item.length, 0) + (req.instructions?.length ?? 0),
      user: 0,
      assistant: 0,
      tool: 0,
    })
    const tokens = {
      system: estimateTokens(counts.system),
      user: estimateTokens(counts.user),
      assistant: estimateTokens(counts.assistant),
      tool: estimateTokens(counts.tool),
    }
    const total = tokens.system + tokens.user + tokens.assistant + tokens.tool
    if (total <= args.input) {
      return build({ ...tokens, other: args.input - total }, args.input)
    }

    const scale = args.input / total
    const scaled = {
      system: Math.floor(tokens.system * scale),
      user: Math.floor(tokens.user * scale),
      assistant: Math.floor(tokens.assistant * scale),
      tool: Math.floor(tokens.tool * scale),
    }
    const used = scaled.system + scaled.user + scaled.assistant + scaled.tool
    return build({ ...scaled, other: Math.max(0, args.input - used) }, args.input)
  }

  const counts = args.messages.reduce(
    (acc, msg) => {
      const parts = args.parts[msg.id] ?? []
      if (msg.role === "user") {
        const user = parts.reduce((sum, part) => sum + charsFromUserPart(part), 0)
        return { ...acc, user: acc.user + user }
      }

      if (msg.role !== "assistant") return acc
      const assistant = parts.reduce(
        (sum, part) => {
          const next = charsFromAssistantPart(part)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + assistant.assistant,
        tool: acc.tool + assistant.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      assistant: 0,
      tool: 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool

  if (estimated <= args.input) {
    return build({ ...tokens, other: args.input - estimated }, args.input)
  }

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
