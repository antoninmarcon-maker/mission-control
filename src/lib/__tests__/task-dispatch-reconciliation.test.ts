// @vitest-environment node
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST, PUT } from '@/app/api/tasks/[id]/clarification/route'

const mockDbState = vi.hoisted(() => ({
  db: null as Database.Database | null,
  tasks: [] as Array<{
    id: number
    title: string
    assigned_to: string | null
    metadata: string | null
    workspace_id: number
    workspace_isolation?: 'shared' | 'strict'
    ticket_prefix?: string | null
    project_ticket_no?: number | null
  }>,
  updates: [] as Array<{
    resolution: string
    metadata: string
    taskId: number
    workspaceId: number
  }>,
  comments: [] as Array<{
    taskId: number
    author: string
    content: string
    workspaceId: number
  }>,
  statusUpdates: [] as Array<{
    status: string
    taskId: number
  }>,
  metadataUpdates: [] as Array<{
    metadata: string
    taskId: number
  }>,
  callOpenClawGateway: vi.fn(),
  runOpenClaw: vi.fn(),
  getAllGatewaySessions: vi.fn(),
  readSessionJsonl: vi.fn(),
  logActivity: vi.fn(),
  broadcast: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../db', () => ({
  getDatabase: () => mockDbState.db ?? ({
    prepare: (sql: string) => {
      if (sql.includes('SELECT') && sql.includes('assigned_to') && sql.includes('metadata') && sql.includes('project_ticket_no')) {
        return {
          all: () => sql.includes("w.isolation = 'shared'")
            ? mockDbState.tasks.filter((task) => task.workspace_isolation !== 'strict')
            : mockDbState.tasks,
        }
      }
      if (sql.includes('FROM tasks t') && sql.includes('JOIN agents')) {
        return {
          all: () => sql.includes("w.isolation = 'shared'")
            ? mockDbState.tasks.filter((task) => task.workspace_isolation !== 'strict')
            : mockDbState.tasks,
        }
      }
      if (sql.includes('SELECT metadata FROM tasks WHERE id = ? AND workspace_id = ?')) {
        return {
          get: (taskId: number) => {
            const task = mockDbState.tasks.find((item) => item.id === taskId)
            return task ? { metadata: task.metadata } : undefined
          },
        }
      }
      // isGatewayAvailable() (task-dispatch) queries for a healthy gateway row.
      // Report one so these tests deterministically take the GATEWAY dispatch
      // path they assert, instead of falling through to the direct-API path
      // when the host happens to have ANTHROPIC_API_KEY or the claude CLI.
      if (sql.includes('FROM gateways') && sql.includes('COUNT(*)')) {
        return { get: () => ({ c: 1 }) }
      }
      // Matches both the plain status update and the atomic claim variant
      // (UPDATE ... WHERE id = ? AND status = 'assigned') introduced in #698.
      if (
        sql === 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?' ||
        sql.startsWith("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'assigned' AND workspace_id = ?")
      ) {
        return {
          get: (status: string, _updatedAt: number, taskId: number, workspaceId: number) => {
            const task = mockDbState.tasks.find((item) => item.id === taskId && item.workspace_id === workspaceId)
            if (!task) return undefined
            mockDbState.statusUpdates.push({ status, taskId })
            return { metadata: task.metadata }
          },
          run: (status: string, _updatedAt: number, taskId: number) => {
            mockDbState.statusUpdates.push({ status, taskId })
            return { changes: 1 }
          },
        }
      }
      if (sql === 'UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?') {
        return {
          run: (metadata: string, _updatedAt: number, taskId: number) => {
            mockDbState.metadataUpdates.push({ metadata, taskId })
            return { changes: 1 }
          },
        }
      }
      if (sql.includes('UPDATE tasks') && sql.includes("status = 'review'")) {
        return {
          run: (resolution: string, metadata: string, _updatedAt: number, taskId: number, workspaceId: number) => {
            mockDbState.updates.push({ resolution, metadata, taskId, workspaceId })
            return { changes: 1 }
          },
        }
      }
      if (sql.includes('INSERT INTO comments')) {
        return {
          run: (taskId: number, author: string, content: string, _createdAt: number, workspaceId: number) => {
            mockDbState.comments.push({ taskId, author, content, workspaceId })
            return { changes: 1 }
          },
        }
      }
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
      }
    },
  }),
  db_helpers: {
    logActivity: mockDbState.logActivity,
  },
}))

