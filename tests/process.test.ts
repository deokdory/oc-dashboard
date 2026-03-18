import { describe, test, expect } from "bun:test";
import { isMainOpenCodeProcess, getCwd, getOpenCodeProcesses } from "../process";

describe("isMainOpenCodeProcess", () => {
  test('returns true for "opencode"', () => {
    expect(isMainOpenCodeProcess("opencode")).toBe(true);
  });

  test('returns true for "/usr/local/bin/opencode"', () => {
    expect(isMainOpenCodeProcess("/usr/local/bin/opencode")).toBe(true);
  });

  test('returns true for "opencode --debug"', () => {
    expect(isMainOpenCodeProcess("opencode --debug")).toBe(true);
  });

  test('returns false for "node /path/to/pyright"', () => {
    expect(isMainOpenCodeProcess("node /path/to/pyright")).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(isMainOpenCodeProcess("")).toBe(false);
  });

  test('returns false for "opencode-helper"', () => {
    expect(isMainOpenCodeProcess("opencode-helper")).toBe(false);
  });

  test('returns true for full path with args', () => {
    expect(isMainOpenCodeProcess("/home/user/.opencode/bin/opencode web --hostname 0.0.0.0")).toBe(true);
  });
});

describe("getCwd", () => {
  test("returns current working directory for current process", async () => {
    const result = await getCwd(process.pid);
    expect(result).toBe(process.cwd());
  });

  test("returns empty string for non-existent PID", async () => {
    const result = await getCwd(999999);
    expect(result).toBe("");
  });
});

describe("getOpenCodeProcesses", () => {
  test("returns array without crashing", async () => {
    const result = await getOpenCodeProcesses();
    expect(Array.isArray(result)).toBe(true);
  });
});
