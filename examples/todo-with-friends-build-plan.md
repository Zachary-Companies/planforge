# Todo with Friends build plan
<!-- slug: todo-with-friends -->

> **Status refresh (2026-07-02):** plan created from the interview; the
> walking-skeleton scaffold has shipped and the app boots locally with
> `npm run dev`. Everything else is pending; realtime updates are gated on D2.

## 1. Overview

**Thesis** — A small shared-todo web app for friend groups. One person makes a
list ("Groceries", "Cabin trip"), invites friends by link, and everyone adds
and checks off items from their own phone or laptop. It deliberately stays
small: no projects, no due-date engines, no comments — a list you actually
share beats a project manager nobody opens.

**Users** — The list owner and the friends they invite (roughly 2–15 people
per group). Everyone uses it through a browser, mostly on phones.

**Done when** —
- Two people on different devices see the same list and each other's check-offs.
- A friend can join a list from an invite link in under a minute, including sign-up.
- Todos survive server restarts and browser refreshes.
- The whole app deploys as one container with one mounted data volume.
- `npm install && npm run dev` gives a working local setup on a fresh clone.

## 2. Architecture

Repo layout:

| Dir | Owns |
|---|---|
| `web/` | React + Vite single-page app (screens, components, API client) |
| `server/` | Node + Express API: auth, lists, todos, invites, SQLite persistence |
| `docs/` | deploy and operations notes |

**Stack** (from `stack-preferences.json`): TypeScript everywhere
(`general.languages`), React + Vite (`webApp.framework` / `webApp.meta`),
plain CSS (`webApp.styling`), Node + Express (`webApp.backend`), raw SQL
(`webApp.orm`), email + password auth (`webApp.auth`), vitest
(`general.testing`), npm, MIT, GitHub Actions CI — all per preferences.
**Deviation:** preferences name PostgreSQL (`webApp.db`); this plan uses
SQLite — recorded as **D1** (Accepted).

Contracts:
- REST JSON under `/api/*`; auth is an httpOnly session cookie; the Vite dev
  server (port 5173) proxies `/api` to the Express server (port 3001).
- SQLite database file at `server/data/todo.db`; forward-only numbered
  migrations in `server/src/migrations/` applied at server start.
- Invite links carry a signed, expiring token: `/join?token=…`.

## 3. Open decisions

- **D1 — Use SQLite instead of the preferred PostgreSQL?** — Accepted: yes,
  for v1 (2026-07-02). A friend group is tens of users, not thousands; one
  SQLite file means zero-ops deploys, trivial backups, and no managed-DB
  bill. Revisit only if hosting ever moves to multiple app instances.
- **D2 — How do list changes reach other members' screens?** — Proposed:
  (a) poll `GET /api/changes?since=<cursor>` every 5 seconds — boring, works
  everywhere, plenty for a friend group; (b) WebSockets — instant, but adds
  connection state, reconnect logic, and deploy complexity. Recommendation:
  (a) polling for v1; the cursor API keeps (b) possible later without
  changing the client's mental model. Gates `realtime-updates`.

## 4. Phases

### Phase 1 — Walking skeleton (boots locally, single-user todos)

- **scaffold-repo — Repo scaffold with one-command dev setup**
  - paths: `package.json`, `web/package.json`, `web/vite.config.ts`, `web/index.html`, `server/package.json`, `.gitignore`, `README.md`, `.github/workflows/ci.yml`
  - status: shipped
  - acceptance: `npm install && npm run dev` starts web (5173) and server (3001) together; the root page renders an app shell; CI runs typecheck + tests on every PR.

- **server-todos-api — SQLite todos store + CRUD routes**
  - paths: `server/src/index.ts`, `server/src/db.ts`, `server/src/migrations/001-todos.sql`, `server/src/routes/todos.ts`, `server/test/todos.test.ts`
  - deps: scaffold-repo
  - status: pending
  - acceptance: `POST/GET/PATCH/DELETE /api/todos` round-trips; todos survive a server restart; `npm test --workspace server` passes.

- **web-todo-list — Todo UI wired to the API**
  - paths: `web/src/App.tsx`, `web/src/api.ts`, `web/src/components/TodoList.tsx`, `web/src/components/TodoItem.tsx`, `web/src/styles.css`
  - deps: server-todos-api
  - status: pending
  - acceptance: adding, completing, and deleting a todo in the browser persists across a page reload.

### Phase 2 — Accounts and shared lists (runnable multi-user app)

- **server-auth — Email + password accounts with cookie sessions**
  - paths: `server/src/routes/auth.ts`, `server/src/sessions.ts`, `server/src/migrations/002-users.sql`, `server/test/auth.test.ts`
  - deps: server-todos-api
  - status: pending
  - acceptance: sign-up / sign-in / sign-out routes work end-to-end; passwords stored hashed (scrypt); todo routes return 401 without a session; tests pass.

- **web-auth-screens — Sign-up and sign-in screens**
  - paths: `web/src/screens/SignIn.tsx`, `web/src/screens/SignUp.tsx`, `web/src/auth.ts`
  - deps: server-auth, web-todo-list
  - status: pending
  - acceptance: a new visitor can create an account, sign in, and see their own (empty) list; a signed-out visitor is routed to sign-in.

- **server-lists-invites — Shared lists, membership, magic invite links**
  - paths: `server/src/routes/lists.ts`, `server/src/invites.ts`, `server/src/migrations/003-lists.sql`, `server/test/lists.test.ts`
  - deps: server-auth
  - status: pending
  - acceptance: a list owner can mint an invite URL carrying a signed, expiring token; opening it while signed in joins the list; members read and write the same todos; non-members get 403.

- **web-share-flow — Create, share, and join lists in the UI**
  - paths: `web/src/screens/Lists.tsx`, `web/src/screens/Join.tsx`, `web/src/components/ShareDialog.tsx`
  - deps: server-lists-invites, web-auth-screens
  - status: pending
  - acceptance: user A creates a list and copies an invite link; user B opens it in another browser, joins, and both see the same todos after a refresh.

### Phase 3 — Live feel, polish, and deploy

- **realtime-updates — Members see each other's changes without refreshing**
  - paths: `server/src/routes/changes.ts`, `web/src/hooks/useLiveList.ts`
  - deps: web-share-flow
  - status: blocked-on-D2
  - acceptance: with two browsers on the same list, a change made in one appears in the other within 10 seconds, with no manual refresh.

- **ui-polish-states — Empty, loading, and error states everywhere**
  - paths: `web/src/components/EmptyState.tsx`, `web/src/components/ErrorBanner.tsx`, `web/src/components/Spinner.tsx`
  - deps: web-share-flow
  - status: pending
  - acceptance: fresh accounts see a friendly empty state; a stopped server produces a visible error banner rather than a blank page; slow responses show a spinner.

- **deploy-single-node — One-container deploy story**
  - paths: `Dockerfile`, `server/src/static.ts`, `docs/deploy.md`
  - deps: web-share-flow
  - status: pending
  - acceptance: `docker build . && docker run` serves the built web app and the API on one port with `server/data/` on a mounted volume; `docs/deploy.md` walks through a Fly.io deploy per `webApp.hosting`.

## 5. Status ledger

- verified against 4b8e2d1 2026-07-02 — plan created; scaffold-repo shipped (`npm run dev` boots web + server, CI green on PR #1); all other slices pending; realtime-updates blocked on D2.
