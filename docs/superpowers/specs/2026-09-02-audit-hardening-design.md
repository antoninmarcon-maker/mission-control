# Mission Control Audit Hardening Design

## Objective

Turn the September 2026 audit findings into a focused hardening release without redesigning Mission Control or changing its runtime architecture. The result must improve security hygiene, first-run behavior, accessibility, browser quality, and test reproducibility while preserving the existing API and operator workflows.

## Baseline evidence

The clean `main` baseline produced the following results:

- ESLint: pass.
- TypeScript: pass.
- Vitest: 182 files and 1,577 tests pass.
- Production build and standalone artifact preparation: pass.
- Playwright: 514 tests pass after installing the matching Chromium binary.
- API contract parity and security shell tests: pass.
- Lighthouse on `/login`: Performance 90, Accessibility 92, Best Practices 100, SEO 92; LCP 3.6 seconds.
- `pnpm audit --audit-level moderate`: 8 high and 5 moderate advisories.
- `pnpm audit --prod --audit-level moderate`: 7 high and 1 moderate advisories because build and lint tooling currently lives in `dependencies`.

Rendered-browser inspection also found:

- `maximum-scale=1` prevents browser zoom.
- `/login` has no `main` landmark.
- The authenticated dashboard has no level-one heading.
- Three dashboard controls render 14-16 CSS pixels high, below the WCAG 2.2 AA 24-pixel target minimum.
- One authenticated-dashboard button has no accessible name.
- Completed or skipped onboarding intentionally reopens in every fresh browser tab because `getOnboardingSessionDecision()` converts terminal server state into replay state.
- Optional GitHub and OpenClaw probes return HTTP 400 responses during an otherwise healthy local-mode dashboard boot, producing noisy browser console errors.
- `/robots.txt` is intercepted by authentication and returns login HTML instead of a crawler policy.

## Scope

### Dependency hygiene

Update direct and transitive dependencies only as far as necessary to remove known high and moderate advisories. Prefer compatible patch/minor resolution changes. Move build-only packages such as ESLint and TypeScript to `devDependencies` when runtime packaging does not require them. Do not accept a major framework or database migration solely to make the audit output shorter.

### Onboarding persistence

The server remains the source of truth for onboarding completion and skip state. A fresh browser session must not reopen onboarding when the server reports `completed` or `skipped`. Explicit replay remains available from Settings by resetting the server state, clearing session dismissal/replay flags, and opening the wizard from step one.

### Accessibility and semantics

Remove the restrictive maximum zoom scale. Give the login screen a `main` landmark. Give the authenticated dashboard one discoverable level-one heading without changing the visual hierarchy. Ensure every visible interactive element has an accessible name, and ensure standalone dashboard controls meet a minimum 24-by-24 CSS-pixel target size. Preserve the existing skip link and keyboard-first focus behavior.

### Optional-integration behavior

An unconfigured optional integration is a normal disabled state, not a browser error. Dashboard requests must either avoid probes that cannot succeed or receive a successful typed response describing the disabled state. Genuine configuration failures must remain visible to operators and logs. No blanket swallowing of unexpected exceptions is allowed.

### Private crawler policy

Serve a valid public `/robots.txt` containing `User-agent: *` and `Disallow: /`. Authentication middleware must exempt only that exact path. Mission Control is a private control plane and must not advertise indexable application routes.

### Low-risk loading improvements

Keep Lighthouse Performance at or above the 90 baseline and reduce login rendering delay only where the change is local and measurable. Do not introduce speculative caching, a service worker, or a broad bundle rewrite. Accessibility, correctness, and security take priority over chasing a synthetic score.

## Verification architecture

Every behavioral correction starts with a focused failing Vitest or Playwright test. The failure must demonstrate the current defect, and the smallest implementation must make it pass. Existing suites then guard compatibility.

The final verification loop is:

1. Focused red-green regression tests.
2. `pnpm audit --audit-level moderate` and `pnpm audit --prod --audit-level moderate`.
3. `pnpm lint` and `pnpm typecheck`.
4. `pnpm test`.
5. `pnpm build` and `pnpm artifact:check`.
6. `pnpm test:e2e`.
7. Production-mode browser audit on isolated SQLite data with synthetic credentials.
8. Lighthouse on `/login`.
9. Manual keyboard, 390-pixel mobile viewport, 200% zoom, error-message, onboarding persistence, and optional-integration checks.

## Acceptance criteria

- No known high or moderate advisory remains in the resolved dependency graph. If the package registry reports an advisory with no compatible fix, the PR must document the exact dependency path and exposure rather than hide it.
- Onboarding does not reopen after completion or skip in a fresh tab or browser session; Settings replay still works.
- Lighthouse Accessibility reaches 100 on `/login`.
- Lighthouse Best Practices remains 100 and Performance remains at least 90 on the same machine and production build.
- `/robots.txt` returns status 200, `text/plain`, and `Disallow: /` without authentication.
- The login screen and authenticated shell have correct main/heading semantics.
- No visible interactive element found by the audit script lacks an accessible name.
- Standalone dashboard controls found by the audit script are at least 24 by 24 CSS pixels. The visually hidden skip link is excluded until focused.
- No unexpected console error, page error, or failed application request occurs during login, onboarding dismissal, dashboard load, and the selected core navigation checks. The deliberately rejected invalid-login request is recorded separately.
- Lint, typecheck, all unit tests, production build, artifact check, API parity, security shell tests, and all Playwright tests pass.
- No real credential, `.env` file, SQLite database, browser state, or audit trace is committed.

## Demonstration environment

The final protocol uses an isolated `MISSION_CONTROL_DATA_DIR`, a loopback-only server, and clearly marked demonstration credentials. Those credentials have no value outside that temporary database. The final handoff provides the URL, username, password, API key, startup command, cleanup guidance, screenshots, and the exact test sequence without exposing personal or production secrets.

## Delivery

This repository has no local Vercel project link. Delivery therefore consists of a draft GitHub PR with the repository quality workflow and security scanners as the deployment-equivalent gates. No production merge is implied by this design.
