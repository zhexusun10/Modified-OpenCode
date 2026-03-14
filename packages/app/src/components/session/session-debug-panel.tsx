import { createMemo, For, Show } from "solid-js"
import { Accordion } from "@opencode-ai/ui/accordion"
import { File } from "@opencode-ai/ui/file"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { checksum } from "@opencode-ai/util/encode"
import type { AssistantMessage, Message, Part, UserMessage } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"

function Stat(props: { label: string; value: string }) {
  return (
    <div class="flex flex-col gap-1 rounded-md border border-border-weak-base bg-background-base px-3 py-2">
      <div class="text-11-medium uppercase tracking-[0.04em] text-text-weaker">{props.label}</div>
      <div class="text-12-medium text-text-strong break-all">{props.value}</div>
    </div>
  )
}

function requestText(part: Extract<Part, { type: "debug" }>) {
  return JSON.stringify(part.request, null, 2)
}

function RequestBody(props: { part: Extract<Part, { type: "debug" }> }) {
  const body = createMemo(() => {
    const contents = requestText(props.part)
    return {
      name: `${props.part.messageID}-provider-request.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return <File mode="text" file={body()} overflow="wrap" class="select-text" />
}

const tokens = (msg: AssistantMessage) =>
  msg.tokens.total ?? msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write

const estimate = (value?: string) => (value ? Math.ceil(value.length / 4) : 0)
const requestTokens = (part?: Extract<Part, { type: "debug" }>) =>
  estimate([part?.request.system.join("\n\n"), part?.request.instructions].filter(Boolean).join("\n\n"))

const snippet = (msg: UserMessage | undefined, parts: Record<string, Part[] | undefined>) => {
  if (!msg) return ""
  const value = (parts[msg.id] ?? [])
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
  if (!value) return msg.id
  if (value.length <= 80) return value
  return value.slice(0, 80) + "..."
}

export function SessionDebugPanel() {
  const sync = useSync()
  const language = useLanguage()
  const { params } = useSessionLayout()

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []) as Message[])
  const parts = createMemo(() => sync.data.part as Record<string, Part[] | undefined>)
  const fmt = createMemo(
    () =>
      new Intl.DateTimeFormat(language.intl(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
  )

  const turns = createMemo(() => {
    const byID = new Map(messages().map((msg) => [msg.id, msg] as const))
    return messages()
      .filter((msg): msg is AssistantMessage => msg.role === "assistant")
      .map((assistant) => {
        const part = (parts()[assistant.id] ?? []).find(
          (item): item is Extract<Part, { type: "debug" }> => item.type === "debug",
        )
        const user = byID.get(assistant.parentID)
        return {
          assistant,
          part,
          user: user?.role === "user" ? user : undefined,
        }
      })
      .filter((item) => item.part || tokens(item.assistant) > 0)
  })

  return (
    <ScrollView class="h-full">
      <div class="p-3">
        <Show
          when={turns().length > 0}
          fallback={<div class="pt-8 text-center text-12-regular text-text-weak">{language.t("session.debug.empty")}</div>}
        >
          <Accordion multiple collapsible class="flex flex-col gap-3">
            <For each={turns()}>
              {(turn) => (
                <Accordion.Item value={turn.assistant.id} class="overflow-hidden rounded-lg border border-border-weak-base">
                  <StickyAccordionHeader>
                    <Accordion.Trigger class="bg-background-stronger">
                      <div class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left">
                        <div class="min-w-0">
                          <div class="truncate text-12-medium text-text-strong">{snippet(turn.user, parts())}</div>
                          <div class="mt-0.5 text-11-regular text-text-weaker">{turn.assistant.id}</div>
                        </div>
                        <div class="shrink-0 text-11-regular text-text-weaker">
                          {fmt().format(new Date(turn.assistant.time.created))}
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content class="bg-background-base">
                    <div class="flex flex-col gap-3 p-3">
                      <div class="grid grid-cols-2 gap-2">
                        <Stat label={language.t("session.debug.provider")} value={turn.assistant.providerID} />
                        <Stat label={language.t("session.debug.model")} value={turn.assistant.modelID} />
                        <Stat
                          label={language.t("session.debug.system")}
                          value={`${requestTokens(turn.part)} ${language.t("session.debug.tokensUnit")}`}
                        />
                        <Stat
                          label={language.t("session.debug.total")}
                          value={`${tokens(turn.assistant).toLocaleString(language.intl())} ${language.t("session.debug.tokensUnit")}`}
                        />
                        <Stat
                          label={language.t("session.debug.input")}
                          value={`${turn.assistant.tokens.input.toLocaleString(language.intl())} ${language.t(
                            "session.debug.tokensUnit",
                          )}`}
                        />
                        <Stat
                          label={language.t("session.debug.output")}
                          value={`${turn.assistant.tokens.output.toLocaleString(language.intl())} ${language.t(
                            "session.debug.tokensUnit",
                          )}`}
                        />
                        <Stat
                          label={language.t("session.debug.reasoning")}
                          value={`${turn.assistant.tokens.reasoning.toLocaleString(language.intl())} ${language.t(
                            "session.debug.tokensUnit",
                          )}`}
                        />
                        <Stat
                          label={language.t("session.debug.cache")}
                          value={`${turn.assistant.tokens.cache.read.toLocaleString(language.intl())} / ${turn.assistant.tokens.cache.write.toLocaleString(language.intl())}`}
                        />
                      </div>

                      <div class="flex flex-col gap-2">
                        <div class="text-12-medium text-text-strong">{language.t("session.debug.request")}</div>
                        <Show
                          when={turn.part}
                          fallback={
                            <div class="rounded-md border border-border-weak-base bg-background-stronger px-3 py-2 text-12-regular text-text-weak">
                              {language.t("session.debug.requestUnavailable")}
                            </div>
                          }
                        >
                          {(part) => (
                            <div class="rounded-md border border-border-weak-base bg-background-stronger p-1">
                              <RequestBody part={part()} />
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                  </Accordion.Content>
                </Accordion.Item>
              )}
            </For>
          </Accordion>
        </Show>
      </div>
    </ScrollView>
  )
}
