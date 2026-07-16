# Grok Build Web

A local browser workspace for Grok Build, designed around an inspectable agent loop: intent, activity, review, verification, and recovery.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:4173>. The service uses the repository containing this folder and the authenticated `grok`, `git`, and `gh` command-line tools.

## Cloud workspace

The production workspace uses Cloudflare Access, Workers, Workflows, D1, R2, Artifacts, and Sandbox. Each task forks its project's canonical Artifacts repository, runs the pinned Grok CLI in a Standard-3 container, verifies and repairs its result, retains logs and browser evidence, and waits for explicit review before a fast-forward promotion. Force-push is never used.

Containers use `sleepAfter: "30s"`. A shared KasmVNC desktop and headed Playwright browser are started only for an active agent or an opened review desktop. The UI sends a heartbeat while the desktop is visible; TaskHub stops the desktop after 60 seconds without one. A sleeping or stopped container does not keep active compute allocated.

The usage ledger uses a conservative Standard-3 upper bound of `220032` microdollars per active wall-clock hour. That assumes all 2 vCPUs are active plus the provisioned 8 GiB memory and 16 GB disk at Cloudflare's April 2026 list rates; Cloudflare bills actual active CPU and applies monthly included usage, so the dashboard labels this an upper bound rather than an invoice. Update `STANDARD_3_COST_PER_HOUR_MICROS` when list pricing changes.

The browser-facing origin is `https://grok.forgeagent.app`. Cloudflare Access can use `ACCESS_EMAIL`, `ACCESS_EMAILS`, or `ACCESS_EMAIL_DOMAINS` as its membership allowlist; its application audience and team domain must be set as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Machine callbacks use `https://grok-build-runner.director-78b.workers.dev` instead: GitHub webhooks are HMAC-verified, companion calls are device-signed, and MCP/CI proxy calls use short-lived task-scoped tokens.

Sandbox backups require an R2 Object Read & Write credential scoped to `grok-build-backups-director-78b`:

```sh
cd web
npx wrangler secret put R2_ACCESS_KEY_ID --config remote/wrangler.jsonc
npx wrangler secret put R2_SECRET_ACCESS_KEY --config remote/wrangler.jsonc
npx wrangler secret put ACCESS_AUD --config remote/wrangler.jsonc
npx wrangler secret put ACCESS_TEAM_DOMAIN --config remote/wrangler.jsonc
npx wrangler queues create grok-build-artifacts-events --config remote/wrangler.jsonc
npx wrangler d1 migrations apply grok-build-control --remote --config remote/wrangler.jsonc
npm run remote:deploy
```

In **Cloudflare Dashboard → Artifacts → Settings → Event subscriptions**, create a subscription for the `grok-build` namespace, select repository lifecycle and repository Git-operation events, and deliver them to the `grok-build-artifacts-events` Queue. Queue deliveries are normalized into the same event contract as GitHub webhooks and are deduplicated before an automation is admitted. Artifacts subscriptions are intentionally configured outside the Worker deployment because the subscription owns the Queue producer relationship.

After deployment, open **Settings** to register the GitHub App, link an installation/repository, pair the signed local companion, and configure project-scoped HTTP/SSE MCP servers. Upstream MCP credentials are encrypted outside task sandboxes. Failed GitHub Actions runs create bounded repair tasks only when the failing commit was previously synced by Grok Build; human commits are ignored.

## Cursor-parity program

Cloudflare Artifacts is the canonical SCM for every project. GitHub is an optional mirror: tasks always fork, review, repair, and promote in Artifacts first. When GitHub is linked, an independent review also pushes a task review branch, opens or updates a pull request, and mirrors finding threads; canonical promotion still requires the exact reviewed Artifacts head and explicit approval.

The cloud control plane now includes:

- Artifacts and GitHub event triggers with one normalized, idempotent automation path.
- Artifacts-native review publications, selected-finding autofix runs, reviewer feedback, and approval-gated learned rule candidates.
- Standard-3 container sessions, model token meters, cost estimates, project budgets, and `block_new` enforcement without hiding active work.
- Organizations, role-based membership, shared project visibility, review assignments, and an organization audit log.
- Scoped `gbk_…` Agent API keys for `POST/GET /v1/agents`, follow-ups, cancellation, event retrieval, and signed `/v1/webhooks` delivery.
- Full-transcript/path search, expiring view/comment/review links, persistent reviewer comments, and resumable cloud follow-ups.
- A digest-pinned team marketplace for MCP servers, plugins, skills, rules, commands, hooks, and subagents. Submissions require explicit trust approval before installation.
- Automation destinations for in-app/Artifacts results and connector-backed webhook, Slack, Linear-compatible webhook, and email delivery. Destination failures are retained without changing the task result.

Agent webhook signatures cover `<timestamp>.<raw-body>` with HMAC-SHA256 and are sent as `x-grok-signature: sha256=<base64url>`. Plaintext webhook secrets and API keys are shown only once. Connector credentials stay encrypted in R2.

The runner does not use an xAI API key. It stores the refreshable Grok subscription session in private R2 storage and copies it only into authenticated task sandboxes.

## What is real

- Every task gets a dedicated Git branch and worktree.
- Grok runs headlessly with streaming JSON; sessions can be resumed with follow-ups.
- Run state, transcripts, terminal evidence, previews, and automations persist in `.grok-web/state.json`.
- Diff, changed-file, and file-content views read the task worktree directly.
- Hourly and daily automations start isolated tasks but never publish them automatically.
- Publishing stages and commits the reviewed work, pushes only the task branch, then opens a GitHub pull request after explicit confirmation.

Grok is sandboxed to the task workspace and receives explicit denials for `git push` and `gh`. Read-only tasks use plan mode and deny edit, write, and shell tools. The review terminal runs only when the user explicitly submits a command. Secrets matching common token formats are redacted from retained output.

## Verification

```sh
npm run build
npm test
npx tsc -p remote/tsconfig.json
npm outdated
```

The test suite launches the real local service against a temporary Git repository and a deterministic Grok fixture. It verifies worktree creation, atomic review readiness, streaming completion, persistent session IDs, real diffs and file reads, terminal evidence, path traversal rejection, read-only process arguments, and the cloud browser-evidence review surface. Wrangler dry-run additionally validates the Worker bindings and container image.
