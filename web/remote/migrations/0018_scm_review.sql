PRAGMA foreign_keys = ON;

-- Every project is anchored in Cloudflare Artifacts. Other SCMs are mirrors.
CREATE TABLE project_scm_targets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  role TEXT NOT NULL CHECK (role IN ('canonical', 'mirror')),
  repository TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  connection_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, provider, repository),
  CHECK (provider != 'github' OR role = 'mirror'),
  CHECK (provider != 'artifacts' OR role = 'canonical')
);

CREATE UNIQUE INDEX project_one_canonical_scm
  ON project_scm_targets(project_id, role) WHERE role = 'canonical';

INSERT INTO project_scm_targets
  (id, project_id, owner_sub, provider, role, repository, default_branch, created_at, updated_at)
SELECT 'scm_art_' || id, id, owner_sub, 'artifacts', 'canonical', artifact_repo, default_branch, created_at, updated_at
FROM projects;

INSERT INTO project_scm_targets
  (id, project_id, owner_sub, provider, role, repository, default_branch, connection_ref, created_at, updated_at)
SELECT 'scm_gh_' || s.project_id, s.project_id, p.owner_sub, 'github', 'mirror', s.repository_full_name,
       p.default_branch, s.github_connection_id, s.updated_at, s.updated_at
FROM sync_state s JOIN projects p ON p.id = s.project_id
WHERE s.repository_full_name IS NOT NULL;

CREATE TABLE scm_events (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  event_type TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  ref TEXT,
  before_sha TEXT,
  after_sha TEXT,
  actor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(actor_json)),
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT,
  UNIQUE(provider, delivery_id, event_type)
);

CREATE INDEX scm_events_project_received ON scm_events(project_id, received_at DESC);
CREATE INDEX scm_events_unprocessed ON scm_events(processed_at, received_at) WHERE processed_at IS NULL;

ALTER TABLE review_runs ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'artifacts'
  CHECK (source_provider IN ('artifacts', 'github', 'internal'));
ALTER TABLE review_runs ADD COLUMN source_event_id TEXT REFERENCES scm_events(id) ON DELETE SET NULL;

CREATE TABLE review_publications (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  repository TEXT NOT NULL,
  ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  external_number TEXT,
  external_id TEXT,
  external_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'publishing', 'published', 'failed', 'skipped')),
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(review_run_id, provider, repository, ref)
);

CREATE TABLE review_threads (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES review_publications(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  repository TEXT NOT NULL,
  ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  file_path TEXT,
  line INTEGER,
  external_id TEXT,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed', 'outdated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(publication_id, finding_id)
);

CREATE TABLE review_feedback (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES review_findings(id) ON DELETE CASCADE,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('artifacts', 'github')),
  kind TEXT NOT NULL CHECK (kind IN ('reaction', 'reply', 'resolved', 'reopened', 'fixed', 'dismissed')),
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  actor_ref TEXT NOT NULL,
  external_id TEXT,
  body TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE(provider, external_id, kind)
);

CREATE INDEX review_publications_run ON review_publications(review_run_id, provider);
CREATE INDEX review_threads_finding ON review_threads(finding_id, provider);
CREATE INDEX review_feedback_finding ON review_feedback(finding_id, created_at DESC);
