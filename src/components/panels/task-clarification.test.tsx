import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskClarification } from './task-clarification'

const clarification = { state: 'pending' as const, revision: 'v1', createdBy: 'agent', createdAt: 1, questions: [
  { id: 'q1', prompt: 'Quel périmètre ?', multiple: false, options: [{ id: 'a', label: 'Minimum', recommended: true, reason: 'Plus rapide' }, { id: 'b', label: 'Complet' }] },
  { id: 'q2', prompt: 'Quels canaux ?', multiple: true, options: [{ id: 'a', label: 'Email' }, { id: 'b', label: 'Blog' }] },
] }
afterEach(() => vi.unstubAllGlobals())
it('does not preselect recommendations and blocks incomplete answers', () => {
  render(<TaskClarification taskId={1} value={clarification} canEdit onUpdate={() => {}} />)
  expect(screen.getByRole('radio', { name: /Minimum/ })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Valider mes réponses' })).toBeDisabled()
})
it('submits single/multiple choices with revision and shows saved state', async () => {
  let sent: any
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    sent = JSON.parse(init.body)
    return new Response(JSON.stringify({ clarification: { ...clarification, state: 'answered', answers: sent.answers, answeredBy: 'Antonin' } }), { status: 200 })
  }))
  render(<TaskClarification taskId={1} value={clarification} canEdit onUpdate={() => {}} />)
  fireEvent.click(screen.getByRole('radio', { name: /Minimum/ }))
  fireEvent.click(screen.getByRole('radio', { name: 'Complet' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Email' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Blog' }))
  fireEvent.click(screen.getByRole('button', { name: 'Valider mes réponses' }))
  await waitFor(() => expect(screen.getByText('Cadrage validé')).toBeInTheDocument())
  expect(sent).toEqual({ revision: 'v1', answers: [{ questionId: 'q1', selected: ['b'], text: '' }, { questionId: 'q2', selected: ['a', 'b'], text: '' }] })
})
it('offers free text alternatives and exposes server errors without losing draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Le cadrage a changé' }), { status: 409 })))
  render(<TaskClarification taskId={1} value={clarification} canEdit onUpdate={() => {}} />)
  screen.getAllByRole('textbox').forEach(input => fireEvent.change(input, { target: { value: 'Ma précision' } }))
  fireEvent.click(screen.getByRole('button', { name: 'Valider mes réponses' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Le cadrage a changé')
  expect(screen.getAllByRole('textbox')[0]).toHaveValue('Ma précision')
})
