import {
  getProjects,
  getAllActiveSessions,
  batchGetSessionTodos,
  batchGetLastMessages,
  getSubAgentCounts,
  getSubAgentSessions,
  getTokenSummary,
} from "./db";
import type { Project, Session, Todo, MessagePreview, SubAgentSession, TokenSummary } from "./db";
import { getOpenCodeProcesses, type OcProcess } from "./process";

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

interface DashboardState {
  projects: Project[];
  sessions: SessionWithCounts[];
  todos: Record<string, Todo[]>;
  messages: Record<string, MessagePreview | null>;
  processes: OcProcess[];
  transitions: Transition[];
  tokenSummary: TokenSummary;
  timestamp: number;
}

const prevStatusMap = new Map<string, string>();

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

    const sessions: SessionWithCounts[] = rawSessions.map(s => ({
      ...s,
      subAgentCount: subAgentCounts[s.id]?.active ?? 0,
      activeSubAgentCount: subAgentCounts[s.id]?.active ?? 0,
    }));

    const nonIdleIds = sessions.filter(s => s.status !== "IDLE").map(s => s.id);
    const todos = batchGetSessionTodos(nonIdleIds);
    const messages = batchGetLastMessages(nonIdleIds);

    const processes = await getOpenCodeProcesses();
    const transitions = detectTransitions(sessions);

    return {
      projects,
      sessions,
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
