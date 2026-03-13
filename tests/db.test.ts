import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createTestDbFile } from "./helpers";
import {
  getProjects,
  getAllActiveSessions,
  getActiveSessions,
  batchGetSessionTodos,
  batchGetLastMessages,
  batchGetTokenSummary,
  getSubAgentCounts,
  getSubAgentSessions,
  getSessionTodos,
  getLastMessage,
} from "../db";

let db: Database;
let originalDbPath: string | undefined;
let cleanup: () => void;

beforeEach(() => {
  originalDbPath = process.env.DB_PATH;
  const result = createTestDbFile();
  db = result.db;
  process.env.DB_PATH = result.dbPath;
  cleanup = result.cleanup;
});

afterEach(() => {
  if (originalDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = originalDbPath;
  }
  cleanup();
});

describe("getProjects", () => {
  test("returns projects with derived displayName", () => {
    db.run("INSERT INTO project VALUES (?, ?, ?, ?)", [
      "p1",
      "/home/user/myproject",
      null,
      2000,
    ]);
    db.run("INSERT INTO project VALUES (?, ?, ?, ?)", [
      "p2",
      "/home/user/another",
      "Custom Name",
      1000,
    ]);

    const projects = getProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0].displayName).toBe("myproject");
    expect(projects[1].displayName).toBe("Custom Name");
  });

  test("returns empty array when no projects", () => {
    expect(getProjects()).toEqual([]);
  });

  test("deduplicates colliding displayNames with id suffix", () => {
    db.run("INSERT INTO project VALUES (?, ?, ?, ?)", [
      "id_AAAA",
      "/home/user/myproject",
      null,
      2000,
    ]);
    db.run("INSERT INTO project VALUES (?, ?, ?, ?)", [
      "id_BBBB",
      "/other/myproject",
      null,
      1000,
    ]);

    const projects = getProjects();
    expect(projects).toHaveLength(2);
    expect(projects[0].displayName).toBe("myproject (AAAA)");
    expect(projects[1].displayName).toBe("myproject (BBBB)");
  });
});

describe("getAllActiveSessions", () => {
  test("returns non-archived main sessions", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s1",
      "p1",
      null,
      "Session 1",
      "/dir",
      now,
      null,
      now,
      5,
      3,
      2,
    ]);

    const sessions = getAllActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
    expect(sessions[0].title).toBe("Session 1");
    expect(sessions[0].summaryAdditions).toBe(5);
  });

  test("excludes archived sessions", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s1",
      "p1",
      null,
      "Active",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s2",
      "p1",
      null,
      "Archived",
      "/dir",
      now,
      now,
      now,
      null,
      null,
      null,
    ]);

    const sessions = getAllActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
  });

  test("excludes sub-agent sessions (parent_id IS NOT NULL)", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s1",
      "p1",
      null,
      "Main",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s2",
      "p1",
      "s1",
      "Sub-agent",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);

    const sessions = getAllActiveSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
  });
});

describe("getActiveSessions", () => {
  test("filters by projectId", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s1",
      "proj-a",
      null,
      "A session",
      "/a",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "s2",
      "proj-b",
      null,
      "B session",
      "/b",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);

    const sessions = getActiveSessions("proj-a");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBe("proj-a");
  });
});

describe("batchGetSessionTodos", () => {
  test("returns todos grouped by sessionId", () => {
    db.run("INSERT INTO todo VALUES (?,?,?,?,?,?)", [
      "t1",
      "s1",
      "Task A",
      "pending",
      "high",
      0,
    ]);
    db.run("INSERT INTO todo VALUES (?,?,?,?,?,?)", [
      "t2",
      "s1",
      "Task B",
      "completed",
      "low",
      1,
    ]);
    db.run("INSERT INTO todo VALUES (?,?,?,?,?,?)", [
      "t3",
      "s2",
      "Task C",
      "in_progress",
      "medium",
      0,
    ]);

    const result = batchGetSessionTodos(["s1", "s2"]);
    expect(result["s1"]).toHaveLength(2);
    expect(result["s2"]).toHaveLength(1);
    expect(result["s1"][0].content).toBe("Task A");
    expect(result["s1"][0].priority).toBe("high");
    expect(result["s2"][0].status).toBe("in_progress");
  });

  test("returns empty object for empty input", () => {
    expect(batchGetSessionTodos([])).toEqual({});
  });
});

describe("getSessionTodos", () => {
  test("returns todos ordered by position", () => {
    db.run("INSERT INTO todo VALUES (?,?,?,?,?,?)", [
      "t1",
      "s1",
      "Second",
      "pending",
      "low",
      1,
    ]);
    db.run("INSERT INTO todo VALUES (?,?,?,?,?,?)", [
      "t2",
      "s1",
      "First",
      "completed",
      "high",
      0,
    ]);

    const todos = getSessionTodos("s1");
    expect(todos).toHaveLength(2);
    expect(todos[0].content).toBe("First");
    expect(todos[1].content).toBe("Second");
  });
});

