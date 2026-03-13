import { Database } from "bun:sqlite";

export interface Project {
  id: string;
  worktree: string;
  displayName: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  timeUpdated: number; // milliseconds
  status: "ACTIVE" | "RECENT" | "IDLE";
  summaryAdditions: number | null;
  summaryDeletions: number | null;
  summaryFiles: number | null;
}

export interface Todo {
  sessionId: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
  position: number;
}

export interface SubAgentSession {
  id: string;
  title: string;
  agentName: string | null;
  status: "ACTIVE" | "RECENT" | "IDLE";
  timeUpdated: number;
}

export interface MessagePreview {
  role: string;
  agent: string | null;
  textPreview: string | null;
  timeCreated: number;
}

export interface SessionMessages {
  last: MessagePreview | null;
  user: MessagePreview | null;
}

export interface TokenSummary {
  totalInput: number;
  totalOutput: number;
}

function openDb(): Database {
  const dbPath =
    process.env.DB_PATH ??
    `${process.env.HOME}/.local/share/opencode/opencode.db`;
  try {
    const db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    return db;
  } catch (err) {
    throw new Error(
      `Database unavailable: ${dbPath} — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function getProjects(): Project[] {
  try {
    const db = openDb();
    try {
      const rows = db
        .query<
          { id: string; worktree: string; name: string | null },
          []
        >("SELECT id, worktree, name FROM project ORDER BY time_updated DESC")
        .all();

      const projects: Project[] = rows.map((r) => ({
        id: r.id,
        worktree: r.worktree,
        displayName: deriveDisplayName(r.worktree, r.name),
      }));

      // Deduplicate displayNames — append last 4 chars of id on collision
      const seen = new Map<string, number>();
      for (const p of projects) {
        seen.set(p.displayName, (seen.get(p.displayName) ?? 0) + 1);
      }
      for (const p of projects) {
        if ((seen.get(p.displayName) ?? 0) > 1) {
          p.displayName = `${p.displayName} (${p.id.slice(-4)})`;
        }
      }

      return projects;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getProjects error:", err);
    return [];
  }
}

function deriveDisplayName(worktree: string, name: string | null): string {
  if (worktree === "/") return "🏠 Home";
  if (name) return name;
  return worktree.split("/").filter(Boolean).pop() ?? worktree;
}

export function getActiveSessions(
  projectId: string,
  limit = 5,
): Session[] {
  try {
    const db = openDb();
    try {
      const rows = db
        .query<
          {
            id: string;
            project_id: string;
            title: string;
            directory: string;
            time_updated: number;
            summary_additions: number | null;
            summary_deletions: number | null;
            summary_files: number | null;
          },
          [string, number]
        >(
          `SELECT id, project_id, title, directory, time_updated,
                  summary_additions, summary_deletions, summary_files
           FROM session
           WHERE project_id = ? AND time_archived IS NULL AND parent_id IS NULL
           ORDER BY time_updated DESC
           LIMIT ?`,
        )
        .all(projectId, limit);

      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        directory: r.directory,
        timeUpdated: r.time_updated,
        status: classifyStatus(now, r.time_updated),
        summaryAdditions: r.summary_additions,
        summaryDeletions: r.summary_deletions,
        summaryFiles: r.summary_files,
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getActiveSessions error:", err);
    return [];
  }
}

export function getAllActiveSessions(limit = 100): Session[] {
  try {
    const db = openDb();
    try {
      const rows = db
        .query<
          {
            id: string;
            project_id: string;
            title: string;
            directory: string;
            time_updated: number;
            summary_additions: number | null;
            summary_deletions: number | null;
            summary_files: number | null;
          },
          [number]
        >(
          `SELECT id, project_id, title, directory, time_updated,
                  summary_additions, summary_deletions, summary_files
           FROM session
           WHERE time_archived IS NULL AND parent_id IS NULL
           ORDER BY time_updated DESC
           LIMIT ?`,
        )
        .all(limit);

      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        title: r.title,
        directory: r.directory,
        timeUpdated: r.time_updated,
        status: classifyStatus(now, r.time_updated),
        summaryAdditions: r.summary_additions,
        summaryDeletions: r.summary_deletions,
        summaryFiles: r.summary_files,
      }));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getAllActiveSessions error:", err);
    return [];
  }
}

function classifyStatus(
  now: number,
  timeUpdated: number,
): "ACTIVE" | "RECENT" | "IDLE" {
  const delta = now - timeUpdated;
  if (delta < 10_000) return "ACTIVE";
  if (delta < 300_000) return "RECENT";
  return "IDLE";
}

export function getSubAgentCounts(
  sessionIds: string[],
): Record<string, { total: number; active: number }> {
  if (sessionIds.length === 0) return {};
  try {
    const db = openDb();
    try {
      const now = Date.now();
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .query<
          { parent_id: string; total: number; active: number },
          [number, ...string[]]
        >(
          `SELECT parent_id,
                  COUNT(*) as total,
                  SUM(CASE WHEN ? - time_updated < 10000 THEN 1 ELSE 0 END) as active
           FROM session
           WHERE parent_id IN (${placeholders})
             AND time_archived IS NULL
           GROUP BY parent_id`,
        )
        .all(now, ...sessionIds);

      const result: Record<string, { total: number; active: number }> = {};
      for (const r of rows) {
        result[r.parent_id] = { total: r.total, active: r.active };
      }
      return result;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getSubAgentCounts error:", err);
    return {};
  }
}

export function getSubAgentSessions(parentId: string): SubAgentSession[] {
  try {
    const db = openDb();
    try {
      const now = Date.now();
      const rows = db
        .query<
          { id: string; title: string; time_updated: number },
          [string, number]
        >(
          `SELECT id, title, time_updated
           FROM session
           WHERE parent_id = ?
             AND time_archived IS NULL
             AND ? - time_updated < 10000
           ORDER BY time_updated DESC
           LIMIT 30`,
        )
        .all(parentId, now);

      return rows.map((r) => {
        const agentMatch = r.title.match(/\s*\(@([\w-]+)\s+subagent\)$/);
        const agentName = agentMatch ? agentMatch[1] : null;
        const cleanTitle = agentMatch
          ? r.title.slice(0, r.title.length - agentMatch[0].length).trim()
          : r.title;
        return {
          id: r.id,
          title: cleanTitle,
          agentName,
          status: classifyStatus(now, r.time_updated),
          timeUpdated: r.time_updated,
        };
      });
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getSubAgentSessions error:", err);
    return [];
  }
}

export function getTokenSummary(sessionIds: string[]): TokenSummary {
  if (sessionIds.length === 0) return { totalInput: 0, totalOutput: 0 };
  try {
    const db = openDb();
    try {
      const placeholders = sessionIds.map(() => "?").join(",");
      const row = db
        .query<
          { totalInput: number | null; totalOutput: number | null },
          string[]
        >(
          `SELECT
             COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) as totalInput,
             COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as totalOutput
           FROM part
           WHERE message_id IN (
             SELECT id FROM message WHERE session_id IN (${placeholders})
           )
             AND json_extract(data, '$.type') = 'step-finish'`,
        )
        .get(...sessionIds);
      return {
        totalInput: row?.totalInput ?? 0,
        totalOutput: row?.totalOutput ?? 0,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getTokenSummary error:", err);
    return { totalInput: 0, totalOutput: 0 };
  }
}

export function getSessionTodos(sessionId: string): Todo[] {
  try {
    const db = openDb();
    try {
      return db
        .query<
          {
            session_id: string;
            content: string;
            status: "pending" | "in_progress" | "completed";
            priority: "high" | "medium" | "low";
            position: number;
          },
          [string]
        >(
          `SELECT session_id, content, status, priority, position
           FROM todo
           WHERE session_id = ?
           ORDER BY position ASC`,
        )
        .all(sessionId)
        .map((r) => ({
          sessionId: r.session_id,
          content: r.content,
          status: r.status,
          priority: r.priority,
          position: r.position,
        }));
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getSessionTodos error:", err);
    return [];
  }
}

export function batchGetSessionTodos(
  sessionIds: string[],
): Record<string, Todo[]> {
  if (sessionIds.length === 0) return {};
  try {
    const db = openDb();
    try {
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .query<
          {
            session_id: string;
            content: string;
            status: "pending" | "in_progress" | "completed";
            priority: "high" | "medium" | "low";
            position: number;
          },
          string[]
        >(
          `SELECT session_id, content, status, priority, position
           FROM todo
           WHERE session_id IN (${placeholders})
           ORDER BY session_id, position ASC`,
        )
        .all(...sessionIds);

      const result: Record<string, Todo[]> = {};
      for (const r of rows) {
        if (!result[r.session_id]) result[r.session_id] = [];
        result[r.session_id].push({
          sessionId: r.session_id,
          content: r.content,
          status: r.status,
          priority: r.priority,
          position: r.position,
        });
      }
      return result;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] batchGetSessionTodos error:", err);
    return {};
  }
}

export function getLastMessage(sessionId: string): MessagePreview | null {
  try {
    const db = openDb();
    try {
      const msg = db
        .query<
          {
            id: string;
            role: string;
            agent: string | null;
            time_created: number;
          },
          [string]
        >(
          `SELECT id,
                  json_extract(data, '$.role') as role,
                  json_extract(data, '$.agent') as agent,
                  time_created
           FROM message
           WHERE session_id = ?
           ORDER BY time_created DESC
           LIMIT 1`,
        )
        .get(sessionId);

      if (!msg) return null;

      const part = db
        .query<{ text: string | null }, [string]>(
          `SELECT substr(json_extract(data, '$.text'), 1, 100) as text
           FROM part
           WHERE message_id = ?
             AND json_extract(data, '$.type') = 'text'
           ORDER BY time_created DESC
           LIMIT 1`,
        )
        .get(msg.id);

      return {
        role: msg.role,
        agent: msg.agent,
        textPreview: part?.text ?? null,
        timeCreated: msg.time_created,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] getLastMessage error:", err);
    return null;
  }
}

export function batchGetLastMessages(
  sessionIds: string[],
): Record<string, SessionMessages> {
  if (sessionIds.length === 0) return {};
  try {
    const db = openDb();
    try {
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .query<
          {
            session_id: string;
            kind: string;
            role: string;
            agent: string | null;
            time_created: number;
            text_preview: string | null;
          },
          string[]
        >(
          `SELECT m.session_id,
                  'last' as kind,
                  json_extract(m.data, '$.role') as role,
                  json_extract(m.data, '$.agent') as agent,
                  m.time_created,
                  (SELECT substr(json_extract(p.data, '$.text'), 1, 200)
                   FROM part p
                   WHERE p.message_id = m.id
                     AND json_extract(p.data, '$.type') = 'text'
                   ORDER BY p.time_created DESC LIMIT 1) as text_preview
           FROM message m
           WHERE m.session_id IN (${placeholders})
             AND m.time_created = (
               SELECT MAX(m2.time_created)
               FROM message m2
               WHERE m2.session_id = m.session_id
             )
           UNION ALL
           SELECT m.session_id,
                  'user' as kind,
                  json_extract(m.data, '$.role') as role,
                  json_extract(m.data, '$.agent') as agent,
                  m.time_created,
                  (SELECT substr(json_extract(p.data, '$.text'), 1, 200)
                   FROM part p
                   WHERE p.message_id = m.id
                     AND json_extract(p.data, '$.type') = 'text'
                   ORDER BY p.time_created DESC LIMIT 1) as text_preview
           FROM message m
           WHERE m.session_id IN (${placeholders})
             AND json_extract(m.data, '$.role') = 'user'
             AND m.time_created = (
               SELECT MAX(m3.time_created)
               FROM message m3
               WHERE m3.session_id = m.session_id
                 AND json_extract(m3.data, '$.role') = 'user'
             )`,
        )
        .all(...sessionIds, ...sessionIds);

      const result: Record<string, SessionMessages> = {};
      for (const r of rows) {
        if (!result[r.session_id]) {
          result[r.session_id] = { last: null, user: null };
        }
        const preview: MessagePreview = {
          role: r.role,
          agent: r.agent,
          textPreview: r.text_preview,
          timeCreated: r.time_created,
        };
        if (r.kind === "last") {
          result[r.session_id].last = preview;
        } else {
          result[r.session_id].user = preview;
        }
      }
      return result;
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn("[db] batchGetLastMessages error:", err);
    return {};
  }
}
