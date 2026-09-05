import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskProposal } from '@/lib/task-proposals'
import { ProposalCard } from './proposal-card'

const messages = {
  common: { save: 'Save changes', cancel: 'Cancel' },
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
  objective: 'Return users to the requested page after authentication.',
  context: 'The callback URL is lost after a session expires.',
  rationale: 'An unresolved audit item blocks the authentication rollout.',
  risk: 'medium', routeForecast: { runtime: 'codex', model: 'gpt-5.6', reason: 'The change is isolated.' },
  metadata: {}, status: 'pending', revision: 'c6d88a9f-93b5-44f2-895d-4856e8014b41',
  orchestratorAgent: 'codex', createdBy: 'audit', acceptedBy: null, acceptedAt: null,
  dismissedBy: null, dismissedAt: null, dismissalReason: null, taskId: null,
  expiresAt: null, createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
}

function renderCard(overrides: Partial<React.ComponentProps<typeof ProposalCard>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ProposalCard
        proposal={proposal}
        onAccept={async () => {}}
        onEdit={async () => {}}
        onDismiss={async () => {}}
        {...overrides}
      />
    </NextIntlClientProvider>,
  )
}

afterEach(() => vi.restoreAllMocks())

it('keeps the authorization decision visible while keeping private context disclosed', async () => {
  const accept = vi.fn(async () => {})
  renderCard({ onAccept: accept })

  expect(screen.getByRole('heading', { name: 'Repair the login redirect' })).toBeVisible()
  expect(screen.getByText('Return users to the requested page after authentication.')).toBeVisible()
  expect(screen.getByText(/An unresolved audit item blocks the authentication rollout\./)).toBeVisible()
  expect(screen.getByText(/Codex/)).toBeVisible()
  expect(screen.getByText(/chat/)).toBeVisible()
  expect(screen.getByText('MEDIUM')).toBeVisible()
  expect(screen.getByText('The orchestrator rechecks the route at launch.')).toBeVisible()
  expect(screen.queryByText('The callback URL is lost after a session expires.')).not.toBeInTheDocument()

  const acceptButton = screen.getByRole('button', { name: 'Validate and launch' })
  acceptButton.focus()
  expect(acceptButton).toHaveFocus()
  fireEvent.click(acceptButton)
  await waitFor(() => expect(accept).toHaveBeenCalledWith(proposal))

  fireEvent.click(screen.getByRole('button', { name: 'Context' }))
  expect(screen.getByText('The callback URL is lost after a session expires.')).toBeVisible()
})

it('edits and dismisses a pending proposal from accessible controls', async () => {
  const edit = vi.fn(async () => {})
  const dismiss = vi.fn(async () => {})
  renderCard({ onEdit: edit, onDismiss: dismiss })

  fireEvent.click(screen.getByRole('button', { name: 'Modify' }))
  const title = screen.getByLabelText('Title')
  fireEvent.change(title, { target: { value: 'Keep the callback URL' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(edit).toHaveBeenCalledWith(proposal, { title: 'Keep the callback URL' }))

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith(proposal))
})

it('disables competing decisions while an acceptance is pending', async () => {
  let release: (() => void) | undefined
  const accept = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
  renderCard({ onAccept: accept })

  fireEvent.click(screen.getByRole('button', { name: 'Validate and launch' }))
  expect(screen.getByRole('button', { name: 'Validate and launch' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Modify' })).toBeDisabled()
  release?.()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Validate and launch' })).toBeEnabled())
})

it('renders an accepted proposal as a link to the launched task', () => {
  renderCard({ proposal: { ...proposal, status: 'accepted', taskId: 42 } })
  expect(screen.getByRole('link', { name: 'Task launched' })).toHaveAttribute('href', '?taskId=42')
})
