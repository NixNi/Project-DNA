import { tool } from "@opencode-ai/plugin/tool";
import { z } from "zod";

export default tool({
  description: "Returns a greeting message with the current timestamp.",
  args: {
    name: z.string().optional().describe("Name to greet"),
  },
  execute: async (args) => {
    const name = args.name || "World";
    const data = {
      message: `Hello, ${name}!`,
      timestamp: new Date().toISOString(),
    };
    return {
      output: JSON.stringify(data, null, 2),
      metadata: data,
    };
  },
});