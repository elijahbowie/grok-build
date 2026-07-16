CREATE TABLE plan_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'rejected', 'changes_requested', 'cancelled')),
  goal TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  acceptance_checks_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_by_sub TEXT NOT NULL,
  submitted_at TEXT,
  decided_by_sub TEXT,
  decision_reason TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, revision),
  UNIQUE(task_id, content_digest)
);

CREATE TABLE task_plan_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  current_revision_id TEXT REFERENCES plan_revisions(id),
  approved_revision_id TEXT REFERENCES plan_revisions(id),
  execution_phase TEXT NOT NULL DEFAULT 'planning' CHECK (execution_phase IN ('planning', 'awaiting_approval', 'approved', 'building', 'cancelled', 'recovery_required', 'completed')),
  cancellation_reason TEXT,
  cancelled_by_sub TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE plan_step_states (
  plan_revision_id TEXT NOT NULL REFERENCES plan_revisions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  step_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'skipped')),
  status_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(plan_revision_id, step_id),
  UNIQUE(plan_revision_id, position)
);

CREATE TABLE plan_message_queue (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'cancelled')),
  queued_at TEXT NOT NULL,
  delivered_at TEXT,
  cancelled_at TEXT,
  UNIQUE(task_id, sequence)
);

CREATE TABLE plan_audit_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  plan_revision_id TEXT REFERENCES plan_revisions(id),
  actor_sub TEXT NOT NULL,
  action TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX plan_revisions_task_revision ON plan_revisions(task_id, revision DESC);
CREATE INDEX plan_revisions_owner_task ON plan_revisions(owner_sub, task_id, created_at DESC);
CREATE INDEX plan_step_states_task_status ON plan_step_states(task_id, status, position);
CREATE INDEX plan_message_queue_task_status ON plan_message_queue(task_id, status, sequence);
CREATE INDEX plan_audit_events_task_created ON plan_audit_events(task_id, created_at DESC);

CREATE TRIGGER approved_plan_revisions_are_immutable
BEFORE UPDATE ON plan_revisions
WHEN OLD.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved plan revisions are immutable');
END;

CREATE TRIGGER approved_plan_revisions_cannot_be_deleted
BEFORE DELETE ON plan_revisions
WHEN OLD.status = 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approved plan revisions are immutable');
END;