vi.mock('../auth', () => ({
  requireRole: () => ({ user: { id: 1, role: 'operator', workspace_id: 1, username: 'antonin' } }),
}))

vi.mock('../rate-limit', () => ({ mutationLimiter: () => null }))

vi.mock('../config', () => ({
  config: {
    openclawHome: 'C:/openclaw',
    openclawStateDir: 'C:/openclaw',
  },
}))

vi.mock('../openclaw-gateway', () => ({
  callOpenClawGateway: mockDbState.callOpenClawGateway,
}))

vi.mock('../command', () => ({
  runOpenClaw: mockDbState.runOpenClaw,
}))

vi.mock('../sessions', () => ({
  getAllGatewaySessions: mockDbState.getAllGatewaySessions,
}))

vi.mock('../transcript-parser', () => ({
  readSessionJsonl: mockDbState.readSessionJsonl,
  parseJsonlTranscript: (raw: string, limit: number) => raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === 'message' && entry.message)
    .map((entry) => ({
      role: entry.message.role === 'assistant' ? 'assistant' : entry.message.role === 'system' ? 'system' : 'user',
      parts: Array.isArray(entry.message.content)
        ? entry.message.content
            .filter((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim())
            .map((part: any) => ({ type: 'text', text: part.text.trim() }))
        : typeof entry.message.content === 'string' && entry.message.content.trim()
          ? [{ type: 'text', text: entry.message.content.trim() }]
          : [],
      timestamp: entry.timestamp,
    }))
    .filter((message) => message.parts.length > 0)
    .slice(-limit),
}))

vi.mock('../event-bus', () => ({
  eventBus: {
    broadcast: mockDbState.broadcast,
  },
}))

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mockDbState.warn,
    error: vi.fn(),
  },
}))

import { dispatchAssignedTasks, extractDeferredCompletionText, reconcileDeferredTaskCompletions } from '../task-dispatch'

