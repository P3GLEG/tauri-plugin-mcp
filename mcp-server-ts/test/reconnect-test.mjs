#!/usr/bin/env node
/**
 * Socket client reconnect regression test
 *
 * Stands up a fake newline-delimited JSON server and drives TauriSocketClient
 * against it. Checks that overlapping connect() calls and reconnects leave
 * exactly one connection, and that responses spanning several 8192 byte
 * socket chunks still resolve. No Tauri app required.
 *
 * Run:  node test/reconnect-test.mjs
 * (from mcp-server-ts/ directory, after `npm run build`)
 */

import net from "node:net";
import { TauriSocketClient } from "../build/tools/client.js";

// Large enough to span three socket chunks, which is what a duplicated data
// listener corrupts. Anything under 8192 bytes arrives in one chunk and passes
// even when the client is in the broken state.
const PAYLOAD_BYTES = 20000;
// The size the app's socket writes arrive in, and the boundary a duplicated
// data listener corrupts. Loopback TCP would otherwise deliver the whole
// response in one event and hide the bug.
const CHUNK_BYTES = 8192;
const COMMAND_TIMEOUT_MS = 5000;
// The client's auto-reconnect fires 2 seconds after a close.
const RECONNECT_DELAY_MS = 2500;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fake app socket ───────────────────────────────────────────────────

const liveSockets = new Set();
let peakConnections = 0;

const server = net.createServer((socket) => {
  liveSockets.add(socket);
  peakConnections = Math.max(peakConnections, liveSockets.size);
  socket.on("close", () => liveSockets.delete(socket));
  socket.on("error", () => {});

  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.substring(0, newlineIndex);
      buffer = buffer.substring(newlineIndex + 1);
      const request = JSON.parse(line);
      const response =
        JSON.stringify({
          success: true,
          id: request.id,
          data: { payload: "x".repeat(PAYLOAD_BYTES) },
        }) + "\n";

      // Write in chunks, spaced out so each one lands as its own data event.
      for (let offset = 0; offset < response.length; offset += CHUNK_BYTES) {
        if (socket.destroyed) return;
        socket.write(response.substring(offset, offset + CHUNK_BYTES));
        await sleep(5);
      }
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const client = new TauriSocketClient({ type: "tcp", host: "127.0.0.1", port });

// ── 1. Overlapping connect() calls share one socket ───────────────────

await Promise.all([client.connect(), client.connect(), client.connect()]);
// Let the server finish accepting anything the client opened.
await sleep(100);
check(
  "three concurrent connect() calls open one connection",
  peakConnections === 1,
  `server saw ${peakConnections} concurrent connections`
);

let response = await client.sendCommand("ping", {}, COMMAND_TIMEOUT_MS).catch((e) => e);
check(
  "multi-chunk response resolves after concurrent connects",
  response?.payload?.length === PAYLOAD_BYTES,
  response instanceof Error ? response.message : `got ${JSON.stringify(response).slice(0, 80)}`
);

// ── 2. A command lost to a drop fails fast instead of hanging ─────────

for (const socket of liveSockets) socket.destroy();

const startedAt = Date.now();
response = await client.sendCommand("ping", {}, COMMAND_TIMEOUT_MS).catch((e) => e);
const elapsed = Date.now() - startedAt;
check(
  "a command in flight when the connection drops rejects promptly",
  response instanceof Error && elapsed < 1000,
  response instanceof Error
    ? `rejected after ${elapsed}ms: ${response.message}`
    : "the command resolved, so it was answered by a socket that had closed"
);

// The auto-reconnect timer from the drop above fires while that command's own
// connection is already up. It must not open a second socket.
await sleep(RECONNECT_DELAY_MS);
check(
  "the auto-reconnect timer does not add a second connection",
  peakConnections === 1,
  `server saw ${peakConnections} concurrent connections`
);

// ── 3. The same holds after the auto-reconnect owns the connection ────

for (const socket of liveSockets) socket.destroy();
await sleep(RECONNECT_DELAY_MS);

response = await client.sendCommand("ping", {}, COMMAND_TIMEOUT_MS).catch((e) => e);
check(
  "multi-chunk response resolves after an auto-reconnect",
  response?.payload?.length === PAYLOAD_BYTES,
  response instanceof Error ? response.message : `got ${JSON.stringify(response).slice(0, 80)}`
);

console.log(failures === 0 ? "\nAll reconnect checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
