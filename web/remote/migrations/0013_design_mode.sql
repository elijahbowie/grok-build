CREATE TABLE design_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  preview_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'stale')),
  stale_revision TEXT,
  cancellation_reason TEXT,
  created_by_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE design_element_refs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  bounding_box_json TEXT NOT NULL,
  dom_provenance_json TEXT NOT NULL,
  code_provenance_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE design_selections (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE design_selection_members (
  selection_id TEXT NOT NULL REFERENCES design_selections(id) ON DELETE CASCADE,
  element_ref_id TEXT NOT NULL REFERENCES design_element_refs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY(selection_id, element_ref_id),
  UNIQUE(selection_id, position)
);

CREATE TABLE design_selection_relationships (
  id TEXT PRIMARY KEY,
  selection_id TEXT NOT NULL REFERENCES design_selections(id) ON DELETE CASCADE,
  from_element_ref_id TEXT NOT NULL REFERENCES design_element_refs(id) ON DELETE CASCADE,
  to_element_ref_id TEXT NOT NULL REFERENCES design_element_refs(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('parent-child', 'sibling', 'alignment', 'spacing', 'sequence')),
  CHECK (from_element_ref_id <> to_element_ref_id),
  UNIQUE(selection_id, from_element_ref_id, to_element_ref_id, relationship)
);

CREATE TABLE design_annotations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  element_ref_id TEXT REFERENCES design_element_refs(id) ON DELETE SET NULL,
  strokes_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE design_edit_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  selection_id TEXT REFERENCES design_selections(id) ON DELETE SET NULL,
  instruction_kind TEXT NOT NULL CHECK (instruction_kind IN ('text', 'voice-transcript')),
  instruction_text TEXT NOT NULL,
  instruction_metadata_json TEXT NOT NULL DEFAULT '{}',
  annotation_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'stale')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, sequence)
);

CREATE TABLE design_edit_targets (
  edit_request_id TEXT NOT NULL REFERENCES design_edit_requests(id) ON DELETE CASCADE,
  element_ref_id TEXT NOT NULL REFERENCES design_element_refs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY(edit_request_id, element_ref_id),
  UNIQUE(edit_request_id, position)
);

CREATE TABLE design_edit_evidence (
  id TEXT PRIMARY KEY,
  edit_request_id TEXT NOT NULL REFERENCES design_edit_requests(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preview', 'screenshot', 'diff', 'test', 'log', 'code')),
  label TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE design_audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES design_sessions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  owner_sub TEXT NOT NULL,
  edit_request_id TEXT REFERENCES design_edit_requests(id) ON DELETE SET NULL,
  actor_sub TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX design_sessions_owner_task ON design_sessions(owner_sub, task_id, created_at DESC);
CREATE INDEX design_elements_session ON design_element_refs(session_id, captured_at);
CREATE INDEX design_selections_session ON design_selections(session_id, created_at);
CREATE INDEX design_annotations_session ON design_annotations(session_id, created_at);
CREATE INDEX design_edits_session_status ON design_edit_requests(session_id, status, sequence);
CREATE INDEX design_evidence_edit ON design_edit_evidence(edit_request_id, created_at);
CREATE INDEX design_audit_session ON design_audit_events(session_id, created_at DESC);

CREATE TRIGGER design_session_revision_is_immutable
BEFORE UPDATE OF preview_revision ON design_sessions
BEGIN
  SELECT RAISE(ABORT, 'design session preview revision is immutable');
END;

CREATE TRIGGER design_element_refs_are_immutable
BEFORE UPDATE ON design_element_refs
BEGIN
  SELECT RAISE(ABORT, 'design element references are immutable');
END;

CREATE TRIGGER design_annotations_are_immutable
BEFORE UPDATE ON design_annotations
BEGIN
  SELECT RAISE(ABORT, 'design annotations are immutable');
END;
