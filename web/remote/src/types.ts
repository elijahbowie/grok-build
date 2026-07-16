export type Identity = {
  sub: string;
  email: string;
  name?: string;
};

export type Project = {
  id: string;
  owner_sub: string;
  name: string;
  slug: string;
  artifact_repo: string;
  default_branch: string;
  source_type: "empty" | "github" | "artifacts" | "local";
  source_url: string | null;
  config_json: string;
  github_json: string;
  created_at: string;
  updated_at: string;
};

export type TaskStatus = "queued" | "preparing" | "running" | "repairing" | "review" | "completed" | "failed" | "cancelled";

export type Task = {
  id: string;
  owner_sub: string;
  project_id: string;
  workflow_id: string;
  task_repo: string | null;
  title: string;
  prompt: string;
  status: TaskStatus;
  model: string;
  permission_mode: "isolated-write" | "review-only";
  session_id: string | null;
  base_sha: string | null;
  head_sha: string | null;
  repair_attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  additions: number;
  deletions: number;
  changed_files_json: string;
  patch_key: string | null;
  verification_key: string | null;
  backup_id: string | null;
};

export type TaskWorkflowInput = {
  taskId: string;
  ownerSub: string;
  planRevisionId?: string;
  subagentId?: string;
  parentTaskId?: string;
  automationRunId?: string;
};

export type ControlEnv = Env & {
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_EMAIL?: string;
  ACCESS_ALLOWED_EMAILS?: string;
  ACCESS_ALLOWED_DOMAINS?: string;
  MACHINE_ORIGIN: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BACKUP_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  BACKUP_BUCKET_NAME?: string;
  CONNECTOR_ENCRYPTION_KEY: string;
  STANDARD_3_COST_PER_HOUR_MICROS?: string;
  REVIEW_WORKFLOW: Workflow<import("./review-workflow").ReviewWorkflowInput>;
  PLAN_WORKFLOW: Workflow<import("./planning-workflow").PlanningWorkflowInput>;
  DESIGN_WORKFLOW: Workflow<import("./design-workflow").DesignWorkflowInput>;
};
