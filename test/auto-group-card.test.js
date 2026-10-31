import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import vm from "node:vm"

const moduleUrl = new URL("../plugins/example/自动群名片.js", import.meta.url)
const source = fs
  .readFileSync(moduleUrl, "utf8")
  .replace(/^import .*\n/gm, "")
  .replace("export class AutoGroupCard", "class AutoGroupCard")
  .replaceAll("import.meta.url", JSON.stringify(moduleUrl.href))
const suffix = "本机器人拒绝服务酷狗！"

function setup(config = {}, bots = {}) {
  const warnings = []
  const Plugin = vm.runInNewContext(`${source}\nAutoGroupCard`, {
    plugin: class {
      constructor(options) {
        Object.assign(this, options)
      }
    },
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify(config) },
    YAML: { parse: JSON.parse },
    URL,
    Math: { ...Math, random: () => 0, floor: Math.floor },
    Bot: { uin: Object.keys(bots), ...bots },
    logger: { warn: message => warnings.push(message) },
  })
  return { plugin: new Plugin(), warnings }
}

test("uses the migrated schedule and master-only manual command", () => {
  const { plugin } = setup({ cron: "0 0,30 * * * *" })
  assert.equal(plugin.task.cron, "0 0,30 * * * *")
  assert.equal(plugin.task.log, false)
  assert.equal(plugin.rule[0].permission, "master")
})

test("updates each account's own card, skips excluded/unchanged groups and continues after errors", async () => {
  const calls = []
  function bot(uin, ids) {
    return {
      uin,
      nickname: `bot-${uin}`,
      gl: new Map(ids.map(id => [id, {}])),
      pickGroup: group => ({
        pickMember: member => {
          assert.equal(member, uin)
          return { card: group === 1 ? `绫华｜${suffix}` : "old" }
        },
        setCard: async (member, card) => {
          calls.push([uin, group, member, card])
          if (group === 3) throw new Error("permission denied")
        },
      }),
    }
  }
  const { plugin, warnings } = setup(
    { nickname: "绫华", notGroup: [2] },
    {
      a: bot("a", [1, 2, 3, 4]),
      b: bot("b", [4]),
    },
  )
  const result = await plugin.updateCards()
  assert.equal(result.updated, 2)
  assert.equal(result.unchanged, 1)
  assert.equal(result.failed, 1)
  assert.deepEqual(calls, [
    ["a", 3, "a", `绫华｜${suffix}`],
    ["a", 4, "a", `绫华｜${suffix}`],
    ["b", 4, "b", `绫华｜${suffix}`],
  ])
  assert.equal(warnings.length, 1)
})

test("disabled configuration schedules nothing and performs no updates", async () => {
  const { plugin } = setup({ enable: false })
  assert.equal(plugin.task.length, 0)
  assert.equal(await plugin.updateCards(), false)
})

test("manual and scheduled updates cannot run concurrently", async () => {
  let finish
  const pending = new Promise(resolve => {
    finish = resolve
  })
  const { plugin } = setup(
    {},
    {
      a: {
        uin: "a",
        nickname: "test",
        gl: new Map([[1, {}]]),
        pickGroup: () => ({ pickMember: () => ({ card: "old" }), setCard: () => pending }),
      },
    },
  )
  const running = plugin.updateCards()
  assert.equal(await plugin.updateCards(), false)
  finish()
  assert.equal((await running).updated, 1)
  assert.equal((await plugin.updateCards()).updated, 1)
})

test("manual updates reject non-master callers", async () => {
  const { plugin } = setup()
  plugin.e = { isMaster: false }
  plugin.updateCards = () => {
    throw new Error("must not run")
  }
  assert.equal(await plugin.updateManually(), false)
})
