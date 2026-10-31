import timers from "node:timers/promises"

// Retry remote failures only; repeating a failed local merge/rebase can lose work.
const remoteError =
  /unable to access|无法访问|could not read (?:Username|Password)|Authentication failed|鉴权失败|could not resolve|failed to connect|connection.*(?:reset|closed|refused|timed out)|timed? out|TLS|SSL|gnutls|RPC failed|remote end hung up|early EOF|unexpected disconnect|could not read from remote repository/i

export async function retryGitCommand(exec) {
  for (let attempt = 0; ; attempt++) {
    const ret = await exec()
    if (
      !ret.error ||
      attempt >= 5 ||
      !remoteError.test(`${ret.error.message}\n${ret.stderr || ""}`)
    )
      return ret
    await timers.setTimeout((attempt + 1) * 5000)
  }
}
