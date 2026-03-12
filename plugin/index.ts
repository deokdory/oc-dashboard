import type { Plugin } from "@opencode-ai/plugin";
import { writeFileSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const STATE_PATH = join(
  process.env.HOME || "",
  ".local",
  "share",
  "opencode",
  "active-sessions.json",
);

interface ActiveEntry {
  status: "busy" | "retry";
  ts: number;
  attempt?: number;
}

function readState(): Record<string, ActiveEntry> {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeState(state: Record<string, ActiveEntry>) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state), "utf-8");
}

const plugin: Plugin = async () => ({
  event: async ({ event }) => {
    if (event.type === "session.status") {
      const { sessionID, status } = event.properties;
      const state = readState();

      if (status.type === "idle") {
        delete state[sessionID];
      } else {
        state[sessionID] = {
          status: status.type,
          ts: Date.now(),
          ...(status.type === "retry" ? { attempt: (status as any).attempt } : {}),
        };
      }

      writeState(state);
    }

    if (event.type === "session.deleted") {
      const sessionID = (event.properties as any).info?.id;
      if (sessionID) {
        const state = readState();
        delete state[sessionID];
        writeState(state);
      }
    }
  },
});

export default plugin;
