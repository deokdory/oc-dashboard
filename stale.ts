export const PLUGIN_STALE_MS = 10 * 60 * 1000; // 10 minutes — plugin ts older than this is suspect
export const DB_STALE_MS = 5 * 60 * 1000; // 5 minutes — matches IDLE threshold in classifyStatus()

export function isPluginEntryStale(
  now: number,
  pluginTs: number,
  dbTimeUpdated: number,
): boolean {
  const pluginStale = (now - pluginTs) > PLUGIN_STALE_MS;
  const dbStale = (now - dbTimeUpdated) > DB_STALE_MS;
  return dbStale && pluginStale;
}
