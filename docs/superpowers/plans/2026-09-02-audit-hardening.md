# Mission Control Audit Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the verified security, onboarding, accessibility, crawler, and optional-integration defects while preserving Mission Control's existing operator workflows.

**Architecture:** Keep server state authoritative for onboarding, represent optional integrations as successful unavailable states, and enforce rendered accessibility through Playwright. Dependency fixes stay within compatible releases and all behavior changes are isolated behind existing route/component boundaries.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, SQLite, Tailwind CSS 4, Vitest, Playwright, pnpm, Lighthouse 13.

**Spec:** `docs/superpowers/specs/2026-09-02-audit-hardening-design.md`

## Global Constraints

- Do not commit `.env*`, SQLite data, browser state, traces, screenshots, or real credentials.
- Use pnpm only and preserve Node.js 22 compatibility.
- Do not perform a major framework, React, TypeScript, or database migration.
- Keep the REST authentication and authorization boundary unchanged.
- Every behavioral correction must be demonstrated by a failing test before implementation.
- Performance must remain at least 90 in the production-mode `/login` Lighthouse run.
- The final draft PR must remain unmerged until the repository's normal review decision.

---

### Task 1: Resolve dependency advisories and runtime dependency classification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: the existing package scripts and standalone Next.js build contract.
- Produces: a dependency graph with no high or moderate advisory and a runtime install that excludes build-only tooling.

- [ ] **Step 1: Record the failing security gate**

Run:

```bash
pnpm audit --audit-level moderate
pnpm audit --prod --audit-level moderate
```

Expected: both commands fail; the first reports 8 high and 5 moderate advisories and the production graph reports 7 high and 1 moderate advisories.

- [ ] **Step 2: Correct direct package classification**

Move `eslint`, `eslint-config-next`, and `typescript` from `dependencies` to `devDependencies`. Keep their current compatible ranges before refreshing the lockfile.

- [ ] **Step 3: Refresh compatible dependency resolutions**

Run:

```bash
pnpm update --latest=false
```

If a vulnerable transitive remains even though a compatible patched version exists, add the narrowest `pnpm.overrides` entry for the affected package and patched version. Do not add overrides for packages absent from the audit output.

- [ ] **Step 4: Verify dependency and build contracts**

Run:

```bash
pnpm audit --audit-level moderate
pnpm audit --prod --audit-level moderate
pnpm lint
pnpm typecheck
pnpm build
pnpm artifact:check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: resolve dependency security advisories"
```

### Task 2: Make onboarding completion and skip persistent

**Files:**
- Modify: `src/lib/__tests__/onboarding-session.test.ts`
- Modify: `src/lib/onboarding-session.ts`

**Interfaces:**
- Consumes: `getOnboardingSessionDecision(OnboardingSessionDecisionParams)`.
- Produces: `{ shouldOpen: false, replayFromStart: false }` for completed or skipped server state; Settings continues to replay by resetting server state and directly opening the wizard.

- [ ] **Step 1: Write the failing tests**

Replace the completion replay expectation and add the skipped case:

```ts
it('keeps completed onboarding closed in a fresh browser session', () => {
  expect(getOnboardingSessionDecision({
    isAdmin: true,
    serverShowOnboarding: false,
    completed: true,
    skipped: false,
    dismissedThisSession: false,
  })).toEqual({ shouldOpen: false, replayFromStart: false })
})

it('keeps skipped onboarding closed in a fresh browser session', () => {
  expect(getOnboardingSessionDecision({
    isAdmin: true,
    serverShowOnboarding: false,
    completed: false,
    skipped: true,
    dismissedThisSession: false,
  })).toEqual({ shouldOpen: false, replayFromStart: false })
})
```

- [ ] **Step 2: Run the focused test and verify red**

Run:

```bash
pnpm vitest run src/lib/__tests__/onboarding-session.test.ts
```

Expected: the completed and skipped cases fail because the current function returns `shouldOpen: true`.

- [ ] **Step 3: Implement the minimal server-state decision**

Change the terminal-state branch in `getOnboardingSessionDecision()` to:

```ts
if (params.completed || params.skipped) {
  return { shouldOpen: false, replayFromStart: false }
}
```

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm vitest run src/lib/__tests__/onboarding-session.test.ts
```

Expected: all onboarding-session tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding-session.ts src/lib/__tests__/onboarding-session.test.ts
git commit -m "fix: persist onboarding dismissal across sessions"
```

### Task 3: Enforce accessible shell semantics and control sizing

**Files:**
- Create: `tests/browser-quality.spec.ts`
- Modify: `src/app/layout.tsx`
- Modify: `src/app/login/page.tsx`
- Modify: `src/components/dashboard/dashboard.tsx`
- Modify: `src/components/dashboard/empty-state-launchpad.tsx`
- Modify: `src/app/[[...panel]]/page.tsx`

