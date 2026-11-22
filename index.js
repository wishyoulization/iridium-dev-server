#!/usr/bin/env node
// iridium-dev-server            edit notebooks in Iridium (live, with MCP at /mcp)
// iridium-dev-server -build     compile every notebook to a define() module
// iridium-dev-server mcp        MCP over stdio, for assistants (see lib/mcp-stdio.js)
import { createRequire } from 'node:module';
import { loadConfig } from './lib/config.js';
import { compileAll, startServer } from './lib/server.js';
import { runStdio } from './lib/mcp-stdio.js';

const args = process.argv.slice(2);
const { version } = createRequire(import.meta.url)('./package.json');

if (args[0] === 'mcp') await runStdio({ version });
else if (args.some((arg) => arg === '-build' || arg === '--build')) compileAll(loadConfig());
else startServer(loadConfig());
