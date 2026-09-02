import { expect, test, type Page } from '@playwright/test'

const TEST_USER = process.env.AUTH_USER || 'testadmin'
const TEST_PASS = process.env.AUTH_PASS || 'testpass1234!'

async function signIn(page: Page) {
  const loginResponse = await page.request.post('/api/auth/login', {
    data: { username: TEST_USER, password: TEST_PASS },
    headers: { 'x-forwarded-for': `10.42.0.${Math.floor(Math.random() * 200) + 1}` },
  })
  expect(loginResponse.status()).toBe(200)

  await page.goto('/')

  const skipSetup = page.getByRole('button', { name: 'Skip setup' })
  await expect(page.getByRole('navigation').or(skipSetup)).toBeVisible({ timeout: 30_000 })
  if (await skipSetup.isVisible().catch(() => false)) {
    await skipSetup.click()
  }

  await expect(page.getByRole('navigation')).toBeVisible()
}

test.describe('Browser quality regressions', () => {
  test('robots policy is public and blocks indexing of the private dashboard', async ({ request }) => {
    const response = await request.get('/robots.txt', { maxRedirects: 0 })

    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/plain')
    expect(await response.text()).toMatch(/User-agent:\s*\*/i)
    expect(await response.text()).toMatch(/Disallow:\s*\//i)
  })

  test('login exposes a main landmark and permits browser zoom', async ({ page }) => {
    await page.goto('/login')

    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
      'content',
      /maximum-scale=1(?:\.0)?(?:,|$)/
    )
  })

  test('dashboard has one page heading and named controls', async ({ page }) => {
    await signIn(page)

    await expect(page.getByRole('heading', { level: 1, name: 'Mission Control overview' })).toHaveCount(1)

    const controls = page.locator('button:visible, [role="button"]:visible')
    const unnamedControls: string[] = []
    for (let index = 0; index < await controls.count(); index += 1) {
      const control = controls.nth(index)
      const accessibleName = await control.getAttribute('aria-label') ||
        await control.getAttribute('aria-labelledby') ||
        await control.getAttribute('title') ||
        await control.innerText()
      if (!accessibleName.trim()) {
        unnamedControls.push((await control.evaluate((element) => element.outerHTML)).slice(0, 500))
      }
    }

    expect(unnamedControls).toEqual([])
  })

  test('standalone dashboard buttons meet the 24px target-size floor', async ({ page }) => {
    await signIn(page)

    const undersizedButtons = await page.locator('button:visible, [role="button"]:visible').evaluateAll((controls) =>
      controls
        .map((control) => {
          const rect = control.getBoundingClientRect()
          return {
            name: (
              control.getAttribute('aria-label') ||
              control.getAttribute('title') ||
              control.textContent ||
              '<unnamed>'
            ).trim().replace(/\s+/g, ' ').slice(0, 80),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
        })
        .filter(({ width, height }) => width < 24 || height < 24)
    )

    expect(undersizedButtons).toEqual([])
  })
})
