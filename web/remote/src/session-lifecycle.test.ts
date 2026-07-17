import { describe, expect, it } from "vitest";
import { boundTranscript, executableSessionTask, renderSessionMarkdown, validateSessionName, type TaskSession, type TaskSessionRevision } from "./session-lifecycle";
import type { Task } from "./types";

describe("session lifecycle", () => {
  it("validates durable session names", () => {
    expect(validateSessionName("  Payment repair  ")).toBe("Payment repair");
    expect(() => validateSessionName(" ")).toThrow(/1 to 160/);
    expect(() => validateSessionName("x".repeat(161))).toThrow(/1 to 160/);
  });

  it("exports immutable revision lineage at exact prompt boundaries", () => {
    const session:TaskSession={id:"session_one",ownerSub:"owner",projectId:"project_one",rootTaskId:"task_one",sourceSessionId:null,name:"Checkout repair",createdBySub:"owner",createdAt:"2026-01-01T00:00:00.000Z",updatedAt:"2026-01-01T00:01:00.000Z"};
    const revision:TaskSessionRevision={id:"revision_one",sessionId:session.id,sourceTaskId:"task_one",parentRevisionId:null,operation:"rewind",promptMessageId:"message_two",title:"Checkout repair",prompt:"Try the smaller fix",executionContext:"Repair checkout\n\nFollow-up instruction:\nTry the smaller fix",taskStatus:"review",model:"grok-4.5",permissionMode:"isolated-write",baseSha:"a".repeat(40),headSha:"b".repeat(40),acpSessionId:"acp_one",createdBySub:"owner",createdAt:session.updatedAt,transcript:[{id:"message_one",role:"user",body:"Repair checkout",createdAt:session.createdAt},{id:"message_two",role:"user",body:"Try the smaller fix",createdAt:session.updatedAt}]};
    const output=renderSessionMarkdown({session,revisions:[revision]});
    expect(output).toContain("# Checkout repair");
    expect(output).toContain("Prompt boundary: message_two");
    expect(output).toContain("Try the smaller fix");
    expect(output).not.toContain("canonical rewrite");
  });

  it("binds a rewind to a retained user prompt without later transcript content", () => {
    const rows=[
      {id:"one",role:"user" as const,body:"First request",created_at:"2026-01-01T00:00:00.000Z"},
      {id:"two",role:"assistant" as const,body:"First answer",created_at:"2026-01-01T00:01:00.000Z"},
      {id:"three",role:"user" as const,body:"Second request",created_at:"2026-01-01T00:02:00.000Z"},
    ];
    expect(boundTranscript(rows,"one").transcript.map((item) => item.id)).toEqual(["one","two"]);
    expect(boundTranscript(rows).prompt.id).toBe("three");
    expect(() => boundTranscript(rows,"two")).toThrow(/exact retained user prompt/);
    expect(() => boundTranscript(rows,"missing")).toThrow(/exact retained user prompt/);
  });

  it("turns a retained revision into an executable task pinned to source code", () => {
    const task={id:"tsk_source",task_repo:"task-source",model_profile_id:"profile_one",output_schema_json:null,max_turns:20,allowed_tools_json:"[]",denied_tools_json:"[]",web_search_mode:"allow"} as Task;
    const revision={id:"revision_one",sessionId:"session_one",sourceTaskId:task.id,parentRevisionId:null,operation:"rewind",promptMessageId:"message_one",title:"Repair checkout",prompt:"Try the smaller fix",executionContext:"Original selected context",taskStatus:"review",model:"grok-4.5",permissionMode:"isolated-write",baseSha:"a".repeat(40),headSha:"b".repeat(40),acpSessionId:"acp_one",transcript:[{id:"message_one",role:"user",body:"Try the smaller fix",createdAt:"2026-01-01T00:00:00.000Z"}],createdBySub:"owner",createdAt:"2026-01-01T00:00:00.000Z"} satisfies TaskSessionRevision;
    const execution=executableSessionTask(task,revision);
    expect(execution.workflowId).toBe(`task-${execution.taskId}`);
    expect(execution.sourceTaskId).toBe(task.id);
    expect(execution.sourceHeadSha).toBe("b".repeat(40));
    expect(execution.title).toBe("Rewind: Repair checkout");
    expect(execution.prompt).toContain("USER:\nTry the smaller fix");
  });

  it("refuses metadata-only session revisions without executable code", () => {
    const task={id:"tsk_source",task_repo:null} as Task;
    const revision={operation:"fork",title:"Unavailable",prompt:"Retry",headSha:null} as TaskSessionRevision;
    expect(()=>executableSessionTask(task,revision)).toThrow(/executable source code snapshot/);
  });
});
