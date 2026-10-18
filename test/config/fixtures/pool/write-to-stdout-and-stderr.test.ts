import { test } from 'vitest'
import EventEmitter from 'node:events'

test('write to streams', async () => {
  process.stdout.write('Worker writing to stdout')
  process.stderr.write('Worker writing to stderr')

  // MaxListenersExceededWarning is emitted asynchronously: attach the listener
  // before triggering it, then wait for it so it is written before the worker ends
  const warned = new Promise<void>(r => process.once('warning', () => r()))
  triggerNodeWarning()
  await warned
  await new Promise(r => setTimeout(r, 0))
})

function triggerNodeWarning() {
  const emitter = new TestFixturesCustomEmitter()
  emitter.setMaxListeners(2)
  emitter.addListener('message', () => {})
  emitter.addListener('message', () => {})
  emitter.addListener('message', () => {})
}

class TestFixturesCustomEmitter extends EventEmitter {}