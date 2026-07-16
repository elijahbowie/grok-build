import { describe, expect, it } from "vitest";
import {
  ApprovalValidationError,
  type ApprovalDeliveryRow,
  deliverApprovalOutbox,
  validateApprovalForAction,
  validateApprovalRequest,
  validateApprovalRollback,
  validateApprovalTarget,
  validatePromotionDeliveryPayload,
} from "./approvals";

const head = "a".repeat(40);
const now = new Date("2026-07-16T12:00:00.000Z");

function request(overrides: Record<string, unknown> = {}) {
  return {
    projectId:"project_1", taskId:"task_1", action:"promotion",
    target:{ kind:"repository-ref", identifier:"owner/repo@main", label:"owner/repo main" },
    consequence:"Push the verified task head to the main branch.",
    rollback:{ strategy:"manual", instructions:"Revert the published commit from main." },
    expectedHeadSha:head, requestReason:"The task passed review and is ready to publish.",
    expiresAt:"2026-07-16T13:00:00.000Z", ...overrides,
  };
}

describe("high-impact approval requests", () => {
  it("produces an explicit, time-bound request bound to an exact task head", () => {
    expect(validateApprovalRequest(request(), now)).toEqual(request());
  });

  it("rejects vague, stale, overlong, or extensible approvals", () => {
    expect(() => validateApprovalRequest(request({ consequence:"" }), now)).toThrow(ApprovalValidationError);
    expect(() => validateApprovalRequest(request({ expectedHeadSha:"main" }), now)).toThrow(/full Git SHA/);
    expect(() => validateApprovalRequest(request({ expiresAt:"2026-07-24T12:00:00.000Z" }), now)).toThrow(/seven days/);
    expect(() => validateApprovalRequest({ ...request(), wildcard:true }, now)).toThrow(/unsupported fields/);
  });

  it("requires the target shape appropriate to every consequential action", () => {
    expect(validateApprovalTarget("publish", { kind:"repository-ref", identifier:"acme/app@release", label:"release" }).target.kind).toBe("repository-ref");
    expect(validateApprovalTarget("external-write", { kind:"external-resource", identifier:"ticket:123", label:"Ticket 123" }).target.kind).toBe("external-resource");
    expect(validateApprovalTarget("connector-write", { kind:"connector", identifier:"github:comment", label:"GitHub comment" }).target.kind).toBe("connector");
    expect(validateApprovalTarget("automation-enable", { kind:"automation", identifier:"automation_1", label:"Nightly checks" }).target.kind).toBe("automation");
    expect(() => validateApprovalTarget("connector-write", { kind:"external-resource", identifier:"github", label:"GitHub" })).toThrow(/connector target/);
  });

  it("requires rollback instructions, including an explanation for irreversible actions", () => {
    expect(validateApprovalRollback({ strategy:"automatic", instructions:"Restore the prior ref automatically." }).strategy).toBe("automatic");
    expect(() => validateApprovalRollback({ strategy:"none", instructions:"No" })).toThrow(/explain/);
  });
});

describe("approval consumption gate", () => {
  const approval = { action:"promotion" as const, task_id:"task_1", expected_head_sha:head, status:"approved" as const, expires_at:"2026-07-16T13:00:00.000Z" };

  it("allows only the exact approved action, task, head, and validity window", () => {
    expect(validateApprovalForAction({ approval, action:"promotion", taskId:"task_1", expectedHeadSha:head }, now)).toEqual({ allowed:true, reasons:[] });
    expect(validateApprovalForAction({ approval, action:"publish", taskId:"task_1", expectedHeadSha:head }, now).reasons).toContain("Approval is for a different consequential action");
    expect(validateApprovalForAction({ approval, action:"promotion", taskId:"task_2", expectedHeadSha:head }, now).reasons).toContain("Approval is bound to a different task");
    expect(validateApprovalForAction({ approval, action:"promotion", taskId:"task_1", expectedHeadSha:"b".repeat(40) }, now).reasons).toContain("Approval is stale for the requested task head");
  });

  it("rejects expired and already consumed capabilities", () => {
    expect(validateApprovalForAction({ approval, action:"promotion", taskId:"task_1", expectedHeadSha:head }, new Date("2026-07-16T13:00:00.000Z")).reasons).toContain("Approval has expired");
    expect(validateApprovalForAction({ approval:{ ...approval, status:"consumed" }, action:"promotion", taskId:"task_1", expectedHeadSha:head }, now).reasons).toContain("Approval is consumed");
  });
});

