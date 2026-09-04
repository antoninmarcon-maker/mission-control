import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const optionSchema = z.object({
  id, label: z.string().trim().min(1).max(240),
  recommended: z.boolean().optional(), reason: z.string().trim().max(500).optional(),
}).refine(o => !o.recommended || !!o.reason, 'Une recommandation doit être expliquée.')
const questionSchema = z.object({
  id, prompt: z.string().trim().min(1).max(1000), multiple: z.boolean(),
  options: z.array(optionSchema).min(2).max(8),
}).refine(q => new Set(q.options.map(o => o.id)).size === q.options.length, 'Identifiants des options dupliqués.')
export const questionSetSchema = z.object({
  questions: z.array(questionSchema).min(1).max(6),
}).refine(s => new Set(s.questions.map(q => q.id)).size === s.questions.length, 'Identifiants des questions dupliqués.')
export const answerSetSchema = z.object({
  revision: z.string().min(1).max(100),
  answers: z.array(z.object({ questionId: id, selected: z.array(id).max(8), text: z.string().trim().max(2000) })).min(1).max(6),
})
export type ClarificationQuestion = z.infer<typeof questionSchema>
export type ClarificationAnswer = z.infer<typeof answerSetSchema>['answers'][number]
export type Clarification = {
  state: 'pending' | 'answered'; revision: string; questions: ClarificationQuestion[];
  createdBy: string; createdAt: number; answers?: ClarificationAnswer[];
  answeredBy?: string; answeredAt?: number;
}

export function validateAnswers(questions: ClarificationQuestion[], answers: ClarificationAnswer[]): string | null {
  if (answers.length !== questions.length || new Set(answers.map(a => a.questionId)).size !== answers.length) return 'Répondez à chaque question une seule fois.'
  for (const q of questions) {
    const a = answers.find(a => a.questionId === q.id)
    if (!a || (!a.selected.length && !a.text.trim())) return 'Choisissez une réponse ou ajoutez une précision pour chaque question.'
    if ((!q.multiple && a.selected.length > 1) || new Set(a.selected).size !== a.selected.length || a.selected.some(id => !q.options.some(o => o.id === id))) return 'La sélection ne correspond pas aux options proposées.'
  }
  return null
}

/** Include only confirmed human choices in subsequent agent execution. */
export function clarificationPrompt(metadata: { clarification?: Clarification }): string {
  const c = metadata.clarification
  if (c?.state !== 'answered' || !c.answers) return ''
  return ['## Cadrage validé', ...c.questions.map(q => {
    const a = c.answers!.find(a => a.questionId === q.id)
    return `${q.prompt}\n${q.options.filter(o => a?.selected.includes(o.id)).map(o => o.label).join('; ')}${a?.text ? `\n${a.text}` : ''}`
  })].join('\n\n')
}

// Reused in SELECT and atomic claim: pending cards must not consume LIMIT slots.
export const CLARIFICATION_READY_SQL = "COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.clarification.state'), '') != 'pending'"
