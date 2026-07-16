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
    instructions: "Workflow: Start with query_page(mode='app_info') to discover the app. Use query_page(mode='map') for numbered refs, then click or type_text to interact. Use query_page(mode='state') for lightweight checks. Use navigate for URLs, manage_storage for localStorage/cookies, manage_window for window/zoom/devtools. Use execute_js as the universal escape hatch.",
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
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
