import { spawnSync } from "node:child_process"

const { command, entry, passthroughArgs } = parseWrapperArgs(process.argv.slice(2))
const commandArgs = [entry, ...passthroughArgs]

const result = spawnSync(command, commandArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error) {
  console.error(result.error.message)
}

// This wrapper is for package-manager convenience scripts. Exiting non-zero
// makes pnpm append ELIFECYCLE, which looks like an internal CLI crash.
process.exit(0)

function parseWrapperArgs(args) {
  const passthroughArgs = []
  let command = process.env.SAFECAFE_CLI_COMMAND ?? "tsx"
  let entry = process.env.SAFECAFE_CLI_ENTRY ?? "cli/index.ts"

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--") {
      passthroughArgs.push(...args.slice(index + 1))
      break
    }
    if (arg === "--command") {
      command = readValue(args, index, "--command")
      index += 1
      continue
    }
    if (arg === "--entry") {
      entry = readValue(args, index, "--entry")
      index += 1
      continue
    }
    passthroughArgs.push(arg)
  }

  return { command, entry, passthroughArgs }
}

function readValue(args, index, flag) {
  const value = args[index + 1]
  if (!value) {
    console.error(`${flag} requires a value`)
    process.exit(0)
  }
  return value
}
