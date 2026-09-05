import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskProposal } from '@/lib/task-proposals'
import { useMissionControl } from '@/store'
import { ProposalRail } from './proposal-rail'
import { useServerEvents } from '@/lib/use-server-events'

const messages = {
  common: { loading: 'Loading...', retry: 'Retry', save: 'Save changes', cancel: 'Cancel' },
  taskProposals: {
    title: 'Proposals', empty: 'No pending proposals', validateLaunch: 'Validate and launch',
    modify: 'Modify', dismiss: 'Dismiss', context: 'Context', whyNow: 'Why now',
    forecast: 'Expected route', forecastDisclaimer: 'The orchestrator rechecks the route at launch.',
    accepted: 'Task launched', stale: 'This proposal changed. The latest version has been loaded.',
    failed: 'The proposal could not be updated. Try again.',
    editTitle: 'Title', editObjective: 'Objective',
  },
}

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

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function renderRail() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProposalRail />
    </NextIntlClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useMissionControl.setState({ proposals: [], currentUser: null })
})

it('shows loading, then an empty authorization queue', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ proposals: [] })))
  renderRail()
  expect(screen.getByText('Loading...')).toBeVisible()
  expect(await screen.findByText('No pending proposals')).toBeVisible()
})

it('keeps the rail horizontally scrollable at mobile widths', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ proposals: [proposal, { ...proposal, id: 13, title: 'Second proposal' }] })))
  renderRail()
  const rail = await screen.findByRole('list', { name: 'Proposals' })
  expect(rail).toHaveClass('overflow-x-auto')
  expect(rail).toHaveClass('min-w-0', 'w-full')
  const items = within(rail).getAllByRole('listitem')
  expect(items).toHaveLength(2)
  expect(items[0]).toHaveClass('w-[min(22rem,100%)]', 'max-w-full', 'min-w-0', 'shrink-0')
  const card = screen.getByRole('heading', { name: 'Repair the login redirect' }).closest('article')
  expect(card).toHaveClass('w-full', 'max-w-full', 'min-w-0', 'break-words')
  expect(screen.getAllByRole('button', { name: 'Validate and launch' })[0].parentElement).toHaveClass('flex-wrap')
})

it('accepts once and replaces the proposal with its task link', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ proposal: { ...proposal, status: 'accepted', taskId: 44 }, task: { id: 44, title: proposal.title } }))
  vi.stubGlobal('fetch', fetchMock)
  renderRail()

  await screen.findByRole('heading', { name: proposal.title })
  fireEvent.click(screen.getByRole('button', { name: 'Validate and launch' }))
  expect(await screen.findByRole('link', { name: 'Task launched' })).toHaveAttribute('href', '?taskId=44')
  await act(async () => { useMissionControl.getState().removeProposal(proposal.id) })
  expect(screen.getByRole('link', { name: 'Task launched' })).toHaveAttribute('href', '?taskId=44')
  expect(fetchMock).toHaveBeenLastCalledWith('/api/task-proposals/12/accept', expect.objectContaining({ method: 'POST' }))
})

it('reloads the latest proposal revision after a 409 conflict', async () => {
  const latest = { ...proposal, title: 'Repair the stored login redirect', revision: '0a437936-6d3c-4a00-a2af-202ac0ea8fb3' }
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ error: 'Proposal changed' }, 409))
    .mockResolvedValueOnce(response({ proposals: [latest] })))
  renderRail()

  await screen.findByRole('heading', { name: proposal.title })
  fireEvent.click(screen.getByRole('button', { name: 'Validate and launch' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('This proposal changed. The latest version has been loaded.')
  expect(screen.getByRole('heading', { name: latest.title })).toBeVisible()
})

it('shows a recoverable request error without rendering expired proposals', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'offline' }, 500)))
  renderRail()
  expect(await screen.findByRole('alert')).toHaveTextContent('The proposal could not be updated. Try again.')
  expect(screen.queryByRole('heading', { name: proposal.title })).not.toBeInTheDocument()
})

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

it('excludes an accepted ID even if a pending snapshot contains it again', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ proposal: { ...proposal, status: 'accepted', taskId: 44 }, task: { id: 44, title: proposal.title } })))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  fireEvent.click(screen.getByRole('button', { name: 'Validate and launch' }))
  await screen.findByRole('link', { name: 'Task launched' })
  act(() => useMissionControl.setState({ proposals: [proposal] }))
  expect(screen.queryByRole('button', { name: 'Validate and launch' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('heading', { name: proposal.title })).toHaveLength(1)
})

it('keeps the edit form and its draft open after a failed save', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ error: 'offline' }, 500)))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  await user.click(screen.getByRole('button', { name: 'Modify' }))
  await user.clear(screen.getByLabelText('Title'))
  await user.type(screen.getByLabelText('Title'), 'My unsaved draft')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(messages.taskProposals.failed)
  expect(screen.getByLabelText('Title')).toHaveValue('My unsaved draft')
  expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
})

