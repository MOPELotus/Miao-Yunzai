import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { setImmediate } from "node:timers/promises"
import test from "node:test"
import vm from "node:vm"
import { retryGitCommand } from "../lib/tools/gitRetry.js"

const success = { stdout: "Already up to date.", stderr: "" }
const failure = message => ({ error: new Error(message), stdout: "", stderr: message })
const tlsFailure = failure(
  "fatal: unable to access 'https://github.com/example/repo/': gnutls_handshake() failed",
)

test("successful requests do not wait or retry", async () => {
  let calls = 0
  assert.equal(await retryGitCommand(async () => (calls++, success)), success)
  assert.equal(calls, 1)
})

test("five retries wait 5, 10, 15, 20, 25 seconds and return the last failure", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let calls = 0
  const pending = retryGitCommand(async () => (calls++, tlsFailure))
  await setImmediate()
  for (const delay of [5000, 10000, 15000, 20000, 25000]) {
    const before = calls
    t.mock.timers.tick(delay - 1)
    await setImmediate()
    assert.equal(calls, before)
    t.mock.timers.tick(1)
    await setImmediate()
    assert.equal(calls, before + 1)
  }
  assert.equal(await pending, tlsFailure)
  assert.equal(calls, 6)
})

test("Gitee username failures retry and stop immediately after recovery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let calls = 0
  const pending = retryGitCommand(async () =>
    ++calls === 1
      ? failure("fatal: could not read Username for 'https://gitee.com': No such device or address")
      : success,
  )
  await setImmediate()
  t.mock.timers.tick(5000)
  assert.equal(await pending, success)
  t.mock.timers.tick(100000)
  assert.equal(calls, 2)
})

test("local merge and rebase failures are returned without retrying", async () => {
  for (const message of [
    "Your local changes would be overwritten by merge",
    "CONFLICT (content): Merge conflict in package.json",
    "fatal: Need to specify how to reconcile divergent branches.",
    "error: cannot pull with rebase: You have unstaged changes.",
  ]) {
    let calls = 0
    const ret = failure(message)
    assert.equal(await retryGitCommand(async () => (calls++, ret)), ret)
    assert.equal(calls, 1)
  }
})

// Isolate the plugin from live config watchers, accounts and restart handling.
const source = (await readFile(new URL("../plugins/other/update.js", import.meta.url), "utf8"))
  .replace(/^import .*\n/gm, "")
  .replace("export class update", "class update")
const Update = vm.runInNewContext(`${source}\nupdate`, {
  plugin: class {},
  retryGitCommand,
  logger: { mark() {} },
})

function updater(msg = "#更新demo") {
  const instance = new Update()
  const replies = []
  instance.e = { msg, logFnc: "[test]" }
  instance.reply = async message => replies.push(message)
  instance.getCommitId = async () => "abc123"
  instance.getRemoteBranch = async () => "origin/main"
  instance.getTime = async () => "2026-10-31"
  return { instance, replies }
}

test("force-update prepares once and keeps intermediate failures out of replies", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { instance, replies } = updater("#强制更新demo")
  const commands = []
  let pulls = 0
  instance.exec = async (cmd, plugin, opts) => {
    assert.equal(plugin, "demo")
    assert.equal(opts.quiet, true)
    commands.push(cmd)
    return cmd === "git pull --rebase" && ++pulls === 1 ? tlsFailure : success
  }
  const pending = instance.runUpdate("demo")
  await setImmediate()
  assert.equal(replies.length, 1)
  t.mock.timers.tick(5000)
  assert.equal(await pending, true)
  assert.deepEqual(commands, [
    "git reset --hard origin/main",
    "git pull --rebase",
    "git pull --rebase",
  ])
  assert.equal(replies.length, 2)
  assert.match(replies[1], /已是最新/)
})

test("only the final network failure is reported after all five retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { instance, replies } = updater()
  let calls = 0
  instance.exec = async () => (calls++, tlsFailure)
  const pending = instance.runUpdate("demo")
  await setImmediate()
  for (const delay of [5000, 10000, 15000, 20000, 25000]) {
    assert.equal(replies.length, 1)
    t.mock.timers.tick(delay)
    await setImmediate()
  }
  assert.equal(await pending, false)
  assert.equal(calls, 6)
  assert.equal(replies.length, 2)
  assert.match(replies[1], /远程仓库连接错误/)
})

test("authentication errors give configuration guidance after retries", async () => {
  const { instance, replies } = updater()
  await instance.gitErr("demo", "", "could not read Username for 'https://gitee.com'")
  assert.match(replies[0], /认证失败/)
  assert.doesNotMatch(replies[0], /强制更新/)
  assert.equal(instance.gitErrUrl("an error without quotes"), "未知地址")
})