describe('deferred task completion reconciliation', () => {
  beforeEach(() => {
    mockDbState.tasks = []
    mockDbState.updates = []
    mockDbState.comments = []
    mockDbState.statusUpdates = []
    mockDbState.metadataUpdates = []
    mockDbState.callOpenClawGateway.mockReset()
    mockDbState.runOpenClaw.mockReset()
    mockDbState.getAllGatewaySessions.mockReset()
    mockDbState.getAllGatewaySessions.mockReturnValue([])
    mockDbState.readSessionJsonl.mockReset()
    mockDbState.readSessionJsonl.mockReturnValue(null)
    mockDbState.logActivity.mockClear()
    mockDbState.broadcast.mockClear()
    mockDbState.warn.mockClear()
  })

  it('extracts text from gateway payloads', () => {
    expect(
      extractDeferredCompletionText({
        status: 'completed',
        result: {
          payloads: [{ text: 'Finished delegated work.' }],
        },
      })
    ).toBe('Finished delegated work.')
  })

  it('extracts text from responses-style output arrays', () => {
    expect(
      extractDeferredCompletionText({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'Reviewable result.' }],
          },
        ],
      })
    ).toBe('Reviewable result.')
  })

  it('does not wait on dispatch_session_id when dispatch_run_id is missing', async () => {
    mockDbState.tasks = [{
      id: 11,
      title: 'Deferred task',
      assigned_to: 'agent-one',
      metadata: JSON.stringify({ async_state: 'pending', dispatch_session_id: 'session-123' }),
      workspace_id: 1,
    }]
    const waitForRun = vi.fn(async () => ({ complete: true, text: 'Should not be used.' }))

    const result = await reconcileDeferredTaskCompletions({ waitForRun })

    expect(waitForRun).not.toHaveBeenCalled()
    expect(result.promoted).toBe(0)
    expect(mockDbState.updates).toHaveLength(0)
  })

  it('does not reconcile strict workspace runs or inspect global sessions', async () => {
    mockDbState.tasks = [{
      id: 16,
      title: 'Strict deferred task',
      assigned_to: 'agent-one',
      metadata: JSON.stringify({ async_state: 'pending', dispatch_run_id: 'global-run' }),
      workspace_id: 2,
      workspace_isolation: 'strict',
    }]
    const waitForRun = vi.fn(async () => ({ complete: true, text: null }))

    const result = await reconcileDeferredTaskCompletions({ workspaceId: 2, waitForRun })

    expect(result).toMatchObject({ checked: 0, promoted: 0 })
    expect(waitForRun).not.toHaveBeenCalled()
    expect(mockDbState.getAllGatewaySessions).not.toHaveBeenCalled()
    expect(mockDbState.readSessionJsonl).not.toHaveBeenCalled()
  })

  it('leaves tasks in progress when the wait result is not terminal', async () => {
    mockDbState.tasks = [{
      id: 12,
      title: 'Still running task',
      assigned_to: 'agent-one',
      metadata: JSON.stringify({ async_state: 'pending', dispatch_run_id: 'run-123' }),
      workspace_id: 1,
    }]
    const waitForRun = vi.fn(async () => ({ complete: false, text: 'Partial output is ignored.' }))

    const result = await reconcileDeferredTaskCompletions({ waitForRun })

    expect(result.promoted).toBe(0)
    expect(mockDbState.updates).toHaveLength(0)
    expect(mockDbState.comments).toHaveLength(0)
  })

  it('keeps agent.wait timeout results pending', async () => {
    mockDbState.tasks = [{
      id: 15,
      title: 'Timed out wait task',
      assigned_to: 'agent-one',
      metadata: JSON.stringify({ async_state: 'pending', dispatch_run_id: 'run-timeout' }),
      workspace_id: 1,
    }]
    mockDbState.callOpenClawGateway.mockResolvedValue({ status: 'timeout', runId: 'run-timeout' })

    const result = await reconcileDeferredTaskCompletions()

    expect(mockDbState.callOpenClawGateway).toHaveBeenCalledWith(
      'agent.wait',
      { runId: 'run-timeout', timeoutMs: 1000 },
      3000,
    )
    expect(result.promoted).toBe(0)
    expect(mockDbState.updates).toHaveLength(0)
    expect(mockDbState.comments).toHaveLength(0)
  })

  it('skips malformed async metadata without waiting or updating', async () => {
    mockDbState.tasks = [{
      id: 13,
      title: 'Malformed metadata task',
      assigned_to: 'agent-one',
      metadata: '{"async_state":"pending","dispatch_run_id":"run-123"',
      workspace_id: 1,
    }]
    const waitForRun = vi.fn(async () => ({ complete: true, text: 'Should not be used.' }))

    const result = await reconcileDeferredTaskCompletions({ waitForRun })

    expect(waitForRun).not.toHaveBeenCalled()
    expect(result.promoted).toBe(0)
    expect(mockDbState.updates).toHaveLength(0)
  })

  it('promotes completed runs with a fallback resolution when no text is returned', async () => {
    mockDbState.tasks = [{
      id: 14,
      title: 'Empty output task',
      assigned_to: null,
      metadata: JSON.stringify({ async_state: 'pending', dispatch_run_id: 'run-456' }),
      workspace_id: 1,
    }]
    const waitForRun = vi.fn(async () => ({ complete: true, text: null }))

    const result = await reconcileDeferredTaskCompletions({ waitForRun })

    expect(result.promoted).toBe(1)
    expect(mockDbState.updates[0].resolution).toBe('Deferred agent run completed without textual output.')
    expect(mockDbState.comments[0]).toMatchObject({
      taskId: 14,
      author: 'agent',
      content: 'Deferred agent run completed without textual output.',
      workspaceId: 1,
    })
  })

  it('recovers completed run text from the agent transcript when wait has no text', async () => {
    mockDbState.tasks = [{
      id: 30,
      title: 'Transcript output task',
      assigned_to: 'Arnold',
      metadata: JSON.stringify({
        async_state: 'pending',
        dispatch_run_id: 'run-30',
        dispatch_session_id: 'arnold',
      }),
      workspace_id: 1,
      ticket_prefix: 'TASK',
      project_ticket_no: 30,
    }]
    mockDbState.getAllGatewaySessions.mockReturnValue([{
      key: 'agent:arnold:main',
      agent: 'arnold',
      sessionId: 'session-30',
      updatedAt: Date.now(),
      chatType: 'agent',
      channel: '',
      model: '',
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
      active: true,
    }])
    mockDbState.readSessionJsonl.mockReturnValue([
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-06T20:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '**[TASK-030] Transcript output task**' }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-06T20:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered transcript response.' }],
        },
      }),
    ].join('\n'))
    const waitForRun = vi.fn(async () => ({ complete: true, text: null }))

    const result = await reconcileDeferredTaskCompletions({ waitForRun })

    expect(result.promoted).toBe(1)
    expect(mockDbState.getAllGatewaySessions).toHaveBeenCalledWith(24 * 60 * 60 * 1000, true)
    expect(mockDbState.readSessionJsonl).toHaveBeenCalledWith('C:/openclaw', 'arnold', 'session-30')
    expect(mockDbState.updates[0].resolution).toBe('Recovered transcript response.')
    expect(mockDbState.comments[0]).toMatchObject({
      taskId: 30,
      author: 'Arnold',
      content: 'Recovered transcript response.',
      workspaceId: 1,
    })
  })
})

