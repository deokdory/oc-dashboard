import { describe, test, expect } from "bun:test";
import { isPluginEntryStale } from "../stale";

const NOW = 1_700_000_000_000;
const PLUGIN_STALE = 10 * 60 * 1000;
const DB_STALE = 5 * 60 * 1000;

describe("isPluginEntryStale", () => {
  test("both signals stale → true", () => {
    const pluginTs = NOW - PLUGIN_STALE - 1;
    const dbTime = NOW - DB_STALE - 1;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(true);
  });

  test("plugin fresh, db stale → false (plugin protects)", () => {
    const pluginTs = NOW - 1000;
    const dbTime = NOW - DB_STALE - 1;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(false);
  });

  test("plugin stale, db fresh → false (db protects)", () => {
    const pluginTs = NOW - PLUGIN_STALE - 1;
    const dbTime = NOW - 1000;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(false);
  });

  test("both fresh → false", () => {
    const pluginTs = NOW - 1000;
    const dbTime = NOW - 1000;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(false);
  });

  test("plugin exactly at threshold → not stale", () => {
    const pluginTs = NOW - PLUGIN_STALE;
    const dbTime = NOW - DB_STALE - 1;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(false);
  });

  test("db exactly at threshold → not stale", () => {
    const pluginTs = NOW - PLUGIN_STALE - 1;
    const dbTime = NOW - DB_STALE;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(false);
  });

  test("session with ts=0 (missing) and old db → stale", () => {
    const dbTime = NOW - DB_STALE - 1;
    expect(isPluginEntryStale(NOW, 0, dbTime)).toBe(true);
  });

  test("session not in db (dbTimeUpdated=0) → stale if plugin also stale", () => {
    const pluginTs = NOW - PLUGIN_STALE - 1;
    expect(isPluginEntryStale(NOW, pluginTs, 0)).toBe(true);
  });

  test("home dir collision: both stale → stale regardless of processes", () => {
    const pluginTs = NOW - PLUGIN_STALE - 1;
    const dbTime = NOW - DB_STALE - 1;
    expect(isPluginEntryStale(NOW, pluginTs, dbTime)).toBe(true);
  });
});
