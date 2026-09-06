// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { GET, POST } from '@/app/api/task-proposals/route'
import { PUT } from '@/app/api/task-proposals/[id]/route'
import { POST as ACCEPT } from '@/app/api/task-proposals/[id]/accept/route'
import { GET as INDEX } from '@/app/api/index/route'
import { createSession, hashApiKey } from '@/lib/auth'
import { config } from '@/lib/config'
import { eventBus, eventBelongsToWorkspace, type ServerEvent } from '@/lib/event-bus'
import { runMigrations } from '@/lib/migrations'
import { CLARIFICATION_READY_SQL } from '@/lib/task-clarification'
import type { TaskProposal } from '@/lib/task-proposals'

// Only replace the application singleton; SQL, migrations, auth, limiter and events are real.
const state = vi.hoisted(() => ({ db: null as unknown as Database.Database, context: null as AsyncLocalStorage<Database.Database> | null }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.context?.getStore() ?? state.db }))
state.context = new AsyncLocalStorage<Database.Database>()
const input = {
  sourceType: 'chat', sourceRef: 'chat:42', idempotencyKey: 'chat:42:repair',
  title: 'Repair login', objective: 'Restore redirects', context: 'private-transcript-secret',
  rationale: 'private-rationale-secret', risk: 'high',
  routeForecast: { runtime: 'codex', reason: 'private-route-secret' },
  metadata: { token: 'private-token-secret' },
}
let directory: string
let events: ServerEvent[]
let human: Record<string, string>
let viewer: Record<string, string>
let other: Record<string, string>
let agent: Record<string, string>
let projectId: number
const originalCoordinator = config.coordinatorAgent
const capture = (event: ServerEvent) => events.push(event)
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const request = (method: string, body?: unknown, headers = human, query = '') => new NextRequest(
  `http://localhost/api/task-proposals${query ? `?${query}` : ''}`,
  { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
)
const create = (patch: Record<string, unknown> = {}, headers = agent) => POST(request('POST', { ...input, ...patch }, headers))
const accept = (id: number | string, revision: string, headers = human) => ACCEPT(request('POST', { revision }, headers), params(id))
const edit = (id: number | string, body: unknown, headers = human) => PUT(request('PUT', body, headers), params(id))
const list = (query = '', headers = viewer) => GET(request('GET', undefined, headers, query))
const row = (id: number) => state.db.prepare('SELECT * FROM task_proposals WHERE id = ?').get(id) as Record<string, unknown>
const taskCount = () => (state.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count
async function proposal(patch: Record<string, unknown> = {}, headers = agent): Promise<TaskProposal> {
  const response = await create({ idempotencyKey: randomUUID(), ...patch }, headers)
  expect(response.status).toBe(201)
  return (await response.json()).proposal
}
function session(username: string, role: string, workspaceId: number) {
  const id = Number(state.db.prepare('INSERT INTO users (username, display_name, password_hash, role, workspace_id) VALUES (?, ?, ?, ?, ?)')
    .run(username, username, 'unused', role, workspaceId).lastInsertRowid)
  return { cookie: `mc-session=${createSession(id, undefined, undefined, workspaceId).token}` }
}
beforeEach(() => {
  vi.stubEnv('MC_DISABLE_RATE_LIMIT', '1')
  vi.stubEnv('API_KEY', 'test-global-key')
  vi.stubEnv('MC_PROXY_AUTH_HEADER', '')
  directory = mkdtempSync(join(tmpdir(), 'mc-proposal-routes-'))
  state.db = new Database(join(directory, 'test.db'))
  state.db.pragma('foreign_keys = ON')
  state.db.pragma('journal_mode = WAL')
  runMigrations(state.db)
  human = session('antonin', 'operator', 1)
  viewer = session('reader', 'viewer', 1)
  other = session('other', 'operator', 2)
  const agentId = state.db.prepare("INSERT INTO agents (name, role, workspace_id) VALUES ('antonin-policy-engine', 'orchestrator', 1)").run().lastInsertRowid
  state.db.prepare('INSERT INTO agent_api_keys (agent_id, workspace_id, name, key_hash, key_prefix, scopes) VALUES (?, 1, ?, ?, ?, ?)')
    .run(agentId, 'producer', hashApiKey('test-agent-key'), 'test', '["operator"]')
  agent = { 'x-api-key': 'test-agent-key' }
  projectId = (state.db.prepare('SELECT id FROM projects WHERE workspace_id = 1 LIMIT 1').get() as { id: number }).id
  config.coordinatorAgent = 'configured-coordinator'
  events = []
  eventBus.on('server-event', capture)
})
afterEach(() => {
  eventBus.off('server-event', capture)
  state.db.close()
  rmSync(directory, { recursive: true, force: true })
  config.coordinatorAgent = originalCoordinator
  vi.unstubAllEnvs()
})

describe('proposal ingestion and listing', () => {
  it('derives identity, deduplicates only within the workspace, and audits without private data', async () => {
    const first = await create({ orchestratorAgent: 'attacker', createdBy: 'attacker' })
    expect(first.status).toBe(201)
    const stored = (await first.json()).proposal
    expect(stored).toMatchObject({ orchestratorAgent: 'antonin-policy-engine', createdBy: 'antonin-policy-engine', status: 'pending', workspaceId: 1 })
    const duplicate = await create({ title: 'Replacement' })
    expect(duplicate.status).toBe(200)
    expect((await duplicate.json()).proposal).toEqual(stored)
    expect((await create({}, other)).status).toBe(201)
    expect((await (await list('status=pending')).json()).total).toBe(1)
    expect(taskCount()).toBe(0)
    expect(events.filter(e => e.type === 'proposal.created')).toHaveLength(2)
    const audit = state.db.prepare("SELECT * FROM audit_log WHERE action = 'proposal.duplicate_suppressed'").all() as Array<Record<string, unknown>>
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ workspace_id: 1, target_id: stored.id })
    expect(JSON.parse(String(audit[0].detail))).toMatchObject({ proposalId: stored.id, sourceType: 'chat', revision: stored.revision, actor: 'antonin-policy-engine' })
    expect(JSON.stringify(audit)).not.toContain('private-')
  })

  it('allows human ingestion only with a configured coordinator', async () => {
    config.coordinatorAgent = '  '
    expect((await create({}, human)).status).toBe(409)
    expect((await create({}, { 'x-api-key': 'test-global-key' })).status).toBe(409)
    config.coordinatorAgent = ' configured-coordinator '
    expect(await proposal({}, human)).toMatchObject({ orchestratorAgent: 'configured-coordinator', createdBy: 'antonin' })
    expect(await proposal()).toMatchObject({ orchestratorAgent: 'antonin-policy-engine' })
  })

  it.each([
    ['human', '', 409],
    ['human', 'configured-coordinator', 201],
    ['global key', '', 409],
    ['global key', 'configured-coordinator', 409],
  ] as const)('ignores agent attribution on a %s with coordinator "%s"', async (identity, coordinator, status) => {
    config.coordinatorAgent = coordinator
    const headers = { ...(identity === 'human' ? human : { 'x-api-key': 'test-global-key' }), 'x-agent-name': 'caller-controlled-agent' }
    const response = await create({}, headers)
    expect(response.status).toBe(status)
    if (status === 201) {
      const { proposal: created } = await response.json()
      expect(created).toMatchObject({ orchestratorAgent: 'configured-coordinator', createdBy: 'antonin' })
      const duplicate = await create({}, headers)
      expect(duplicate.status).toBe(200)
      expect((await duplicate.json()).proposal).toEqual(created)
      const audits = state.db.prepare("SELECT actor, detail FROM audit_log WHERE target_type = 'task_proposal'").all()
      expect(audits).toHaveLength(2)
      expect(audits).toEqual(expect.arrayContaining([expect.objectContaining({ actor: 'antonin' })]))
      expect(JSON.stringify(audits)).not.toContain('caller-controlled-agent')
      const accepted = await accept(created.id, created.revision)
      expect(accepted.status).toBe(200)
      expect((await accepted.json()).task.assigned_to).toBe('configured-coordinator')
    } else {
      expect(state.db.prepare('SELECT COUNT(*) AS count FROM task_proposals').get()).toEqual({ count: 0 })
      expect(state.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target_type = 'task_proposal'").get()).toEqual({ count: 0 })
      expect(taskCount()).toBe(0)
    }
  })

  it('keeps authenticated admin-agent ownership despite a different attribution name', async () => {
    config.coordinatorAgent = ''
    state.db.prepare("UPDATE agent_api_keys SET scopes = '[\"admin\"]'").run()
    const headers = { ...agent, 'x-agent-name': 'caller-controlled-agent' }
    const p = await proposal({}, headers)
    expect(p).toMatchObject({ orchestratorAgent: 'antonin-policy-engine', createdBy: 'antonin-policy-engine' })
    expect((await accept(p.id, p.revision, headers)).status).toBe(403)
  })

  it('uses the human credential when a session and agent key are both supplied', async () => {
    const headers = { ...human, ...agent, 'x-agent-name': 'caller-controlled-agent' }
    const p = await proposal({}, headers)
    expect(p).toMatchObject({ orchestratorAgent: 'configured-coordinator', createdBy: 'antonin' })
  })

  it('rejects invalid input and foreign projects without writes', async () => {
    const foreignProject = state.db.prepare("INSERT INTO projects (workspace_id, name, slug, ticket_prefix) VALUES (2, 'Other', 'other', 'OTH')").run().lastInsertRowid
    expect((await create({ projectId: Number(foreignProject) })).status).toBe(404)
    expect((await create({ title: '', metadata: null })).status).toBe(400)
    expect((await POST(new NextRequest('http://localhost/api/task-proposals', { method: 'POST', headers: agent, body: '{bad' }))).status).toBe(400)
    expect((await list()).status).toBe(200)
    expect((await (await list()).json()).total).toBe(0)
  })

  it('filters and paginates deterministically with a 200 row cap', async () => {
    const first = await proposal({ projectId })
    await proposal({ sourceType: 'event', sourceRef: 'run:1' })
    await proposal({ sourceType: 'event', sourceRef: 'run:1' })
    const filtered = await (await list(`source_type=chat&source_ref=chat%3A42&project_id=${projectId}`)).json()
    expect(filtered).toMatchObject({ total: 1, proposals: [{ id: first.id }] })
    const page = await (await list('source_type=event&limit=1&offset=1')).json()
    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1 })
    expect(page.proposals).toHaveLength(1)
    expect((await (await list('limit=999')).json()).limit).toBe(200)
    expect((await (await list('offset=99')).json()).proposals).toEqual([])
    for (const query of ['limit=NaN', 'offset=-1', 'limit=0', 'status=bad', 'source_type=bad', 'project_id=1x', 'summary=bad']) {
      expect((await list(query)).status, query).toBe(400)
    }
  })

  it('enforces real authentication and viewer permissions on every mutation', async () => {
    const p = await proposal()
    expect((await list('', {})).status).toBe(401)
    expect((await create({}, {})).status).toBe(401)
    expect((await create({}, viewer)).status).toBe(403)
    expect((await edit(p.id, { action: 'edit', revision: p.revision }, viewer)).status).toBe(403)
    expect((await edit(p.id, { action: 'dismiss', revision: p.revision }, viewer)).status).toBe(403)
    expect((await accept(p.id, p.revision, viewer)).status).toBe(403)
  })
})

