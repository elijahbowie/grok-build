import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const task = {
  id: "task-1", title: "Add a health endpoint", prompt: "Add a health endpoint", source: "user", status: "review",
  branch: "grok-web/health-task-1", baseBranch: "main", model: "grok-build", permissionMode: "isolated-write",
  createdAt: "2026-07-15T12:00:00.000Z", updatedAt: "2026-07-15T12:01:00.000Z", sessionId: "session-1", stopReason: "end_turn",
  error: null, additions: 4, deletions: 0, changedFiles: [{ path: "health.ts", status: "A", additions: 4, deletions: 0 }],
  pr: null, preview: null, messages: [{ role: "user", text: "Add a health endpoint", at: "2026-07-15T12:00:00.000Z" }],
  events: [{ id: "event-1", type: "status", data: "Grok finished", at: "2026-07-15T12:01:00.000Z" }], terminalRuns: [], usage: null, cost: null,
};

const bootstrap = {
  repository: { path: "/repo", name: "elijahbowie/grok-build", branch: "main", remote: "git@github.com:elijahbowie/grok-build.git" },
  capabilities: { grok: true, grokVersion: "grok 0.2.101", models: ["grok-4.5"], github: true, git: true, worktrees: true, remoteRunner: { available: true, authenticated: true, authStatus: "authenticated" } },
  tasks: [task], settings: { model: "grok-4.5", permissionMode: "isolated-write", baseBranch: "main", theme: "dark" }, automations: [],
};

class MockEventSource {
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  addEventListener() {}
  close() {}
}

function response(value: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(value) } as Response);
}

beforeEach(() => {
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/bootstrap") return response(bootstrap);
    if (path === "/api/tasks/task-1") return response(task);
    if (path === "/api/tasks/task-1/diff") return response({ patch: "diff --git a/health.ts b/health.ts\n+export const healthy = true;" });
    if (path === "/api/tasks" && init?.method === "POST") return response({ ...task, id: "task-2", title: "Build it", status: "queued", changedFiles: [] });
    return response({});
  }));
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Grok Build workspace", () => {
  it("loads a real, inspectable task workspace", async () => {
    render(<App />);
    expect(await screen.findByRole("main", { name: "Agent transcript" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Artifact review" })).toBeInTheDocument();
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Code diff" })).toHaveTextContent("export const healthy");
  });

  it("creates a task through the service", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /New agent/i }));
    fireEvent.change(screen.getByRole("textbox", { name: "Agent instructions" }), { target: { value: "Build it" } });
    fireEvent.click(screen.getByRole("button", { name: "Start agent" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST" })));
  });

  it("requires explicit confirmation before publishing", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Publish changes" }));
    expect(screen.getByRole("dialog", { name: "Publish 1 changed files?" })).toHaveTextContent("It will not merge");
    expect(screen.getByRole("button", { name: "Commit, push, and open PR" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith("/api/tasks/task-1/pull-request", expect.anything());
  });

  it("filters task history without changing the active task", async () => {
    render(<App />);
    const search = await screen.findByRole("textbox", { name: "Search tasks" });
    fireEvent.change(search, { target: { value: "missing task" } });
    expect(screen.getByText("No matching tasks.")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Agent transcript" })).toBeInTheDocument();
  });

  it("shows the connected subscription and enables cloud compute", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Cloud Grok subscription" })).toBeInTheDocument();
    expect(screen.getByText("Your subscription is ready for cloud tasks.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New agent/i }));
    const compute = screen.getByRole("combobox", { name: "Compute" });
    expect(compute).toBeEnabled();
    expect(screen.getByRole("option", { name: "Cloud sandbox" })).toBeEnabled();
  });

  it("presents authenticated browser evidence for cloud tasks", async () => {
    const cloudTask = { ...task, projectId: "project-1", source: "cloud", executionTarget: "remote" };
    const cloudBootstrap = {
      ...bootstrap, mode: "cloud", identity: { email: "director@eicimpact.org" }, tasks: [cloudTask],
      projects: [{ id: "project-1", name: "Grok Build", slug: "grok-build", artifact_repo: "grok-build", default_branch: "main", source_type: "empty", source_url: null, ready: true }],
      github: { app: null, connections: [], sync: [] }, limits: { concurrentTasks: 5, taskTimeoutMinutes: 60, retentionDays: 30 },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/bootstrap") return response(cloudBootstrap);
      if (path === "/api/tasks/task-1") return response(cloudTask);
      if (path === "/api/tasks/task-1/diff") return response({ patch: "" });
      if (path === "/api/tasks/task-1/evidence") return response({ evidence: [{ id: "ev-1", kind: "browser-artifact", contentType: "image/png", size: 2048, name: "checkout.png", createdAt: task.updatedAt, url: "/api/tasks/task-1/evidence/ev-1" }] });
      return response({});
    }));
    vi.stubGlobal("WebSocket", class { onmessage = null; onerror = null; close() {} });
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Evidence" }));
    expect(await screen.findByRole("img", { name: "Browser evidence: checkout.png" })).toHaveAttribute("src", "/api/tasks/task-1/evidence/ev-1");
    expect(screen.getByRole("link", { name: "Open artifact ↗" })).toHaveAttribute("href", "/api/tasks/task-1/evidence/ev-1");
  });
});
