const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../plugins/example/退群自动拉黑.js'), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace(/^const configFile = .*$/m, 'const configFile = "test-config"')
  .replaceAll('export class', 'class')
  + '\n;({LeaveBlacklistNotice, LeaveBlacklistRequest, LeaveBlacklistManage})'

function fixture() {
  const records = new Map(), calls = []
  const config = { enable: true, groups: [702211431] }
  const api = vm.runInNewContext(source, {
    plugin: class { constructor() {} },
    fs: { existsSync: () => true, readFileSync: () => '' },
    YAML: { parse: () => config },
    redis: {
      hSet: async (key, user, value) => records.set(`${key}:${user}`, value),
      hGet: async (key, user) => records.get(`${key}:${user}`),
      hDel: async (key, user) => Number(records.delete(`${key}:${user}`)),
    },
    logger: { mark() {} },
  })
  const e = { group_id: 702211431, self_id: 100, user_id: 300, operator_id: 300,
    group: { kickMember: async (...args) => calls.push(['kick', ...args]) },
    approve: async (...args) => calls.push(['approve', ...args]),
    reply: async msg => calls.push(['reply', msg]),
  }
  return { ...api, e, calls, records, config }
}

test('only configured groups record future voluntary departures; records have no TTL', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.accept({ ...f.e, sub_type: 'decrease', group_id: 1 })
  assert.equal(f.records.size, 0)
  await handler.accept({ ...f.e, sub_type: 'decrease', operator_id: '300' })
  assert.equal(f.records.size, 1)
  assert.equal(f.calls.length, 0)
})
test('kicks, missing operator, self departure and dismissals do not add people', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  for (const change of [{ operator_id: 400 }, { operator_id: undefined }, { user_id: 100 }, { dismiss: true }])
    await handler.accept({ ...f.e, sub_type: 'decrease', ...change })
  assert.equal(f.records.size, 0)
})
test('returning blacklisted users are rejected only in the configured group', async () => {
  const f = fixture()
  await new f.LeaveBlacklistNotice().accept({ ...f.e, sub_type: 'decrease' })
  const handler = new f.LeaveBlacklistRequest()
  assert.equal(await handler.accept(f.e), 'return')
  assert.equal(f.calls[0][0], 'approve')
  assert.equal(f.calls[0][1], false)
  await handler.accept({ ...f.e, group_id: 2 })
  await handler.accept({ ...f.e, user_id: 400 })
  assert.equal(f.calls.length, 1)
})
test('invited blacklisted users are removed; ordinary joins stay untouched', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.accept({ ...f.e, sub_type: 'decrease' })
  assert.equal(await handler.accept({ ...f.e, sub_type: 'increase' }), 'return')
  assert.deepEqual(f.calls, [['kick', 300, true]])
  await handler.accept({ ...f.e, user_id: 400, sub_type: 'increase' })
  assert.equal(f.calls.length, 1)
})
test('only the master can remove a group blacklist entry', async () => {
  const f = fixture()
  await new f.LeaveBlacklistNotice().accept({ ...f.e, sub_type: 'decrease' })
  const handler = new f.LeaveBlacklistManage()
  await handler.manage({ ...f.e, msg: '#退群拉黑解除300', isMaster: false })
  assert.equal(f.records.size, 1)
  await handler.manage({ ...f.e, msg: '#退群拉黑解除300', isMaster: true })
  assert.equal(f.records.size, 0)
  assert.equal(await new f.LeaveBlacklistRequest().accept(f.e), false)
})
test('disabling the rule stops recording and enforcement', async () => {
  const f = fixture(), handler = new f.LeaveBlacklistNotice()
  await handler.accept({ ...f.e, sub_type: 'decrease' })
  f.config.enable = false
  await handler.accept({ ...f.e, user_id: 400, sub_type: 'decrease' })
  await handler.accept({ ...f.e, sub_type: 'increase' })
  await new f.LeaveBlacklistRequest().accept(f.e)
  assert.equal(f.records.size, 1)
  assert.equal(f.calls.length, 0)
})
