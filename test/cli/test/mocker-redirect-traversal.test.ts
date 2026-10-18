import type { MockedModuleSerialized } from '@vitest/mocker'
import type { ViteDevServer } from 'vite'
import type { Vitest } from 'vitest/node'
import type { RunVitestConfig } from '../../test-utils'
import { setDefaultResultOrder } from 'node:dns'
import { fileURLToPath } from 'node:url'
import { webdriverio } from '@vitest/browser-webdriverio'
import { MockerRegistry } from '@vitest/mocker'
import { createManualModuleSource, interceptorPlugin } from '@vitest/mocker/node'
import { createServer, parseAst } from 'vite'
import { afterAll, expect, it, onTestFinished } from 'vitest'
import { WebSocket } from 'ws'
import { runInlineTests } from '../../test-utils'

// webdriver@9 sets dns.setDefaultResultOrder("ipv4first") on import,
// which makes Vite resolve localhost to 127.0.0.1 and breaks other tests asserting "localhost"
afterAll(() => setDefaultResultOrder('verbatim'))

const root = fileURLToPath(
  new URL('../fixtures/mocker/redirect-security/root', import.meta.url),
)

interface SocketRegistration {
  /**
   * The server answered with `vitest:interceptor:register:result`
   */
  acknowledged: boolean
}

async function createMockerServer(options: { registerWebSocketEvents?: boolean } = {}) {
  const registry = new MockerRegistry()
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      host: '127.0.0.1',
      watch: null,
      fs: {
        strict: true,
        allow: [root],
        deny: ['.env', '.env.*', '*.{crt,pem}'],
      },
    },
    plugins: [
      {
        name: 'test:virtual-mock',
        enforce: 'pre',
        resolveId(id) {
          if (id === '/mock') {
            return id
          }
        },
        configureServer(server) {
          registerPingHandler(server)
        },
      },
      interceptorPlugin({ registry, ...options }),
    ],
  })
  await server.listen()
  onTestFinished(() => server.close())
  return { server, registry, url: toWebSocketUrl(server) }
}

// messages on a single socket are handled in order, so the pong proves
// that every message sent before the ping was already processed
function registerPingHandler(server: ViteDevServer) {
  server.ws.on('test:ping', (_data, client) => {
    client.send('test:pong')
  })
}

function toWebSocketUrl(server: ViteDevServer) {
  const url = new URL(server.resolvedUrls!.local[0])
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function redirectMock(redirect: string): MockedModuleSerialized {
  return { type: 'redirect', raw: '/mock', id: '/mock', url: '/mock', redirect }
}

function registerOverSocket(url: string, data: MockedModuleSerialized) {
  return new Promise<SocketRegistration>((resolve, reject) => {
    // no Origin header and no token: any local process can open this socket
    const ws = new WebSocket(url, 'vite-hmr')
    let acknowledged = false
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('timed out waiting for the server to process the registration'))
    }, 20_000)
    ws.on('message', (raw) => {
      let message: any
      try {
        message = JSON.parse(raw.toString())
      }
      catch {
        return
      }
      if (message.type !== 'custom') {
        return
      }
      if (message.event === 'vitest:interceptor:register:result') {
        acknowledged = true
      }
      else if (message.event === 'test:pong') {
        clearTimeout(timeout)
        ws.close()
        resolve({ acknowledged })
      }
    })
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'custom', event: 'vitest:interceptor:register', data }))
      ws.send(JSON.stringify({ type: 'custom', event: 'test:ping' }))
    })
    ws.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

it('rejects a redirect mock whose target escapes the project root', async () => {
  const { server, registry, url } = await createMockerServer()
  // an opaque URL scheme keeps the `..` segments, so join(root, pathname)
  // resolves outside the root; the mock must not be registered
  const registration = await registerOverSocket(url, redirectMock('traversal:../secret.txt'))
  expect(registration.acknowledged).toBe(true)
  expect(registry.getById('/mock')).toBeUndefined()
  const result = await server.transformRequest('/mock').catch(() => null)
  expect(result).toBe(null)
})

it('rejects a redirect mock that escapes the project root with backslashes', async () => {
  const { server, registry, url } = await createMockerServer()
  // `..\` is a parent directory segment on Windows, the check has to see it
  const registration = await registerOverSocket(url, redirectMock('traversal:..\\secret.txt'))
  expect(registration.acknowledged).toBe(true)
  expect(registry.getById('/mock')).toBeUndefined()
  const result = await server.transformRequest('/mock').catch(() => null)
  expect(result).toBe(null)
})

it('rejects a redirect mock whose target is denied by server.fs.deny', async () => {
  const { server, registry, url } = await createMockerServer()
  // the file is inside the root, but `server.fs.deny` must still be respected
  const registration = await registerOverSocket(url, redirectMock('traversal:denied.pem'))
  expect(registration.acknowledged).toBe(true)
  expect(registry.getById('/mock')).toBeUndefined()
  const result = await server.transformRequest('/mock').catch(() => null)
  expect(result).toBe(null)
})

