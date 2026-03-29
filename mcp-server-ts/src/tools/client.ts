import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';

// Constants
const SOCKET_FILENAME = 'tauri-mcp.sock';
// Use /tmp on Unix as a well-known default. The Tauri app and MCP server run as
// separate processes with different TMPDIR values (e.g. GUI vs terminal on macOS),
// so os.tmpdir() can't be relied on to match the Rust side.
const DEFAULT_SOCKET_PATH = os.platform() === 'win32'
  ? `${os.tmpdir()}\\${SOCKET_FILENAME}`
  : `/tmp/${SOCKET_FILENAME}`;

// Connection configuration types
export interface IpcConfig {
  type: 'ipc';
  path?: string;
}

export interface TcpConfig {
  type: 'tcp';
  host: string;
  port: number;
}

export type ConnectionConfig = IpcConfig | TcpConfig;

// Socket client for Tauri IPC/TCP
export class TauriSocketClient {
  private config: ConnectionConfig;
  private client: net.Socket | null = null;
  private isConnected = false;
  private responseCallbacks: Map<string, { resolve: (value: any) => void, reject: (reason: any) => void }> = new Map();
  private buffer = '';
  private reconnectAttempts = 0;
  private authToken: string | undefined;
  private suppressAutoReconnect = false;

  constructor(config?: ConnectionConfig) {
    // Default to IPC with default path
    this.config = config || { type: 'ipc', path: DEFAULT_SOCKET_PATH };
  }

  /**
   * Returns the effective IPC connection path, applying Windows named-pipe
   * rewriting when necessary. Used by both connect() and token discovery so
   * they always agree on the path.
   */
  private getEffectiveIpcPath(): string {
    if (this.config.type !== 'ipc') {
      throw new Error('getEffectiveIpcPath called on non-IPC config');
    }
    let connectionPath = this.config.path || DEFAULT_SOCKET_PATH;
    if (os.platform() === 'win32') {
      connectionPath = `\\\\.\\pipe\\tmp\\${SOCKET_FILENAME}`;
    }
    return connectionPath;
  }