describe('proposal decisions', () => {
  it('isolates list, edit, dismissal and acceptance from foreign workspaces', async () => {
    const p = await proposal()
    expect(await (await list('', other)).json()).toMatchObject({ total: 0, proposals: [] })
    for (const action of ['edit', 'dismiss']) {
      expect((await edit(p.id, { revision: p.revision, action, title: 'Hijack' }, other)).status).toBe(404)
    }
    expect((await accept(p.id, p.revision, other)).status).toBe(404)
    expect(row(p.id)).toMatchObject({ title: 'Repair login', status: 'pending', revision: p.revision })
    expect(taskCount()).toBe(0)
  })

  it('edits with revision CAS then dismisses once, preserving ownership and audit history', async () => {
    const p = await proposal()
    expect((await edit(p.id, { action: 'edit', revision: randomUUID(), title: 'Stale' })).status).toBe(409)
    const edited = await edit(p.id, { action: 'edit', revision: p.revision, title: ' Approved title ', objective: 'Approved objective', context: 'private-edit-secret', risk: 'critical', orchestratorAgent: 'attacker' })
    expect(edited.status).toBe(200)
    const updated = (await edited.json()).proposal
    expect(updated).toMatchObject({ title: 'Approved title', objective: 'Approved objective', risk: 'high', orchestratorAgent: 'antonin-policy-engine' })
    expect(updated.revision).not.toBe(p.revision)
    expect((await edit(p.id, { action: 'dismiss', revision: p.revision })).status).toBe(409)
    const dismissed = await edit(p.id, { action: 'dismiss', revision: updated.revision, dismissalReason: 'private-dismissal-secret' })
    expect(dismissed.status).toBe(200)
    const final = (await dismissed.json()).proposal
    expect(final).toMatchObject({ status: 'dismissed', dismissedBy: 'antonin', dismissedAt: expect.any(Number), dismissalReason: 'private-dismissal-secret' })
    expect(final.revision).not.toBe(updated.revision)
    expect((await accept(p.id, final.revision)).status).toBe(409)
    expect((await edit(p.id, { action: 'edit', revision: final.revision })).status).toBe(409)
    expect((await edit(p.id, { action: 'dismiss', revision: final.revision })).status).toBe(409)
    expect(events.map(e => e.type)).toEqual(['proposal.created', 'proposal.updated', 'proposal.dismissed'])
    const audit = state.db.prepare("SELECT action, detail FROM audit_log WHERE target_type = 'task_proposal' ORDER BY id").all() as Array<{ action: string; detail: string }>
    expect(audit.map(a => a.action)).toEqual(['proposal.created', 'proposal.updated', 'proposal.dismissed'])
    expect(JSON.stringify(audit)).not.toContain('private-')
    expect(JSON.stringify(events)).not.toContain('private-')
    expect(events.every(e => eventBelongsToWorkspace(e, 1) && !eventBelongsToWorkspace(e, 2))).toBe(true)
  })

  it('atomically creates a project ticket and returns the same linked task on concurrent retries across two connections', async () => {
    const p = await proposal({ projectId })
    expect((await accept(p.id, randomUUID())).status).toBe(409)
    const originalDb = state.db
    const second = new Database(join(directory, 'test.db'))
    second.pragma('foreign_keys = ON')
    try {
      const [a, b] = await Promise.all([
        state.context!.run(originalDb, () => accept(p.id, p.revision)),
        state.context!.run(second, () => accept(p.id, p.revision)),
      ])
      expect([a.status, b.status]).toEqual([200, 200])
      const result = await a.json()
      expect((await b.json()).task).toEqual(result.task)
      expect(result.proposal).toMatchObject({ status: 'accepted', acceptedBy: 'antonin', taskId: result.task.id })
      expect(result.task).toMatchObject({ status: 'assigned', assigned_to: 'antonin-policy-engine', created_by: 'antonin', priority: 'high', workspace_id: 1, project_id: projectId, project_ticket_no: 1,
        description: 'Restore redirects\n\n## Context\nprivate-transcript-secret\n\n## Why now\nprivate-rationale-secret',
        metadata: { proposal: { id: p.id, source_type: 'chat', source_ref: 'chat:42', accepted_by: 'antonin', accepted_user_id: expect.any(Number), execution_owner: 'external_orchestrator', route_forecast: { runtime: 'codex', reason: 'private-route-secret' } } },
      })
      expect(result.task.metadata).not.toHaveProperty('token')
      const approver = state.db.prepare("SELECT id FROM users WHERE username = 'antonin'").get() as { id: number }
      expect(result.task.metadata.proposal.accepted_user_id).toBe(approver.id)
      expect(result.proposal.metadata.accepted_user_id).toBe(approver.id)
      expect(taskCount()).toBe(1)
      expect(state.db.prepare(`SELECT id FROM tasks WHERE ${CLARIFICATION_READY_SQL}`).all()).toEqual([{ id: result.task.id }])
      expect((await accept(p.id, p.revision)).status).toBe(200)
      expect(events.filter(e => e.type === 'proposal.accepted')).toHaveLength(1)
      expect(events.filter(e => e.type === 'task.created')).toHaveLength(1)
      expect(JSON.stringify(events)).not.toContain('private-')
      const audits = state.db.prepare("SELECT * FROM audit_log WHERE action = 'proposal.accepted'").all() as Array<{ detail: string; workspace_id: number }>
      expect(audits).toHaveLength(1)
      expect(audits[0].workspace_id).toBe(1)
      expect(JSON.parse(audits[0].detail)).toMatchObject({ proposalId: p.id, taskId: result.task.id, actor: 'antonin', revision: result.proposal.revision })
    } finally { second.close() }
  })

  it('accepts only the current edited content and rejects the old approval revision', async () => {
    const p = await proposal()
    const edited = await (await edit(p.id, { action: 'edit', revision: p.revision, title: 'Approved title', objective: 'Approved objective', context: 'Approved context' })).json()
    expect((await accept(p.id, p.revision)).status).toBe(409)
    const response = await accept(p.id, edited.proposal.revision)
    expect(response.status).toBe(200)
    expect((await response.json()).task).toMatchObject({ title: 'Approved title', description: 'Approved objective\n\n## Context\nApproved context\n\n## Why now\nprivate-rationale-secret' })
  })

  it('serializes competing edit/dismiss and accept decisions with no rejected content launched', async () => {
    for (const action of ['edit', 'dismiss']) {
      const p = await proposal()
      const before = taskCount()
      const [decision, accepted] = await Promise.all([
        edit(p.id, { action, revision: p.revision, title: 'Changed title' }),
        accept(p.id, p.revision),
      ])
      expect([decision.status, accepted.status].sort()).toEqual([200, 409])
      expect(taskCount() - before).toBe(row(p.id).status === 'accepted' ? 1 : 0)
    }
  })

  it('rejects a stored project that now belongs to another workspace without consuming its ticket', async () => {
    const p = await proposal({ projectId })
    state.db.prepare('UPDATE projects SET workspace_id = 2 WHERE id = ?').run(projectId)
    expect((await accept(p.id, p.revision)).status).toBe(409)
    expect(taskCount()).toBe(0)
    expect(state.db.prepare('SELECT ticket_counter FROM projects WHERE id = ?').get(projectId)).toEqual({ ticket_counter: 0 })
  })

  it.each(['low', 'medium', 'high', 'critical'])('maps %s risk directly to task priority without choosing execution policy', async risk => {
    const p = await proposal({ risk, routeForecast: undefined })
    const result = await (await accept(p.id, p.revision)).json()
    expect(result.task.priority).toBe(risk)
    expect(result.task.project_id).toBeNull()
    expect(result.task.metadata.proposal).not.toHaveProperty('final_route')
  })

  it('rejects agent keys, elevated agent keys, agent-labelled sessions and identity-less API keys', async () => {
    const p = await proposal()
    expect((await accept(p.id, p.revision, agent)).status).toBe(403)
    state.db.prepare("UPDATE agent_api_keys SET scopes = '[\"admin\"]'").run()
    expect((await accept(p.id, p.revision, agent)).status).toBe(403)
    expect((await accept(p.id, p.revision, { ...human, 'x-agent-name': 'worker' })).status).toBe(403)
    expect((await accept(p.id, p.revision, { 'x-api-key': 'test-global-key' })).status).toBe(403)
    expect(taskCount()).toBe(0)
  })

  it('rejects invalid IDs, malformed bodies and non-UUID revisions', async () => {
    const p = await proposal()
    for (const id of ['0', '1x', '-1', '9007199254740992']) {
      expect((await accept(id, p.revision)).status).toBe(400)
      expect((await edit(id, { action: 'edit', revision: p.revision })).status).toBe(400)
    }
    expect((await accept(9999, p.revision)).status).toBe(404)
    expect((await edit(9999, { action: 'edit', revision: p.revision })).status).toBe(404)
    expect((await accept(p.id, 'not-uuid')).status).toBe(400)
    expect((await edit(p.id, { action: 'edit', revision: p.revision, title: '' })).status).toBe(400)
    for (const [method, handler] of [['PUT', PUT], ['POST', ACCEPT]] as const) {
      const bad = new NextRequest('http://localhost/api/task-proposals', { method, headers: human, body: '{bad' })
      expect((await handler(bad, params(p.id))).status).toBe(400)
    }
  })

  it('rolls back task creation, project counter, acceptance and events if lifecycle audit fails', async () => {
    const p = await proposal({ projectId })
    state.db.exec("CREATE TRIGGER reject_accept_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'proposal.accepted' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END")
    expect((await accept(p.id, p.revision)).status).toBe(500)
    expect(taskCount()).toBe(0)
    expect(row(p.id)).toMatchObject({ status: 'pending', revision: p.revision, task_id: null })
    expect(state.db.prepare('SELECT ticket_counter FROM projects WHERE id = ?').get(projectId)).toEqual({ ticket_counter: 0 })
    expect(events.map(e => e.type)).toEqual(['proposal.created'])
  })

  it.each(['metadata', 'route_forecast'])('fails closed on corrupt stored %s during listing and acceptance', async field => {
    const p = await proposal()
    state.db.prepare(`UPDATE task_proposals SET ${field} = ? WHERE id = ?`).run('{private-corrupt-secret', p.id)
    const listing = await list()
    const accepted = await accept(p.id, p.revision)
    expect([listing.status, accepted.status]).toEqual([500, 500])
    expect(await listing.text()).not.toContain('private-')
    expect(await accepted.text()).not.toContain('private-')
    expect(taskCount()).toBe(0)
    expect(row(p.id).status).toBe('pending')
  })

  it('fails closed for deleted or foreign linked tasks and empty stored orchestrators', async () => {
    const p = await proposal()
    state.db.prepare("UPDATE task_proposals SET orchestrator_agent = '' WHERE id = ?").run(p.id)
    expect((await accept(p.id, p.revision)).status).toBe(409)
    state.db.prepare("UPDATE task_proposals SET orchestrator_agent = 'antonin-policy-engine' WHERE id = ?").run(p.id)
    const result = await (await accept(p.id, p.revision)).json()
    state.db.prepare('UPDATE tasks SET workspace_id = 2 WHERE id = ?').run(result.task.id)
    expect((await accept(p.id, p.revision)).status).toBe(409)
    state.db.prepare('DELETE FROM tasks WHERE id = ?').run(result.task.id)
    expect((await accept(p.id, p.revision)).status).toBe(409)
    expect(taskCount()).toBe(0)
  })
})