describe('existing-session deferred dispatch', () => {
  beforeEach(() => {
    mockDbState.tasks = []
    mockDbState.updates = []
    mockDbState.comments = []
    mockDbState.statusUpdates = []
    mockDbState.metadataUpdates = []
    mockDbState.callOpenClawGateway.mockReset()
    mockDbState.runOpenClaw.mockReset()
    mockDbState.getAllGatewaySessions.mockReset()
    mockDbState.getAllGatewaySessions.mockReturnValue([])
    mockDbState.readSessionJsonl.mockReset()
    mockDbState.readSessionJsonl.mockReturnValue(null)
    mockDbState.logActivity.mockClear()
    mockDbState.broadcast.mockClear()
    mockDbState.warn.mockClear()
  })

  it('marks accepted chat.send without a runId as explicit manual reconciliation', async () => {
    mockDbState.tasks = [{
      id: 21,
      title: 'Existing session task',
      description: 'Use the existing chat session.',
      status: 'assigned',
      priority: 'medium',
      assigned_to: 'agent-one',
      workspace_id: 1,
      agent_name: 'agent-one',
      agent_id: 7,
      agent_config: null,
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      metadata: JSON.stringify({ target_session: 'session-123' }),
    } as any]
    mockDbState.callOpenClawGateway.mockResolvedValue({ status: 'accepted' })

    const result = await dispatchAssignedTasks()

    expect(result).toEqual({ ok: true, message: 'Dispatched 1/1 tasks' })
    expect(mockDbState.callOpenClawGateway).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey: 'session-123',
        deliver: false,
      }),
      125_000,
    )
    expect(mockDbState.metadataUpdates).toHaveLength(1)
    const metadata = JSON.parse(mockDbState.metadataUpdates[0].metadata)
    expect(metadata).toMatchObject({
      target_session: 'session-123',
      dispatch_session_id: 'session-123',
      async_state: 'accepted_without_run_id',
      async_reconciliation: 'manual_required',
    })
    expect(metadata.dispatch_run_id).toBeUndefined()
    expect(metadata.async_warning).toContain('accepted without a runId')
    expect(mockDbState.broadcast).toHaveBeenCalledWith('task.updated', expect.objectContaining({
      id: 21,
      status: 'in_progress',
      async_state: 'accepted_without_run_id',
    }))
    expect(mockDbState.logActivity).toHaveBeenCalledWith(
      'task_deferred_dispatch_unreconcilable',
      'task',
      21,
      'scheduler',
      expect.stringContaining('manual reconciliation required'),
      expect.objectContaining({
        dispatch_session_id: 'session-123',
        async_state: 'accepted_without_run_id',
      }),
      1,
    )
  })

  it('does not dispatch strict workspace tasks to named or new global sessions', async () => {
    mockDbState.tasks = [{
      id: 23,
      title: 'Strict session task',
      description: 'Must remain isolated.',
      status: 'assigned',
      priority: 'high',
      assigned_to: 'agent-one',
      workspace_id: 2,
      workspace_isolation: 'strict',
      agent_name: 'agent-one',
      agent_id: 7,
      agent_config: null,
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      metadata: JSON.stringify({ target_session: 'global-session' }),
    } as any]

    const result = await dispatchAssignedTasks()

    expect(result).toEqual({ ok: true, message: 'No assigned tasks to dispatch' })
    expect(mockDbState.callOpenClawGateway).not.toHaveBeenCalled()
    expect(mockDbState.runOpenClaw).not.toHaveBeenCalled()
    expect(mockDbState.statusUpdates).toHaveLength(0)
    expect(mockDbState.metadataUpdates).toHaveLength(0)
  })

  it('does not send heuristic model overrides when the agent has a configured default model', async () => {
    mockDbState.tasks = [{
      id: 22,
      title: 'Diagnose failure in dispatch',
      description: 'Investigate why the task is not working.',
      status: 'assigned',
      priority: 'medium',
      assigned_to: 'Arnold',
      workspace_id: 1,
      agent_name: 'Arnold',
      agent_id: 1,
      agent_config: JSON.stringify({
        openclawId: 'arnold',
        model: { primary: 'openai-codex/gpt-5.4' },
      }),
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      metadata: '{}',
    } as any]
    mockDbState.callOpenClawGateway.mockResolvedValue({
      status: 'accepted',
      runId: 'run-22',
      sessionId: 'session-22',
    })

    await dispatchAssignedTasks()

    expect(mockDbState.runOpenClaw).not.toHaveBeenCalled()
    expect(mockDbState.callOpenClawGateway).toHaveBeenCalledTimes(1)
    const [, params, timeoutMs] = mockDbState.callOpenClawGateway.mock.calls[0]
    expect(timeoutMs).toBe(60_000)
    expect(params).toMatchObject({
      agentId: 'arnold',
      deliver: false,
    })
    expect(params.model).toBeUndefined()
    const metadata = JSON.parse(mockDbState.metadataUpdates[0].metadata)
    expect(metadata).toMatchObject({
      dispatch_session_id: 'session-22',
      dispatch_run_id: 'run-22',
      async_state: 'pending',
    })
  })
})

