#!/usr/bin/env node
/**
 * GitMem MCP Server Entry Point
 *
 * Run with: npx gitmem server
 * Or: node dist/index.js
 *
 * Environment variables:
 * - SUPABASE_URL: Supabase project URL
 * - SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY: Supabase auth key
 */

import { runServer } from "./server.js";

// Run the server
runServer().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
