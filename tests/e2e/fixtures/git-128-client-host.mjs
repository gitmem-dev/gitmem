// GIT-128 E2E fixture. One "client" process: owns one stdio gitmem server, as
// a Claude Code CLI or the desktop app does. Commands arrive as JSON lines on
// stdin, results go out as JSON lines on stdout. Hooks are spawned as children
// of this process, the way Claude Code spawns them, so they share the client's
// process ancestry. REPRO_DIST is the package root (dist/, node_modules/).
//   {"id":1,"op":"call","tool":"recall","args":{...}}
//   {"id":2,"op":"hook","script":"/path/recall-check.sh","input":{...}}
//   {"id":3,"op":"restart"}      kill the server, start a fresh one (MCP reconnect)
//   {"id":4,"op":"info"}
import path from "path";
import readline from "readline";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const DIST = process.env.REPRO_DIST; // directory holding dist/index.js and node_modules
const require = createRequire(path.join(DIST, "package.json"));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const NAME = process.env.REPRO_CLIENT_NAME || "repro-client";
let client, transport;

async function start() {
  transport = new StdioClientTransport({
    command: "node",
    args: [path.join(DIST, "dist/index.js")],
    env: { ...process.env, NO_COLOR: "1" },
    stderr: "ignore",
  });
  client = new Client({ name: NAME, version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
}

const serverPid = () => transport?._process?.pid ?? null;

await start();
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  const cmd = JSON.parse(line);
  const out = { id: cmd.id, serverPid: serverPid(), clientPid: process.pid };
  try {
    if (cmd.op === "call") {
      const res = await client.callTool({ name: cmd.tool, arguments: cmd.args || {} });
      out.text = res.content?.map((c) => c.text ?? "").join("\n") ?? "";
    } else if (cmd.op === "hook") {
      const r = spawnSync("bash", [cmd.script], { input: JSON.stringify(cmd.input), env: process.env, encoding: "utf8" });
      out.text = r.stdout;
      out.stderr = r.stderr;
      out.status = r.status;
    } else if (cmd.op === "restart") {
      const old = serverPid();
      try { process.kill(old, "SIGKILL"); } catch {}
      try { await client.close(); } catch {}
      await new Promise((r) => setTimeout(r, 300));
      await start();
      out.oldServerPid = old;
      out.serverPid = serverPid();
    } else if (cmd.op === "quit") {
      try { await client.close(); } catch {}
      process.stdout.write(JSON.stringify(out) + "\n");
      process.exit(0);
    }
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = String(e?.message || e);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
}
