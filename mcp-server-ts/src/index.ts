#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { registerAllTools, initializeSocket } from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Create server instance
const server = new McpServer(
  {
    name: "tauri-mcp",
    version,
  },
  {
    instructions: "Workflow: Start with query_page(mode='app_info') to discover the app. Use query_page(mode='map') for numbered refs, then click, type_text, or press_key to interact; use wait_for after actions that load content asynchronously. Use query_page(mode='state') for lightweight checks. Debugging: bracket an action with log_mark, then query_logs({between: id}) to see exactly the Rust + console logs it produced (query_logs mode='summary' first to avoid flooding context). Use manage_ipc to invoke backend commands directly (bisects bugs into frontend vs Rust) and to assert events fire (arm_event → act → captured). Use navigate for URLs, manage_storage for localStorage/cookies, manage_window for window/zoom/devtools, restart_app only in production builds (refuses in dev). Use execute_js as the universal escape hatch.",
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

async function main() {
  try {
    // Connect to the Tauri socket server at startup
    await initializeSocket();
    
    // Register all tools with the server
    registerAllTools(server);
    
    // Connect the server to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Tauri MCP Server running on stdio");

    // Exit when the MCP client goes away — otherwise every closed session
    // leaves an orphaned node process behind.
    transport.onclose = () => {
      console.error("MCP client disconnected (transport closed) — exiting");
      process.exit(0);
    };
    process.stdin.on("end", () => {
      console.error("stdin closed — exiting");
      process.exit(0);
    });
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
