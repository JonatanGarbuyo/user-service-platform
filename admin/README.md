# Administración web

React + TypeScript + Vite SPA under `/admin`, served by the existing Hono
Worker's Static Assets binding on the same origin. This first slice signs in
an existing verified administrator, shows the real identity, restores access
on reload and signs out. User list/detail belong to #125/#126; Profile is deferred.

## Kit provenance and maintenance

The real Marmelab [Shadcn Admin Kit](https://marmelab.com/shadcn-admin-kit/docs/install/)
is distributed as source registry components, not as the community npm package
named `shadcn-admin-kit`. `src/kit` vendors the 38-file transitive closure used
by Admin, Layout, TextInput and Button from upstream tag **v2.0.0**, commit
[`11983abe4afc60a3904991820526aafe4d0588d3`](https://github.com/marmelab/shadcn-admin-kit/tree/11983abe4afc60a3904991820526aafe4d0588d3/src).
The upstream MIT license is preserved in `src/kit/LICENSE`.

The kit's actual Admin, Layout, authProvider facilities, form/input and UI
components are used. `src/login-page.tsx` adapts its login form for Spanish
copy, email/password fields and safe inline errors. These vendored adaptations
are intentionally small and must be retained when updating the pinned source:

- `app-sidebar.tsx`: replace demo branding and check an optional resource safely.
- `theme-mode-toggle.tsx` and `ui/sidebar.tsx`: Spanish visible/accessibility labels.
- `user-menu.tsx`: accessible Spanish menu label and safe logout failure notification.
- `refresh-button.tsx`: accessible Spanish label.

Other kit files retain upstream content and formatting. The vendor subtree is
excluded from repository formatter/lint rewriting; the complete imported code
is still typechecked and bundled. All owned TS/TSX files have typed lint gates.
Dependencies are pinned in `package.json` and the root lock. Tailwind/static CSS
provides styling; no Emotion, MUI or other CSS-in-JS library is installed.

## Authentication

`src/api.ts` consumes the runtime contracts owned by Identity; it never maintains
a second API schema. Same-origin `fetch` uses HttpOnly session cookies with
`credentials: include`. No authentication data is stored in localStorage or
sessionStorage. The kit receives an in-memory store and telemetry is disabled.
`GET /v1/admin/me` is the permission authority; public `/v1/me` stays unchanged.

ra-core's default `requireAuth` failure path invokes logout on every rejection.
Our small protected route uses its `useAuthState` without automatic logout and
wraps the real kit Layout: 401 shows login, 403 shows access denial preserving
the regular User's session, and 500/transport failure offers retry preserving
the cookie. The authProvider implements real login/identity/logout operations.
Spanish strings used by this slice are defined in `src/i18n.ts`; future slices
must translate their additional resource labels.

## Run locally

Use the repository-pinned Node/npm versions, then from the repository root:

```sh
npm ci
npm run build:admin
npm run db:local:migrate
npm run dev:local
```

Open `http://localhost:8787/admin/`. Use `npm run admin:bootstrap` and the existing
verification procedure to prepare a local administrator. Local mail is a
metadata-only sink; use the isolated browser test for automated fixture setup.
For frontend live reload, run `npm run dev --workspace admin` alongside the
Worker; Vite proxies `/v1` and `/auth-actions` to the local Worker.

## Verification

`npm run test` builds assets before Workers tests. `npm run test:harness` rebuilds
them and includes a real Chromium acceptance test against a private temporary
Worker/D1 database. It never resets ordinary local D1 or uses remote resources.
A system Chromium is used if present (`CHROME_PATH` may select one); otherwise
the pinned Playwright CLI installs its headless Chromium. An environment must
allow local listeners/processes and have Chromium's system libraries.

`npm run test:admin:browser` runs the same browser acceptance directly after a
fresh `npm run build:admin`. It covers administrator login/reload/logout, wrong
password, unverified login, regular-User denial without session loss, an actual
storage failure/retry, expired/revoked sessions, exact HTTP identity shapes,
asset/API routing, keyboard focus and a narrow viewport. No API response mocks.

## Short operator smoke after sandbox deployment

1. Open `<sandbox-origin>/admin/login`; sign in with the existing verified admin.
2. Confirm the email, `admin` role and verified state; reload and confirm access.
3. Sign out; reload `/admin/` and confirm the login page.
4. Sign in with a verified regular User; confirm access denial and that `/v1/me`
   still returns 200 in that same browser session, then sign out.

Do not share passwords, cookies or action tokens in issues or screenshots.
