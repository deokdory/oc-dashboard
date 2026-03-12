import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      name TEXT,
      time_updated INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      title TEXT,
      directory TEXT,
      time_updated INTEGER,
      time_archived INTEGER,
      time_created INTEGER,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    )
  `);

  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE todo (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      content TEXT,
      status TEXT,
      priority TEXT,
      position INTEGER
    )
  `);
}

export function createTestDb(): Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

export function createTestDbFile(): {
  db: Database;
  dbPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "oc-test-"));
  const dbPath = join(tmpDir, "test.db");
  const db = new Database(dbPath);
  applySchema(db);
  return {
    db,
    dbPath,
    cleanup: () => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
