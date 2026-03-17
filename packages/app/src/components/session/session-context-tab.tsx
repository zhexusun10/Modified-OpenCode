import { createMemo, createEffect, on, onCleanup, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { useSync } from "@/context/sync"
import { checksum } from "@opencode-ai/util/encode"
import { findLast } from "@opencode-ai/util/array"
import { same } from "@/utils/same"
import { Icon } from "@opencode-ai/ui/icon"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { File } from "@opencode-ai/ui/file"
import { Markdown } from "@opencode-ai/ui/markdown"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/pages/session/session-layout"
import { getSessionContextMetrics } from "./session-context-metrics"
import type { SessionContextMetricsContext } from "./session-context-metrics"
import { estimateSessionContextBreakdown, type SessionContextBreakdownKey } from "./session-context-breakdown"
import { createSessionContextFormatter } from "./session-context-format"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
}

function Stat(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <div class="text-12-medium text-text-strong">{props.value}</div>
    </div>
  )
}

type RawItem =
  | {
      kind: "message"
      id: string
      role: Message["role"]
      created: number
      message: Message
    }
  | {
      kind: "system"
      id: string
      role: "system"
      created: number
      system: string[]
      messageID: string
    }
  | {
      kind: "instructions"
      id: string
      role: "instructions"
      created: number
      instructions: string
      messageID: string
    }

function debug(parts: Part[]) {
  return parts.find((part): part is Extract<Part, { type: "debug" }> => part.type === "debug")
}

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (!value || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.toLowerCase().includes("encrypted"))
      .map(([key, item]) => [key, scrub(item)]),
  )
}

