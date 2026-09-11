import { tool } from "@opencode-ai/plugin/tool";
import { z } from "zod";
import { execSync } from "child_process";
import { cwd } from "process";

export default tool({
  description: "Returns current system information including platform, architecture, working directory, and disk space.",
  args: {},
  execute: async () => {
    const dir = cwd();
    let diskSpace = "unknown";
    try {
      diskSpace = execSync("df -h . | tail -1 | awk '{print $4}'", { encoding: "utf-8" }).trim();
    } catch {}

    return {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      workingDirectory: dir,
      availableDisk: diskSpace,
      uptime: `${Math.floor(process.uptime())}s`,
      memoryUsage: {
        rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      },
    };
  },
});