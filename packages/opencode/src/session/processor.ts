import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import { PartID } from "./schema"
import type { SessionID, MessageID } from "./schema"
import path from "path"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  async function logTokens(input: {
    sessionID: SessionID
    model: Provider.Model
    userID: MessageID
    tokens: {
      input: number
      total?: number
    }
  }) {
    const user = await MessageV2.get({ sessionID: input.sessionID, messageID: input.userID }).catch(() => undefined)
    const text =
      user?.parts
        .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
        .map((part) => part.text)
        .join("\n")
        .trim() ?? ""

    const file = Instance.worktree + "/.opencode/token-usage.log"

    const line = JSON.stringify({
      time: new Date().toISOString(),
      sessionID: input.sessionID,
      modelID: input.model.id,
      providerID: input.model.providerID,
      systemTokens: input.tokens.input,
      totalTokens: input.tokens.total ?? input.tokens.input,
      user: text,
    })

    const prev = await Filesystem.readText(file).catch(() => "")
    await Filesystem.write(file, prev + line + "\n").catch(() => {})
  }

  function debugFile(sessionID: SessionID) {
    const root = path.resolve(import.meta.dirname, "../../../..")
    return path.join(root, "debug", `${sessionID}.md`)
  }

  function fmt(value: unknown) {
    return JSON.stringify(clean(value), null, 2)
  }

  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "reasoningEncryptedContent")
        .map(([key, item]) => [key, clean(item)]),
    )
  }

  /** @internal Exported for testing */
  export function cleanDebug(value: unknown) {
    return clean(value)
  }

  function text(title: string, value?: string) {
    if (!value?.trim()) return ""
    return [`## ${title}`, "", value.trim()].join("\n")
  }

  function json(title: string, value: unknown) {
    if (value === undefined) return ""
    return [`## ${title}`, "", "```json", fmt(value), "```"].join("\n")
  }

  function code(title: string, value?: string) {
    if (!value?.trim()) return ""
    const text = value.trim()
    try {
      return json(title, JSON.parse(text))
    } catch {
      return [`## ${title}`, "", "```", text, "```"].join("\n")
    }
  }

  function chars(value: unknown) {
    if (value === undefined) return 0
    return JSON.stringify(clean(value))?.length ?? 0
  }

  function ms(value: number | undefined) {
    if (value === undefined) return ""
    return `${value}ms`
  }

  function errmsg(error: NonNullable<MessageV2.Assistant["error"]>) {
    const msg = error.data?.message
    if (typeof msg === "string" && msg) return `${error.name}: ${msg}`
    return error.name
  }

  function tools(value: string[]) {
    if (value.length === 0) return "none"
    return value.join(", ")
  }

  function stats(msg: MessageV2.WithParts) {
    if (msg.info.role !== "assistant") return []
    const time = msg.info.time.completed ? ms(msg.info.time.completed - msg.info.time.created) : ""
    const tokens = [
      `input ${msg.info.tokens.input}`,
      `output ${msg.info.tokens.output}`,
      `reasoning ${msg.info.tokens.reasoning}`,
      typeof msg.info.tokens.total === "number" ? `total ${msg.info.tokens.total}` : "",
      `cache r${msg.info.tokens.cache.read}/w${msg.info.tokens.cache.write}`,
    ]
      .filter(Boolean)
      .join(", ")
    return [
      `- Agent: ${msg.info.agent}`,
      `- Model: ${msg.info.providerID}/${msg.info.modelID}`,
      msg.info.mode ? `- Mode: ${msg.info.mode}` : "",
      time ? `- Duration: ${time}` : "",
      msg.info.finish ? `- Finish: ${msg.info.finish}` : "",
      `- Cost: ${msg.info.cost}`,
      `- Tokens: ${tokens}`,
      msg.info.error ? `- Error: ${errmsg(msg.info.error)}` : "",
    ].filter(Boolean)
  }

  function decision(msg: MessageV2.WithParts) {
    return msg.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !!part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  function request(item: MessageV2.DebugPart["request"]) {
    return [
      `- Agent: ${item.meta.agent}`,
      `- Mode: ${item.meta.mode}`,
      item.meta.stage ? `- Stage: ${item.meta.stage}` : "",
      typeof item.meta.step === "number" ? `- Step: ${item.meta.step}` : "",
      `- Model: ${item.meta.providerID}/${item.meta.modelID}`,
      `- Tools: ${tools(item.meta.tools)}`,
      item.meta.toolChoice ? `- Tool choice: ${item.meta.toolChoice}` : "",
      item.meta.source ? `- Source: ${item.meta.source}` : "",
      `- System prompts: ${item.system.length} (${chars(item.system)} chars)`,
      item.instructions ? `- Instructions: ${chars(item.instructions)} chars` : "",
      `- Messages: ${item.messages.length} (${chars(item.messages)} chars)`,
      item.conversation ? `- Conversation: ${item.conversation.length} (${chars(item.conversation)} chars)` : "",
    ].filter(Boolean)
  }

  function role(msg: MessageV2.WithParts) {
    if (msg.info.role === "assistant") {
      const info = msg.info as MessageV2.Assistant
      return info.mode ? `assistant (${info.mode})` : "assistant"
    }
    return "user"
  }

  function summary(msg: MessageV2.WithParts) {
    const parts = msg.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.ignored)
      .map((part) => part.text.trim())
      .filter(Boolean)
    if (parts.length === 0) return ""
    return parts.join("\n\n")
  }

  function render(msgs: MessageV2.WithParts[], file: string) {
    const reqs = msgs.flatMap((msg) =>
      msg.parts
        .filter((part): part is MessageV2.DebugPart => part.type === "debug")
        .map((part) => ({
          messageID: msg.info.id,
          role: role(msg),
          request: part.request,
        })),
    )
    return [
      "# Session Debug Snapshot",
      "",
      `Path: \`${file}\``,
      "",
      `Messages: ${msgs.length}`,
      `Requests: ${reqs.length}`,
      "",
      "## Conversation",
      "",
      ...msgs.flatMap((msg) => {
        const out = [`### ${role(msg)} ${msg.info.id}`]
        const body = summary(msg)
        const plan = decision(msg)
        const meta = stats(msg)
        if (body) out.push("", body)
        if (meta.length > 0) out.push("", ...meta)
        if (plan) out.push("", code("Decision", plan))
        return [...out, ""]
      }),
      "## Requests",
      "",
      ...reqs.flatMap((item, idx) => [
        `### Request ${idx + 1} ${item.messageID}`,
        "",
        `Role: ${item.role}`,
        "",
        ...request(item.request),
        "",
      ]),
    ].join("\n")
  }

  /** @internal Exported for testing */
  export function renderDebug(msgs: MessageV2.WithParts[], file: string) {
    return render(msgs, file)
  }

  async function persist(part: MessageV2.DebugPart) {
    const file = part.request.meta.file
    if (!file) return
    const msgs = await Session.messages({ sessionID: part.sessionID }).catch(() => [])
    await Filesystem.write(file, render(msgs, file)).catch(() => {})
  }

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let dbg: MessageV2.DebugPart | undefined
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        const base = {
          meta: {
            agent: streamInput.agent.name,
            mode: streamInput.agent.mode,
            providerID: input.model.providerID,
            modelID: input.model.id,
            userID: streamInput.user.id,
            tools: Object.keys(streamInput.tools),
            toolChoice: streamInput.toolChoice,
            file: debugFile(input.sessionID),
            source: streamInput.debug?.source,
            stage: streamInput.debug?.stage,
            step: streamInput.debug?.step,
          },
          system: streamInput.system,
          messages: streamInput.messages,
          conversation: streamInput.debug?.conversation,
        }
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            dbg = (await Session.updatePart({
              id: dbg?.id ?? PartID.ascending(),
              messageID: input.assistantMessage.id,
              sessionID: input.assistantMessage.sessionID,
              type: "debug",
              request: base,
            })) as MessageV2.DebugPart
            await persist(dbg)
            const stream = (await LLM.stream({
              ...streamInput,
              onRequest: async (req) => {
                dbg = (await Session.updatePart({
                  id: dbg?.id ?? PartID.ascending(),
                  messageID: input.assistantMessage.id,
                  sessionID: input.assistantMessage.sessionID,
                  type: "debug",
                  request: {
                    ...base,
                    system: req.system,
                    instructions: req.instructions,
                    messages: req.messages,
                  },
                })) as MessageV2.DebugPart
                await persist(dbg)
              },
            })) as LLM.StreamOutput & { experimental_output?: unknown }

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  reasoningMap[value.id] = reasoningPart
                  await Session.updatePart(reasoningPart)
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      partID: part.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  await logTokens({
                    sessionID: input.sessionID,
                    model: input.model,
                    userID: input.assistantMessage.parentID,
                    tokens: {
                      input: usage.tokens.input,
                      total: usage.tokens.total,
                    },
                  })
                  log.info("tokens", {
                    sessionID: input.sessionID,
                    modelID: input.model.id,
                    providerID: input.model.providerID,
                    systemTokens: usage.tokens.input,
                    totalTokens: usage.tokens.total,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: PartID.ascending(),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: PartID.ascending(),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (
                    !input.assistantMessage.summary &&
                    (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model }))
                  ) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: PartID.ascending(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    ignored: streamInput.debug?.stage === "planner",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  await Session.updatePart(currentText)
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePartDelta({
                      sessionID: currentText.sessionID,
                      messageID: currentText.messageID,
                      partID: currentText.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
            if (streamInput.output && streamInput.onOutput) {
              await streamInput.onOutput(stream.experimental_output)
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              needsCompaction = true
              Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error,
              })
            } else {
              const retry = SessionRetry.retryable(error)
              if (retry !== undefined) {
                attempt++
                const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
                SessionStatus.set(input.sessionID, {
                  type: "retry",
                  attempt,
                  message: retry,
                  next: Date.now() + delay,
                })
                await SessionRetry.sleep(delay, input.abort).catch(() => {})
                continue
              }
              input.assistantMessage.error = error
              Bus.publish(Session.Event.Error, {
                sessionID: input.assistantMessage.sessionID,
                error: input.assistantMessage.error,
              })
              SessionStatus.set(input.sessionID, { type: "idle" })
            }
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          if (
            streamInput.debug?.stage === "executor" &&
            !input.assistantMessage.finish &&
            !input.assistantMessage.error &&
            p.every((part) => part.type === "debug")
          ) {
            input.assistantMessage.error = MessageV2.fromError(
              new Error("Executor stream ended before producing any output or tool calls."),
              { providerID: input.model.providerID },
            )
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
