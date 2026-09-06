import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskProposal } from '@/lib/task-proposals'
import { useMissionControl } from '@/store'
import { useServerEvents } from './use-server-events'

const proposal: TaskProposal = {
  id: 12, workspaceId: 1, projectId: null, sourceType: 'chat', sourceRef: 'Codex',
  idempotencyKey: 'proposal-login-redirect', title: 'Repair the login redirect',
  objective: 'Return users to the requested page after authentication.', context: 'Callback URL context.',
  rationale: 'An unresolved audit item.', risk: 'medium',
  routeForecast: { runtime: 'codex', model: 'gpt-5.6', reason: 'An isolated change.' }, metadata: {},
  status: 'pending', revision: 'c6d88a9f-93b5-44f2-895d-4856e8014b41', orchestratorAgent: 'codex',
  createdBy: 'audit', acceptedBy: null, acceptedAt: null, dismissedBy: null, dismissedAt: null,
  dismissalReason: null, taskId: null, expiresAt: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null

  constructor(_url: string) { FakeEventSource.instances.push(this) }
  close() {}
}

function EventClient() {
  useServerEvents()
  return null
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
  useMissionControl.setState({ proposals: [], tasks: [], selectedTask: null, currentUser: null })
})

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

function emit(type: string, id = proposal.id, fields: Record<string, unknown> = {}) {
  act(() => FakeEventSource.instances.at(-1)?.onmessage?.({
    data: JSON.stringify({ type, data: { id, ...fields } }),
  } as MessageEvent<string>))
}

async function resolveProposals(pending: ReturnType<typeof deferredResponse>, proposals: TaskProposal[]) {
  await act(async () => {
    pending.resolve(new Response(JSON.stringify({ proposals })))
    await pending.promise
  })
}

it.each(['proposal.accepted', 'proposal.dismissed', 'proposal.expired'])(
  'does not resurrect a proposal when a snapshot arrives after %s', async (terminal) => {
    const delayed = deferredResponse()
    const fetchMock = vi.fn().mockReturnValueOnce(delayed.promise)
      .mockResolvedValue(new Response(JSON.stringify({ proposals: [] })))
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', fetchMock)
    useMissionControl.setState({ proposals: [proposal] })
    render(<EventClient />)
    emit('proposal.updated')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    emit(terminal)
    await resolveProposals(delayed, [proposal])
    expect(useMissionControl.getState().proposals).toEqual([])
  },
)

