export type PwaRequestInput = {
  url: string;
  method?: string;
  mode?: string;
  headers?: Headers | Record<string, string>;
};

export type SafePushPayload = {
  version: 1;
  eventId: string;
  taskId: string;
  kind: "task-completed" | "task-failed" | "approval-needed";
  createdAt: string;
};

export const ATTENTION_KINDS: readonly SafePushPayload["kind"][];
export function classifyPwaRequest(input: PwaRequestInput, appOrigin: string): "network-only" | "navigation-fallback" | "cache-first-static";
export function isSafeCacheResponse(response: Response): boolean;
export function safePushPayload(input: unknown): SafePushPayload | null;
export function pushText(kind: SafePushPayload["kind"]): { title: string; body: string };