describe('atomic dispatch clarification claims', () => {
  beforeEach(() => {
    mockDbState.db = new Database(':memory:')
    mockDbState.db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, title TEXT, description TEXT, status TEXT DEFAULT 'assigned',
        priority TEXT DEFAULT 'medium', assigned_to TEXT DEFAULT 'agent-one',
        metadata TEXT DEFAULT '{}', workspace_id INTEGER DEFAULT 1,
        project_id INTEGER, project_ticket_no INTEGER, tags TEXT,
        created_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0
      );
      CREATE TABLE agents (id INTEGER, name TEXT, config TEXT, runtime_type TEXT, workspace_id INTEGER);
      CREATE TABLE workspaces (id INTEGER, isolation TEXT);
      CREATE TABLE projects (id INTEGER, ticket_prefix TEXT, workspace_id INTEGER);
      CREATE TABLE comments (task_id INTEGER, author TEXT, content TEXT, created_at INTEGER, workspace_id INTEGER);
      CREATE TABLE gateways (status TEXT);
      INSERT INTO agents VALUES (7, 'agent-one', NULL, NULL, 1);
      INSERT INTO workspaces VALUES (1, 'shared');
      INSERT INTO gateways VALUES ('healthy');
      INSERT INTO tasks (id, title, created_at) VALUES (1, 'First task', 1), (2, 'Second task', 2);
    `)
    mockDbState.callOpenClawGateway.mockReset()
    mockDbState.callOpenClawGateway.mockResolvedValue({ status: 'accepted', runId: 'run-accepted' })
    mockDbState.logActivity.mockClear()
    mockDbState.broadcast.mockClear()
  })

  afterEach(() => {
    mockDbState.db?.close()
    mockDbState.db = null
  })

  async function openClarification() {
    const response = await POST(new NextRequest('http://localhost/api/tasks/2/clarification', {
      method: 'POST',
      body: JSON.stringify({ questions: [{
        id: 'scope', prompt: 'Quel périmètre ?', multiple: false,
        options: [{ id: 'small', label: 'Minimum' }, { id: 'full', label: 'Périmètre complet' }],
      }] }),
    }), { params: Promise.resolve({ id: '2' }) })
    expect(response.status).toBe(201)
    return (await response.json()).clarification
  }

  it('dispatches human decisions confirmed after selection but before the atomic claim', async () => {
    mockDbState.callOpenClawGateway.mockImplementationOnce(async () => {
      // Both tasks were selected before the first dispatch yielded to the gateway.
      expect(mockDbState.db!.prepare('SELECT status FROM tasks WHERE id = 2').get()).toEqual({ status: 'assigned' })
      const clarification = await openClarification()
      const response = await PUT(new NextRequest('http://localhost/api/tasks/2/clarification', {
        method: 'PUT',
        body: JSON.stringify({
          revision: clarification.revision,
          answers: [{ questionId: 'scope', selected: ['full'], text: 'Inclure les tests de migration.' }],
        }),
      }), { params: Promise.resolve({ id: '2' }) })
      expect(response.status).toBe(200)
      return { status: 'accepted', runId: 'run-first' }
    })

    expect(await dispatchAssignedTasks()).toEqual({ ok: true, message: 'Dispatched 2/2 tasks' })

    const [, secondRequest] = mockDbState.callOpenClawGateway.mock.calls[1]
    expect(secondRequest.message).toContain('**[TASK-2] Second task**')
    expect(secondRequest.message).toContain('## Cadrage validé\n\nQuel périmètre ?\nPérimètre complet\nInclure les tests de migration.')
    expect(secondRequest.message).not.toContain('Minimum')
    const task = mockDbState.db!.prepare('SELECT status, metadata FROM tasks WHERE id = 2').get() as { status: string; metadata: string }
    expect(task.status).toBe('in_progress')
    expect(JSON.parse(task.metadata).clarification).toMatchObject({ state: 'answered', answeredBy: 'antonin' })
  })

  it('skips a task whose clarification is still pending at claim time', async () => {
    mockDbState.callOpenClawGateway.mockImplementationOnce(async () => {
      await openClarification()
      return { status: 'accepted', runId: 'run-first' }
    })

    expect(await dispatchAssignedTasks()).toEqual({ ok: true, message: 'Dispatched 1/2 tasks' })

    expect(mockDbState.callOpenClawGateway).toHaveBeenCalledTimes(1)
    expect(mockDbState.db!.prepare('SELECT status FROM tasks WHERE id = 2').get()).toEqual({ status: 'assigned' })
    expect(mockDbState.broadcast).not.toHaveBeenCalledWith('task.status_changed', expect.objectContaining({ id: 2 }))
    expect(mockDbState.logActivity).not.toHaveBeenCalledWith('task_dispatched', 'task', 2, expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it.each([
    ['already claimed', "UPDATE tasks SET status = 'in_progress' WHERE id = 2"],
    ['moved to another workspace', 'UPDATE tasks SET workspace_id = 2 WHERE id = 2'],
  ])('skips a selected task that was %s before its claim', async (_reason, mutation) => {
    mockDbState.callOpenClawGateway.mockImplementationOnce(async () => {
      mockDbState.db!.exec(mutation)
      return { status: 'accepted', runId: 'run-first' }
    })

    expect(await dispatchAssignedTasks()).toEqual({ ok: true, message: 'Dispatched 1/2 tasks' })
    expect(mockDbState.callOpenClawGateway).toHaveBeenCalledTimes(1)
    expect(mockDbState.broadcast).not.toHaveBeenCalledWith('task.status_changed', expect.objectContaining({ id: 2 }))
  })
})
