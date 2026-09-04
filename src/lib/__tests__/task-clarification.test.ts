import { describe, expect, it } from 'vitest'
import { questionSetSchema, answerSetSchema, validateAnswers, clarificationPrompt } from '../task-clarification'

const questions = [{ id: 'q1', prompt: 'Quel périmètre ?', multiple: false, options: [
  { id: 'a', label: 'Minimum', recommended: true, reason: 'Livraison rapide' },
  { id: 'b', label: 'Complet' },
] }]

describe('task clarification', () => {
  it('rejects duplicate question and option identifiers', () => {
    expect(questionSetSchema.safeParse({ questions: [questions[0], questions[0]] }).success).toBe(false)
    expect(questionSetSchema.safeParse({ questions: [{ ...questions[0], options: [questions[0].options[0], questions[0].options[0]] }] }).success).toBe(false)
  })
  it('requires an explanation for a recommendation', () => {
    expect(questionSetSchema.safeParse({ questions: [{ ...questions[0], options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B' }] }] }).success).toBe(false)
  })
  it('rejects empty, duplicate, unknown and multiple single-choice answers', () => {
    for (const selected of [[], ['a', 'a'], ['x'], ['a', 'b']]) {
      expect(validateAnswers(questions, [{ questionId: 'q1', selected, text: '' }])).not.toBeNull()
    }
    expect(validateAnswers(questions, [])).not.toBeNull()
    expect(validateAnswers(questions, [{ questionId: 'q1', selected: ['a'], text: '' }, { questionId: 'q1', selected: ['a'], text: '' }])).not.toBeNull()
  })
  it('accepts free text instead of a choice and multiple selections when allowed', () => {
    expect(validateAnswers(questions, [{ questionId: 'q1', selected: [], text: 'Un autre périmètre' }])).toBeNull()
    expect(validateAnswers([{ ...questions[0], multiple: true }], [{ questionId: 'q1', selected: ['a', 'b'], text: '' }])).toBeNull()
  })
  it('requires a revision for answers to prevent stale submissions', () => {
    expect(answerSetSchema.safeParse({ answers: [] }).success).toBe(false)
  })
  it('includes human answers, not unaccepted recommendations, in the execution prompt', () => {
    const prompt = clarificationPrompt({ clarification: { state: 'answered', questions, answers: [{ questionId: 'q1', selected: ['b'], text: 'Sans abonnement annuel' }], revision: 'v1', createdBy: 'agent', createdAt: 1 } })
    expect(prompt).toContain('Complet')
    expect(prompt).toContain('Sans abonnement annuel')
    expect(prompt).not.toContain('Livraison rapide')
    expect(clarificationPrompt({ clarification: { state: 'pending', questions, revision: 'v1', createdBy: 'agent', createdAt: 1 } })).toBe('')
  })
})
