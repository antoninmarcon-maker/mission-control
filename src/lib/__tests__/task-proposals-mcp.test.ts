import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const root = process.cwd()
const mcpScript = join(root, 'scripts/mc-mcp-server.cjs')
const cliScript = join(root, 'scripts/mc-cli.cjs')
const apiKey = 'test-api-key-that-must-not-leak'
const proposal = {
  sourceType: 'chat',
  sourceRef: 'conversation:abc:message:17',
  idempotencyKey: 'chat:abc:17:repair-login',
  title: 'Repair the login redirect',
  objective: 'Preserve callbackUrl through authentication.',
  context: 'The audit result in message 17 identified the dropped parameter.',
  rationale: 'This is the remaining actionable finding.',
  risk: 'medium',
  routeForecast: { runtime: 'codex', reason: 'Repository change with tests.' },
}

const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceType: { type: 'string', enum: ['chat', 'event'] },
    sourceRef: { type: 'string', minLength: 1, maxLength: 500 },
    idempotencyKey: { type: 'string', minLength: 1, maxLength: 240 },
    title: { type: 'string', minLength: 1, maxLength: 240 },
    objective: { type: 'string', minLength: 1, maxLength: 2000 },
    context: { type: 'string', minLength: 1, maxLength: 8000 },
    rationale: { type: 'string', minLength: 1, maxLength: 2000 },
    risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
    routeForecast: {
      type: 'object', additionalProperties: false,
      properties: {
        runtime: { type: 'string', enum: ['local', 'codex', 'claude'] },
        model: { type: 'string', minLength: 1, maxLength: 200 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['runtime', 'reason'],
    },
    projectId: { type: 'integer', minimum: 1 },
    metadata: { type: 'object', additionalProperties: true },
    expiresAt: { type: 'integer', minimum: 1 },
  },
  required: ['sourceType', 'sourceRef', 'idempotencyKey', 'title', 'objective', 'context', 'rationale', 'risk'],
}

type RequestRecord = { method: string; url: string; body: unknown; apiKey: string | undefined }

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks).toString('utf8')
  return body ? JSON.parse(body) : undefined
}

