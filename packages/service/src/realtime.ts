import type { Server, IncomingMessage } from "node:http";
import type { PoolClient } from "pg";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import type { Store } from "./store.js";
import type { Auth } from "./auth.js";
import { logFailure } from "./diagnostic-log.js";
import { apiEvents, apiProject } from "./api-compat.js";

// One LISTEN connection per API process, shared across browser connections.
export function attachRealtime(
  server: Server,
  store: Store,
  auth: Auth,
  origin: string,
  tokenFor: (request: IncomingMessage) => string | undefined,
) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const subscribers = new Set<(projectId: string, after?: number) => void>();
  let listener: Promise<PoolClient> | undefined;
  let stopped = false;
  let stopListener: (() => void) | undefined;
  function listen() {
    return (listener ??= (async () => {
      const client = await store.pool.connect();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        listener = undefined;
        client.release(true);
        for (const socket of sockets.clients) socket.terminate();
      };
      stopListener = release;
      client.on("error", release);
      client.on("end", release);
      client.on("notification", (event) => {
        if (event.channel === "herbie_changes" && event.payload) {
          const [id, eventId] = event.payload.split(":");
          if (!id || !z.string().uuid().safeParse(id).success) return;
          const after = eventId ? Number(eventId) - 1 : undefined;
          if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) return;
          for (const notify of subscribers) notify(id, after);
        }
      });
      try {
        await client.query("LISTEN herbie_changes");
        if (stopped) throw new Error("Server stopped");
        return client;
      } catch (error) {
        release();
        throw error;
      }
    })().catch((error) => {
      listener = undefined;
      throw error;
    }));
  }
  server.on("upgrade", (request, connection, head) => {
    connection.on("error", () => connection.destroy());
    const reject = (status: number) => {
      connection.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    };
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname !== "/api/stream") return reject(404);
      if (request.headers.origin !== origin) return reject(403);
      const token = tokenFor(request);
      const session = token ? await auth.session(token) : null;
      if (!session || !token) return reject(401);
      const selected = url.searchParams.get("project");
      const version = url.searchParams.get("version") ?? undefined;
      if (selected && !z.string().uuid().safeParse(selected).success) return reject(400);
      if (selected && !(await store.getProject(selected, session.user.id))) return reject(404);
      await listen(); // Subscribe before reading snapshots so concurrent commits cannot be lost.
      if (connection.destroyed || stopped) return connection.destroy();
      sockets.handleUpgrade(request, connection, head, (socket) => {
        let cursor = 0;
        let rewind = Infinity;
        let dirty = false;
        let sending = false;
        let alive = true;
        let owned = new Set<string>();
        socket.on("error", () => socket.terminate());
        socket.on("pong", () => {
          alive = true;
        });
        socket.on("message", () => socket.close(1008, "Read-only stream"));
        const send = (value: unknown) => {
          if (socket.bufferedAmount > 1024 * 1024) return socket.terminate();
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
        };
        async function flush(after?: number) {
          // Sequence IDs can commit out of order. Re-read from a notified event,
          // even when a later ID was already sent; browsers deduplicate by ID.
          if (after !== undefined) rewind = Math.min(rewind, after);
          dirty = true;
          if (sending) return;
          sending = true;
          try {
            while (dirty && socket.readyState === WebSocket.OPEN) {
              dirty = false;
              cursor = Math.min(cursor, rewind);
              rewind = Infinity;
              if ((await auth.session(token!))?.user.id !== session!.user.id) {
                socket.close(1008, "Login required");
                return;
              }
              const projects = await store.listProjects(session!.user.id);
              owned = new Set(projects.map((project) => project.id));
              send({
                type: "projects",
                projects: projects.map((project) => apiProject(project, version)),
              });
              if (selected && owned.has(selected)) {
                // Drain all pages, including histories longer than the REST page limit.
                while (socket.readyState === WebSocket.OPEN) {
                  const events = await store.events(selected, cursor);
                  send({ type: "events", projectId: selected, events: apiEvents(events, version) });
                  if (events.length) cursor = events[events.length - 1]!.id;
                  if (events.length < 1000) break;
                }
              }
            }
          } catch (error) {
            logFailure(error, { component: "realtime-stream" });
            socket.terminate();
          } finally {
            sending = false;
          }
        }
        const notify = (id: string, after?: number) => {
          // Unknown IDs can be newly created projects; the owner-scoped query is authoritative.
          if (owned.has(id)) void flush(id === selected ? after : undefined);
          else
            void store
              .getProject(id, session!.user.id)
              .then((project) => {
                if (project) void flush(id === selected ? after : undefined);
              })
              .catch(() => socket.terminate());
        };
        subscribers.add(notify);
        const heartbeat = setInterval(() => {
          if (!alive) return socket.terminate();
          alive = false;
          socket.ping();
          void auth
            .session(token)
            .then((current) => {
              if (current?.user.id !== session.user.id) socket.close(1008, "Login required");
            })
            .catch(() => socket.terminate());
        }, 30_000);
        heartbeat.unref();
        socket.on("close", () => {
          clearInterval(heartbeat);
          subscribers.delete(notify);
        });
        void flush();
      });
    })().catch((error) => {
      logFailure(error, { component: "realtime-upgrade" });
      reject(503);
    });
  });
  // Upgraded sockets must be closed before waiting for HTTP shutdown.
  const close = server.close.bind(server);
  server.close = (callback) => {
    stopped = true;
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    stopListener?.();
    listener = undefined;
    return close(callback);
  };
}