describe("durable promotion delivery", () => {
  it("binds an outbox message to the exact approval delivery, review, and head", () => {
    const payload = validatePromotionDeliveryPayload({ approvedBy:"owner@example.com", approvedAt:"2026-07-16T12:00:00Z", expectedHeadSha:head, reviewRunId:"review_1", approvalDeliveryId:"apd_1" });
    expect(payload).toEqual({ approvedBy:"owner@example.com", approvedAt:"2026-07-16T12:00:00.000Z", expectedHeadSha:head, reviewRunId:"review_1", approvalDeliveryId:"apd_1" });
  });

  it("rejects mutable refs and extra event fields", () => {
    const payload = { approvedBy:"owner@example.com", approvedAt:"2026-07-16T12:00:00Z", expectedHeadSha:head, reviewRunId:"review_1", approvalDeliveryId:"apd_1" };
    expect(() => validatePromotionDeliveryPayload({ ...payload, expectedHeadSha:"main" })).toThrow(/full Git SHA/);
    expect(() => validatePromotionDeliveryPayload({ ...payload, command:"publish anyway" })).toThrow(/unsupported fields/);
  });

  it("retains a failed delivery for retry and does not redeliver after acknowledgement", async () => {
    const row: ApprovalDeliveryRow = {
      id:"apd_1", approval_id:"approval_1", owner_sub:"owner_1", task_id:"task_1", expected_head_sha:head,
      workflow_id:"task-task_1", event_type:"promote",
      payload_json:JSON.stringify({ approvedBy:"owner@example.com", approvedAt:"2026-07-16T12:00:00Z", expectedHeadSha:head, reviewRunId:"review_1", approvalDeliveryId:"apd_1" }),
      status:"pending", attempt_count:0, lease_token:null, lease_expires_at:null, last_error:null,
      created_at:"2026-07-16T12:00:00.000Z", updated_at:"2026-07-16T12:00:00.000Z", delivered_at:null,
    };
    const db = deliveryDatabase(row);
    await expect(deliverApprovalOutbox(db, "owner_1", "apd_1", async () => { throw new Error("temporary workflow outage"); }, now)).rejects.toThrow(/safely queued for retry/);
    expect(row.status).toBe("failed");
    expect(row.attempt_count).toBe(1);
    let sends = 0;
    const retried = await deliverApprovalOutbox(db, "owner_1", "apd_1", async () => { sends += 1; }, new Date("2026-07-16T12:01:00.000Z"));
    expect(retried.deliveredNow).toBe(true);
    expect(row.status).toBe("delivered");
    expect(row.attempt_count).toBe(2);
    await deliverApprovalOutbox(db, "owner_1", "apd_1", async () => { sends += 1; }, new Date("2026-07-16T12:02:00.000Z"));
    expect(sends).toBe(1);
  });
});

function deliveryDatabase(row: ApprovalDeliveryRow) {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first() { return row.id === values[0] && row.owner_sub === values[1] ? { ...row } : null; },
        async run() {
          if (sql.includes("SET status = 'delivering'")) {
            const claimable = row.status === "pending" || row.status === "failed" || (row.status === "delivering" && String(row.lease_expires_at) <= String(values[5]));
            if (!claimable) return { meta:{ changes:0 } };
            row.status = "delivering"; row.attempt_count += 1; row.lease_token = String(values[0]); row.lease_expires_at = String(values[1]); row.last_error = null; row.updated_at = String(values[2]);
            return { meta:{ changes:1 } };
          }
          if (sql.includes("SET status = 'failed'")) {
            if (row.status !== "delivering" || row.lease_token !== values[4]) return { meta:{ changes:0 } };
            row.status = "failed"; row.lease_token = null; row.lease_expires_at = null; row.last_error = String(values[0]); row.updated_at = String(values[1]);
            return { meta:{ changes:1 } };
          }
          if (sql.includes("SET status = 'delivered'")) {
            if (row.status !== "delivering" || row.lease_token !== values[4]) return { meta:{ changes:0 } };
            row.status = "delivered"; row.lease_token = null; row.lease_expires_at = null; row.last_error = null; row.delivered_at = String(values[0]); row.updated_at = String(values[1]);
            return { meta:{ changes:1 } };
          }
          return { meta:{ changes:0 } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}
