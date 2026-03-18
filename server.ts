import {
  getProjects,
  getAllActiveSessions,
  batchGetSessionTodos,
  batchGetLastMessages,
  getSubAgentCounts,
  getSubAgentSessions,
  batchGetTokenSummary,
  batchGetSessionTiming,
  batchGetSessionAgents,
  batchGetPendingQuestions,
  batchGetPendingBackgroundTasks,
} from "./db";
import type {
  Project,
  Session,
  Todo,
  MessagePreview,
  SessionMessages,
  SubAgentSession,
  TokenSummary,
  SessionTiming,
} from "./db";
import { getOpenCodeProcesses, type OcProcess } from "./process";
import { isPluginEntryStale } from "./stale";

const ACTIVE_SESSIONS_PATH = `${Bun.env.HOME || ""}/.local/share/opencode/active-sessions.json`;

interface PluginEntry {
  status: string;
  ts: number;
}

async function readPluginActiveSessions(): Promise<{ exists: boolean; entries: Map<string, PluginEntry> }> {
  try {
    const file = Bun.file(ACTIVE_SESSIONS_PATH);
    const text = await file.text();
    const parsed = JSON.parse(text) as Record<string, PluginEntry>;
    const entries = new Map<string, PluginEntry>();
    for (const [id, entry] of Object.entries(parsed)) {
      entries.set(id, { status: entry.status, ts: entry.ts ?? 0 });
    }
    return { exists: true, entries };
  } catch {
    return { exists: false, entries: new Map() };
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
  sessionTokens: Record<string, TokenSummary>;
  sessionTimings: Record<string, SessionTiming>;
  sessionAgents: Record<string, string>;
  waitingSessions: string[];
  delegatingSessions: string[];
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
    const sessionTokens = batchGetTokenSummary(sessionIds);

    const processes = await getOpenCodeProcesses();
    const pluginResult = await readPluginActiveSessions();
    const activeCwds = new Set(processes.filter(p => !p.isWebServer).map(p => p.cwd).filter(Boolean));

    let activeSessionIds: Set<string>;
    if (pluginResult.exists) {
      activeSessionIds = new Set<string>();
      const now = Date.now();
      for (const [id, entry] of pluginResult.entries) {
        const session = rawSessions.find(s => s.id === id);
        const dbTimeUpdated = session?.timeUpdated ?? 0;
        const hasProcess = session ? activeCwds.has(session.directory) : false;

        if (isPluginEntryStale(now, entry.ts, dbTimeUpdated, hasProcess)) {
          continue;
        }
        activeSessionIds.add(id);
      }
    } else {
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

    const allSessionIds = [...sessions, ...archivedSessions].map(s => s.id);
    const sessionTimings = batchGetSessionTiming(allSessionIds);
    const sessionAgents = batchGetSessionAgents(allSessionIds);

    const activeIds = sessions.filter(s => s.status === "ACTIVE").map(s => s.id);
    const pendingQuestions = batchGetPendingQuestions(activeIds);
    const waitingSessions = [...pendingQuestions];

    const nonIdleSessions = sessions.filter(s => s.status !== "IDLE");
    const nonActiveIds = nonIdleSessions.filter(s => s.status !== "ACTIVE").map(s => s.id);
    const pendingBgTasks = batchGetPendingBackgroundTasks([...activeIds, ...nonActiveIds]);
    const delegatingSessions = [...pendingBgTasks];

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
      sessionTokens,
      sessionTimings,
      sessionAgents,
      waitingSessions,
      delegatingSessions,
      timestamp: Date.now(),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const DEMO_MODE = Bun.env.DEMO === "true";

function buildDemoState(): DashboardState {
  const now = Date.now();

  const projects: Project[] = [
    { id: "proj-web", worktree: "/home/dev/web-app", displayName: "web-app" },
    { id: "proj-api", worktree: "/home/dev/api-server", displayName: "api-server" },
    { id: "proj-cli", worktree: "/home/dev/cli-tool", displayName: "cli-tool" },
    { id: "proj-docs", worktree: "/home/dev/docs", displayName: "docs" },
  ];

  const sessions: SessionWithCounts[] = [
    {
      id: "ses-demo-1", projectId: "proj-web", title: "Implement OAuth2 login flow",
      directory: "/home/dev/web-app", timeUpdated: now - 3000, status: "ACTIVE",
      summaryAdditions: 247, summaryDeletions: 38, summaryFiles: 12,
      subAgentCount: 2, activeSubAgentCount: 2,
    },
    {
      id: "ses-demo-2", projectId: "proj-web", title: "Fix responsive layout on mobile",
      directory: "/home/dev/web-app", timeUpdated: now - 5000, status: "ACTIVE",
      summaryAdditions: 89, summaryDeletions: 23, summaryFiles: 5,
      subAgentCount: 0, activeSubAgentCount: 0,
    },
    {
      id: "ses-demo-3", projectId: "proj-api", title: "Add rate limiting middleware",
      directory: "/home/dev/api-server", timeUpdated: now - 120000, status: "RECENT",
      summaryAdditions: 156, summaryDeletions: 12, summaryFiles: 8,
      subAgentCount: 1, activeSubAgentCount: 1,
    },
    {
      id: "ses-demo-4", projectId: "proj-api", title: "Database migration v2.3",
      directory: "/home/dev/api-server", timeUpdated: now - 7200000, status: "IDLE",
      summaryAdditions: 420, summaryDeletions: 195, summaryFiles: 15,
      subAgentCount: 0, activeSubAgentCount: 0,
    },
    {
      id: "ses-demo-5", projectId: "proj-cli", title: "Add --json output flag",
      directory: "/home/dev/cli-tool", timeUpdated: now - 4000, status: "ACTIVE",
      summaryAdditions: 63, summaryDeletions: 8, summaryFiles: 3,
      subAgentCount: 1, activeSubAgentCount: 1,
    },
    {
      id: "ses-demo-6", projectId: "proj-web", title: "Refactor state management",
      directory: "/home/dev/web-app", timeUpdated: now - 180000, status: "RECENT",
      summaryAdditions: 312, summaryDeletions: 287, summaryFiles: 22,
      subAgentCount: 0, activeSubAgentCount: 0,
    },
  ];

  const archivedSessions: SessionWithCounts[] = [
    {
      id: "ses-demo-old-1", projectId: "proj-docs", title: "Update API reference docs",
      directory: "/home/dev/docs", timeUpdated: now - 5 * 86400000, status: "IDLE",
      summaryAdditions: 89, summaryDeletions: 14, summaryFiles: 4,
      subAgentCount: 0, activeSubAgentCount: 0,
    },
    {
      id: "ses-demo-old-2", projectId: "proj-docs", title: "Add getting started guide",
      directory: "/home/dev/docs", timeUpdated: now - 7 * 86400000, status: "IDLE",
      summaryAdditions: 210, summaryDeletions: 0, summaryFiles: 6,
      subAgentCount: 0, activeSubAgentCount: 0,
    },
  ];

  const todos: Record<string, Todo[]> = {
    "ses-demo-1": [
      { sessionId: "ses-demo-1", content: "Implement Google OAuth provider", status: "completed", priority: "high", position: 0 },
      { sessionId: "ses-demo-1", content: "Add token refresh logic", status: "completed", priority: "high", position: 1 },
      { sessionId: "ses-demo-1", content: "Create login callback handler", status: "in_progress", priority: "high", position: 2 },
      { sessionId: "ses-demo-1", content: "Add session persistence", status: "pending", priority: "medium", position: 3 },
      { sessionId: "ses-demo-1", content: "Write integration tests", status: "pending", priority: "medium", position: 4 },
    ],
    "ses-demo-2": [
      { sessionId: "ses-demo-2", content: "Fix sidebar collapse on tablet", status: "completed", priority: "high", position: 0 },
      { sessionId: "ses-demo-2", content: "Adjust grid breakpoints", status: "in_progress", priority: "medium", position: 1 },
    ],
    "ses-demo-5": [
      { sessionId: "ses-demo-5", content: "Parse --json flag from args", status: "completed", priority: "high", position: 0 },
      { sessionId: "ses-demo-5", content: "Format output as JSON", status: "completed", priority: "high", position: 1 },
      { sessionId: "ses-demo-5", content: "Update help text", status: "in_progress", priority: "low", position: 2 },
    ],
  };

  const messages: Record<string, SessionMessages> = {
    "ses-demo-1": {
      last: { role: "assistant", agent: "Sisyphus", textPreview: "OAuth callback handler implemented. Now adding PKCE verification for the authorization code flow...", timeCreated: now - 3000 },
      user: { role: "user", agent: null, textPreview: "Implement Google OAuth2 login with PKCE flow", timeCreated: now - 60000 },
    },
    "ses-demo-2": {
      last: { role: "assistant", agent: "Sisyphus", textPreview: "Fixed the sidebar z-index issue. Adjusting grid breakpoints for 768px viewport...", timeCreated: now - 5000 },
      user: { role: "user", agent: null, textPreview: "The sidebar overlaps content on iPad. Fix the responsive layout", timeCreated: now - 30000 },
    },
    "ses-demo-3": {
      last: { role: "assistant", agent: "Sisyphus", textPreview: "Rate limiting middleware complete. Added sliding window algorithm with Redis backend, 100 req/min default.", timeCreated: now - 120000 },
      user: { role: "user", agent: null, textPreview: "Add rate limiting to all API endpoints", timeCreated: now - 300000 },
    },
    "ses-demo-5": {
      last: { role: "assistant", agent: "Sisyphus", textPreview: "JSON output flag working. Updating --help text to document the new option...", timeCreated: now - 4000 },
      user: { role: "user", agent: null, textPreview: "Add a --json flag for machine-readable output", timeCreated: now - 20000 },
    },
    "ses-demo-6": {
      last: { role: "assistant", agent: "Sisyphus", textPreview: "Refactoring complete. Migrated 22 files from Redux to Zustand. All tests passing.", timeCreated: now - 180000 },
      user: { role: "user", agent: null, textPreview: "Migrate state management from Redux to Zustand", timeCreated: now - 600000 },
    },
  };

  const sessionTokens: Record<string, TokenSummary> = {
    "ses-demo-1": { totalInput: 284500, totalOutput: 12300, latestContext: 142000 },
    "ses-demo-2": { totalInput: 95200, totalOutput: 4800, latestContext: 48000 },
    "ses-demo-3": { totalInput: 187600, totalOutput: 8900, latestContext: 95000 },
    "ses-demo-4": { totalInput: 523000, totalOutput: 31200, latestContext: 210000 },
    "ses-demo-5": { totalInput: 67400, totalOutput: 3100, latestContext: 34000 },
    "ses-demo-6": { totalInput: 412800, totalOutput: 19500, latestContext: 172000 },
    "ses-demo-old-1": { totalInput: 45000, totalOutput: 2100, latestContext: 23000 },
    "ses-demo-old-2": { totalInput: 78000, totalOutput: 5600, latestContext: 40000 },
  };

  const sessionAgents: Record<string, string> = {
    "ses-demo-1": "Sisyphus (Ultraworker)",
    "ses-demo-2": "Sisyphus (Ultraworker)",
    "ses-demo-3": "Sisyphus (Ultraworker)",
    "ses-demo-4": "Atlas (Plan Executor)",
    "ses-demo-5": "Sisyphus (Ultraworker)",
    "ses-demo-6": "Sisyphus (Ultraworker)",
    "ses-demo-old-1": "herald",
    "ses-demo-old-2": "Sisyphus (Ultraworker)",
  };

  const sessionTimings: Record<string, SessionTiming> = {
    "ses-demo-1": {
      firstUserRequestAt: now - 2_400_000,
      lastUserRequestAt: now - 60_000,
      responseEndAt: now - 3_000,
    },
    "ses-demo-2": {
      firstUserRequestAt: now - 900_000,
      lastUserRequestAt: now - 30_000,
      responseEndAt: now - 5_000,
    },
    "ses-demo-3": {
      firstUserRequestAt: now - 1_200_000,
      lastUserRequestAt: now - 300_000,
      responseEndAt: now - 120_000,
    },
    "ses-demo-4": {
      firstUserRequestAt: now - 8_400_000,
      lastUserRequestAt: now - 7_500_000,
      responseEndAt: now - 7_200_000,
    },
    "ses-demo-5": {
      firstUserRequestAt: now - 420_000,
      lastUserRequestAt: now - 20_000,
      responseEndAt: now - 4_000,
    },
    "ses-demo-6": {
      firstUserRequestAt: now - 4_200_000,
      lastUserRequestAt: now - 600_000,
      responseEndAt: now - 180_000,
    },
    "ses-demo-old-1": {
      firstUserRequestAt: now - 5 * 86400000 - 900_000,
      lastUserRequestAt: now - 5 * 86400000 - 600_000,
      responseEndAt: now - 5 * 86400000 - 300_000,
    },
    "ses-demo-old-2": {
      firstUserRequestAt: now - 7 * 86400000 - 1_200_000,
      lastUserRequestAt: now - 7 * 86400000 - 900_000,
      responseEndAt: now - 7 * 86400000 - 600_000,
    },
  };

  const processes: OcProcess[] = [
    { pid: 42150, cpu: "8.2", mem: "1.8", elapsed: "12:34.56", cwd: "/home/dev/web-app", isWebServer: false },
    { pid: 42283, cpu: "5.1", mem: "1.4", elapsed: "08:12.03", cwd: "/home/dev/api-server", isWebServer: false },
    { pid: 42401, cpu: "11.7", mem: "2.1", elapsed: "03:45.21", cwd: "/home/dev/cli-tool", isWebServer: false },
  ];

  return {
    projects,
    archivedProjectIds: ["proj-docs"],
    sessions,
    archivedSessions,
    todos,
    messages,
    processes,
    transitions: [],
    sessionTokens,
    sessionTimings,
    sessionAgents,
    waitingSessions: [],
    delegatingSessions: ["ses-demo-3"],
    timestamp: now,
  };
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
  const state = DEMO_MODE ? buildDemoState() : await buildState();
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

          const state = DEMO_MODE ? buildDemoState() : await buildState();
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
      const state = DEMO_MODE ? buildDemoState() : await buildState();
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

console.log(`OC Dashboard running at http://localhost:${PORT}${DEMO_MODE ? " (DEMO MODE)" : ""}`);