async function startApi(handler: (record: RequestRecord, response: ServerResponse) => void | Promise<void>) {
  const requests: RequestRecord[] = []
  const server = createServer(async (request, response) => {
    const record = {
      method: request.method || '', url: request.url || '', body: await readBody(request),
      apiKey: typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'] : undefined,
    }
    requests.push(record)
    await handler(record, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function closedLoopbackUrl() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return `http://127.0.0.1:${address.port}`
}

async function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cliScript, ...args], { cwd: root, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

async function startMcp(baseUrl: string) {
  const child = spawn(process.execPath, [mcpScript], {
    cwd: root,
    env: { ...process.env, MC_URL: baseUrl, MC_API_KEY: apiKey },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const responses = new Map<number, (response: any) => void>()
  let buffered = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    buffered += String(chunk)
    const lines = buffered.split('\n')
    buffered = lines.pop() || ''
    for (const line of lines) {
      if (!line) continue
      const response = JSON.parse(line)
      responses.get(response.id)?.(response)
      responses.delete(response.id)
    }
  })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const request = (id: number, method: string, params?: unknown) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP ${method}: ${stderr}`)), 5_000)
    responses.set(id, response => { clearTimeout(timer); resolve(response) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
  })
  return {
    request,
    close: async () => {
      child.kill()
      await new Promise<void>(resolve => child.once('close', () => resolve()))
    },
  }
}

describe('task proposal orchestrator interfaces', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  })

  it('lists strict proposal MCP contracts and forwards the exact create body once', async () => {
    const api = await startApi((request, response) => {
      expect(request).toMatchObject({ method: 'POST', url: '/api/task-proposals', body: proposal, apiKey })
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ proposal: { id: 73, revision: '11111111-2222-4333-8444-555555555555' } }))
    })
    cleanups.push(api.close)
    const mcp = await startMcp(api.baseUrl)
    cleanups.push(mcp.close)

    const listed = await mcp.request(1, 'tools/list')
    const tools = listed.result.tools.filter((tool: { name: string }) => tool.name.startsWith('task_proposals_'))
    expect(tools).toEqual([
      expect.objectContaining({ name: 'task_proposals_create', inputSchema: proposalSchema }),
      expect.objectContaining({
        name: 'task_proposals_list',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['pending', 'accepted', 'dismissed', 'expired'] },
            sourceType: { type: 'string', enum: ['chat', 'event'] },
            sourceRef: { type: 'string', minLength: 1, maxLength: 500 },
            projectId: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            summary: { type: 'boolean' },
          },
          required: [],
        },
      }),
    ])

    const created = await mcp.request(2, 'tools/call', { name: 'task_proposals_create', arguments: proposal })
    expect(JSON.parse(created.result.content[0].text)).toEqual({ proposal: { id: 73, revision: '11111111-2222-4333-8444-555555555555' } })
    expect(api.requests).toHaveLength(1)
  })

  it('encodes proposal list filters without exposing a route decision', async () => {
    const api = await startApi((request, response) => {
      expect(request).toMatchObject({ method: 'GET', url: '/api/task-proposals?status=pending&source_type=chat&source_ref=conversation%3Aabc%3Amessage%3A17&project_id=4&limit=20&offset=3&summary=1', body: undefined, apiKey })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ proposals: [], total: 0, limit: 20, offset: 3 }))
    })
    cleanups.push(api.close)
    const mcp = await startMcp(api.baseUrl)
    cleanups.push(mcp.close)

    const listed = await mcp.request(1, 'tools/call', {
      name: 'task_proposals_list',
      arguments: { status: 'pending', sourceType: 'chat', sourceRef: 'conversation:abc:message:17', projectId: 4, limit: 20, offset: 3, summary: true },
    })
    expect(JSON.parse(listed.result.content[0].text)).toEqual({ proposals: [], total: 0, limit: 20, offset: 3 })
  })

  it('posts an absolute proposal JSON file and validates input before network calls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mc-proposal-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'proposal.json')
    await writeFile(file, JSON.stringify(proposal))
    const api = await startApi((request, response) => {
      expect(request).toMatchObject({ method: 'POST', url: '/api/task-proposals', body: proposal, apiKey })
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ proposal: { id: 73, revision: '11111111-2222-4333-8444-555555555555' } }))
    })
    cleanups.push(api.close)

    const created = await runCli(['proposals', 'create', '--json-file', file, '--url', api.baseUrl, '--api-key', apiKey, '--json'])
    expect(created).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(created.stdout)).toMatchObject({ ok: true, data: { proposal: { id: 73, revision: '11111111-2222-4333-8444-555555555555' } } })
    expect(api.requests).toHaveLength(1)

    const invalidFile = join(directory, 'invalid.json')
    await writeFile(invalidFile, JSON.stringify({ ...proposal, unexpected: true }))
    const invalid = await runCli(['proposals', 'create', '--json-file', invalidFile, '--url', api.baseUrl, '--api-key', apiKey, '--json'])
    expect(invalid.code).toBe(2)
    expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(apiKey)
    expect(api.requests).toHaveLength(1)
  })

  it('rejects relative, oversized, and malformed proposal files without leaking API keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mc-proposal-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const malformed = join(directory, 'malformed.json')
    const oversized = join(directory, 'oversized.json')
    await writeFile(malformed, '{invalid')
    await writeFile(oversized, 'x'.repeat(64 * 1024 + 1))
    const api = await startApi(() => { throw new Error('Validation must complete before network access') })
    cleanups.push(api.close)

    for (const file of ['relative.json', malformed, oversized]) {
      const result = await runCli(['proposals', 'create', '--json-file', file, '--url', api.baseUrl, '--api-key', apiKey, '--json'])
      expect(result.code).toBe(2)
      expect(`${result.stdout}${result.stderr}`).not.toContain(apiKey)
    }
    expect(api.requests).toHaveLength(0)
  })

  it('encodes proposal list filters through the CLI', async () => {
    const api = await startApi((request, response) => {
      expect(request).toMatchObject({ method: 'GET', url: '/api/task-proposals?status=pending&source_type=chat', body: undefined, apiKey })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ proposals: [], total: 0, limit: 50, offset: 0 }))
    })
    cleanups.push(api.close)

    const result = await runCli(['proposals', 'list', '--status', 'pending', '--source-type', 'chat', '--url', api.baseUrl, '--api-key', apiKey, '--json'])
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { proposals: [] } })
  })

  it('redacts API keys from proposal errors returned by the API', async () => {
    const api = await startApi((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: `Request rejected: api_key=${apiKey}` }))
    })
    cleanups.push(api.close)

    const cli = await runCli(['proposals', 'list', '--url', api.baseUrl, '--api-key', apiKey, '--json'])
    expect(cli.code).toBe(3)
    expect(`${cli.stdout}${cli.stderr}`).not.toContain(apiKey)
    expect(`${cli.stdout}${cli.stderr}`).toContain('***REDACTED***')

    const mcp = await startMcp(api.baseUrl)
    cleanups.push(mcp.close)
    const response = await mcp.request(1, 'tools/call', { name: 'task_proposals_list', arguments: {} })
    expect(response.result.content[0].text).not.toContain(apiKey)
    expect(response.result.content[0].text).toContain('***REDACTED***')
  })

  it('redacts nested sensitive fields and JSON-labelled bearer credentials while preserving error context', async () => {
    const upstreamSecret = 'upstream-test-secret'
    const bearerToken = 'Bearer upstream-test-token'
    const api = await startApi((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        error: {
          message: 'Upstream proposal validation failed',
          api_key: upstreamSecret,
          apiKey: upstreamSecret,
          'x-api-key': upstreamSecret,
          authorization: bearerToken,
          nested: [{ token: upstreamSecret }, { cookie: upstreamSecret }, { secret: upstreamSecret }, { access_token: upstreamSecret }, { refreshToken: upstreamSecret }],
          diagnostic: `{"api_key":"${upstreamSecret}","authorization":"${bearerToken}"}`,
        },
      }))
    })
    cleanups.push(api.close)

    const cli = await runCli(['proposals', 'list', '--url', api.baseUrl, '--api-key', apiKey, '--json'])
    const cliOutput = `${cli.stdout}${cli.stderr}`
    expect(cli.code).toBe(2)
    expect(cliOutput).toContain('Upstream proposal validation failed')
    expect(cliOutput).not.toContain(upstreamSecret)
    expect(cliOutput).not.toContain(bearerToken)
    expect(cliOutput).not.toContain('upstream-test-token')
    expect(cliOutput).toContain('***REDACTED***')

    const mcp = await startMcp(api.baseUrl)
    cleanups.push(mcp.close)
    const response = await mcp.request(1, 'tools/call', { name: 'task_proposals_list', arguments: {} })
    const mcpOutput = response.result.content[0].text
    expect(mcpOutput).toContain('Upstream proposal validation failed')
    expect(mcpOutput).not.toContain(upstreamSecret)
    expect(mcpOutput).not.toContain(bearerToken)
    expect(mcpOutput).not.toContain('upstream-test-token')
    expect(mcpOutput).toContain('***REDACTED***')
  })

  it('rejects invalid proposal list filters before networking and encodes explicit summary booleans', async () => {
    const api = await startApi((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ proposals: [], total: 0, limit: 50, offset: 0, request: request.url }))
    })
    cleanups.push(api.close)

    for (const args of [
      ['--status'], ['--status', 'waiting'], ['--source-type'], ['--source-type', 'task'], ['--summary', '1'], ['--summary', 'yes'],
    ]) {
      const result = await runCli(['proposals', 'list', ...args, '--url', api.baseUrl, '--api-key', apiKey, '--json'])
      expect(result.code).toBe(2)
    }
    expect(api.requests).toHaveLength(0)

    const mcp = await startMcp(api.baseUrl)
    cleanups.push(mcp.close)
    const invalidMcp = await mcp.request(1, 'tools/call', { name: 'task_proposals_list', arguments: { status: true } })
    expect(invalidMcp.result).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('Invalid proposal filter: status') }] })
    expect(api.requests).toHaveLength(0)

    for (const [summary, expected] of [[[], 'summary=1'], [['true'], 'summary=1'], [['false'], 'summary=0']] as const) {
      const result = await runCli(['proposals', 'list', '--summary', ...summary, '--url', api.baseUrl, '--api-key', apiKey, '--json'])
      expect(result.code).toBe(0)
      expect(api.requests.at(-1)?.url).toBe(`/api/task-proposals?${expected}`)
    }
  })

  it('returns the network exit code for proposal commands when the endpoint is closed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mc-proposal-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const file = join(directory, 'proposal.json')
    await writeFile(file, JSON.stringify(proposal))
    const baseUrl = await closedLoopbackUrl()

    const list = await runCli(['proposals', 'list', '--url', baseUrl, '--api-key', apiKey, '--json'])
    const create = await runCli(['proposals', 'create', '--json-file', file, '--url', baseUrl, '--api-key', apiKey, '--json'])
    expect(list.code).toBe(5)
    expect(create.code).toBe(5)
  })
})
