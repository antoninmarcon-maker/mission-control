import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskProposal } from '@/lib/task-proposals'
import { useMissionControl } from '@/store'
import { ProposalRail } from './proposal-rail'

const messages = {
  common: { loading: 'Loading...', retry: 'Retry' },
  taskProposals: {
    title: 'Proposals', empty: 'No pending proposals', validateLaunch: 'Validate and launch',
    modify: 'Modify', dismiss: 'Dismiss', context: 'Context', whyNow: 'Why now',
    forecast: 'Expected route', forecastDisclaimer: 'The orchestrator rechecks the route at launch.',
    accepted: 'Task launched', stale: 'This proposal changed. The latest version has been loaded.',
    failed: 'The proposal could not be updated. Try again.',
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
  vi.unstubAllGlobals()
  useMissionControl.setState({ proposals: [] })
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
  expect(screen.getByRole('heading', { name: 'Repair the login redirect' }).closest('article')).toHaveClass('min-w-[min(22rem,calc(100vw-2rem))]')
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
