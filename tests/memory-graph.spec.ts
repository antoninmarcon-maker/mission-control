import { expect, test } from '@playwright/test'
import { API_KEY_HEADER } from './helpers'

test.describe('Memory graph API', () => {
  test('returns an empty optional dataset when no memory database exists', async ({ request }) => {
    const response = await request.get('/api/memory/graph?agent=all', {
      headers: API_KEY_HEADER,
    })

    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.agents).toEqual([])
    expect(typeof body.available).toBe('boolean')
  })
})
