import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OfficeAgentAvatar } from '@/components/ui/office-agent-avatar'

describe('OfficeAgentAvatar', () => {
  it('exposes the agent, project, and working state without relying on color', () => {
    render(
      <OfficeAgentAvatar
        name="nutrisecure-dev"
        status="busy"
        statusLabel="En travail"
        project={{
          key: 'nutrisecure',
          label: 'NutriSecure',
          accent: '#34d399',
          accentSoft: 'rgba(52, 211, 153, 0.16)',
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'nutrisecure-dev — NutriSecure — En travail' })).toBeInTheDocument()
    expect(screen.getByText('ND')).toBeInTheDocument()
    expect(screen.getByText('En travail')).toHaveClass('sr-only')
  })

  it('announces an offline agent explicitly', () => {
    render(
      <OfficeAgentAvatar
        name="ship-agent"
        status="offline"
        statusLabel="Hors ligne"
        project={{
          key: 'mission-control',
          label: 'Mission Control',
          accent: '#22d3ee',
          accentSoft: 'rgba(34, 211, 238, 0.16)',
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'ship-agent — Mission Control — Hors ligne' })).toBeInTheDocument()
  })
})