it('serves a redirect mock whose target stays inside the project root', async () => {
  const { server, registry, url } = await createMockerServer()
  const registration = await registerOverSocket(url, redirectMock('traversal:inroot.js'))
  expect(registration.acknowledged).toBe(true)
  expect(registry.getById('/mock')).toMatchObject({ type: 'redirect' })
  const result = await server.transformRequest('/mock').catch(() => null)
  expect(result?.code).toContain('in-root-redirect-ok')
})

it('does not accept mocks over the dev-server socket when registerWebSocketEvents is false', async () => {
  const { server, registry, url } = await createMockerServer({ registerWebSocketEvents: false })
  // even a valid in-root redirect must be ignored
  const registration = await registerOverSocket(url, redirectMock('traversal:inroot.js'))
  expect(registration.acknowledged).toBe(false)
  expect(registry.getById('/mock')).toBeUndefined()
  const result = await server.transformRequest('/mock').catch(() => null)
  expect(result).toBe(null)
})

it('escapes the manual mock url and export names in the generated module', () => {
  const url = '/mock"); globalThis.__vitest_injected__ = ("'
  const name = 'key"]; globalThis.__vitest_injected__ = __factoryModule__["key'
  const code = createManualModuleSource(url, [name])

  const ast = parseAst(code) as any
  // the factory lookup, one binding and export per key and the recursion guard,
  // injected statements would show up as additional nodes
  expect(ast.body.map((node: any) => node.type)).toEqual([
    'VariableDeclaration',
    'VariableDeclaration',
    'ExportNamedDeclaration',
    'IfStatement',
  ])
  const [factory, binding, exported, guard] = ast.body
  expect(factory.declarations[0].init.argument.arguments[0].value).toBe(url)
  expect(binding.declarations[0].init.property.value).toBe(name)
  expect(exported.specifiers.map((specifier: any) => specifier.exported.value)).toEqual([name])
  const callback = guard.consequent.body[0].expression.arguments[0]
  expect(callback.body.body).toHaveLength(1)
  expect(callback.body.body[0].expression.right.property.value).toBe(name)
})

const browserTest = `
import { expect, test } from 'vitest'

// the authenticated browser RPC is the only channel that registers mocks,
// it has to apply the same file access rules as the browser commands
async function registerRedirect(redirect) {
  const rpc = globalThis.__vitest_worker__.rpc
  const sessionId = globalThis.__vitest_browser_runner__.sessionId
  try {
    await rpc.registerMock(sessionId, {
      type: 'redirect',
      raw: '/redirect-probe',
      id: '/redirect-probe',
      url: '/redirect-probe',
      redirect,
    })
    return 'registered'
  }
  catch (error) {
    return String((error && error.message) || error)
  }
}

test('rejects a redirect to a denied file inside the root', async () => {
  expect(await registerRedirect('traversal:denied.pem')).toContain('Access denied')
})

test('rejects a redirect outside of the allowed directories', async () => {
  expect(await registerRedirect('traversal:${'../'.repeat(32)}vitest-redirect-outside.txt')).toContain('Access denied')
})

test('accepts a redirect inside the root', async () => {
  expect(await registerRedirect('traversal:inroot.js')).toBe('registered')
})
`

const webdriverioConfig: RunVitestConfig['browser'] = {
  enabled: true,
  provider: webdriverio({
    ...(process.env.CHROMEDRIVER_PATH && process.env.CHROME_BIN
      ? {
          'wdio:chromedriverOptions': {
            binary: process.env.CHROMEDRIVER_PATH,
          },
          'capabilities': {
            'goog:chromeOptions': {
              binary: process.env.CHROME_BIN,
            },
          },
        }
      : {}),
  }),
  // webdriverio has no native module mocker, so mocks go through the RPC registry
  instances: [{ browser: 'chrome' }],
  headless: true,
}

it('browser mode only registers mocks through the authenticated RPC', { retry: 2 }, async () => {
  let ctx: Vitest | undefined
  let probe: SocketRegistration | Error | undefined

  const { stderr, errorTree } = await runInlineTests({
    'basic.test.js': browserTest,
    'inroot.js': `export const marker = 'in-root-redirect-ok'\n`,
    'denied.pem': `export const secret = 'denied-file-must-not-be-served'\n`,
  }, {
    browser: webdriverioConfig,
    reporters: [
      {
        onInit(ctx_) {
          ctx = ctx_
        },
        async onTestRunEnd() {
          try {
            const vite = ctx!.projects.find(project => project.browser)!.browser!.vite
            registerPingHandler(vite)
            probe = await registerOverSocket(
              toWebSocketUrl(vite),
              redirectMock('traversal:inroot.js'),
            )
          }
          catch (error) {
            probe = error as Error
          }
        },
      },
    ],
  })

  expect(errorTree(), stderr).toEqual({
    'basic.test.js': {
      'accepts a redirect inside the root': 'passed',
      'rejects a redirect outside of the allowed directories': 'passed',
      'rejects a redirect to a denied file inside the root': 'passed',
    },
  })
  // the browser server's own Vite socket is reachable without the API token,
  // so it must not accept mock registrations at all
  expect(probe).toEqual({ acknowledged: false })
})
