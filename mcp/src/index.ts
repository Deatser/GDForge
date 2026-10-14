#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Bridge, DEFAULT_PORT } from "./bridge.js";
import { createServer } from "./server.js";

const port = Number(process.env.GDBUILDER_PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  // stdout carries the MCP protocol, so diagnostics go to stderr
  console.error(`GDBUILDER_PORT must be a port number, got "${process.env.GDBUILDER_PORT}"`);
  process.exit(1);
}

const server = createServer(new Bridge(port));
await server.connect(new StdioServerTransport());
