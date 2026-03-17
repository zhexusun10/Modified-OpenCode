import { describe, expect, test } from "bun:test"
import { SystemPrompt } from "../../src/session/system"

describe("session.system planner", () => {
  test("uses tool capability title", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
    })

    expect(prompt.includes("## Tool Capabilities")).toBe(true)
    expect(prompt.includes("## Tool Capability")).toBe(false)
  })

  test("omits previous plan block when state is absent", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
    })

    expect(prompt.includes("## Previous Plan")).toBe(false)
  })

  test("includes previous plan block when state exists", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
      state: {
        completed_steps: ["a"],
        remaining_steps: ["b"],
        current_step: "c",
        selected_tools: ["glob"],
      },
    })
    const prev = prompt.split("## Previous Plan")[1]?.split("## Retry Context")[0] ?? prompt

    expect(prompt.includes("## Previous Plan")).toBe(true)
    expect(prev.includes('"completed_steps"')).toBe(true)
    expect(prev.includes('"selected_tools"')).toBe(true)
  })

  test("includes retry context block when retry state exists", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
      retry: {
        planner: "Planner_Observation: Error - bad schema",
        executor: "Executor_Observation: Error - bad path",
      },
    })

    expect(prompt.includes("## Retry Context")).toBe(true)
    expect(prompt.includes("Planner_Observation: Error - bad schema")).toBe(true)
    expect(prompt.includes("Executor_Observation: Error - bad path")).toBe(true)
  })

  test("emphasizes next-step planning and observation-first behavior", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
    })

    expect(prompt.includes("Plan only the next executable step.")).toBe(true)
    expect(prompt.includes("Prefer the smallest valid next step")).toBe(true)
    expect(prompt.includes("Do not choose edit tools first")).toBe(true)
    expect(prompt.includes("Treat successful tool results in the shared conversation history as verified evidence")).toBe(true)
  })

  test("requires exact capability names in selected_tools", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
    })

    expect(prompt.includes("matches the provided schema exactly")).toBe(true)
    expect(prompt.includes('{ "completed_steps": string[], "remaining_steps": string[], "current_step": string, "selected_tools": string[] }')).toBe(false)
    expect(prompt.includes("exact capability names")).toBe(true)
    expect(prompt.includes("Return `[]` for `selected_tools`")).toBe(true)
  })

  test("prefers recent tool results over redundant re-reads", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
    })

    expect(prompt.includes("Prefer advancing from recent tool results over re-inspecting the same work")).toBe(true)
    expect(prompt.includes("do not choose `read` only to confirm that the work happened")).toBe(true)
    expect(prompt.includes("Choose `read` after executor work only when the exact file contents are required")).toBe(true)
  })

  test("guides recovery after missing-file patch failures", () => {
    const prompt = SystemPrompt.planner({
      capabilities: [],
      retry: {
        executor: "Executor_Observation: Error - Failed to read file to update",
      },
    })

    expect(prompt.includes("Failed to read file to update")).toBe(true)
    expect(prompt.includes("do not choose an update-style patch")).toBe(true)
    expect(prompt.includes("use `glob`/`read` to confirm the location")).toBe(true)
    expect(prompt.includes("an add-file patch")).toBe(true)
  })
})

describe("session.system executor", () => {
  test("keeps editing rules when tools are selected", () => {
    const prompt = SystemPrompt.executor({
      handoff: {
        completed_steps: [],
        remaining_steps: ["create files"],
        current_step: "Create the requested file",
        selected_tools: ["apply_patch"],
      },
    })

    expect(prompt.includes("## Current Step")).toBe(true)
    expect(prompt.includes("Create the requested file")).toBe(true)
    expect(prompt.includes("## Plan")).toBe(false)
    expect(prompt.includes('"current_step":')).toBe(false)
    expect(prompt.includes('"selected_tools": [')).toBe(false)
    expect(prompt.includes("## Editing constraints")).toBe(true)
    expect(prompt.includes("## Git and workspace hygiene")).toBe(true)
    expect(prompt.includes("## Execution discipline")).toBe(true)
    expect(prompt.includes("## Presenting your work and final message")).toBe(false)
    expect(prompt.includes("## Final answer structure and style guidelines")).toBe(false)
    expect(prompt.includes("Execute only the current operation.")).toBe(true)
    expect(prompt.includes("Do not claim files were created, tests passed")).toBe(true)
  })

  test("keeps final answer rules when no tools are selected", () => {
    const prompt = SystemPrompt.executor({
      handoff: {
        completed_steps: ["create files"],
        remaining_steps: [],
        current_step: "Report the completed work to the user",
        selected_tools: [],
      },
    })

    expect(prompt.includes("## Editing constraints")).toBe(false)
    expect(prompt.includes("## Git and workspace hygiene")).toBe(false)
    expect(prompt.includes("## Presenting your work and final message")).toBe(true)
    expect(prompt.includes("## Final answer structure and style guidelines")).toBe(true)
    expect(prompt.includes("## Current Step")).toBe(true)
    expect(prompt.includes("Report the completed work to the user")).toBe(true)
  })
})
