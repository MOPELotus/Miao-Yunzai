import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../renderers/puppeteer/lib/puppeteer.js', import.meta.url), 'utf8')
  .replace(/^import .*\n/gm, '')
  .replace('export default class Puppeteer', 'class Puppeteer')

function setup(config = {}, connectFails = false) {
  const calls = { launches: [], connections: [] }
  const browser = { wsEndpoint: () => 'ws://new-browser', on() {} }
  const fakeProcess = { cwd: () => '/test', env: { HOME: '/test-home', LD_PRELOAD: 'injected' } }
  const Renderer = class {}
  const Class = vm.runInNewContext(source + '\nPuppeteer', {
    Renderer, process: fakeProcess, cfg: {}, lodash: {}, timers: {},
    ulid: () => 'unique', fs: { rm: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    redis: new Proxy({}, { get() { throw new Error('must not read stale Redis browser endpoint') } }),
    puppeteer: {
      launch: async options => { calls.launches.push(options); return browser },
      connect: async options => {
        calls.connections.push(options)
        if (connectFails) throw new Error('external browser unavailable')
        return browser
      }
    }
  })
  return { instance: new Class(config), calls, browser, fakeProcess }
}

test('local browser starts without reading or writing an old Redis endpoint', async () => {
  const { instance, calls, browser } = setup()
  assert.equal(await instance.browserInit(), browser)
  assert.equal(calls.launches.length, 1)
  assert.equal(calls.connections.length, 0)
})

test('Chromium environment overrides preserve inherited values without changing Node environment', async () => {
  const { instance, calls, fakeProcess } = setup({ env: { LD_PRELOAD: '', EXTRA: 'value' } })
  await instance.browserInit()
  const env = calls.launches[0].env
  assert.equal(env.HOME, '/test-home')
  assert.equal(env.LD_PRELOAD, '')
  assert.equal(env.EXTRA, 'value')
  assert.equal(fakeProcess.env.LD_PRELOAD, 'injected')
  assert.equal(fakeProcess.env.EXTRA, undefined)
})

test('explicit external browser connects without launching a new local browser', async () => {
  const { instance, calls, browser } = setup({ puppeteerWS: 'ws://external' })
  assert.equal(await instance.browserInit(), browser)
  assert.equal(calls.connections[0].browserWSEndpoint, 'ws://external')
  assert.equal(calls.launches.length, 0)
})

test('failed explicit connection falls back to a local browser and concurrent init stays deduplicated', async () => {
  const { instance, calls, browser } = setup({ puppeteerWS: 'ws://external' }, true)
  const results = await Promise.all([instance.browserInit(), instance.browserInit()])
  assert.equal(results[0], browser)
  assert.equal(results[1], browser)
  assert.equal(calls.launches.length, 1)
  assert.equal(calls.connections.length, 1)
  assert.equal(instance.lock, false)
  assert.equal(instance.browserInitPromise, null)
})