  /**
   * Resolves the auth token from env var or .token file.
   * Called on every connect() so that tokens written after MCP startup
   * are picked up without restarting the process.
   */
  private resolveAuthToken(): string | undefined {
    // First check environment variable
    const envToken = process.env.TAURI_MCP_AUTH_TOKEN;
    if (envToken) {
      return envToken;
    }

    // Then try to read from token file, using the effective connection path
    try {
      let tokenPath: string;
      if (this.config.type === 'tcp') {
        tokenPath = `${os.tmpdir()}/tauri-mcp-${this.config.port}.token`;
      } else {
        const socketPath = this.getEffectiveIpcPath();
        tokenPath = `${socketPath}.token`;
      }
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token) {
          console.error(`Auth token loaded from ${tokenPath}`);
          return token;
        }
      }
    } catch (e) {
      // Token file not found or unreadable, proceed without auth
    }

    return undefined;
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;

    // Re-resolve auth token on every connect attempt so that tokens
    // written after MCP startup (e.g. by a Tauri app starting later)
    // are picked up without restarting the MCP process.
    this.authToken = this.resolveAuthToken();

    return new Promise((resolve, reject) => {
      let connectionOptions: net.NetConnectOpts;
      let connectionInfo: string;

      if (this.config.type === 'tcp') {
        // TCP connection
        connectionOptions = {
          host: this.config.host,
          port: this.config.port
        };
        connectionInfo = `TCP ${this.config.host}:${this.config.port}`;
      } else {
        // IPC connection — use the shared effective path
        const connectionPath = this.getEffectiveIpcPath();
        connectionOptions = { path: connectionPath };
        connectionInfo = `IPC ${connectionPath}`;
      }

      console.error(`Connecting to ${connectionInfo} (attempt ${this.reconnectAttempts + 1})`);
      
      this.client = net.createConnection(connectionOptions, () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        console.error(`Connected to Tauri socket server at ${connectionInfo}`);
        
        // Setup data handler
        this.client!.on('data', (data) => {
          this.handleData(data);
        });
        
        resolve();
      });

      this.client!.on('error', (err) => {
        console.error('Socket connection error:', err);
        this.isConnected = false;
        reject(err);
      });
      
      this.client!.on('close', () => {
        this.isConnected = false;
        console.error('Socket connection closed');

        // Skip auto-reconnect if a managed reconnection (e.g. restart) is in progress
        if (this.suppressAutoReconnect) {
          console.error('Auto-reconnect suppressed (managed reconnection in progress)');
          return;
        }

        // Try to reconnect if not too many attempts
        if (this.reconnectAttempts < 3) {
          this.reconnectAttempts++;
          console.error(`Socket closed. Attempting to reconnect in 2 seconds...`);
          setTimeout(() => {
            this.connect().catch(e => {
              console.error('Reconnection failed:', e);
            });
          }, 2000);
        }
      });
    });
  }
  
  private handleData(data: Buffer) {
    // Accumulate data in the buffer
    this.buffer += data.toString();
    
    console.error(`Received ${data.length} bytes, buffer size: ${this.buffer.length}`);
    
    // Try to find complete JSON responses that end with newline
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const jsonStr = this.buffer.substring(0, newlineIndex);
      this.buffer = this.buffer.substring(newlineIndex + 1);
      
      console.error(`Processing JSON response of ${jsonStr.length} bytes`);
      
      try {
        const response = JSON.parse(jsonStr);

        // Match response to request by ID, with FIFO fallback for backward compatibility
        let callbackId: string | undefined;

        if (response.id && this.responseCallbacks.has(response.id)) {
          // Direct match by request ID
          callbackId = response.id;
        } else {
          // FIFO fallback: oldest pending request (sorted by timestamp prefix)
          const callbackIds = Array.from(this.responseCallbacks.keys());
          if (callbackIds.length > 0) {
            callbackIds.sort();
            callbackId = callbackIds[0];
          }
        }

        if (callbackId) {
          const callback = this.responseCallbacks.get(callbackId);
          if (callback) {
            // Remove the callback before invoking to prevent double calls
            this.responseCallbacks.delete(callbackId);

            if (!response.success) {
              // If the server indicates failure, reject the promise with the error message
              const errorMsg = response.error || 'Command failed without specific error';
              console.error(`Command failed with error: ${errorMsg}`);
              callback.reject(new Error(errorMsg));
            } else {
              callback.resolve(response.data);
            }
          }
        } else {
          console.error('Received response but no callbacks were waiting for it');
        }
      } catch (err) {
        console.error('Error parsing response:', err);
        
        // Log first and last 100 characters of the JSON string for debugging
        if (jsonStr.length > 200) {
          console.error(`JSON starts with: ${jsonStr.substring(0, 100)}...`);
          console.error(`JSON ends with: ...${jsonStr.substring(jsonStr.length - 100)}`);
        } else {
          console.error(`Full JSON: ${jsonStr}`);
        }
        
        // If parsing failed, this could be a partial message
        // so we'll just add it back to the buffer and wait for more data
        // But if it's too large (>10MB), something is wrong, so clear it
        if (this.buffer.length > 10_000_000) {
          console.error('Buffer overflow, clearing buffer');
          this.buffer = '';
          
          // Reject any pending callbacks
          for (const [id, callback] of this.responseCallbacks.entries()) {
            callback.reject(new Error('Buffer overflow'));
            this.responseCallbacks.delete(id);
          }
        }
      }
    }
  }

  async sendCommand(command: string, payload: Record<string, any> | string = {}): Promise<any> {
    if (!this.isConnected) {
      try {
        await this.connect();
      } catch (error) {
        throw new Error(`Failed to connect to socket server: ${(error as Error).message}`);
      }
    }

    if (!this.client) {
      throw new Error('Socket client not initialized');
    }

    return new Promise((resolve, reject) => {
      // Handle both string and object payloads
      let finalPayload: Record<string, any>;
      
      if (typeof payload === 'string') {
        // If payload is a string, send it as a special value that the server will recognize
        finalPayload = { window_label: payload };
        console.error(`Sending string payload as window_label: ${payload}`);
      } else {
        // If payload is an object, use it as is
        finalPayload = payload;
      }
      
      // Generate a unique ID for this request including timestamp for ordering
      const requestId = Date.now().toString() + Math.random().toString(36).substring(2);

      const request = JSON.stringify({
        command,
        payload: finalPayload,
        id: requestId,
        ...(this.authToken ? { authToken: this.authToken } : {})
      }) + '\n';

      this.responseCallbacks.set(requestId, { resolve, reject });

      // Log the request
      console.error(`Sending request: ${command} with payload: ${JSON.stringify(finalPayload)}`);
      
      // Send the request
      this.client!.write(request, (err) => {
        if (err) {
          console.error(`Error writing to socket: ${err.message}`);
          this.responseCallbacks.delete(requestId);
          reject(new Error(`Failed to send request: ${err.message}`));
        }
      });
      
      // Set a timeout to prevent hanging if response never comes
      setTimeout(() => {
        if (this.responseCallbacks.has(requestId)) {
          this.responseCallbacks.delete(requestId);
          reject(new Error('Request timed out after 30 seconds'));
        }
      }, 30000);
    });
  }

  /**
   * Disconnects the current socket and polls for reconnection.
   * Used after intentional operations that kill the server (e.g. restart).
   * Suppresses the automatic reconnect handler to avoid races.
   */
  async waitForReconnect(maxAttempts: number = 15, delayMs: number = 2000): Promise<void> {
    // Suppress the auto-reconnect handler
    this.suppressAutoReconnect = true;

    // Reject all pending callbacks — the server is going away
    for (const [id, callback] of this.responseCallbacks.entries()) {
      callback.reject(new Error('Connection closed for restart'));
      this.responseCallbacks.delete(id);
    }

    // Tear down current socket
    if (this.client) {
      this.client.removeAllListeners();
      this.client.destroy();
      this.client = null;
    }
    this.isConnected = false;
    this.buffer = '';

    // Poll for reconnection
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      console.error(`Reconnect attempt ${attempt}/${maxAttempts}...`);
      try {
        this.reconnectAttempts = 0;
        await this.connect();
        console.error('Reconnected successfully after restart');
        this.suppressAutoReconnect = false;
        return;
      } catch (e) {
        console.error(`Reconnect attempt ${attempt} failed: ${(e as Error).message}`);
      }
    }

    // All attempts exhausted
    this.suppressAutoReconnect = false;
    throw new Error(`Failed to reconnect after ${maxAttempts} attempts (${maxAttempts * delayMs / 1000}s)`);
  }
}

// Create a singleton instance based on environment variables or defaults
function createSocketClient(): TauriSocketClient {
  // Check for environment variables to configure connection
  const connectionType = process.env.TAURI_MCP_CONNECTION_TYPE;
  
  if (connectionType === 'tcp') {
    const host = process.env.TAURI_MCP_TCP_HOST || '127.0.0.1';
    const port = parseInt(process.env.TAURI_MCP_TCP_PORT || '9999', 10);
    
    console.error(`Creating TCP socket client: ${host}:${port}`);
    return new TauriSocketClient({
      type: 'tcp',
      host,
      port
    });
  } else {
    // Default to IPC
    const path = process.env.TAURI_MCP_IPC_PATH;
    console.error(`Creating IPC socket client: ${path || 'default path'}`);
    return new TauriSocketClient({
      type: 'ipc',
      path
    });
  }
}

// Export a singleton instance
export const socketClient = createSocketClient(); 