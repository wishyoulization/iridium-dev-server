// `iridium-dev-server mcp`: the MCP server over stdio, for assistants such as
// Claude Code. It serves the current directory's notebooks if it has an
// .iridiumrc; otherwise a home folder (IRIDIUM_HOME, or ~/Documents/Iridium,
// created on first use). If a dev server already runs there, this process
// bridges to its /mcp endpoint so every assistant shares the same live
// notebooks; otherwise it starts one. stdout carries the protocol, so all
// logging goes to stderr.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { hasConfig, loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';
import { serverUrl, startServer } from './server.js';

const log = (...args) => console.error('[iridium]', ...args);

const useHome = () => {
  const home = process.env.IRIDIUM_HOME ?? join(homedir(), 'Documents', 'Iridium');
  mkdirSync(join(home, 'notebooks'), { recursive: true });
  const rc = join(home, '.iridiumrc');
  if (!existsSync(rc)) {
    writeFileSync(rc, `${JSON.stringify({ notebooks: './notebooks', compiled: './dist', port: 8090 }, null, 2)}\n`);
  }
  mkdirSync(join(home, 'dist'), { recursive: true });
  process.chdir(home);
};

// Is an Iridium dev server already answering at url?
const isIridium = async (url) => {
  try {
    const response = await fetch(`${url}/__iridium__/iridium.js`, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
};

const bridge = async (url, version) => {
  const client = new Client({ name: 'iridium-stdio-bridge', version });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  const server = new Server(
    { name: 'iridium', version },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => client.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, (request) => client.callTool(request.params));
  await server.connect(new StdioServerTransport());
};

export const runStdio = async ({ version }) => {
  if (!hasConfig()) useHome();
  const config = loadConfig();
  const url = serverUrl(config);
  log(`notebooks in ${join(process.cwd(), config.notebooks)}`);

  if (await isIridium(url)) {
    log(`using the dev server already running at ${url}`);
    await bridge(url, version);
    return;
  }

  const { server, mcpOptions } = startServer(config, { log });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  }).catch((error) => {
    log(`could not start the dev server on port ${config.port}: ${error.message}`);
    process.exit(1);
  });
  await createMcpServer(mcpOptions).connect(new StdioServerTransport());
  // When the assistant goes away, stop serving.
  process.stdin.on('close', () => process.exit(0));
};
