import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTakeScreenshotTool } from "./take_screenshot.js";
import { registerQueryPageTool } from "./query_page.js";
import { registerClickTool } from "./click.js";
import { registerTypeTextTool } from "./type_text.js";
import { registerPressKeyTool } from "./press_key.js";
import { registerMouseActionTool } from "./mouse_action.js";
import { registerNavigateTool } from "./navigate.js";
import { registerExecuteJsTool } from "./execute_js.js";
import { registerManageStorageTool } from "./manage_storage.js";
import { registerManageWindowTool } from "./manage_window.js";
import { registerWaitForTool } from "./wait_for.js";
import { registerRestartAppTool } from "./restart_app.js";
import { registerQueryLogsTool } from "./query_logs.js";
import { registerLogMarkTool } from "./log_mark.js";
import { registerManageIpcTool } from "./manage_ipc.js";
import { socketClient } from "./client.js";

// Re-export the socket client for direct use
export { socketClient } from "./client.js";

// Function to register all tools with a server instance
export function registerAllTools(server: McpServer) {
  registerTakeScreenshotTool(server);
  registerQueryPageTool(server);
  registerClickTool(server);
  registerTypeTextTool(server);
  registerPressKeyTool(server);
  registerMouseActionTool(server);
  registerNavigateTool(server);
  registerExecuteJsTool(server);
  registerManageStorageTool(server);
  registerManageWindowTool(server);
  registerWaitForTool(server);
  registerRestartAppTool(server);
  registerQueryLogsTool(server);
  registerLogMarkTool(server);
  registerManageIpcTool(server);
}

// Function to initialize socket connection (can be awaited before registering tools)
export async function initializeSocket(): Promise<void> {
  try {
    await socketClient.connect();
    console.error("Socket connection initialized successfully");
  } catch (error) {
    console.error("Failed to initialize socket connection:", error);
    // Don't rethrow - allow operation to continue without socket
  }
}
