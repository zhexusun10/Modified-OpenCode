#!/usr/bin/env bun

import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const jobs = [
  {
    name: "server",
    cmd: ["bun", "run", "--cwd", "packages/opencode", "--conditions=browser", "src/index.ts", "serve", "--port", "4096"],
  },
  {
    name: "app",
    cmd: ["bun", "run", "--cwd", "packages/app", "dev", "--", "--port", "4444"],
  },
] as const

const procs = jobs.map((job) =>
  Bun.spawn(job.cmd, {
    cwd: root,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  }),
)

const stop = (sig: Bun.SignalCode) =>
  Promise.allSettled(
    procs.map((proc) => {
      if (proc.exitCode !== null) return Promise.resolve()
      proc.kill(sig)
      return proc.exited.then(() => undefined)
    }),
  )

const shutdown = (sig: Bun.SignalCode, code: number) => {
  process.exitCode = code
  void stop(sig).finally(() => process.exit(code))
}

process.once("SIGINT", () => shutdown("SIGINT", 130))
process.once("SIGTERM", () => shutdown("SIGTERM", 143))
process.once("SIGHUP", () => shutdown("SIGHUP", 129))

console.log("Local dev:")
console.log("  app:    http://localhost:4444")
console.log("  server: http://localhost:4096")

const exit = await Promise.race(
  procs.map((proc, i) =>
    proc.exited.then((code) => ({
      code,
      name: jobs[i].name,
    })),
  ),
)

await stop("SIGTERM")

if (exit.code !== 0) {
  console.error(`${exit.name} exited with code ${exit.code}`)
}

process.exit(exit.code)
