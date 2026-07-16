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

The browser-facing origin is `https://grok.forgeagent.app`. Cloudflare Access must allow only `director@eicimpact.org`, and its application audience and team domain must be set as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. Machine callbacks use `https://grok-build-runner.director-78b.workers.dev` instead: GitHub webhooks are HMAC-verified, companion calls are device-signed, and MCP/CI proxy calls use short-lived task-scoped tokens.

Sandbox backups require an R2 Object Read & Write credential scoped to `grok-build-backups-director-78b`:

```sh
cd web
npx wrangler secret put R2_ACCESS_KEY_ID --config remote/wrangler.jsonc
npx wrangler secret put R2_SECRET_ACCESS_KEY --config remote/wrangler.jsonc
npx wrangler secret put ACCESS_AUD --config remote/wrangler.jsonc
npx wrangler secret put ACCESS_TEAM_DOMAIN --config remote/wrangler.jsonc
npx wrangler d1 migrations apply grok-build-control --remote --config remote/wrangler.jsonc
npm run remote:deploy
```

After deployment, open **Settings** to register the GitHub App, link an installation/repository, pair the signed local companion, and configure project-scoped HTTP/SSE MCP servers. Upstream MCP credentials are encrypted outside task sandboxes. Failed GitHub Actions runs create bounded repair tasks only when the failing commit was previously synced by Grok Build; human commits are ignored.

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
