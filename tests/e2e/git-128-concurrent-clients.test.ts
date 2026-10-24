/**
 * GIT-128 E2E: two clients on one machine, one store, one project.
 *
 * Each client is its own process owning its own stdio gitmem server — the
 * shape of Claude Code CLI next to the desktop app's server that Brain reaches
 * through the bridge. The push gate is the real recall-check.sh, run as a child
 * of the client process the way Claude Code runs hooks. Nothing is mocked: the
 * defect lives between processes, so an in-process test of it proves nothing.
 *
 * Acceptance (ticket):
 *   1. A recalls and does not confirm; B confirms its own scars; A's gate still blocks
 *   2. A's confirmation survives a later confirm_scars (append, not replace)
 *   3. Each confirmation records its writer
 *   4. A second client never attaches to another client's session; the registry
 *      records the pid that actually serves it
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import readline from "readline";

const ROOT = resolve(__dirname, "../..");
const HOST = join(__dirname, "fixtures/git-128-client-host.mjs");
const HOOK = join(ROOT, "hooks/scripts/recall-check.sh");
const PROJECT = "git128";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

interface Reply { text?: string; serverPid: number; clientPid: number; oldServerPid?: number; ok: boolean; error?: string }

class ClientHost {
  private child: ChildProcess;
  private waiting = new Map<number, (r: Reply) => void>();
  private n = 0;

  constructor(name: string, env: Record<string, string>) {
    this.child = spawn("node", [HOST], {
      env: { ...env, REPRO_DIST: ROOT, REPRO_CLIENT_NAME: name },
      stdio: ["pipe", "pipe", "inherit"],
    });
    readline.createInterface({ input: this.child.stdout! }).on("line", (line) => {
      const m = JSON.parse(line);
      this.waiting.get(m.id)?.(m);
      this.waiting.delete(m.id);
    });
  }

  private send(cmd: Record<string, unknown>): Promise<Reply> {
    return new Promise((res) => {
      const id = ++this.n;
      this.waiting.set(id, res);
      this.child.stdin!.write(JSON.stringify({ id, ...cmd }) + "\n");
    });
  }

  call(tool: string, args: Record<string, unknown>) { return this.send({ op: "call", tool, args }); }
  restart() { return this.send({ op: "restart" }); }
  async gate(): Promise<"BLOCKED" | "allowed"> {
    const r = await this.send({ op: "hook", script: HOOK, input: { tool_name: "Bash", tool_input: { command: "git push origin main" } } });
    return /"decision":\s*"block"/.test(r.text || "") ? "BLOCKED" : "allowed";
  }
  async quit() { await this.send({ op: "quit" }).catch(() => {}); this.child.kill(); }
}

describe("GIT-128: two clients on one machine", () => {
  let home: string;
  let env: Record<string, string>;
  let A: ClientHost, B: ClientHost, C: ClientHost;
  let SA: string, SB: string;

  const session = (id: string) => JSON.parse(readFileSync(join(home, ".gitmem/sessions", id, "session.json"), "utf8"));
  const registry = () => JSON.parse(readFileSync(join(home, ".gitmem/active-sessions.json"), "utf8")).sessions;
  const recallIds = (id: string): string[] =>
    (session(id).surfaced_scars || []).filter((s: any) => s.source === "recall").map((s: any) => s.scar_id);
  const confirm = (h: ClientHost, ids: string[]) =>
    h.call("confirm_scars", {
      confirmations: ids.map((scar_id) => ({
        scar_id,
        decision: "N_A",
        evidence: "N_A: compared the scenario in this scar with the task and it is a different setting entirely.",
      })),
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "gitmem-git128-e2e-"));
    env = {
      ...(process.env as Record<string, string>),
      HOME: home, GITMEM_HOME: home, GITMEM_DIR: "",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", GITMEM_API_KEY: "", GITMEM_TIER: "free",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    };
    delete env.GITMEM_CLIENT_PID;
    A = new ClientHost("client-A", env);
    B = new ClientHost("client-B", env);

    SA = (await A.call("session_start", { project: PROJECT, agent_identity: "cli" })).text!.match(UUID)![0];
    for (const [title, words] of [
      ["Database migrations must be dry-run before push", "migration dry-run supabase db push schema"],
      ["Release tags need human approval before git push", "release tag version bump git push approval"],
      ["Hook scripts must not be edited while they run", "bash hook script edit while running gate"],
    ]) {
      await A.call("create_learning", {
        title, learning_type: "scar", severity: "high", project: PROJECT,
        description: `${title}. Keywords: ${words}.`,
        counter_arguments: [`You might think ${words} is safe — but it is not.`, "You might think this is rare — but it recurs."],
      });
    }
  });

  afterAll(async () => {
    for (const h of [A, B, C]) await h?.quit();
    rmSync(home, { recursive: true, force: true });
  });

  it("A's gate still blocks after B confirms B's own scars (acceptance 1)", async () => {
    await A.call("recall", { plan: "run the supabase db push migration after a dry-run of the schema", project: PROJECT, match_count: 1 });
    expect(recallIds(SA).length).toBeGreaterThan(0);
    expect(await A.gate()).toBe("BLOCKED");

    SB = (await B.call("session_start", { project: PROJECT, agent_identity: "local" })).text!.match(UUID)![0];
    expect(SB).not.toBe(SA);
    await B.call("recall", { plan: "prepare the release tag version bump and git push with approval", project: PROJECT, match_count: 1 });
    expect((await confirm(B, recallIds(SB))).text).toMatch(/ACCEPTED/);

    expect(session(SA).confirmations).toEqual([]);
    expect(await A.gate()).toBe("BLOCKED");
    expect(await B.gate()).toBe("allowed");
  });

  it("A's confirmations survive its next confirm_scars, and a new recall re-arms the gate (acceptance 2)", async () => {
    const first = recallIds(SA);
    expect((await confirm(A, first)).text).toMatch(/ACCEPTED/);
    expect(await A.gate()).toBe("allowed");

    await A.call("recall", { plan: "edit the bash hook script while the gate is running", project: PROJECT, match_count: 1 });
    const added = recallIds(SA).filter((id) => !first.includes(id));
    expect(added.length).toBeGreaterThan(0);
    expect(await A.gate()).toBe("BLOCKED");

    expect((await confirm(A, added)).text).toMatch(/ACCEPTED/);
    const confirmed = session(SA).confirmations.map((c: any) => c.scar_id);
    expect(confirmed).toEqual([...first, ...added]);
    expect(await A.gate()).toBe("allowed");
  });

  it("every confirmation and surfacing names its writer (acceptance 3)", async () => {
    const a = session(SA);
    const b = session(SB);
    for (const c of a.confirmations) expect(c.writer).toMatchObject({ agent: "cli", server_pid: a.pid, client: "client-A/1.0.0" });
    for (const s of a.surfaced_scars) expect(s.writer?.client).toBe("client-A/1.0.0");
    for (const c of b.confirmations) expect(c.writer).toMatchObject({ agent: "local", server_pid: b.pid, client: "client-B/1.0.0" });
    expect(a.owner.client_pid).not.toBe(b.owner.client_pid);
  });

  it("a third client never attaches to A's session; A's restart resumes it (acceptance 4)", async () => {
    const before = session(SA);
    const r = await A.restart(); // A's server dies; its session is orphaned on disk
    C = new ClientHost("client-C", { ...env, CLAUDE_CODE_ENTRYPOINT: "" });

    const cRecall = await C.call("recall", { plan: "run the supabase db push migration after a dry-run of the schema", project: PROJECT, match_count: 3 });
    expect(cRecall.text).toMatch(/No active session/i);
    expect((await confirm(C, recallIds(SA))).text).not.toMatch(/ACCEPTED/);
    expect(session(SA).pid).toBe(before.pid);
    expect(session(SA).confirmations).toEqual(before.confirmations);

    const resumed = await A.call("session_start", { project: PROJECT, agent_identity: "cli" });
    expect(resumed.text!.match(UUID)![0]).toBe(SA);
    const after = session(SA);
    expect(after.pid).toBe(r.serverPid);
    expect(after.pid).not.toBe(r.oldServerPid);
    expect(after.confirmations).toEqual(before.confirmations);
    const entry = registry().find((s: any) => s.session_id === SA);
    expect(entry.pid).toBe(r.serverPid);
    expect(entry.client_pid).toBe(before.owner.client_pid);
  });
});
