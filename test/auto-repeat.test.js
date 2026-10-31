import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import { RepeatTracker, prepareRepeatMessage } from "../lib/plugins/autoRepeat.js"

const text = value => [{ type: "text", text: value }]

test("two distinct users trigger exactly one repeat in a continuous round", () => {
  const tracker = new RepeatTracker()
  assert.equal(tracker.observe(100, 1, text("哈哈")), null)
  assert.equal(tracker.observe(100, "1", text("哈哈")), null)
  assert.deepEqual(tracker.observe(100, 2, text("哈哈")), text("哈哈"))
  assert.equal(tracker.observe(100, 3, text("哈哈")), null)
  assert.equal(tracker.observe(100, 4, text("哈哈")), null)
})
test("a different message resets the round and groups do not affect each other", () => {
  const tracker = new RepeatTracker()
  tracker.observe(100, 1, text("A"))
  assert.equal(tracker.observe(200, 2, text("A")), null)
  tracker.observe(100, 2, text("B"))
  assert.equal(tracker.observe(100, 3, text("A")), null)
  assert.deepEqual(tracker.observe(100, 4, text("A")), text("A"))
  assert.deepEqual(tracker.observe(200, 3, text("A")), text("A"))
})
test("messages separated by more than the idle window do not trigger", () => {
  const tracker = new RepeatTracker({ windowMs: 1000 })
  tracker.observe(100, 1, text("A"), 0)
  assert.equal(tracker.observe(100, 2, text("A"), 1001), null)
  assert.deepEqual(tracker.observe(100, 3, text("A"), 1002), text("A"))
})
test("commands, empty messages and unsupported message types break the round", () => {
  const tracker = new RepeatTracker()
  for (const msg of [text("#更新"), text("  /test"), text("\n"), [], [{ type: "at", qq: "all" }], [{ type: "reply", id: 1 }]]) {
    tracker.observe(100, 1, text("A"))
    assert.equal(tracker.observe(100, 2, msg), null)
    assert.equal(tracker.observe(100, 2, text("A")), null)
  }
})
test("flattened and nested segments, split text and line endings match", () => {
  const a = prepareRepeatMessage([{ type: "text", data: { text: "哈" } }, { type: "text", text: "哈\r\n" }])
  const b = prepareRepeatMessage(text("哈哈\n"))
  assert.equal(a.signature, b.signature)
})
test("images match by MD5 across rotating URLs and resend the current valid URL", () => {
  const tracker = new RepeatTracker()
  const file = "ABCDEF0123456789ABCDEF0123456789.jpg"
  tracker.observe(100, 1, [{ type: "image", file, url: "https://example.com/a?rkey=old" }])
  const result = tracker.observe(100, 2, [{ type: "image", file: file.toLowerCase(), url: "https://example.com/a?rkey=new" }])
  assert.equal(result[0].file, "https://example.com/a?rkey=new")
})
test("image captions, segment order and different faces remain distinct", () => {
  const image = { type: "image", file: "https://example.com/a" }
  assert.notEqual(prepareRepeatMessage([...text("A"), image]).signature, prepareRepeatMessage([...text("B"), image]).signature)
  assert.notEqual(prepareRepeatMessage([...text("A"), image]).signature, prepareRepeatMessage([image, ...text("A")]).signature)
  assert.notEqual(prepareRepeatMessage([{ type: "face", id: 1 }]).signature, prepareRepeatMessage([{ type: "face", id: 2 }]).signature)
})
test("group cache and user sets stay bounded during long chains", () => {
  const tracker = new RepeatTracker({ maxGroups: 2 })
  for (const group of [1, 2, 3]) tracker.observe(group, 1, text("A"))
  assert.equal(tracker.groups.size, 2)
  assert.equal(tracker.groups.has("1"), false)
  for (let user = 2; user < 100; user++) tracker.observe(3, user, text("A"))
  assert.equal(tracker.groups.get("3").users.size, 2)
})
test("plugin ignores all connected bot accounts and sends one ordinary group message", async () => {
  const source = fs.readFileSync(new URL("../plugins/example/自动复读.js", import.meta.url), "utf8")
    .replace(/^import .*\n/gm, "").replace("export class", "class") + "\n;AutoRepeat"
  const sent = []
  const AutoRepeat = vm.runInNewContext(source, {
    plugin: class { constructor() {} async reply(msg) { sent.push(msg); return { message_id: 1 } } },
    RepeatTracker, Bot: { uin: [900, 901] }, logger: { warn() {} },
  })
  const plugin = new AutoRepeat()
  const e = { self_id: 900, group_id: 100, message: text("哈哈") }
  await plugin.accept({ ...e, user_id: 1 })
  await plugin.accept({ ...e, user_id: 900 })
  await plugin.accept({ ...e, user_id: 901 })
  assert.equal(sent.length, 0)
  await plugin.accept({ ...e, user_id: 2 })
  await plugin.accept({ ...e, user_id: 3 })
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], text("哈哈"))
})
