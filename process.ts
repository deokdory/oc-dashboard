import { $ } from "bun";
import { readlink } from "fs/promises";

export interface OcProcess {
  pid: number;
  cpu: string;
  mem: string;
  elapsed: string;
  cwd: string;
  isWebServer: boolean;
}

export function isOpenCodeWebServer(command: string): boolean {
  const trimmed = command.trim();
  const bin = trimmed.split(/\s+/)[0];
  return (bin === "opencode" || bin.endsWith("/opencode")) && trimmed.includes("opencode web");
}

export function isMainOpenCodeProcess(command: string): boolean {
  const trimmed = command.trim();
  
  if (
    trimmed.includes("opencode web") ||
    trimmed.includes("pyright") ||
    trimmed.includes("langserver") ||
    trimmed.includes("node") ||
    trimmed.includes("python")
  ) {
    return false;
  }
  
  if (trimmed === "opencode") return true;
  if (trimmed.endsWith("/opencode")) return true;
  if (/^opencode\s+/.test(trimmed)) return true;
  if (/\/opencode\s+/.test(trimmed)) return true;
  
  return false;
}

export async function getCwd(pid: number): Promise<string> {
  if (process.platform === "linux") {
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      return cwd.replace(/ \(deleted\)$/, "");
    } catch {
      return "";
    }
  } else if (process.platform === "darwin") {
    try {
      // macOS: lsof -p PID -a -d cwd -Fn
      const out = await $`lsof -p ${pid} -a -d cwd -Fn`.text();
      // Output format: "n/path/to/cwd"
      const match = out.split("\n").find((l) => l.startsWith("n"));
      return match ? match.slice(1).trim() : "";
    } catch {
      return "";
    }
  } else {
    console.warn("[process] unsupported platform:", process.platform);
    return "";
  }
}

export async function getOpenCodeProcesses(): Promise<OcProcess[]> {
  const psOutput = await $`ps aux`.text();
  const lines = psOutput.trim().split("\n").slice(1); // Remove header
  
  const processes: OcProcess[] = [];
  
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    
    // ps aux columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND...
    // COMMAND starts at index 10
    if (cols.length < 11) continue;
    
    const command = cols.slice(10).join(" ");
    const webServer = isOpenCodeWebServer(command);
    
    if (!webServer && !isMainOpenCodeProcess(command)) continue;
    
    const pid = parseInt(cols[1], 10);
    if (isNaN(pid)) continue;
    
    const cpu = cols[2];
    const mem = cols[3];
    const elapsed = cols[9]; // TIME column
    const cwd = await getCwd(pid);
    
    processes.push({ pid, cpu, mem, elapsed, cwd, isWebServer: webServer });
  }
  
  return processes;
}