it('ignores an SSE reload after its hook is cleaned up', async () => {
  const delayed = deferredResponse()
  const fetchMock = vi.fn().mockReturnValue(delayed.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  const view = render(<EventClient />)
  emit('proposal.created')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  view.unmount()
  await resolveProposals(delayed, [proposal])
  expect(useMissionControl.getState().proposals).toEqual([])
})

it('ignores a previous workspace snapshot after switching users workspace', async () => {
  const delayed = deferredResponse()
  const fetchMock = vi.fn().mockReturnValue(delayed.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  const user = { id: 1, username: 'operator', display_name: 'Operator', role: 'admin' as const, workspace_id: 1 }
  useMissionControl.getState().setCurrentUser(user)
  render(<EventClient />)
  emit('proposal.created')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  act(() => useMissionControl.getState().setCurrentUser({ ...user, workspace_id: 2 }))
  await resolveProposals(delayed, [proposal])
  expect(useMissionControl.getState().proposals).toEqual([])
})

it('coalesces event bursts and rejects an obsolete snapshot before the next reload', async () => {
  const first = deferredResponse()
  const latest = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  render(<EventClient />)
  emit('proposal.created')
  emit('proposal.updated')
  emit('proposal.updated')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  emit('proposal.updated')
  emit('proposal.updated')
  await resolveProposals(first, [proposal])
  expect(useMissionControl.getState().proposals).toEqual([])
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  await resolveProposals(latest, [{ ...proposal, title: 'Latest revision' }])
  expect(useMissionControl.getState().proposals[0].title).toBe('Latest revision')
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not restore a pending snapshot over a locally updated proposal', async () => {
  const delayed = deferredResponse()
  const replacement = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(delayed.promise).mockReturnValue(replacement.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  render(<EventClient />)
  emit('proposal.updated')
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  const edited = { ...proposal, title: 'Locally edited title', revision: 'local-edit' }
  act(() => useMissionControl.getState().updateProposal(edited))
  await resolveProposals(delayed, [proposal])
  expect(useMissionControl.getState().proposals).toEqual([edited])
})

const secondProposal = { ...proposal, id: 13, title: 'Proposal B', idempotencyKey: 'proposal-b' }
const editedProposal = { ...proposal, title: 'Updated proposal A', revision: 'updated-a' }

const task = { id: 44, title: 'Accepted proposal task', description: 'Private task context', status: 'assigned' as const, priority: 'medium' as const, created_by: 'operator', created_at: 1, updated_at: 1, workspace_id: 1, metadata: {} }
const taskResponse = (value = task) => new Response(JSON.stringify({ task: value }))
const eventUser = { id: 1, username: 'operator', display_name: 'Operator', role: 'admin' as const, workspace_id: 1 }

it('hydrates compact task creation and clarification invalidation through authenticated REST without inserting incomplete items', async () => {
  vi.useFakeTimers()
  const created = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(created.promise).mockResolvedValueOnce(taskResponse({ ...task, metadata: { clarification: { state: 'answered' } } }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  emit('task.created', task.id)
  expect(useMissionControl.getState().tasks).toEqual([])
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledWith('/api/tasks/44', expect.objectContaining({ credentials: 'include' }))
  await act(async () => { created.resolve(taskResponse()); await created.promise })
  expect(useMissionControl.getState().tasks).toEqual([task])
  emit('task.updated', task.id, { clarification_state: 'answered' })
  await flushReloadTimer()
  expect(useMissionControl.getState().tasks[0].metadata).toEqual({ clarification: { state: 'answered' } })
})

it.each(['deleted', 'done', 'local-delete', 'local-done', 'unmount', 'workspace'])('does not publish a stale task read after %s', async (ending) => {
  vi.useFakeTimers()
  const pending = deferredResponse()
  const fetchMock = vi.fn().mockReturnValue(pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  useMissionControl.getState().setCurrentUser(eventUser)
  useMissionControl.setState({ tasks: [task], selectedTask: task })
  const view = render(<EventClient />)
  emit('task.updated', task.id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  if (ending === 'deleted') emit('task.deleted', task.id)
  if (ending === 'done') emit('task.status_changed', task.id, { status: 'done', updated_at: 2 })
  if (ending === 'local-delete') act(() => useMissionControl.getState().deleteTask(task.id))
  if (ending === 'local-done') act(() => useMissionControl.getState().updateTask(task.id, { status: 'done', updated_at: 2 }))
  if (ending === 'unmount') view.unmount()
  if (ending === 'workspace') act(() => useMissionControl.getState().setCurrentUser({ ...eventUser, workspace_id: 2 }))
  await act(async () => { pending.resolve(taskResponse({ ...task, title: 'Stale title' })); await pending.promise })
  const tasks = useMissionControl.getState().tasks
  if (ending.includes('delete') || ending === 'workspace') expect(tasks).toEqual([])
  else expect(tasks[0]).toMatchObject({ title: task.title, status: ending.includes('done') ? 'done' : 'assigned' })
})

it('coalesces compact task bursts, serializes reads for one ID and publishes only the newest snapshot', async () => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const fresh = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  for (let i = 0; i < 10; i++) emit('task.created', task.id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 10; i++) emit('task.updated', task.id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => { stale.resolve(taskResponse({ ...task, title: 'Stale' })); await stale.promise })
  expect(useMissionControl.getState().tasks).toEqual([])
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await act(async () => { fresh.resolve(taskResponse()); await fresh.promise })
  expect(useMissionControl.getState().tasks).toEqual([task])
})

it('keeps full task events compatible and rejects older hydration after a complete update', async () => {
  vi.useFakeTimers()
  const pending = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  emit('task.created', task.id, task)
  expect(useMissionControl.getState().tasks).toEqual([task])
  expect(fetchMock).not.toHaveBeenCalled()
  emit('task.updated', task.id)
  await flushReloadTimer()
  emit('task.updated', task.id, { ...task, title: 'Full newest title', status: 'done' })
  await act(async () => { pending.resolve(taskResponse()); await pending.promise })
  expect(useMissionControl.getState().tasks[0]).toMatchObject({ title: 'Full newest title', status: 'done' })
})

it('bounds hydration concurrency across distinct task IDs and does not duplicate full creations', async () => {
  vi.useFakeTimers()
  const pending = Array.from({ length: 8 }, deferredResponse)
  const fetchMock = vi.fn((url: string) => pending[Number(url.split('/').at(-1)) - 1].promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  for (let id = 1; id <= 8; id++) emit('task.created', id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(4)
  await act(async () => { pending[0].resolve(taskResponse({ ...task, id: 1 })); await pending[0].promise })
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(5)
  emit('task.created', 1, { ...task, id: 1 })
  emit('task.created', 1, { ...task, id: 1 })
  expect(useMissionControl.getState().tasks.filter((item) => item.id === 1)).toHaveLength(1)
})

it('ignores deleted task invalidations and retries failed task reads only on a new event', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(taskResponse())
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  emit('task.created', task.id)
  await flushReloadTimer()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  emit('task.updated', task.id)
  await flushReloadTimer()
  expect(useMissionControl.getState().tasks).toEqual([task])
  emit('task.deleted', task.id)
  emit('task.updated', task.id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(useMissionControl.getState().tasks).toEqual([])
})

it('does not publish a fetched task from a foreign workspace', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(taskResponse({ ...task, workspace_id: 2 })))
  vi.stubGlobal('EventSource', FakeEventSource)
  useMissionControl.getState().setCurrentUser(eventUser)
  render(<EventClient />)
  emit('task.created', task.id)
  await flushReloadTimer()
  expect(useMissionControl.getState().tasks).toEqual([])
})

async function recoverConnection() {
  act(() => FakeEventSource.instances.at(-1)!.onerror?.())
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  act(() => {
    for (let i = 0; i < 5; i++) FakeEventSource.instances.at(-1)!.onopen?.()
  })
  await flushReloadTimer()
}

it('reconciles missed created, edited and dismissed proposals once after each reconnect, including storms', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [editedProposal, secondProposal] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [secondProposal] })))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  useMissionControl.setState({ proposals: [proposal] })
  render(<EventClient />)
  act(() => FakeEventSource.instances.at(-1)!.onopen?.())
  expect(fetchMock).not.toHaveBeenCalled()
  await recoverConnection()
  expect(useMissionControl.getState().proposals).toEqual([editedProposal, secondProposal])
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await recoverConnection()
  expect(useMissionControl.getState().proposals).toEqual([secondProposal])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('allows a failed recovery load to succeed on the next recovery without a retry loop', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [secondProposal] })))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  render(<EventClient />)
  await recoverConnection()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await recoverConnection()
  expect(useMissionControl.getState().proposals).toEqual([secondProposal])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each(['unmount', 'workspace'])('drops reconnect reads across %s', async (ending) => {
  vi.useFakeTimers()
  const pending = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('EventSource', FakeEventSource)
  useMissionControl.getState().setCurrentUser(eventUser)
  const view = render(<EventClient />)
  await recoverConnection()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  if (ending === 'unmount') view.unmount()
  else act(() => useMissionControl.getState().setCurrentUser({ ...eventUser, workspace_id: 2 }))
  await resolveProposals(pending, [proposal])
  expect(useMissionControl.getState().proposals).toEqual([])
})

