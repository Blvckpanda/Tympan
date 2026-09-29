#!/usr/bin/env node
/**
 * tympan-ui — local preview UI for tympan (zero runtime deps beyond the core).
 *
 *   tympan-ui [port]        default 4173
 */
import { createUiServer, parsePort } from '../src/ui/server.js';

const port = parsePort(process.argv[2] || '4173');
if (!port) {
  console.error(`tympan-ui: invalid port: ${process.argv[2]}`);
  process.exit(2);
}

const server = createUiServer();
server.listen(port, '127.0.0.1', () => {
  console.log(`tympan ui running at http://127.0.0.1:${port}`);
});
