const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const source = fs.readFileSync(path.join(__dirname, '../plugins/example/退群自动拉黑.js'), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace(/^const configFile = .*$/m, 'const configFile = "test-config"')
  .replaceAll('import.meta.url', '"file:///test/plugin.js"')
  .replaceAll('export class', 'class')
  + '\n;({LeaveBlacklistNotice, LeaveBlacklistRequest, LeaveBlacklistManage})'

function fixture() {
  const records = new Map(), calls = []
  const config = { enable: true, groups: [702211431] }
  const other = { blackUser: [555], unrelated: 'keep' }
  const cfg = { masterQQ: [999], config: {} }
  const bot = new EventEmitter()
  const api = vm.runInNewContext(source, {
    plugin: class { constructor() {} addCleanup(fn) { this.cleanup = fn } },
    URL, cfg, Bot: bot,
    fs: { existsSync: () => true, readFileSync: () => '', writeFileSync() {} },
    YAML: { parse: () => config, parseDocument: () => ({
      get: key => ({ toJSON: () => other[key] }),
      set: (key, value) => { other[key] = value },
      toJSON: () => other,
      toString: () => JSON.stringify(other),
    }) },
    redis: {
      hSet: async (key, user, value) => records.set(`${key}:${user}`, value),
      hGet: async (key, user) => records.get(`${key}:${user}`),
      hDel: async (key, user) => Number(records.delete(`${key}:${user}`)),
    },
    logger: { mark() {}, error(error) { throw error } },
  })
  const e = { group_id: 702211431, self_id: 100, user_id: 300, operator_id: 300,
    group: { kickMember: async (...args) => calls.push(['kick', ...args]) },
    approve: async (...args) => calls.push(['approve', ...args]),
    reply: async msg => calls.push(['reply', msg]),
  }
  return { ...api, e, calls, records, config, other, cfg, bot }
}

test('only configured groups record future voluntary departures; records have no TTL', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.handle({ ...f.e, sub_type: 'decrease', group_id: 1 })
  assert.equal(f.records.size, 0)
  await handler.handle({ ...f.e, sub_type: 'decrease', operator_id: '300' })
  assert.equal(f.records.size, 1)
  assert.equal(f.calls.length, 0)
})
test('self departure and dismissals do not add people', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  for (const change of [{ user_id: 100 }, { dismiss: true }])
    await handler.handle({ ...f.e, sub_type: 'decrease', ...change })
  assert.equal(f.records.size, 0)
})

test('kicks and departures without an operator are also blacklisted', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.handle({ ...f.e, sub_type: 'decrease', operator_id: 400 })
  await handler.handle({ ...f.e, sub_type: 'decrease', user_id: 301, operator_id: undefined })
  assert.equal(f.records.size, 2)
})

test('returning blacklisted users are rejected only in the configured group', async () => {
  const f = fixture()
  await new f.LeaveBlacklistNotice().handle({ ...f.e, sub_type: 'decrease' })
  const handler = new f.LeaveBlacklistRequest()
  assert.equal(await handler.handle(f.e), 'return')
  assert.equal(f.calls[0][0], 'approve')
  assert.equal(f.calls[0][1], false)
  assert.equal(f.calls[0][2], '主动退群被拉黑')
  await handler.handle({ ...f.e, group_id: 2 })
  await handler.handle({ ...f.e, user_id: 400 })
  assert.equal(f.calls.length, 1)
})
test('invited blacklisted users are removed; ordinary joins stay untouched', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.handle({ ...f.e, sub_type: 'decrease' })
  assert.equal(await handler.handle({ ...f.e, sub_type: 'increase' }), 'return')
  assert.deepEqual(f.calls, [['kick', 300, true]])
  await handler.handle({ ...f.e, user_id: 400, sub_type: 'increase' })
  assert.equal(f.calls.length, 1)
})
test('only the master can remove a group blacklist entry', async () => {
  const f = fixture()
  await new f.LeaveBlacklistNotice().handle({ ...f.e, sub_type: 'decrease' })
  const handler = new f.LeaveBlacklistManage()
  await handler.manage({ ...f.e, msg: '#退群拉黑解除300', isMaster: false })
  assert.equal(f.records.size, 1)
  await handler.manage({ ...f.e, msg: '#退群拉黑解除300', isMaster: true })
  assert.equal(f.records.size, 0)
  assert.equal(await new f.LeaveBlacklistRequest().handle(f.e), false)
})
test('disabling the rule stops recording and enforcement', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.handle({ ...f.e, sub_type: 'decrease' })
  f.config.enable = false
  await handler.handle({ ...f.e, user_id: 400, sub_type: 'decrease' })
  await handler.handle({ ...f.e, sub_type: 'increase' })
  await new f.LeaveBlacklistRequest().handle(f.e)
  assert.equal(f.records.size, 1)
  assert.equal(f.calls.length, 0)
})

test('departures also update the bot blacklist and its runtime cache without losing other settings', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.handle({ ...f.e, sub_type: 'decrease', operator_id: 400 })
  await handler.handle({ ...f.e, sub_type: 'decrease' })
  assert.deepEqual(Array.from(f.other.blackUser), [555, 300])
  assert.equal(f.cfg.config['config.other'].unrelated, 'keep')
  assert.equal(f.cfg.config['config.other'], f.other)
})
test('bot master protection is preserved', async () => {
  const f = fixture()
  await new f.LeaveBlacklistNotice().handle({ ...f.e, sub_type: 'decrease', user_id: 999 })
  assert.deepEqual(f.other.blackUser, [555])
})
test('raw event listeners enforce readmission even after the bot blacklist filters normal plugins', async () => {
  const f = fixture(), notice = new f.LeaveBlacklistNotice(), request = new f.LeaveBlacklistRequest()
  notice.init(); request.init()
  assert.equal(notice.accept, undefined)
  f.bot.emit('notice.group', { ...f.e, sub_type: 'decrease' })
  await new Promise(setImmediate)
  assert.ok(f.other.blackUser.includes(300))
  f.bot.emit('request.group', f.e)
  await new Promise(setImmediate)
  assert.deepEqual(f.calls[0], ['approve', false, '主动退群被拉黑'])
  notice.cleanup(); request.cleanup()
  assert.equal(f.bot.listenerCount('notice.group'), 0)
  assert.equal(f.bot.listenerCount('request.group'), 0)
})
