import { id, now } from "./db";
import type { ControlEnv } from "./types";
import { installationToken } from "./github";
import { sandboxFor, shell } from "./sandbox-runtime";

type Finding = { id:string; file_path:string|null; start_line:number|null; title:string; body:string };
async function stableCandidateId(ownerSub:string, projectId:string, fingerprint:string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ownerSub}\n${projectId}\n${fingerprint}`));
  return `rrc_${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 40)}`;
}

export async function publishReviewToScm(env: ControlEnv, input: { reviewRunId:string; taskId:string; ownerSub:string }) {
  const db = env.CONTROL_DB;
  const context = await db.prepare(`SELECT r.head_sha, r.summary, t.project_id, t.task_repo, p.artifact_repo, p.default_branch
    FROM review_runs r JOIN tasks t ON t.id=r.task_id JOIN projects p ON p.id=t.project_id
    WHERE r.id=? AND r.task_id=? AND r.owner_sub=?`).bind(input.reviewRunId, input.taskId, input.ownerSub)
    .first<{head_sha:string;summary:string|null;project_id:string;task_repo:string|null;artifact_repo:string;default_branch:string}>();
  if (!context) throw new Error("Review publication context not found");
  const timestamp = now(); const publicationId = id("rpub");
  await db.prepare(`INSERT OR IGNORE INTO review_publications
    (id, review_run_id, task_id, owner_sub, provider, repository, ref, head_sha, status, summary, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, 'artifacts', ?, ?, ?, 'published', ?, ?, ?, ?)`)
    .bind(publicationId, input.reviewRunId, input.taskId, input.ownerSub, context.task_repo || context.artifact_repo, `review/${input.taskId}`, context.head_sha, context.summary, timestamp, timestamp, timestamp).run();
  const canonical = await db.prepare("SELECT id FROM review_publications WHERE review_run_id=? AND provider='artifacts'").bind(input.reviewRunId).first<{id:string}>();
  const findings = await db.prepare("SELECT id, file_path, start_line, title, body FROM review_findings WHERE review_run_id=? ORDER BY created_at").bind(input.reviewRunId).all<Finding>();
  for (const finding of findings.results) {
    await db.prepare(`INSERT OR IGNORE INTO review_threads
      (id, publication_id, finding_id, provider, repository, ref, head_sha, file_path, line, status, created_at, updated_at)
      VALUES (?, ?, ?, 'artifacts', ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .bind(id("rthr"), canonical!.id, finding.id, context.task_repo || context.artifact_repo, `review/${input.taskId}`, context.head_sha, finding.file_path, finding.start_line, timestamp, timestamp).run();
  }
  const mirrors = await db.prepare(`SELECT pst.repository, gc.installation_id FROM project_scm_targets pst
    JOIN sync_state ss ON ss.project_id=pst.project_id JOIN github_connections gc ON gc.id=ss.github_connection_id
    WHERE pst.project_id=? AND pst.provider='github' AND pst.role='mirror' AND pst.enabled=1`)
    .bind(context.project_id).all<{repository:string;installation_id:string}>();
  for (const mirror of mirrors.results) {
    const mirrorPublicationId = id("rpub");
    await db.prepare(`INSERT OR IGNORE INTO review_publications
      (id, review_run_id, task_id, owner_sub, provider, repository, ref, head_sha, status, summary, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'github', ?, ?, ?, 'publishing', ?, NULL, ?, ?)`)
      .bind(mirrorPublicationId, input.reviewRunId, input.taskId, input.ownerSub, mirror.repository, `grok-build/${input.taskId}`, context.head_sha, context.summary, timestamp, timestamp).run();
    const publication = await db.prepare("SELECT id FROM review_publications WHERE review_run_id=? AND provider='github' AND repository=?").bind(input.reviewRunId, mirror.repository).first<{id:string}>();
    try {
      if (!context.task_repo) throw new Error("Task fork is unavailable for GitHub review publication");
      const source = await env.ARTIFACTS.get(context.task_repo); const sourceToken = await source.createToken("read", 3600); const githubToken = await installationToken(env, input.ownerSub, mirror.installation_id);
      const branch = `grok-build/${input.taskId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`; const sandbox = sandboxFor(env, `review-publish-${input.taskId}`); const cwd = "/workspace/review-publication";
      try {
        const clone = await sandbox.exec(`rm -rf ${shell(cwd)} && git -c http.extraHeader=${shell(`Authorization: Bearer ${sourceToken.plaintext}`)} clone ${shell(source.remote)} ${shell(cwd)} && git -C ${shell(cwd)} checkout --detach ${shell(context.head_sha)}`, { timeout:180_000 });
        if (!clone.success) throw new Error(`Review mirror clone failed: ${clone.stderr.slice(-1000)}`);
        const pushed = await sandbox.exec(`git -c http.extraHeader=${shell(`Authorization: Bearer ${githubToken}`)} push https://github.com/${mirror.repository}.git HEAD:refs/heads/${shell(branch)}`, { cwd, timeout:180_000 });
        if (!pushed.success) throw new Error(`GitHub review branch push failed: ${pushed.stderr.slice(-1000)}`);
      } finally { await source.revokeToken(sourceToken.id).catch(() => false); }
      const headers = { accept:"application/vnd.github+json", authorization:`Bearer ${githubToken}`, "user-agent":"Grok-Build", "x-github-api-version":"2026-03-10", "content-type":"application/json" };
      const pulls = await fetch(`https://api.github.com/repos/${mirror.repository}/pulls?state=open&head=${encodeURIComponent(`${mirror.repository.split("/")[0]}:${branch}`)}`, { headers });
      const existing = pulls.ok ? await pulls.json<Array<{number:number;id:number;html_url:string}>>() : [];
      let pull = existing[0];
      if (!pull) {
        const created = await fetch(`https://api.github.com/repos/${mirror.repository}/pulls`, { method:"POST", headers, body:JSON.stringify({ title:`Grok Build: ${input.taskId}`, head:branch, base:context.default_branch, body:`${context.summary || "Independent Grok Build review is ready."}\n\nCanonical source: Cloudflare Artifacts repository \`${context.artifact_repo}\`. Promotion remains gated in Grok Build.` }) });
        if (!created.ok) throw new Error(`GitHub pull request creation failed (${created.status})`);
        pull = await created.json<{number:number;id:number;html_url:string}>();
      }
      for (const finding of findings.results) {
        const body = `<!-- grok-finding:${finding.id} -->\n**${finding.title}**\n\n${finding.body}${finding.file_path ? `\n\nLocation: \`${finding.file_path}${finding.start_line ? `:${finding.start_line}` : ""}\`` : ""}`;
        const comment = await fetch(`https://api.github.com/repos/${mirror.repository}/issues/${pull.number}/comments`, { method:"POST", headers, body:JSON.stringify({ body }) });
        const data = comment.ok ? await comment.json<{id:number;html_url:string}>() : null;
        await db.prepare(`INSERT OR IGNORE INTO review_threads
          (id,publication_id,finding_id,provider,repository,ref,head_sha,file_path,line,external_id,external_url,status,created_at,updated_at)
          VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
          .bind(id("rthr"), publication!.id, finding.id, mirror.repository, branch, context.head_sha, finding.file_path, finding.start_line, data ? String(data.id) : null, data?.html_url || null, timestamp, now()).run();
      }
      await db.prepare("UPDATE review_publications SET status='published',external_number=?,external_id=?,external_url=?,error=NULL,published_at=?,updated_at=? WHERE id=?")
        .bind(String(pull.number), String(pull.id), pull.html_url, now(), now(), publication!.id).run();
    } catch (error) {
      await db.prepare("UPDATE review_publications SET status='failed',error=?,updated_at=? WHERE id=?").bind(error instanceof Error ? error.message.slice(0, 4000) : "GitHub review publication failed", now(), publication!.id).run();
    }
  }
}

export async function listReviewPublications(db: D1Database, ownerSub: string, reviewRunId: string) {
  const publications = await db.prepare("SELECT * FROM review_publications WHERE review_run_id=? AND owner_sub=? ORDER BY provider, created_at").bind(reviewRunId, ownerSub).all();
  const threads = await db.prepare(`SELECT rt.* FROM review_threads rt JOIN review_publications rp ON rp.id=rt.publication_id
    WHERE rp.review_run_id=? AND rp.owner_sub=? ORDER BY rt.created_at`).bind(reviewRunId, ownerSub).all();
  const feedback = await db.prepare("SELECT * FROM review_feedback WHERE review_run_id=? AND owner_sub=? ORDER BY created_at").bind(reviewRunId, ownerSub).all();
  return { publications:publications.results, threads:threads.results, feedback:feedback.results };
}

export async function recordReviewFeedback(db: D1Database, input: { ownerSub:string; reviewRunId:string; findingId:string; provider:"artifacts"|"github"; kind:"reaction"|"reply"|"resolved"|"reopened"|"fixed"|"dismissed"; sentiment?:"positive"|"negative"|"neutral"; actorRef:string; body?:string; externalId?:string; metadata?:Record<string, unknown> }) {
  const owns = await db.prepare("SELECT 1 ok FROM review_runs WHERE id=? AND owner_sub=?").bind(input.reviewRunId, input.ownerSub).first();
  if (!owns) throw new Error("Review not found");
  const feedbackId = id("rfb"); const timestamp = now();
  await db.prepare(`INSERT INTO review_feedback
    (id, finding_id, review_run_id, owner_sub, provider, kind, sentiment, actor_ref, external_id, body, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(feedbackId, input.findingId, input.reviewRunId, input.ownerSub, input.provider, input.kind, input.sentiment || null, input.actorRef.slice(0, 200), input.externalId || feedbackId, input.body?.slice(0, 8_000) || null, JSON.stringify(input.metadata || {}), timestamp).run();
  if (["resolved", "fixed", "dismissed"].includes(input.kind)) await db.prepare("UPDATE review_threads SET status=? , updated_at=? WHERE finding_id=?")
    .bind(input.kind === "dismissed" ? "dismissed" : "resolved", timestamp, input.findingId).run();
  const signal = input.sentiment === "positive" || input.kind === "fixed" || input.kind === "resolved" ? "positive" : input.sentiment === "negative" || input.kind === "dismissed" ? "negative" : null;
  if (signal) {
    const finding = await db.prepare(`SELECT f.fingerprint, f.title, f.body, t.project_id FROM review_findings f
      JOIN review_runs r ON r.id=f.review_run_id JOIN tasks t ON t.id=r.task_id WHERE f.id=?`).bind(input.findingId)
      .first<{fingerprint:string;title:string;body:string;project_id:string}>();
    if (finding) {
      const candidateId = await stableCandidateId(input.ownerSub, finding.project_id, finding.fingerprint);
      await db.prepare(`INSERT INTO review_rule_candidates
        (id, owner_sub, project_id, title, content, rationale, source_fingerprints_json, positive_signals, negative_signals, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
        ON CONFLICT(id) DO UPDATE SET positive_signals=positive_signals+excluded.positive_signals,
        negative_signals=negative_signals+excluded.negative_signals, updated_at=excluded.updated_at`)
        .bind(candidateId, input.ownerSub, finding.project_id, `Learned review rule: ${finding.title}`.slice(0, 160), finding.body.slice(0, 16_000), "Proposed from explicit reviewer feedback; approval is required before this affects tasks.", JSON.stringify([finding.fingerprint]), signal === "positive" ? 1 : 0, signal === "negative" ? 1 : 0, timestamp, timestamp).run();
    }
  }
  return { id:feedbackId, createdAt:timestamp };
}
