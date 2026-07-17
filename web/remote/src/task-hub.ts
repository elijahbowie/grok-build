import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

export class TaskHub extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "connected", at: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method === "POST") {
      const url = new URL(request.url);
      if (url.pathname === "/desktop-activity") {
        const { taskId } = await request.json<{taskId:string}>();
        await this.ctx.storage.put(`desktop:${taskId}`, Date.now());
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        return Response.json({ ok: true });
      }
      const message = await request.text();
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(message); } catch { socket.close(1011, "Broadcast failed"); }
      }
      return Response.json({ delivered: this.ctx.getWebSockets().length });
    }
    return new Response("TaskHub requires a WebSocket upgrade", { status: 426 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong");
  }

  async alarm() {
    const entries = await this.ctx.storage.list<number>({ prefix: "desktop:" });
    const cutoff = Date.now() - 60_000;
    let nextAlarm: number | null = null;
    for (const [key, lastSeen] of entries) {
      if (lastSeen <= cutoff) {
        const taskId = key.slice("desktop:".length);
        const sandbox = getSandbox(this.env.Sandbox, `grok-${taskId}`, { normalizeId: true, sleepAfter: "30s" });
        const process = await sandbox.getProcess(`desktop-${taskId}`);
        if (process) await process.kill().catch(() => undefined);
        await this.ctx.storage.delete(key);
      } else {
        nextAlarm = Math.min(nextAlarm ?? Infinity, lastSeen + 60_000);
      }
    }
    if (nextAlarm) await this.ctx.storage.setAlarm(nextAlarm);
  }
}
