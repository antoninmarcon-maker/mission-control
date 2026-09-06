// @vitest-environment node
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { POST, PUT } from '@/app/api/tasks/[id]/clarification/route'
import { CLARIFICATION_READY_SQL } from '@/lib/task-clarification'

const state = vi.hoisted(() => ({ db: null as any, user: { id: 1, role: 'operator', workspace_id: 1, username: 'antonin', agent_name: null as string | null } }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db }))
vi.mock('@/lib/auth', () => ({ requireRole: () => state.user.role === 'viewer' ? { error: 'Forbidden', status: 403 } : { user: state.user } }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: () => {} } }))
const questions = [{ id: 'q', prompt: 'Périmètre ?', multiple: false, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }]
const request = (method: string, body: unknown) => new NextRequest('http://localhost/api/tasks/1/clarification', { method, body: JSON.stringify(body) })
const params = { params: Promise.resolve({ id: '1' }) }
beforeEach(() => {
  state.user = { id: 1, role: 'operator', workspace_id: 1, username: 'antonin', agent_name: null }
  state.db = new Database(':memory:')
  state.db.exec("CREATE TABLE tasks(id INTEGER, status TEXT, assigned_to TEXT, metadata TEXT, updated_at INTEGER, workspace_id INTEGER); INSERT INTO tasks VALUES (1,'assigned','worker','{\"other\":42}',0,1)")
})
afterEach(() => state.db.close())

describe('clarification API', () => {
  it('persists the block and only releases it after a complete human answer', async () => {
    const opened = await POST(request('POST', { questions }), params)
    expect(opened.status).toBe(201)
    const { clarification } = await opened.json()
    expect(state.db.prepare(`SELECT id FROM tasks WHERE ${CLARIFICATION_READY_SQL}`).all()).toEqual([])
    const invalid = await PUT(request('PUT', { revision: clarification.revision, answers: [{ questionId: 'q', selected: [], text: '' }] }), params)
    expect(invalid.status).toBe(400)
    const answer = await PUT(request('PUT', { revision: clarification.revision, answers: [{ questionId: 'q', selected: ['b'], text: '' }] }), params)
    expect(answer.status).toBe(200)
    const row = state.db.prepare('SELECT * FROM tasks').get() as any
    expect(row.status).toBe('assigned')
    expect(JSON.parse(row.metadata)).toMatchObject({ other: 42, clarification: { state: 'answered', answeredBy: 'antonin', answers: [{ questionId: 'q', selected: ['b'], text: '' }] } })
    expect(state.db.prepare(`SELECT id FROM tasks WHERE ${CLARIFICATION_READY_SQL}`).all()).toEqual([{ id: 1 }])
    expect((await PUT(request('PUT', { revision: clarification.revision, answers: [{ questionId: 'q', selected: ['a'], text: '' }] }), params)).status).toBe(409)
  })
  it('rejects stale revisions, foreign workspaces and agent self-approval', async () => {
    const opened = await POST(request('POST', { questions }), params)
    const { clarification } = await opened.json()
    const body = { revision: 'stale', answers: [{ questionId: 'q', selected: ['a'], text: '' }] }
    expect((await PUT(request('PUT', body), params)).status).toBe(409)
    state.user.agent_name = 'worker'
    expect((await PUT(request('PUT', { ...body, revision: clarification.revision }), params)).status).toBe(403)
    state.user.agent_name = null; state.user.workspace_id = 2
    expect((await POST(request('POST', { questions }), params)).status).toBe(404)
  })
  it('refuses recadrage during an active run, viewers, invalid IDs and replacing existing decisions', async () => {
    state.db.prepare("UPDATE tasks SET status = 'in_progress'").run()
    expect((await POST(request('POST', { questions }), params)).status).toBe(409)
    state.db.prepare("UPDATE tasks SET status = 'assigned'").run()
    state.user.role = 'viewer'
    expect((await POST(request('POST', { questions }), params)).status).toBe(403)
    state.user.role = 'operator'
    expect((await POST(request('POST', { questions }), { params: Promise.resolve({ id: '1x' }) })).status).toBe(400)
    expect((await POST(request('POST', { questions }), params)).status).toBe(201)
    expect((await POST(request('POST', { questions }), params)).status).toBe(409)
  })
})
