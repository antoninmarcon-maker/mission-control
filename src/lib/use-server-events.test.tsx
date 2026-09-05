import { render, waitFor } from '@testing-library/react'
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
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
  useMissionControl.setState({ proposals: [] } as never)
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
