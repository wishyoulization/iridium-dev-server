// Reads the dev server's configuration from `.iridiumrc` (JSON) in the current
// directory, or an "iridiumrc" field in package.json.
import { existsSync, readFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const load = () => {
  if (existsSync('.iridiumrc')) return readJson('.iridiumrc');
  if (existsSync('package.json')) return readJson('package.json').iridiumrc ?? {};
  return {};
};

// Paths in the config are relative to the current directory.
export const loadConfig = () => {
  const config = load();
  return {
    notebooks: config.notebooks ?? '.', // where notebooks (.html, legacy .ojs) live
    compiled: config.compiled ?? '.', // where compiled define() modules (.js) go
    static: config.static, // optional extra folder of static assets
    port: config.port ?? 8080,
    host: config.host ?? 'localhost', // the server can write files: local only by default
    localEditor: config.local_editor ?? true, // serve Iridium locally, or from a CDN
    head: config.head ?? '', // extra markup for the page <head>
  };
};

export const hasConfig = () =>
  existsSync('.iridiumrc') || (existsSync('package.json') && 'iridiumrc' in readJson('package.json'));
