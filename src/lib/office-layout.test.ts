import { describe, expect, it } from 'vitest'
import {
  getAgentProjectVisual,
  getIdleMinutes,
  getZoneByRole,
  sortOfficeAgents,
} from '@/lib/office-layout'
import type { Agent } from '@/store'

describe('getZoneByRole', () => {
  it.each([
    ['Développement NutriSecure', 'engineering'],
    ['Maintenance My Volley', 'operations'],
    ['Marketing Love Experience', 'product'],
    ['Contrôle qualité indépendant', 'quality'],
    ['Gestion de la base NutriSecure', 'operations'],
  ])('places the French role %s in the %s zone', (role, expectedZone) => {
    expect(getZoneByRole(role).id).toBe(expectedZone)
  })
})

describe('getAgentProjectVisual', () => {
  it.each([
    ['nutrisecure-dev', 'Développement NutriSecure', 'nutrisecure', 'NutriSecure', '#34d399'],
    ['myvolley-marketing', 'Marketing My Volley', 'my-volley', 'My Volley', '#60a5fa'],
    ['loveexp-maintenance', 'Maintenance Love Experience', 'love-experience', 'Love Experience', '#fb7185'],
    ['frenchsexploration-produit-dev', 'Produit French Sexploration', 'french-sexploration', 'French Sexploration', '#c084fc'],
    ['ops-ressources', 'Ops & ressources', 'ops', 'Ops', '#fbbf24'],
    ['exec-standard', 'agent', 'mission-control', 'Mission Control', '#22d3ee'],
    ['controle-qualite', 'Contrôle qualité indépendant', 'transverse', 'Transverse', '#94a3b8'],
  ])('assigns %s to a stable project identity', (name, role, key, label, accent) => {
    expect(getAgentProjectVisual({ name, role })).toMatchObject({ key, label, accent })
  })

  it('uses the local working directory when the agent name does not identify a project', () => {
    expect(getAgentProjectVisual({
      name: 'worker-local',
      role: 'software-engineer',
      config: { localSession: { workingDir: '/Users/antoninmarcon/Documents/antoninwebsite' } },
    })).toMatchObject({ key: 'antoninwebsite', label: 'Antoninwebsite' })
  })
})

describe('sortOfficeAgents', () => {
  it('keeps working and error agents visible before idle and offline agents', () => {
    const makeAgent = (name: string, status: Agent['status']): Agent => ({
      id: name.length,
      name,
      role: 'agent',
      status,
      created_at: 1,
      updated_at: 1,
    })

    const sorted = sortOfficeAgents([
      makeAgent('offline-agent', 'offline'),
      makeAgent('idle-agent', 'idle'),
      makeAgent('error-agent', 'error'),
      makeAgent('working-agent', 'busy'),
    ])

    expect(sorted.map((agent) => agent.name)).toEqual([
      'working-agent',
      'error-agent',
      'idle-agent',
      'offline-agent',
    ])
  })
})

describe('getIdleMinutes', () => {
  it('returns null instead of an infinite duration when last seen is missing', () => {
    expect(getIdleMinutes(undefined, 1_800)).toBeNull()
  })

  it('never returns a negative duration for a future timestamp', () => {
    expect(getIdleMinutes(2_000, 1_800)).toBe(0)
  })
})
