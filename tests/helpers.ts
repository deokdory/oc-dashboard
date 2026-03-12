import { Database } from "bun:sqlite";

export function createTestDb(): Database {
  const db = new Database(":memory:");

  // Create project table
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      name TEXT,
      time_updated INTEGER
    )
  `);

  // Create session table
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

  // Create message table
  db.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    )
  `);

  // Create part table
  db.exec(`
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
    )
  `);

  // Create todo table
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

  return db;
}