describe("batchGetLastMessages", () => {
  test("returns latest message per session with text preview", () => {
    db.run("INSERT INTO message VALUES (?,?,?,?)", [
      "m1",
      "s1",
      1000,
      JSON.stringify({ role: "user", agent: null }),
    ]);
    db.run("INSERT INTO message VALUES (?,?,?,?)", [
      "m2",
      "s1",
      2000,
      JSON.stringify({ role: "assistant", agent: "build" }),
    ]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", [
      "pt1",
      "m2",
      JSON.stringify({ type: "text", text: "Hello world response" }),
      2000,
    ]);

    const result = batchGetLastMessages(["s1"]);
    expect(result["s1"]).toBeDefined();
    expect(result["s1"].last?.role).toBe("assistant");
    expect(result["s1"].last?.agent).toBe("build");
    expect(result["s1"].last?.textPreview).toBe("Hello world response");
    expect(result["s1"].user?.role).toBe("user");
  });

  test("returns empty object for empty input", () => {
    expect(batchGetLastMessages([])).toEqual({});
  });
});

describe("getLastMessage", () => {
  test("returns null for session with no messages", () => {
    expect(getLastMessage("nonexistent")).toBeNull();
  });
});

describe("batchGetTokenSummary", () => {
  test("sums tokens per session from step-finish parts", () => {
    db.run("INSERT INTO message VALUES (?,?,?,?)", [
      "m1",
      "s1",
      1000,
      JSON.stringify({ role: "assistant" }),
    ]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", [
      "pt1",
      "m1",
      JSON.stringify({
        type: "step-finish",
        tokens: { input: 100, output: 50 },
      }),
      1000,
    ]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", [
      "pt2",
      "m1",
      JSON.stringify({
        type: "step-finish",
        tokens: { input: 200, output: 75 },
      }),
      1001,
    ]);

    const result = batchGetTokenSummary(["s1"]);
    expect(result["s1"].totalInput).toBe(300);
    expect(result["s1"].totalOutput).toBe(125);
  });

  test("returns empty object for empty input", () => {
    const result = batchGetTokenSummary([]);
    expect(Object.keys(result).length).toBe(0);
  });

  test("returns no entry when no step-finish parts exist", () => {
    db.run("INSERT INTO message VALUES (?,?,?,?)", [
      "m1",
      "s1",
      1000,
      JSON.stringify({ role: "assistant" }),
    ]);
    db.run("INSERT INTO part VALUES (?,?,?,?)", [
      "pt1",
      "m1",
      JSON.stringify({ type: "text", text: "hello" }),
      1000,
    ]);

    const result = batchGetTokenSummary(["s1"]);
    expect(result["s1"]).toBeUndefined();
  });
});

describe("getSubAgentCounts", () => {
  test("counts total and active sub-agents", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "parent1",
      "p1",
      null,
      "Parent",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "sub1",
      "p1",
      "parent1",
      "Sub active",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "sub2",
      "p1",
      "parent1",
      "Sub stale",
      "/dir",
      now - 20_000,
      null,
      now,
      null,
      null,
      null,
    ]);

    const counts = getSubAgentCounts(["parent1"]);
    expect(counts["parent1"].total).toBe(2);
    expect(counts["parent1"].active).toBe(1);
  });

  test("returns empty object for empty input", () => {
    expect(getSubAgentCounts([])).toEqual({});
  });

  test("excludes archived sub-agents from total", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "sub-archived",
      "p1",
      "parent1",
      "Archived sub",
      "/dir",
      now,
      now,
      now,
      null,
      null,
      null,
    ]);

    const counts = getSubAgentCounts(["parent1"]);
    expect(counts["parent1"]).toBeUndefined();
  });
});

describe("getSubAgentSessions", () => {
  test("returns active sub-agents and parses agent name from title", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "sub1",
      "p1",
      "parent1",
      "Explore task (@explore subagent)",
      "/dir",
      now,
      null,
      now,
      null,
      null,
      null,
    ]);

    const subs = getSubAgentSessions("parent1");
    expect(subs).toHaveLength(1);
    expect(subs[0].id).toBe("sub1");
    expect(subs[0].agentName).toBe("explore");
    expect(subs[0].title).toBe("Explore task");
  });

  test("excludes inactive sub-agents (>10s old)", () => {
    const now = Date.now();
    db.run("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
      "sub-old",
      "p1",
      "parent1",
      "Old task",
      "/dir",
      now - 20_000,
      null,
      now,
      null,
      null,
      null,
    ]);

    expect(getSubAgentSessions("parent1")).toHaveLength(0);
  });
});