it.each(['Validate and launch', 'Dismiss', 'Save changes'])('does not claim the latest version was loaded when the %s conflict refresh fails', async (action) => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ error: 'Proposal changed' }, 409))
    .mockResolvedValueOnce(response({ error: 'offline' }, 500)))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  if (action === 'Save changes') {
    await user.click(screen.getByRole('button', { name: 'Modify' }))
    await user.type(screen.getByLabelText('Title'), ' draft')
  }
  await user.click(screen.getByRole('button', { name: action }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(messages.taskProposals.failed))
  expect(screen.queryByText(messages.taskProposals.stale)).not.toBeInTheDocument()
  if (action === 'Save changes') expect(screen.getByLabelText('Title')).toHaveValue(`${proposal.title} draft`)
})

it('retains an active draft through a successful conflict refresh until it is cancelled', async () => {
  const user = userEvent.setup()
  const latest = { ...proposal, title: 'Server title', revision: 'server-revision' }
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ error: 'Proposal changed' }, 409))
    .mockResolvedValueOnce(response({ proposals: [latest] })))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  await user.click(screen.getByRole('button', { name: 'Modify' }))
  await user.type(screen.getByLabelText('Title'), ' draft')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(messages.taskProposals.stale)
  expect(screen.getByLabelText('Title')).toHaveValue(`${proposal.title} draft`)
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await user.keyboard('{Enter}')
  expect(screen.getByLabelText('Title')).toHaveValue('Server title')
})

it('moves keyboard focus from acceptance to the launched task link', async () => {
  const user = userEvent.setup()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: [proposal] }))
    .mockResolvedValueOnce(response({ proposal: { ...proposal, status: 'accepted', taskId: 44 }, task: { id: 44, title: proposal.title } })))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  await user.tab()
  expect(screen.getByRole('button', { name: 'Validate and launch' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(await screen.findByRole('link', { name: 'Task launched' })).toHaveFocus()
})

it.each([true, false])('moves keyboard focus after dismissal with another card available: %s', async (hasNext) => {
  const user = userEvent.setup()
  const next = { ...proposal, id: 13, title: 'Second proposal' }
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(response({ proposals: hasNext ? [proposal, next] : [proposal] }))
    .mockResolvedValueOnce(response({ proposal: { ...proposal, status: 'dismissed' } })))
  renderRail()
  await screen.findByRole('heading', { name: proposal.title })
  await user.tab()
  await user.tab()
  await user.tab()
  expect(screen.getAllByRole('button', { name: 'Dismiss' })[0]).toHaveFocus()
  await user.keyboard('{Enter}')
  await waitFor(() => expect(screen.queryByRole('heading', { name: proposal.title })).not.toBeInTheDocument())
  expect(hasNext ? screen.getByRole('button', { name: 'Validate and launch' }) : screen.getByRole('region', { name: 'Proposals' })).toHaveFocus()
})

it('ignores the initial rail snapshot after unmount', async () => {
  const delayed = deferredResponse()
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(delayed.promise))
  const view = renderRail()
  view.unmount()
  await act(async () => { delayed.resolve(response({ proposals: [proposal] })); await delayed.promise })
  expect(useMissionControl.getState().proposals).toEqual([])
})

it('discards pending and accepted cards when changing workspace and ignores the old reload', async () => {
  const user = { id: 1, username: 'operator', display_name: 'Operator', role: 'admin' as const, workspace_id: 1 }
  useMissionControl.getState().setCurrentUser(user)
  const delayed = deferredResponse()
  const fetchMock = vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(response({ proposals: [] }))
  vi.stubGlobal('fetch', fetchMock)
  renderRail()
  act(() => useMissionControl.getState().setCurrentUser({ ...user, workspace_id: 2 }))
  await act(async () => { delayed.resolve(response({ proposals: [proposal] })); await delayed.promise })
  expect(await screen.findByText('No pending proposals')).toBeVisible()
  expect(useMissionControl.getState().proposals).toEqual([])
})

it('coordinates the initial rail load with an SSE terminal invalidation', async () => {
  let onmessage: ((event: MessageEvent<string>) => void) | null = null
  class Events {
    set onmessage(handler: typeof onmessage) { onmessage = handler }
    close() {}
  }
  const delayed = deferredResponse()
  vi.stubGlobal('EventSource', Events)
  vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(delayed.promise).mockResolvedValue(response({ proposals: [] })))
  function Client() { useServerEvents(); return <ProposalRail /> }
  render(<NextIntlClientProvider locale="en" messages={messages}><Client /></NextIntlClientProvider>)
  act(() => onmessage?.({ data: JSON.stringify({ type: 'proposal.dismissed', data: { id: 12 } }) } as MessageEvent<string>))
  await act(async () => { delayed.resolve(response({ proposals: [proposal] })); await delayed.promise })
  expect(screen.queryByRole('heading', { name: proposal.title })).not.toBeInTheDocument()
  expect(useMissionControl.getState().proposals).toEqual([])
})
