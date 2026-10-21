#!/usr/bin/env node
// CLI entry: web-terminal [options]  → runs ../server.mjs
import(new URL('../server.mjs', import.meta.url))