**Interfaces:**
- Consumes: the existing `/login`, `/`, onboarding, navigation, and Playwright test environment.
- Produces: zoomable pages, one main landmark per screen, a dashboard level-one heading, named icon controls, and 24-pixel minimum standalone action targets.

- [ ] **Step 1: Write the failing browser assertions**

Create `tests/browser-quality.spec.ts` with authenticated setup and these assertions:

```ts
import { test, expect } from '@playwright/test'

const user = process.env.AUTH_USER || 'testadmin'
const pass = process.env.AUTH_PASS || 'testpass1234!'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill(user)
  await page.getByLabel('Password').fill(pass)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL('/')
}

async function dismissOnboarding(page: import('@playwright/test').Page) {
  const skip = page.getByRole('button', { name: 'Skip setup' })
  if (await skip.count()) await skip.click()
}

test('login allows zoom and exposes a main landmark', async ({ page }) => {
  await page.goto('/login')
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute('content', /maximum-scale=1/)
  await expect(page.getByRole('main')).toHaveCount(1)
})

test('dashboard has a level-one heading and named live-feed control', async ({ page }) => {
  await login(page)
  await dismissOnboarding(page)
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  const liveFeed = page.getByRole('button', { name: 'Show live feed' })
  if (await liveFeed.count()) await expect(liveFeed).toHaveAccessibleName('Show live feed')
})

test('empty-state text actions meet the WCAG target minimum', async ({ page }) => {
  await login(page)
  await dismissOnboarding(page)
  for (const name of ['Install more runtimes', 'View fleet', 'Open task board']) {
    const control = page.getByRole('button', { name: new RegExp(name, 'i') })
    if (await control.count()) {
      const box = await control.boundingBox()
      expect(box?.height).toBeGreaterThanOrEqual(24)
      expect(box?.width).toBeGreaterThanOrEqual(24)
    }
  }
})
```

- [ ] **Step 2: Run the focused Playwright test and verify red**

Run:

```bash
pnpm exec playwright test tests/browser-quality.spec.ts
```

Expected: zoom, login landmark, dashboard heading, live-feed accessible name, and at least one control-size assertion fail.

- [ ] **Step 3: Implement minimal semantic corrections**

- Remove `maximumScale: 1` from the exported viewport.
- Change the login screen's outer wrapper from `div` to `main`.
- Add `<h1 className="sr-only">Mission Control overview</h1>` at the start of `Dashboard` output.
- Add `aria-label={tp('showLiveFeed')}` and `aria-hidden="true"` on the floating live-feed button and its SVG.
- Add `inline-flex min-h-6 items-center` to the three text-only action buttons in `empty-state-launchpad.tsx`.

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm exec playwright test tests/browser-quality.spec.ts
```

Expected: all browser-quality tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/browser-quality.spec.ts src/app/layout.tsx src/app/login/page.tsx src/components/dashboard/dashboard.tsx src/components/dashboard/empty-state-launchpad.tsx 'src/app/[[...panel]]/page.tsx'
git commit -m "fix: improve dashboard accessibility semantics"
```

### Task 4: Represent unavailable integrations without ambient HTTP errors

**Files:**
- Modify: `tests/github-sync.spec.ts`
- Modify: `src/lib/__tests__/openclaw-doctor-route.test.ts`
- Modify: `src/app/api/github/route.ts`
- Modify: `src/app/api/openclaw/doctor/route.ts`
- Modify: `src/components/dashboard/dashboard.tsx`
- Modify: `src/components/layout/openclaw-doctor-banner.tsx`

**Interfaces:**
- Consumes: `GET /api/github?action=stats`, `GET /api/openclaw/doctor`, and the dashboard/banner clients.
- Produces: HTTP 200 payloads `{ configured: false }` and `{ available: false, ... }` for absent optional tools while preserving non-200 responses for invalid actions, authorization failures, and real upstream failures.

- [ ] **Step 1: Write failing API tests**

Add to `tests/github-sync.spec.ts`:

```ts
test('GET /api/github?action=stats treats an absent token as unconfigured', async ({ request }) => {
  const res = await request.get('/api/github?action=stats', { headers: API_KEY_HEADER })
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ configured: false })
})
```

Change the OpenClaw missing-runtime test to require status 200 and:

```ts
await expect(first.json()).resolves.toMatchObject({
  available: false,
  healthy: false,
  canFix: false,
})
```

- [ ] **Step 2: Run focused tests and verify red**

Run:

```bash
pnpm vitest run src/lib/__tests__/openclaw-doctor-route.test.ts
pnpm exec playwright test tests/github-sync.spec.ts
```

Expected: both new unavailable-state assertions fail with status 400.

- [ ] **Step 3: Implement typed unavailable states**

- Return `NextResponse.json({ configured: false })` when GitHub stats has no token.
- Return status 200 for missing OpenClaw with `{ available: false, healthy: false, level: 'warning', category: 'general', summary: 'OpenClaw is not installed', issues: [], canFix: false, raw: '' }`.
- Keep the missing-OpenClaw response uncached so installation is detected on the next poll.
- In the dashboard, only call `setGithubStats(data)` when `data.configured !== false`.
- Extend `OpenClawDoctorStatus` with `available?: boolean` and make the banner return `null` when `doctor.available === false`.

