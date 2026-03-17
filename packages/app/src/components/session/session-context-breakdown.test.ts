import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })

  test("uses debug request snapshot to classify user assistant and tool context", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      a1: [
        {
          type: "debug",
          request: {
            system: ["system prompt"],
            instructions: "extra instruction",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "hello" }],
              },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "done" },
                  {
                    type: "tool-call",
                    toolCallId: "call-1",
                    toolName: "bash",
                    input: {},
                  },
                ],
              },
              {
                role: "tool",
                content: [
                  {
                    type: "tool-result",
                    toolCallId: "call-1",
                    toolName: "bash",
                    output: { type: "text", value: "ok" },
                  },
                ],
              },
            ],
          },
        },
      ] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 40,
      messageID: "a1",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBeGreaterThan(0)
    expect(map.user).toBeGreaterThan(0)
    expect(map.assistant).toBeGreaterThan(0)
    expect(map.tool).toBeGreaterThan(0)
    expect(output.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(40)
  })
})
