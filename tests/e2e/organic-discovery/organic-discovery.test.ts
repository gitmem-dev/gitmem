/**
 * E2E Tests: Organic Discovery — Multi-session gitmem adoption measurement
 *
 * Tests whether agents organically discover and adopt gitmem with varying
 * nudge prompts and hook configurations. Each config runs a 3-session chain:
 *   1. Onboarding — deliver nudge (or control task), agent may discover gitmem
 *   2. Real task — fix a bug, no mention of gitmem (tests persistence)
 *   3. Real task — add a feature, no mention of gitmem (tests sustained adoption)
 *
 * Measures 4 primary signals: discovery, exploration, self-documentation, persistence.
 *
 * Uses haiku model with budget caps. Costs ~$0.30 per 3-session chain.
 * Full matrix (9 configs x 3 runs) ≈ $8.
 *
 * Run with: npx vitest run tests/e2e/organic-discovery/organic-discovery.test.ts --config vitest.e2e.config.ts
 *
 *
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKHookStartedMessage,
  SDKHookResponseMessage,
  HookCallback,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

const GITMEM_ROOT = join(__dirname, "../../..");

// ─── Types ───────────────────────────────────────────────────────────

interface SessionObservation {
  messages: SDKMessage[];
  init: SDKSystemMessage | null;
  hooks: {
    started: SDKHookStartedMessage[];
    responses: SDKHookResponseMessage[];
  };
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  result: SDKResultMessage | null;
}

interface SessionMetrics {
  session_number: number;
  discovery: boolean;
  exploration: boolean;
  self_documentation: boolean;
  persistence: boolean;
  gitmem_tool_calls: string[];
  memory_md_before: string;
  memory_md_after: string;
  memory_md_diff: string;
  session_close_called: boolean;
  total_turns: number;
  total_tool_calls: number;
}

interface RunResult {
  config_id: string;
  run_number: number;
  run_id: string;
  model: string;
  timestamp: string;
  sessions: SessionMetrics[];
  aggregate: {
    discovery_rate: number;
    exploration_rate: number;
    self_documentation_rate: number;
    persistence_rate: number;
    total_gitmem_calls: number;
  };
}

interface MatrixConfig {
  id: string;
  nudge: string;
  hooks: string;
  starting_state: string;
  description: string;
}

interface HooksConfig {
  description: string;
  hooks: Record<string, unknown>;
}

interface SessionDefinition {
  number: number;
  type: string;
  max_turns: number;
  prompt?: string;
  prompt_source?: string;
  description: string;
}

interface Matrix {
  configs: MatrixConfig[];
  model: string;
  runs_per_config: number;
  sessions: SessionDefinition[];
}

// ─── Config Loading ──────────────────────────────────────────────────

const CONFIGS_DIR = join(__dirname, "configs");
const RESULTS_DIR = join(__dirname, "results");

function loadMatrix(): Matrix {
  const matrixFile = process.env.DISCOVERY_MATRIX ?? "matrix.json";
  return JSON.parse(readFileSync(join(CONFIGS_DIR, matrixFile), "utf-8"));
}

function loadNudge(version: string): string {
  return readFileSync(join(CONFIGS_DIR, "nudges", `${version}-${nudgeName(version)}.txt`), "utf-8").trim();
}

function nudgeName(version: string): string {
  const names: Record<string, string> = {
    v0: "control",
    v1: "minimal",
    v2: "exploratory",
    v3: "objective",
    v4: "self-doc",
  };
  return names[version] || "control";
}

function loadHooks(version: string): HooksConfig {
  const names: Record<string, string> = {
    h0: "h0-none.json",
    h1: "h1-session-start.json",
    h2: "h2-session-pretool.json",
  };
  return JSON.parse(readFileSync(join(CONFIGS_DIR, "hooks", names[version]), "utf-8"));
}

// ─── Gitmem Tool Detection ──────────────────────────────────────────

const GITMEM_TOOL_PREFIXES = ["mcp__gitmem__"];

function isGitmemTool(name: string): boolean {
  return GITMEM_TOOL_PREFIXES.some((p) => name.startsWith(p));
}

function isExplorationTool(name: string): boolean {
  const explorationTools = [
    "recall", "gitmem-r", "gm-scar",
    "search", "gitmem-search", "gm-search",
    "log", "gitmem-log", "gm-log",
    "graph_traverse", "gitmem-graph", "gm-graph",
  ];
  return explorationTools.some((t) => name.includes(t));
}

function isSessionCloseTool(name: string): boolean {
  return name.includes("session_close") || name.includes("gitmem-sc") || name.includes("gm-close");
}

// ─── Session Runner ─────────────────────────────────────────────────

async function runSession(
  prompt: string,
  options: {
    cwd: string;
    maxTurns?: number;
    maxBudgetUsd?: number;
    model?: string;
  }
): Promise<SessionObservation> {
  const obs: SessionObservation = {
    messages: [],
    init: null,
    hooks: { started: [], responses: [] },
    toolCalls: [],
    result: null,
  };

  const toolObserver: HookCallback = async (input) => {
    if (input.hook_event_name === "PreToolUse") {
      const pre = input as PreToolUseHookInput;
      obs.toolCalls.push({
        name: pre.tool_name,
        input: (pre.tool_input || {}) as Record<string, unknown>,
      });
    }
    return {};
  };

  for await (const msg of query({
    prompt,
    options: {
      cwd: options.cwd,
      model: (options.model as "haiku" | "sonnet" | "opus") ?? "haiku",
      maxTurns: options.maxTurns ?? 10,
      maxBudgetUsd: options.maxBudgetUsd ?? 0.50,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      settingSources: ["project"],
      thinking: { type: "disabled" },
      hooks: {
        PreToolUse: [{ hooks: [toolObserver] }],
      },
    },
  })) {
    obs.messages.push(msg);

    if (msg.type === "system" && msg.subtype === "init") {
      obs.init = msg as SDKSystemMessage;
    }
    if (msg.type === "system" && msg.subtype === "hook_started") {
      obs.hooks.started.push(msg as SDKHookStartedMessage);
    }
    if (msg.type === "system" && msg.subtype === "hook_response") {
      obs.hooks.responses.push(msg as SDKHookResponseMessage);
    }
    if (msg.type === "result") {
      obs.result = msg as SDKResultMessage;
    }
  }

  return obs;
}

// ─── Metric Extraction ──────────────────────────────────────────────

function extractMetrics(
  session: SessionObservation,
  sessionNumber: number,
  memoryMdBefore: string,
  memoryMdAfter: string
): SessionMetrics {
  const gitmemCalls = session.toolCalls
    .filter((tc) => isGitmemTool(tc.name))
    .map((tc) => tc.name.replace("mcp__gitmem__", ""));

  const discovery = gitmemCalls.length > 0;
  const exploration = session.toolCalls.some((tc) => isGitmemTool(tc.name) && isExplorationTool(tc.name));
  const selfDocumentation = memoryMdBefore !== memoryMdAfter;
  const persistence = sessionNumber > 1 && discovery;
  const sessionCloseCalled = session.toolCalls.some((tc) => isGitmemTool(tc.name) && isSessionCloseTool(tc.name));

  const diff = selfDocumentation
    ? computeSimpleDiff(memoryMdBefore, memoryMdAfter)
    : "";

  return {
    session_number: sessionNumber,
    discovery,
    exploration,
    self_documentation: selfDocumentation,
    persistence,
    gitmem_tool_calls: gitmemCalls,
    memory_md_before: memoryMdBefore,
    memory_md_after: memoryMdAfter,
    memory_md_diff: diff,
    session_close_called: sessionCloseCalled,
    total_turns: countTurns(session),
    total_tool_calls: session.toolCalls.length,
  };
}

function countTurns(session: SessionObservation): number {
  return session.messages.filter((m) => m.type === "assistant").length;
}

function computeSimpleDiff(before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const added = afterLines.filter((l) => !beforeLines.includes(l)).map((l) => `+${l}`);
  const removed = beforeLines.filter((l) => !afterLines.includes(l)).map((l) => `-${l}`);
  return [...removed, ...added].join("\n");
}

function computeAggregate(sessions: SessionMetrics[]): RunResult["aggregate"] {
  const count = sessions.length;
  const discoveryCount = sessions.filter((s) => s.discovery).length;
  const explorationCount = sessions.filter((s) => s.exploration).length;
  const selfDocCount = sessions.filter((s) => s.self_documentation).length;
  const laterSessions = sessions.filter((s) => s.session_number > 1);
  const persistenceCount = laterSessions.filter((s) => s.persistence).length;
  const totalGitmemCalls = sessions.reduce((sum, s) => sum + s.gitmem_tool_calls.length, 0);

  return {
    discovery_rate: count > 0 ? discoveryCount / count : 0,
    exploration_rate: count > 0 ? explorationCount / count : 0,
    self_documentation_rate: count > 0 ? selfDocCount / count : 0,
    persistence_rate: laterSessions.length > 0 ? persistenceCount / laterSessions.length : 0,
    total_gitmem_calls: totalGitmemCalls,
  };
}

// ─── Test Environment Setup ─────────────────────────────────────────

function setupTestDir(configId: string, runNumber: number, hooksConfig: HooksConfig): string {
  const testDir = join(tmpdir(), `gitmem-discovery-${configId}-${runNumber}-${Date.now()}`);

  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });

  // Copy scaffold project
  const scaffoldDir = join(__dirname, "scaffold");
  cpSync(scaffoldDir, testDir, { recursive: true });

  // Create .mcp.json pointing to built gitmem server
  const mcpConfig = {
    mcpServers: {
      gitmem: {
        command: "node",
        args: [join(GITMEM_ROOT, "dist/index.js")],
        env: { GITMEM_TIER: "free" },
      },
    },
  };
  writeFileSync(join(testDir, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));

  // Create .claude/settings.json with hooks (if any)
  const claudeDir = join(testDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });

  const settings: Record<string, unknown> = {
    permissions: {
      allow: [
        "Bash(*)",
        "Read(*)",
        "Edit(*)",
        "Write(*)",
        "Glob(*)",
        "Grep(*)",
        "mcp__gitmem__*",
      ],
    },
  };

  if (Object.keys(hooksConfig.hooks).length > 0) {
    settings.hooks = hooksConfig.hooks;
  }

  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings, null, 2));

  // Create empty MEMORY.md (s0 starting state)
  writeFileSync(join(testDir, "MEMORY.md"), "");

  return testDir;
}

function cleanupTestDir(testDir: string): void {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
}

// ─── Run a Single Config Chain ──────────────────────────────────────

async function runConfigChain(
  config: MatrixConfig,
  runNumber: number,
  matrix: Matrix
): Promise<RunResult> {
  const nudgePrompt = loadNudge(config.nudge);
  const hooksConfig = loadHooks(config.hooks);
  const testDir = setupTestDir(config.id, runNumber, hooksConfig);
  const memoryMdPath = join(testDir, "MEMORY.md");

  const sessionResults: SessionMetrics[] = [];

  try {
    for (const sessionDef of matrix.sessions) {
      const prompt =
        sessionDef.number === 1
          ? nudgePrompt
          : sessionDef.prompt!;

      const memoryMdBefore = existsSync(memoryMdPath)
        ? readFileSync(memoryMdPath, "utf-8")
        : "";

      const observation = await runSession(prompt, {
        cwd: testDir,
        maxTurns: sessionDef.max_turns,
        model: matrix.model,
        maxBudgetUsd: matrix.model === "haiku" ? 0.50 : 2.00,
      });

      const memoryMdAfter = existsSync(memoryMdPath)
        ? readFileSync(memoryMdPath, "utf-8")
        : "";

      const metrics = extractMetrics(
        observation,
        sessionDef.number,
        memoryMdBefore,
        memoryMdAfter
      );

      sessionResults.push(metrics);
    }
  } finally {
    cleanupTestDir(testDir);
  }

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${config.id}-${String(runNumber).padStart(3, "0")}`;

  return {
    config_id: config.id,
    run_number: runNumber,
    run_id: runId,
    model: matrix.model,
    timestamp: new Date().toISOString(),
    sessions: sessionResults,
    aggregate: computeAggregate(sessionResults),
  };
}

// ─── Save Results ───────────────────────────────────────────────────

function saveResult(result: RunResult): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${result.run_id}.json`;
  writeFileSync(join(RESULTS_DIR, filename), JSON.stringify(result, null, 2));
}

// ─── Test Suite ─────────────────────────────────────────────────────

let claudeAvailable = false;
try {
  const { execFileSync } = await import("child_process");
  const ver = execFileSync("claude", ["--version"], { timeout: 5_000 })
    .toString()
    .trim();
  claudeAvailable = ver.includes("Claude Code");
} catch {
  // claude not installed
}

describe.skipIf(!claudeAvailable)(
  "Organic Discovery: Multi-Session Adoption Measurement",
  () => {
    const matrix = loadMatrix();

    // Run a single config for validation (override with DISCOVERY_CONFIG=all for full matrix)
    const targetConfig = process.env.DISCOVERY_CONFIG;
    const configsToRun =
      targetConfig === "all"
        ? matrix.configs
        : targetConfig
          ? matrix.configs.filter((c) => c.id === targetConfig)
          : [matrix.configs[0]]; // Default: just A1 for validation

    const runsPerConfig = targetConfig === "all"
      ? matrix.runs_per_config
      : 1;

    for (const config of configsToRun) {
      describe(`Config ${config.id}: ${config.description}`, () => {
        for (let run = 1; run <= runsPerConfig; run++) {
          it(
            `Run ${run}/${runsPerConfig} — 3-session chain`,
            async () => {
              const result = await runConfigChain(config, run, matrix);
              saveResult(result);

              // Basic validation — session chain completed
              expect(result.sessions).toHaveLength(3);
              expect(result.config_id).toBe(config.id);
              expect(result.run_number).toBe(run);

              // Log summary for visibility
              console.log(
                `[${config.id} run ${run}] ` +
                `discovery=${result.aggregate.discovery_rate.toFixed(2)} ` +
                `exploration=${result.aggregate.exploration_rate.toFixed(2)} ` +
                `self_doc=${result.aggregate.self_documentation_rate.toFixed(2)} ` +
                `persistence=${result.aggregate.persistence_rate.toFixed(2)} ` +
                `gitmem_calls=${result.aggregate.total_gitmem_calls}`
              );
            },
            300_000 // 5 min per 3-session chain
          );
        }
      });
    }

    it("results directory contains output files", async () => {
      // This runs after all config chains — verify we got results
      if (!existsSync(RESULTS_DIR)) {
        // No results yet — skip if running in isolation
        return;
      }

      const { readdirSync } = await import("fs");
      const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"));
      expect(files.length).toBeGreaterThan(0);

      // Validate result schema
      const firstResult: RunResult = JSON.parse(
        readFileSync(join(RESULTS_DIR, files[0]), "utf-8")
      );
      expect(firstResult.config_id).toBeTruthy();
      expect(firstResult.sessions).toHaveLength(3);
      expect(firstResult.aggregate).toBeDefined();
      expect(firstResult.aggregate.discovery_rate).toBeGreaterThanOrEqual(0);
      expect(firstResult.aggregate.discovery_rate).toBeLessThanOrEqual(1);
    });
  }
);