function RawMessageContent(props: { item: RawItem; getParts: (id: string) => Part[]; onRendered: () => void }) {
  const file = createMemo(() => {
    if (props.item.kind === "system") {
      const contents = JSON.stringify(
        {
          role: "system",
          source: "provider_request",
          messageID: props.item.messageID,
          content: props.item.system,
        },
        null,
        2,
      )
      return {
        name: `${props.item.role}-${props.item.messageID}.json`,
        contents,
        cacheKey: checksum(contents),
      }
    }

    if (props.item.kind === "instructions") {
      const contents = JSON.stringify(
        {
          role: "instructions",
          source: "provider_request",
          messageID: props.item.messageID,
          content: props.item.instructions,
        },
        null,
        2,
      )
      return {
        name: `${props.item.role}-${props.item.messageID}.json`,
        contents,
        cacheKey: checksum(contents),
      }
    }

    const parts = props.getParts(props.item.message.id)
    const contents = JSON.stringify(scrub({ message: props.item.message, parts }), null, 2)
    return {
      name: `${props.item.message.role}-${props.item.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  item: RawItem
  getParts: (id: string) => Part[]
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.item.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.item.role} <span class="text-text-base">• {props.item.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.item.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent item={props.item} getParts={props.getParts} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

function BreakdownBar(props: {
  title: string
  segments: ReturnType<typeof estimateSessionContextBreakdown>
  label: (key: SessionContextBreakdownKey) => string
  intl: string
  note: string
}) {
  return (
    <div class="flex flex-col gap-2">
      <div class="text-12-medium text-text-strong">{props.title}</div>
      <div class="h-2 w-full rounded-full bg-surface-base overflow-hidden flex">
        <For each={props.segments}>
          {(segment) => (
            <div
              class="h-full"
              style={{
                width: `${segment.width}%`,
                "background-color": BREAKDOWN_COLOR[segment.key],
              }}
            />
          )}
        </For>
      </div>
      <div class="flex flex-wrap gap-x-3 gap-y-1">
        <For each={props.segments}>
          {(segment) => (
            <div class="flex items-center gap-1 text-11-regular text-text-weak">
              <div class="size-2 rounded-sm" style={{ "background-color": BREAKDOWN_COLOR[segment.key] }} />
              <div>{props.label(segment.key)}</div>
              <div class="text-text-weaker">{segment.percent.toLocaleString(props.intl)}%</div>
            </div>
          )}
        </For>
      </div>
      <div class="hidden text-11-regular text-text-weaker">{props.note}</div>
    </div>
  )
}

function PromptBlock(props: { title: string; text: string }) {
  return (
    <div class="flex flex-col gap-2">
      <div class="text-12-medium text-text-strong">{props.title}</div>
      <div class="border border-border-base rounded-md bg-surface-base px-3 py-2">
        <Markdown text={props.text} class="text-12-regular" />
      </div>
    </div>
  )
}

const emptyMessages: Message[] = []
const emptyUserMessages: UserMessage[] = []
const emptyRawItems: RawItem[] = []

export function SessionContextTab() {
  const sync = useSync()
  const language = useLanguage()
  const { params, view } = useSessionLayout()

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const messages = createMemo(
    () => {
      const id = params.id
      if (!id) return emptyMessages
      return (sync.data.message[id] ?? []) as Message[]
    },
    emptyMessages,
    { equals: same },
  )

  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )

  const visibleUserMessages = createMemo(
    () => {
      const revert = info()?.revert?.messageID
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const metrics = createMemo(() => getSessionContextMetrics(messages(), sync.data.provider.all))
  const ctx = createMemo(() => metrics().context)
  const plan = createMemo(() => metrics().stages.plan)
  const exec = createMemo(() => metrics().stages.execute)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const cost = createMemo(() => {
    return usd().format(metrics().totalCost)
  })

  const counts = createMemo(() => {
    const all = messages()
    const user = all.reduce((count, x) => count + (x.role === "user" ? 1 : 0), 0)
    const assistant = all.reduce((count, x) => count + (x.role === "assistant" ? 1 : 0), 0)
    return {
      all: all.length,
      user,
      assistant,
    }
  })

  const getParts = (id: string) => (sync.data.part[id] ?? []) as Part[]

  const promptFor = (id?: string) => {
    if (id) {
      const req = debug(getParts(id))?.request
      const system = req?.system.join("\n\n").trim()
      const instructions = req?.instructions?.trim()
      const text = [system ? "## System\n\n" + system : "", instructions ? "## Instructions\n\n" + instructions : ""]
        .filter(Boolean)
        .join("\n\n")
      if (text) return text
    }
    const msg = findLast(visibleUserMessages(), (m) => !!m.system)
    const system = msg?.system
    if (!system) return
    const trimmed = system.trim()
    if (!trimmed) return
    return trimmed
  }

  const systemPrompt = createMemo(() => {
    const part = findLast(messages(), (message) => {
      if (message.role !== "assistant") return false
      const req = debug(getParts(message.id))?.request
      return !!req?.system.length || !!req?.instructions?.trim()
    })
    return promptFor(part?.id)
  })
  const planPrompt = createMemo(() => promptFor(plan()?.message.id))
  const execPrompt = createMemo(() => promptFor(exec()?.message.id))

  const providerLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.providerLabel
  })

  const modelLabel = createMemo(() => {
    const c = ctx()
    if (!c) return "—"
    return c.modelLabel
  })

  const pair = (fmt: (value: SessionContextMetricsContext) => string) => {
    const p = plan()
    const e = exec()
    return `Plan ${p ? fmt(p) : "—"} / Execute ${e ? fmt(e) : "—"}`
  }

  const breakdown = (value: SessionContextMetricsContext | undefined) => {
    if (!value?.input) return []
    return estimateSessionContextBreakdown({
      messages: messages().filter((message) => message.id <= value.message.id),
      parts: sync.data.part as Record<string, Part[] | undefined>,
      input: value.input,
      systemPrompt: promptFor(value.message.id),
      messageID: value.message.id,
    })
  }

  const planBreakdown = createMemo(
    on(
      () => [plan()?.message.id, plan()?.input, messages().length],
      () => breakdown(plan()),
    ),
  )

  const execBreakdown = createMemo(
    on(
      () => [exec()?.message.id, exec()?.input, messages().length],
      () => breakdown(exec()),
    ),
  )

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    return language.t("context.breakdown.other")
  }

  const stats = [
    { label: "context.stats.session", value: () => info()?.title ?? params.id ?? "—" },
    { label: "context.stats.messages", value: () => counts().all.toLocaleString(language.intl()) },
    { label: "context.stats.provider", value: providerLabel },
    { label: "context.stats.model", value: modelLabel },
    { label: "context.stats.limit", value: () => formatter().number(ctx()?.limit) },
    { label: "context.stats.totalTokens", value: () => pair((value) => formatter().number(value.total)) },
    { label: "context.stats.usage", value: () => pair((value) => formatter().percent(value.usage)) },
    { label: "context.stats.inputTokens", value: () => pair((value) => formatter().number(value.input)) },
    { label: "context.stats.outputTokens", value: () => pair((value) => formatter().number(value.output)) },
    { label: "context.stats.reasoningTokens", value: () => pair((value) => formatter().number(value.reasoning)) },
    {
      label: "context.stats.cacheTokens",
      value: () => pair((value) => `${formatter().number(value.cacheRead)} / ${formatter().number(value.cacheWrite)}`),
    },
    { label: "context.stats.userMessages", value: () => counts().user.toLocaleString(language.intl()) },
    { label: "context.stats.assistantMessages", value: () => counts().assistant.toLocaleString(language.intl()) },
    { label: "context.stats.totalCost", value: cost },
    { label: "context.stats.sessionCreated", value: () => formatter().time(info()?.time.created) },
    { label: "context.stats.lastActivity", value: () => formatter().time(ctx()?.message.time.created) },
  ] satisfies { label: string; value: () => JSX.Element }[]

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined
  let lock = false
  const raw = createMemo(
    () =>
      messages().flatMap((message) => {
        const item: RawItem = {
          kind: "message",
          id: message.id,
          role: message.role,
          created: message.time.created,
          message,
        }
        if (message.role !== "assistant") return [item]

        const part = debug(getParts(message.id))
        const system = part?.request.system.filter(Boolean)
        const instructions = part?.request.instructions?.trim()
        if (!system?.length && !instructions) return [item]

        return [
          ...(system?.length
            ? [
                {
                  kind: "system" as const,
                  id: `${message.id}:system`,
                  role: "system" as const,
                  created: message.time.created,
                  system,
                  messageID: message.id,
                },
              ]
            : []),
          ...(instructions
            ? [
                {
                  kind: "instructions" as const,
                  id: `${message.id}:instructions`,
                  role: "instructions" as const,
                  created: message.time.created,
                  instructions,
                  messageID: message.id,
                },
              ]
            : []),
          item,
        ] satisfies RawItem[]
      }),
    emptyRawItems,
    { equals: same },
  )

  const restoreScroll = () => {
    if (lock) return
    const el = scroll
    if (!el) return

    const s = view().scroll("context")
    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y
    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    const el = event.currentTarget
    const bottom = el.scrollHeight - (el.scrollTop + el.clientHeight)
    lock = bottom > 16
    pending = {
      x: el.scrollLeft,
      y: el.scrollTop,
    }
    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined
      if (!next) return

      view().setScroll("context", next)
    })
  }

  createEffect(
    on(
      () => messages().length,
      () => {
        requestAnimationFrame(restoreScroll)
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full pb-10"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div class="px-6 pt-4 flex flex-col gap-10">
        <div class="grid grid-cols-1 @[32rem]:grid-cols-2 gap-4">
          <For each={stats}>
            {(stat) => <Stat label={language.t(stat.label as Parameters<typeof language.t>[0])} value={stat.value()} />}
          </For>
        </div>

        <Show when={planBreakdown().length > 0 || execBreakdown().length > 0}>
          <div class="flex flex-col gap-4">
            <div class="text-12-regular text-text-weak">{language.t("context.breakdown.title")}</div>
            <Show when={planBreakdown().length > 0}>
              <BreakdownBar
                title="Plan"
                segments={planBreakdown()}
                label={breakdownLabel}
                intl={language.intl()}
                note={language.t("context.breakdown.note")}
              />
            </Show>
            <Show when={execBreakdown().length > 0}>
              <BreakdownBar
                title="Execute"
                segments={execBreakdown()}
                label={breakdownLabel}
                intl={language.intl()}
                note={language.t("context.breakdown.note")}
              />
            </Show>
          </div>
        </Show>

        <div class="flex flex-col gap-2">
          <div class="text-12-regular text-text-weak">{language.t("context.rawMessages.title")}</div>
          <Accordion multiple>
            <For each={raw()}>
              {(item) => <RawMessage item={item} getParts={getParts} onRendered={restoreScroll} time={formatter().time} />}
            </For>
          </Accordion>
        </div>
      </div>
    </ScrollView>
  )
}
