import { describe, expect, spyOn, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

describe("session.processor", () => {
  test("removes reasoningEncryptedContent from debug payloads", () => {
    expect(
      SessionProcessor.cleanDebug({
        metadata: {
          opencode: {
            itemId: "x",
            reasoningEncryptedContent: "secret",
          },
        },
        items: [
          {
            reasoningEncryptedContent: "secret-2",
            ok: true,
          },
        ],
      }),
    ).toEqual({
      metadata: {
        opencode: {
          itemId: "x",
        },
      },
      items: [
        {
          ok: true,
        },
      ],
    })
  })

  test("renders debug snapshot as decision and performance summary", () => {
    const sessionID = SessionID.make("ses-debug-summary")
    const userID = MessageID.make("msg-user-debug-summary")
    const assistantID = MessageID.make("msg-assistant-debug-summary")
    const file = "/tmp/ses-debug-summary.md"
    const out = SessionProcessor.renderDebug(
      [
        {
          info: {
            id: userID,
            sessionID,
            role: "user",
            time: { created: 1 },
            summary: { diffs: [] },
            agent: "build",
            model: {
              providerID: model.providerID,
              modelID: model.id,
            },
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: userID,
              sessionID,
              type: "text",
              text: "删除对话调试 log 噪音",
            },
          ],
        },
        {
          info: {
            id: assistantID,
            sessionID,
            role: "assistant",
            parentID: userID,
            providerID: model.providerID,
            modelID: model.id,
            mode: "build_planner",
            agent: "build_planner",
            path: {
              cwd: "/tmp",
              root: "/tmp",
            },
            cost: 0.25,
            tokens: {
              total: 321,
              input: 123,
              output: 45,
              reasoning: 153,
              cache: {
                read: 7,
                write: 8,
              },
            },
            finish: "stop",
            time: {
              created: 10,
              completed: 35,
            },
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: assistantID,
              sessionID,
              type: "debug",
              request: {
                meta: {
                  agent: "build_planner",
                  mode: "primary",
                  providerID: model.providerID,
                  modelID: model.id,
                  userID,
                  tools: ["read", "grep"],
                  toolChoice: "auto",
                  file,
                  source: "stage",
                  stage: "planner",
                  step: 1,
                },
                system: ["SECRET_SYSTEM_PROMPT"],
                instructions: "SECRET_INSTRUCTIONS",
                messages: [{ role: "user", content: "SECRET_MESSAGES" }],
                conversation: [{ info: { id: userID }, parts: ["SECRET_CONVERSATION"] }],
              },
            },
            {
              id: PartID.ascending(),
              messageID: assistantID,
              sessionID,
              type: "text",
              ignored: true,
              text: '{"current_step":"inspect logs","selected_tools":["read","grep"]}',
            },
          ],
        },
      ],
      file,
    )

    expect(out).toContain("## Decision")
    expect(out).toContain('"current_step": "inspect logs"')
    expect(out).toContain("- Duration: 25ms")
    expect(out).toContain("- Tokens: input 123, output 45, reasoning 153, total 321, cache r7/w8")
    expect(out).toContain("- System prompts: 1")
    expect(out).toContain("- Messages: 1")
    expect(out).toContain("- Conversation: 1")
    expect(out).not.toContain("SECRET_SYSTEM_PROMPT")
    expect(out).not.toContain("SECRET_INSTRUCTIONS")
    expect(out).not.toContain("SECRET_MESSAGES")
    expect(out).not.toContain("SECRET_CONVERSATION")
  })

  test("marks empty executor streams as errors", async () => {
    const spy = spyOn(LLM, "stream").mockResolvedValue({
      fullStream: (async function* () {})(),
      request: {},
      response: {},
    } as unknown as Awaited<ReturnType<typeof LLM.stream>>)

    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const now = Date.now()
          const user = (await Session.updateMessage({
            id: MessageID.make("msg-user-empty-stream"),
            sessionID: session.id,
            role: "user",
            time: { created: now },
            agent: "build",
            model: {
              providerID: model.providerID,
              modelID: model.id,
            },
          })) as MessageV2.User
          const assistant = (await Session.updateMessage({
            id: MessageID.make("msg-assistant-empty-stream"),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            providerID: model.providerID,
            modelID: model.id,
            mode: "build",
            agent: "build_executor",
            path: {
              cwd: tmp.path,
              root: tmp.path,
            },
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
            time: {
              created: now,
            },
          })) as MessageV2.Assistant
          const abort = new AbortController()
          const processor = SessionProcessor.create({
            assistantMessage: assistant,
            model,
            abort: abort.signal,
            sessionID: session.id,
          })
          const agent = {
            name: "build_executor",
            mode: "primary",
            options: {},
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          } satisfies Agent.Info

          const result = await processor.process({
            sessionID: SessionID.make(session.id),
            user,
            model,
            agent,
            abort: abort.signal,
            system: [],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            debug: {
              stage: "executor",
            },
          })

          expect(result).toBe("stop")

          const stored = await MessageV2.get({
            sessionID: session.id,
            messageID: assistant.id,
          })

          if (stored.info.role !== "assistant") {
            throw new Error("expected assistant message")
          }

          expect(stored.info.error?.name).toBe("UnknownError")
          expect(stored.info.error?.data.message).toContain(
            "Executor stream ended before producing any output or tool calls.",
          )
          expect(stored.info.time.completed).toBeNumber()

          await Session.remove(session.id)
        },
      })
    } finally {
      spy.mockRestore()
    }
  })
})
