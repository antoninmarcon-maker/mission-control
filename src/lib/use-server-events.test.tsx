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
  useMissionControl.setState({ proposals: [], currentUser: null })
})

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

function emit(type: string, id = proposal.id) {
  act(() => FakeEventSource.instances.at(-1)?.onmessage?.({
    data: JSON.stringify({ type, data: { id } }),
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