- [ ] **Step 4: Verify green and keep error semantics intact**

Run:

```bash
pnpm vitest run src/lib/__tests__/openclaw-doctor-route.test.ts
pnpm exec playwright test tests/github-sync.spec.ts tests/auth-guards.spec.ts
```

Expected: all focused tests pass, unauthorized requests remain 401, and invalid GitHub actions remain 400.

- [ ] **Step 5: Commit**

```bash
git add tests/github-sync.spec.ts src/lib/__tests__/openclaw-doctor-route.test.ts src/app/api/github/route.ts src/app/api/openclaw/doctor/route.ts src/components/dashboard/dashboard.tsx src/components/layout/openclaw-doctor-banner.tsx
git commit -m "fix: model unavailable integrations as healthy states"
```

### Task 5: Publish a private crawler policy

**Files:**
- Create: `src/app/robots.ts`
- Modify: `src/proxy.ts`
- Modify: `tests/browser-quality.spec.ts`

**Interfaces:**
- Consumes: Next.js metadata routes and the exact-path public-route list in `proxy()`.
- Produces: unauthenticated `GET /robots.txt` with a site-wide disallow policy.

- [ ] **Step 1: Add the failing browser/API assertion**

Append:

```ts
test('robots policy is public and disallows indexing', async ({ request }) => {
  const res = await request.get('/robots.txt')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('text/plain')
  expect(await res.text()).toContain('Disallow: /')
})
```

- [ ] **Step 2: Run and verify red**

Run:

```bash
pnpm exec playwright test tests/browser-quality.spec.ts -g "robots policy"
```

Expected: the response redirects to `/login` or returns login HTML.

- [ ] **Step 3: Implement the metadata route and exact exemption**

Create:

```ts
import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } }
}
```

Add only `pathname === '/robots.txt'` to the public-path condition in `src/proxy.ts`.

- [ ] **Step 4: Verify green**

Run:

```bash
pnpm exec playwright test tests/browser-quality.spec.ts -g "robots policy"
```

Expected: the test passes.

- [ ] **Step 5: Commit**

```bash
git add src/app/robots.ts src/proxy.ts tests/browser-quality.spec.ts
git commit -m "fix: publish private robots policy"
```

### Task 6: Run the full quality loop and deliver the operator protocol

**Files:**
- Create: `docs/testing/audit-hardening-test-protocol.md`
- Modify: `docs/superpowers/plans/2026-09-02-audit-hardening.md`

**Interfaces:**
- Consumes: all corrected application surfaces and the isolated test-data pattern.
- Produces: reproducible operator instructions and fresh verification evidence attached to the draft PR.

- [ ] **Step 1: Run repository gates**

Run:

```bash
pnpm audit --audit-level moderate
pnpm audit --prod --audit-level moderate
pnpm lint
pnpm typecheck
pnpm test
pnpm api:parity
pnpm test:security-shell
pnpm build
pnpm artifact:check
pnpm test:e2e
```

Expected: every command exits 0 with no failed test.

- [ ] **Step 2: Run production browser and Lighthouse audits**

Use a unique ignored `MISSION_CONTROL_DATA_DIR`, loopback port 3001, and the synthetic credentials documented in the protocol. Capture login, onboarding, desktop dashboard, and 390-by-844 mobile dashboard screenshots outside the repository. Run Lighthouse 13 against `/login` and record category scores and Core Web Vitals.

- [ ] **Step 3: Verify regression-test integrity**

For each new behavioral test, temporarily inspect the pre-fix behavior or revert only the corresponding production hunk, confirm the test fails for the expected reason, restore the hunk, and confirm the test passes. Do not commit the temporary reversion.

- [ ] **Step 4: Write the operator protocol**

Document:

- prerequisites and install command;
- isolated environment variables and loopback startup command;
- synthetic username, password, and API key, clearly marked non-production;
- login, invalid-login, onboarding persistence, navigation, mobile, zoom, keyboard, optional-integration, API-key, and logout checks;
- automated verification commands and expected results;
- cleanup of only the explicitly named temporary data directory;
- the rule never to reuse demonstration credentials on a reachable deployment.

- [ ] **Step 5: Mark completed plan checkboxes and commit**

```bash
git add docs/testing/audit-hardening-test-protocol.md docs/superpowers/plans/2026-09-02-audit-hardening.md
git commit -m "docs: add audit hardening test protocol"
```

- [ ] **Step 6: Push and inspect draft PR checks**

```bash
ship push -m "chore: finalize mission control audit hardening"
gh pr checks 3 --watch
```

Expected: branch is pushed, PR #3 remains draft, and all required checks pass. If a check fails, diagnose its root cause, add a focused regression test when applicable, correct it, and repeat this task.
