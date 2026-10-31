import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"
import vm from "node:vm"

const source = fs
  .readFileSync(new URL("../plugins/adapter/OneBotv11.js", import.meta.url), "utf8")
  .replace(/^import .*\n/gm, "")

function setup(member, lookup = async () => member) {
  const events = []
  const warnings = []
  const globalBot = {
    adapter: [],
    makeLog: (level, message) => {
      if (level === "warn") warnings.push(message)
    },
    em: (name, event) => events.push({ name, event }),
  }
  vm.runInNewContext(source, { Bot: globalBot, cfg: { bot: { cache_group_member: true } } })
  const adapter = globalBot.adapter[0]
  const bot = {
    uin: 100,
    gl: new Map([[200, { group_id: 200, group_name: "Test group" }]]),
    gml: new Map([[200, new Map(member ? [[member.user_id, member]] : [])]]),
    fl: new Map(),
    sendApi: async action => {
      if (action === "get_group_info") return { data: { group_id: 200, group_name: "Test group" } }
      if (action === "get_group_member_info") return { data: await lookup() }
      throw new Error(`Unexpected API: ${action}`)
    },
  }
  const context = { bot, self_id: bot.uin }
  bot.pickGroup = id => adapter.pickGroup(context, id)
  bot.pickMember = (group, user) => adapter.pickMember(context, group, user)
  return { adapter, bot, events, warnings }
}

const notice = (bot, type, user = 300) => ({
  bot,
  self_id: bot.uin,
  group_id: 200,
  user_id: user,
  operator_id: user,
  post_type: "notice",
  notice_type: type,
  sub_type: "approve",
})

test("joins wait for fresh member data and expose both nickname and member fields", async () => {
  let finish
  const lookup = new Promise(resolve => {
    finish = resolve
  })
  const { adapter, bot, events } = setup(null, () => lookup)
  const pending = adapter.makeNotice(notice(bot, "group_increase"))
  assert.equal(events.length, 0)
  finish({ user_id: 300, nickname: "Past", card: "Group card" })
  await pending
  assert.equal(events[0].name, "notice.group.increase")
  assert.equal(events[0].event.nickname, "Past")
  assert.equal(events[0].event.member.nickname, "Past")
  assert.equal(events[0].event.member.card, "Group card")
  assert.equal(bot.gml.get(200).get(300).nickname, "Past")
})

test("lookup failure still emits the join using available cached data", async () => {
  const { adapter, bot, events, warnings } = setup(
    { user_id: 300, nickname: "Cached", card: "Cached card" },
    async () => {
      throw new Error("lookup failed")
    },
  )
  await adapter.makeNotice(notice(bot, "group_increase"))
  assert.equal(events[0].event.nickname, "Cached")
  assert.equal(events[0].event.member.card, "Cached card")
  assert.equal(warnings.length, 1)
})

test("departures preserve member details on the event while removing stale cache entries", async () => {
  const { adapter, bot, events } = setup({ user_id: 300, nickname: "Leaving", card: "Old card" })
  await adapter.makeNotice(notice(bot, "group_decrease"))
  assert.equal(bot.gml.get(200).has(300), false)
  assert.equal(events[0].event.member.nickname, "Leaving")
  assert.equal(events[0].event.member.card, "Old card")
  assert.equal(events[0].event.nickname, "Leaving")
  assert.equal(events[0].event.group_name, "Test group")
})

test("bot removal retains group/member snapshots after deleting both caches", async () => {
  const { adapter, bot, events } = setup({ user_id: 100, nickname: "Bot", card: "Bot card" })
  await adapter.makeNotice(notice(bot, "group_decrease", 100))
  assert.equal(bot.gl.has(200), false)
  assert.equal(bot.gml.has(200), false)
  assert.equal(events[0].event.group_name, "Test group")
  assert.equal(events[0].event.member.card, "Bot card")
})

test("departures without cached profile data still emit a usable member object", async () => {
  const { adapter, bot, events } = setup(null)
  await adapter.makeNotice(notice(bot, "group_decrease"))
  assert.equal(events[0].event.member.user_id, 300)
  assert.equal(typeof events[0].event.member.getInfo, "function")
})

test("invites retain their inviter after notice subtypes are normalized", async () => {
  const { adapter, bot, events } = setup({ user_id: 300, nickname: "Joined" })
  await adapter.makeNotice({
    ...notice(bot, "group_increase"),
    sub_type: "invite",
    operator_id: 400,
  })
  assert.equal(events[0].event.sub_type, "increase")
  assert.equal(events[0].event.increase_type, "invite")
  assert.equal(events[0].event.inviter_id, 400)
})

test("approved applications are never relabeled as invitations", async () => {
  const { adapter, bot, events } = setup({ user_id: 300, nickname: "Joined" })
  await adapter.makeNotice({ ...notice(bot, "group_increase"), operator_id: 400 })
  assert.equal(events[0].event.increase_type, "approve")
  assert.equal(events[0].event.inviter_id, undefined)
})
