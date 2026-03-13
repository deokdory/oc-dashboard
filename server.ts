import {
  getProjects,
  getAllActiveSessions,
  batchGetSessionTodos,
  batchGetLastMessages,
  getSubAgentCounts,
  getSubAgentSessions,
  getTokenSummary,
} from "./db";
import type { Project, Session, Todo, MessagePreview, SessionMessages, SubAgentSession, TokenSummary } from "./db";
import { getOpenCodeProcesses, type OcProcess } from "./process";

const ACTIVE_SESSIONS_PATH = `${Bun.env.HOME || ""}/.local/share/opencode/active-sessions.json`;

async function readPluginActiveSessions(): Promise<{ exists: boolean; ids: Set<string> }> {
  try {
    const file = Bun.file(ACTIVE_SESSIONS_PATH);
    const text = await file.text();
    return { exists: true, ids: new Set(Object.keys(JSON.parse(text))) };
  } catch {
    return { exists: false, ids: new Set() };
  }
}

declare const Bun: {
  env: Record<string, string | undefined>;
  serve(options: { port: number; fetch(req: Request): Response | Promise<Response> }): void;
  file(path: string | URL): Blob;
};

interface Transition {
  sessionId: string;
  from: string;
  to: string;
  title: string;
}

interface SessionWithCounts extends Session {
  subAgentCount: number;
  activeSubAgentCount: number;
}

const ARCHIVE_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

interface DashboardState {
  projects: Project[];
  archivedProjectIds: string[];
  sessions: SessionWithCounts[];
  archivedSessions: SessionWithCounts[];
  todos: Record<string, Todo[]>;
  messages: Record<string, SessionMessages>;
  processes: OcProcess[];
  transitions: Transition[];
  tokenSummary: TokenSummary;
  timestamp: number;
}

const prevStatusMap = new Map<string, string>();
const dismissedSessions = new Set<string>();

function detectTransitions(sessions: Session[]): Transition[] {
  const transitions: Transition[] = [];

  for (const session of sessions) {
    const prev = prevStatusMap.get(session.id);
    if (prev !== undefined && prev !== session.status) {
      transitions.push({
        sessionId: session.id,
        from: prev,
        to: session.status,
        title: session.title,
      });
    }
    prevStatusMap.set(session.id, session.status);
  }

  return transitions;
}

let projectsCache: Project[] = [];
let projectsCacheAt = 0;
const PROJECTS_TTL = 30_000;

async function buildState(): Promise<DashboardState | { error: string }> {
  try {
    if (Date.now() - projectsCacheAt > PROJECTS_TTL) {
      projectsCache = getProjects();
      projectsCacheAt = Date.now();
    }

    const projects = projectsCache;
    const rawSessions = getAllActiveSessions();

    const sessionIds = rawSessions.map(s => s.id);
    const subAgentCounts = getSubAgentCounts(sessionIds);
    const tokenSummary = getTokenSummary(sessionIds);

    const processes = await getOpenCodeProcesses();
    const pluginResult = await readPluginActiveSessions();

    let activeSessionIds: Set<string>;
    if (pluginResult.exists) {
      activeSessionIds = pluginResult.ids;
    } else {
      const activeCwds = new Set(processes.map(p => p.cwd).filter(Boolean));
      const newestSessionPerCwd = new Map<string, string>();
      for (const s of rawSessions) {
        if (!activeCwds.has(s.directory)) continue;
        const existing = newestSessionPerCwd.get(s.directory);
        if (!existing) {
          newestSessionPerCwd.set(s.directory, s.id);
        } else {
          const existingSession = rawSessions.find(r => r.id === existing)!;
          if (s.timeUpdated > existingSession.timeUpdated) {
            newestSessionPerCwd.set(s.directory, s.id);
          }
        }
      }
      activeSessionIds = new Set(newestSessionPerCwd.values());
    }

    const now = Date.now();
    const archiveCutoff = now - ARCHIVE_THRESHOLD_MS;

    const allSessions: SessionWithCounts[] = rawSessions.map(s => {
      const isActive = activeSessionIds.has(s.id);
      let status = isActive && s.status !== "ACTIVE" ? "ACTIVE" as const : s.status;
      if (status === "RECENT" && dismissedSessions.has(s.id)) {
        status = "IDLE";
      }
      if (s.status !== "RECENT") {
        dismissedSessions.delete(s.id);
      }
      return {
        ...s,
        status,
        subAgentCount: subAgentCounts[s.id]?.active ?? 0,
        activeSubAgentCount: subAgentCounts[s.id]?.active ?? 0,
      };
    });

    const sessions: SessionWithCounts[] = [];
    const archivedSessions: SessionWithCounts[] = [];
    for (const s of allSessions) {
      if (s.status === "ACTIVE" || s.timeUpdated > archiveCutoff) {
        sessions.push(s);
      } else {
        archivedSessions.push(s);
      }
    }

    const activeSessionProjectIds = new Set(sessions.map(s => s.projectId));
    const archivedProjectIds = projects
      .filter(p => !activeSessionProjectIds.has(p.id))
      .map(p => p.id);

    const nonIdleIds = sessions.filter(s => s.status !== "IDLE").map(s => s.id);
    const todos = batchGetSessionTodos(nonIdleIds);
    const messages = batchGetLastMessages(nonIdleIds);

    const transitions = detectTransitions(sessions);

    return {
      projects,
      archivedProjectIds,
      sessions,
      archivedSessions,
      todos,
      messages,
      processes,
      transitions,
      tokenSummary,
      timestamp: Date.now(),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type Controller = ReadableStreamDefaultController<Uint8Array>;
const clients = new Set<Controller>();
const encoder = new TextEncoder();

function broadcast(state: DashboardState | { error: string }): void {
  const payload = encoder.encode(`data: ${JSON.stringify(state)}\n\n`);

  for (const client of clients) {
    try {
      client.enqueue(payload);
    } catch {
      clients.delete(client);
    }
  }
}

setInterval(async () => {
  if (clients.size === 0) return;
  const state = await buildState();
  broadcast(state);
}, 2_000);

const PORT = parseInt(Bun.env.PORT ?? "3333", 10);

Bun.serve({
  port: PORT,
  async fetch(req: Request) {
    const url = new URL(req.url);

    if (url.pathname === "/events") {
      let clientController: Controller | null = null;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          clientController = controller;
          clients.add(controller);

          const state = await buildState();
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(state)}\n\n`));
          } catch {
            clients.delete(controller);
          }
        },
        cancel() {
          if (clientController) {
            clients.delete(clientController);
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const sessionPathParts = url.pathname.split("/").filter(Boolean);
    if (
      sessionPathParts.length === 3 &&
      sessionPathParts[0] === "sessions" &&
      sessionPathParts[2] === "dismiss" &&
      req.method === "POST"
    ) {
      const sessionId = sessionPathParts[1];
      dismissedSessions.add(sessionId);
      const state = await buildState();
      broadcast(state);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    if (
      sessionPathParts.length === 3 &&
      sessionPathParts[0] === "sessions" &&
      sessionPathParts[2] === "subagents"
    ) {
      const sessionId = sessionPathParts[1];
      const subAgents = getSubAgentSessions(sessionId);
      return new Response(JSON.stringify(subAgents), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(new URL("./public/index.html", import.meta.url)));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`OC Dashboard running at http://localhost:${PORT}`);