describe('expiry and observability', () => {
  it.each(['list', 'accept', 'edit'])('expires due rows before %s, with one scoped event and audit per transition', async operation => {
    const p = await proposal()
    const foreign = await proposal({}, other)
    const now = Math.floor(Date.now() / 1000)
    state.db.prepare('UPDATE task_proposals SET expires_at = ? WHERE id IN (?, ?)').run(now, p.id, foreign.id)
    if (operation === 'list') expect(await (await list('status=expired')).json()).toMatchObject({ total: 1, proposals: [{ id: p.id, status: 'expired' }] })
    else if (operation === 'accept') expect((await accept(p.id, p.revision)).status).toBe(409)
    else expect((await edit(p.id, { action: 'edit', revision: p.revision })).status).toBe(409)
    expect(row(foreign.id).status).toBe('pending')
    expect(row(p.id).status).toBe('expired')
    expect(row(p.id).revision).not.toBe(p.revision)
    expect((await accept(p.id, p.revision)).status).toBe(409)
    expect((await list()).status).toBe(200)
    expect(taskCount()).toBe(0)
    const expired = events.filter(e => e.type === 'proposal.expired')
    expect(expired).toHaveLength(1)
    expect(expired[0].data).toMatchObject({ id: p.id, workspace_id: 1, status: 'expired' })
    expect(state.db.prepare("SELECT workspace_id, target_id FROM audit_log WHERE action = 'proposal.expired'").all()).toEqual([{ workspace_id: 1, target_id: p.id }])
  })

  it('aggregates lifecycle counts, duplicates, decision latency and valid route changes only within the workspace', async () => {
    const accepted = await proposal()
    const dismissed = await proposal()
    const expired = await proposal()
    await proposal()
    const malformed = await proposal()
    const foreign = await proposal({}, other)
    await create({ idempotencyKey: accepted.idempotencyKey })
    await create({ idempotencyKey: foreign.idempotencyKey }, other)
    await accept(accepted.id, accepted.revision)
    await accept(malformed.id, malformed.revision)
    await accept(foreign.id, foreign.revision, other)
    await edit(dismissed.id, { action: 'dismiss', revision: dismissed.revision })
    state.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.final_route.runtime', 'claude')").run()
    // Simulate a legacy/corrupt row: the recurring-task expression index otherwise rejects bad JSON on write.
    state.db.exec('DROP INDEX idx_tasks_recurring')
    state.db.prepare("UPDATE tasks SET metadata = '{bad' WHERE id = ?").run(row(malformed.id).task_id)
    state.db.prepare("UPDATE task_proposals SET created_at = 1000, accepted_at = 1020 WHERE status = 'accepted'").run()
    state.db.prepare("UPDATE task_proposals SET created_at = 1000, dismissed_at = 1040 WHERE status = 'dismissed'").run()
    state.db.prepare('UPDATE task_proposals SET created_at = 1000, expires_at = 1060 WHERE id = ?').run(expired.id)
    const result = await (await list('summary=1&status=pending&limit=1')).json()
    expect(result).toMatchObject({ total: 1, summary: { created: 5, pending: 1, accepted: 2, dismissed: 1, expired: 1, duplicateSuppressed: 1, averageDecisionLatencySeconds: 35, routeChanges: 1 } })
    expect(await (await list('summary=1', other)).json()).toMatchObject({ summary: { created: 1, accepted: 1, duplicateSuppressed: 1, averageDecisionLatencySeconds: 20, routeChanges: 1 } })
    expect(await (await list()).json()).not.toHaveProperty('summary')
  })

  it('reports zero counts and null latency for an empty workspace', async () => {
    expect(await (await list('summary=1')).json()).toMatchObject({ summary: { created: 0, pending: 0, accepted: 0, dismissed: 0, expired: 0, duplicateSuppressed: 0, averageDecisionLatencySeconds: null, routeChanges: 0 } })
  })

  it('publishes all four operations and their request/response contracts', async () => {
    const index = await (await INDEX()).json()
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8'))
    for (const [path, method, role] of [
      ['/api/task-proposals', 'get', 'viewer'], ['/api/task-proposals', 'post', 'operator'],
      ['/api/task-proposals/{id}', 'put', 'operator'], ['/api/task-proposals/{id}/accept', 'post', 'operator'],
    ]) {
      expect(index.endpoints).toContainEqual(expect.objectContaining({ path: path.replace('{id}', ':id'), methods: expect.arrayContaining([method.toUpperCase()]), auth: expect.stringContaining(role) }))
      const operation = spec.paths[path]?.[method]
      expect(operation).toBeDefined()
      expect(operation['x-required-role']).toBe(role)
      expect(operation.responses['200']).toBeDefined()
      if (method !== 'get') expect(operation.requestBody.content['application/json'].schema).toBeDefined()
    }
  })

  it('validates the real acceptance response including nullable task fields against OpenAPI', async () => {
    const p = await proposal()
    const response = await accept(p.id, p.revision)
    expect(response.status).toBe(200)
    const { task } = await response.json()
    expect(task).toMatchObject({ due_date: null, estimated_hours: null, actual_hours: null, project_id: null })
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8'))
    const schemaName = spec.components.schemas.TaskProposalAcceptance.properties.task.$ref.split('/').pop()
    const taskSchema = spec.components.schemas[schemaName]
    const validated = z.fromJSONSchema(taskSchema).safeParse(task)
    expect(validated.error?.issues).toBeUndefined()
    expect(validated.success).toBe(true)
    expect(Object.keys(taskSchema.properties)).toEqual(expect.arrayContaining(Object.keys(task)))
  })

  it.each(['backlog', 'inbox', 'assigned', 'awaiting_owner', 'in_progress', 'review', 'quality_review', 'done', 'failed'])('validates a %s task returned on acceptance retry against OpenAPI', async status => {
    const p = await proposal()
    const first = await accept(p.id, p.revision)
    expect(first.status).toBe(200)
    const { task: created } = await first.json()
    state.db.prepare('UPDATE tasks SET status = ?, due_date = 1800000000, estimated_hours = 1.25, actual_hours = 2.5 WHERE id = ?').run(status, created.id)
    const retry = await accept(p.id, p.revision)
    expect(retry.status).toBe(200)
    const { task } = await retry.json()
    expect(task).toMatchObject({ id: created.id, status, due_date: 1800000000, estimated_hours: 1.25, actual_hours: 2.5 })
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8'))
    const schemaName = spec.components.schemas.TaskProposalAcceptance.properties.task.$ref.split('/').pop()
    const validator = z.fromJSONSchema(spec.components.schemas[schemaName])
    const validated = validator.safeParse(task)
    expect(validated.error?.issues).toBeUndefined()
    expect(validated.success).toBe(true)
    expect(validator.safeParse({ ...task, status: 'not-a-task-status' }).success).toBe(false)
    expect(taskCount()).toBe(1)
  })
})