async function flushReloadTimer() {
  await act(async () => { await vi.advanceTimersByTimeAsync(25) })
}

it.each(['edit', 'accept', 'dismiss'])('preserves one reload obligation when a local %s supersedes the last SSE snapshot', async (action) => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const replacement = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  useMissionControl.setState({ proposals: [proposal] })
  render(<EventClient />)
  emit('proposal.created', secondProposal.id)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(1)
  act(() => {
    // Several committed changes while the list is in flight still need only
    // one replacement snapshot, which also discovers the unrelated proposal B.
    useMissionControl.getState().updateProposal(editedProposal)
    if (action === 'accept') useMissionControl.getState().updateProposal({ ...editedProposal, status: 'accepted', taskId: 44 })
    if (action === 'dismiss') useMissionControl.getState().removeProposal(proposal.id)
  })
  const localState = useMissionControl.getState().proposals
  await resolveProposals(stale, [proposal, secondProposal])
  expect(useMissionControl.getState().proposals).toEqual(localState)
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const latest = action === 'edit' ? [editedProposal, secondProposal] : [secondProposal]
  await resolveProposals(replacement, latest)
  expect(useMissionControl.getState().proposals).toEqual(latest)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each(['unmount', 'workspace'])('drops a superseded reload obligation on %s before it restarts', async (ending) => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  const user = { id: 1, username: 'operator', display_name: 'Operator', role: 'admin' as const, workspace_id: 1 }
  useMissionControl.getState().setCurrentUser(user)
  useMissionControl.setState({ proposals: [proposal] })
  const view = render(<EventClient />)
  emit('proposal.created', secondProposal.id)
  await flushReloadTimer()
  act(() => useMissionControl.getState().updateProposal(editedProposal))
  if (ending === 'unmount') view.unmount()
  else act(() => useMissionControl.getState().setCurrentUser({ ...user, workspace_id: 2 }))
  const localState = useMissionControl.getState().proposals
  await resolveProposals(stale, [proposal, secondProposal])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(useMissionControl.getState().proposals).toEqual(localState)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it.each(['unmount', 'workspace'])('ignores a replacement snapshot after %s and does not restart again', async (ending) => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const replacement = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  const user = { id: 1, username: 'operator', display_name: 'Operator', role: 'admin' as const, workspace_id: 1 }
  useMissionControl.getState().setCurrentUser(user)
  useMissionControl.setState({ proposals: [proposal] })
  const view = render(<EventClient />)
  emit('proposal.created', secondProposal.id)
  await flushReloadTimer()
  act(() => useMissionControl.getState().updateProposal(editedProposal))
  await resolveProposals(stale, [proposal, secondProposal])
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  if (ending === 'unmount') view.unmount()
  else act(() => useMissionControl.getState().setCurrentUser({ ...user, workspace_id: 2 }))
  const localState = useMissionControl.getState().proposals
  await resolveProposals(replacement, [editedProposal, secondProposal])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(useMissionControl.getState().proposals).toEqual(localState)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it.each(['proposal.accepted', 'proposal.dismissed', 'proposal.expired'])('merges the replacement obligation with %s without reviving the terminal proposal', async (terminal) => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const replacement = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  useMissionControl.setState({ proposals: [proposal] })
  render(<EventClient />)
  emit('proposal.created', secondProposal.id)
  await flushReloadTimer()
  act(() => useMissionControl.getState().updateProposal(editedProposal))
  emit(terminal, secondProposal.id)
  await resolveProposals(stale, [proposal, secondProposal])
  expect(useMissionControl.getState().proposals).toEqual([editedProposal])
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await resolveProposals(replacement, [editedProposal])
  expect(useMissionControl.getState().proposals).toEqual([editedProposal])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not retry a failed replacement without a new invalidation', async () => {
  vi.useFakeTimers()
  const stale = deferredResponse()
  const replacement = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(replacement.promise)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  useMissionControl.setState({ proposals: [proposal] })
  render(<EventClient />)
  emit('proposal.created', secondProposal.id)
  await flushReloadTimer()
  act(() => useMissionControl.getState().updateProposal(editedProposal))
  await resolveProposals(stale, [proposal, secondProposal])
  await flushReloadTimer()
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await act(async () => {
    replacement.resolve(new Response(JSON.stringify({ error: 'offline' }), { status: 500 }))
    await replacement.promise
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(useMissionControl.getState().proposals).toEqual([editedProposal])
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('deduplicates proposal store upserts by proposal id', () => {
  const newer = { ...proposal, title: 'Repair the persisted login redirect' }
  useMissionControl.getState().setProposals([proposal, newer])
  useMissionControl.getState().addProposal(newer)
  useMissionControl.getState().updateProposal(newer)

  expect(useMissionControl.getState().proposals).toEqual([newer])
})

it('upserts a reloaded compact proposal event without duplicate cards', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ proposals: [proposal] }))))
  render(<EventClient />)

  FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'proposal.created', data: { id: proposal.id, revision: proposal.revision } }) } as MessageEvent<string>)
  await waitFor(() => expect((useMissionControl.getState() as unknown as { proposals: TaskProposal[] }).proposals).toEqual([proposal]))

  FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'proposal.updated', data: { id: proposal.id, revision: proposal.revision } }) } as MessageEvent<string>)
  await waitFor(() => expect((useMissionControl.getState() as unknown as { proposals: TaskProposal[] }).proposals).toHaveLength(1))
})

it('removes accepted, dismissed, and expired proposals from the pending queue', () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  useMissionControl.setState({ proposals: [proposal] } as never)
  render(<EventClient />)

  for (const type of ['proposal.accepted', 'proposal.dismissed', 'proposal.expired']) {
    useMissionControl.setState({ proposals: [proposal] } as never)
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type, data: { id: proposal.id } }) } as MessageEvent<string>)
    expect((useMissionControl.getState() as unknown as { proposals: TaskProposal[] }).proposals).toEqual([])
  }
})
