#!/usr/bin/env node
/**
 * platen-ui — local preview UI for platen (zero runtime deps beyond the core).
 *
 *   platen-ui [port]        default 4173
 */
import { createUiServer, parsePort } from '../src/ui/server.js';

const port = parsePort(process.argv[2] || '4173');
if (!port) {
  console.error(`platen-ui: invalid port: ${process.argv[2]}`);
  process.exit(2);
}

const server = createUiServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`platen ui running at http://127.0.0.1:${port}`);
});
