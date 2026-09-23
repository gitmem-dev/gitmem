/**
 * GIT-109 step 2: static schema-drift analysis.
 *
 * Customers never run SQL after initial setup (standing rule, 2026-09-21), so
 * every table and column gitmem touches must exist in the v1.8.0 setup.sql —
 * or be deliberately guarded. Release B found closes lost to exactly this: the
 * code wrote production-only columns a setup.sql store does not have.
 *
 * This walks src/ with the TypeScript compiler API and collects, per call site:
 *   writes  — table + payload keys reaching directUpsert / directPatch /
 *             upsertRecord / storage.upsert
 *   reads   — table + select / filter / order keys reaching directQuery,
 *             directQueryAll, listRecords, getRecord
 * and compares them with a parsed setup.sql (table -> columns, views included).
 *
 * Resolution is deliberately conservative: a table or payload it cannot
 * resolve statically is reported as UNRESOLVED, never assumed fine.
 */
import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

// ---------------------------------------------------------------- schema

export type Schema = Map<string, Set<string>>;

const CONSTRAINT_WORDS = /^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK|EXCLUDE)\b/i;

/** setup.sql -> table/view name -> columns. */
export function parseSchema(sql: string): Schema {
  const schema: Schema = new Map();
  const clean = sql.replace(/--[^\n]*/g, "");
  const add = (t: string, c: string) => {
    if (!schema.has(t)) schema.set(t, new Set());
    schema.get(t)!.add(c);
  };

  // CREATE TABLE ... ( body );  — body split on top-level commas
  const tableRe = /CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(clean))) {
    const table = m[1];
    let depth = 1, i = tableRe.lastIndex, start = i;
    const parts: string[] = [];
    for (; i < clean.length && depth > 0; i++) {
      const ch = clean[i];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) parts.push(clean.slice(start, i)); }
      else if (ch === "," && depth === 1) { parts.push(clean.slice(start, i)); start = i + 1; }
    }
    if (!schema.has(table)) schema.set(table, new Set());
    for (const p of parts) {
      const line = p.trim();
      if (!line || CONSTRAINT_WORDS.test(line)) continue;
      const col = line.match(/^"?(\w+)"?/);
      if (col) add(table, col[1]);
    }
  }

  const alterRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?(\w+)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+"?(\w+)"?/gi;
  while ((m = alterRe.exec(clean))) add(m[1], m[2]);

  const viewRe = /CREATE (?:OR REPLACE )?VIEW\s+(?:public\.)?(\w+)\s+AS\s+SELECT\s+([\s\S]+?)\s+FROM\s+(?:public\.)?(\w+)/gi;
  while ((m = viewRe.exec(clean))) {
    const [, view, list, base] = m;
    if (!schema.has(view)) schema.set(view, new Set());
    for (const item of list.split(",").map((s) => s.trim())) {
      if (item === "*") { for (const c of schema.get(base) ?? []) add(view, c); continue; }
      const alias = item.match(/\bAS\s+(\w+)$/i);
      add(view, alias ? alias[1] : item.replace(/^\w+\./, "").match(/^(\w+)/)?.[1] ?? item);
    }
  }
  return schema;
}

// ---------------------------------------------------------------- code scan

export type AccessKind = "write" | "select" | "filter" | "order";

export interface Access {
  file: string;
  line: number;
  call: string;
  table: string;
  column: string;
  kind: AccessKind;
}

export interface Unresolved {
  file: string;
  line: number;
  call: string;
  what: string;
}

export interface ScanResult {
  accesses: Access[];
  /** Generic helpers whose table is a parameter (storage.ts, supabase-client.ts): checked at their callers. */
  passThrough: Unresolved[];
  /** Tables reached with no column information (e.g. a bare select=*). */
  tables: Array<{ file: string; line: number; call: string; table: string }>;
  unresolved: Unresolved[];
  /** Call sites in free-tier-only code (local JSON files, not the store). */
  freeTierOnly: number;
  callSites: number;
}

const WRITE_CALLS = new Set(["directUpsert", "upsertRecord"]);
const PATCH_CALLS = new Set(["directPatch"]);
const QUERY_CALLS = new Set(["directQuery", "directQueryAll"]);
const DEFAULT_PREFIX = "gitmem_";

function calleeName(expr: ts.LeftHandSideExpression): { name: string; receiver?: string } | null {
  if (ts.isIdentifier(expr)) return { name: expr.text };
  if (ts.isPropertyAccessExpression(expr)) {
    const recv = expr.expression;
    const receiver = ts.isIdentifier(recv) ? recv.text : ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) ? `${recv.expression.text}()` : undefined;
    return { name: expr.name.text, receiver };
  }
  return null;
}

/** Find the nearest declaration of `name` visible from `from` (same file). */
function findDeclaration(name: string, from: ts.Node): ts.VariableDeclaration | ts.ParameterDeclaration | null {
  let scope: ts.Node | undefined = from;
  while (scope) {
    let found: ts.VariableDeclaration | ts.ParameterDeclaration | null = null;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.pos < from.pos) found = n;
      else if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n;
      if (n !== scope && (ts.isFunctionLike(n) || ts.isClassLike(n))) {
        // parameters of the enclosing function are visited via the scope itself
        return;
      }
      ts.forEachChild(n, visit);
    };
    if (ts.isFunctionLike(scope)) for (const p of scope.parameters) visit(p);
    ts.forEachChild(scope, visit);
    if (found) return found;
    scope = scope.parent;
  }
  return null;
}

function resolveTable(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return resolveTable(expr.expression);
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "getTableName") {
    const arg = expr.arguments[0];
    return arg && ts.isStringLiteralLike(arg) ? DEFAULT_PREFIX + arg.text : null;
  }
  if (ts.isIdentifier(expr)) {
    const decl = findDeclaration(expr.text, expr);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return resolveTable(decl.initializer);
  }
  return null;
}

interface KeySet { keys: Set<string>; complete: boolean; why: string[] }

function propName(p: ts.ObjectLiteralElementLike): string | null {
  const n = p.name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n)) return n.text;
  return null;
}

/** Keys of an object-valued expression, following spreads, conditionals and later assignments. */
function resolveKeys(expr: ts.Expression | undefined, seen = new Set<ts.Node>()): KeySet {
  const out: KeySet = { keys: new Set(), complete: true, why: [] };
  const merge = (k: KeySet) => { k.keys.forEach((x) => out.keys.add(x)); if (!k.complete) { out.complete = false; out.why.push(...k.why); } };
  if (!expr) return { keys: new Set(), complete: false, why: ["no payload"] };
  if (seen.has(expr)) return out;
  seen.add(expr);

  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression?.(expr)) {
    return resolveKeys((expr as ts.ParenthesizedExpression).expression, seen);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const p of expr.properties) {
      if (ts.isSpreadAssignment(p)) merge(resolveKeys(p.expression, seen));
      else if (ts.isShorthandPropertyAssignment(p)) out.keys.add(p.name.text);
      else {
        const n = propName(p);
        if (n) out.keys.add(n); else { out.complete = false; out.why.push(`computed key ${p.getText().slice(0, 40)}`); }
      }
    }
    return out;
  }
  // `cond && {…}`  /  `cond ? {…} : {…}`
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken || expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    if (ts.isObjectLiteralExpression(expr.right) || ts.isParenthesizedExpression(expr.right)) return resolveKeys(expr.right, seen);
  }
  if (ts.isConditionalExpression(expr)) {
    merge(resolveKeys(expr.whenTrue, seen));
    merge(resolveKeys(expr.whenFalse, seen));
    return out;
  }
  if (ts.isIdentifier(expr)) {
    const decl = findDeclaration(expr.text, expr);
    // A callback parameter: `rows.map((r) => write(r))` — the elements of rows.
    if (decl && ts.isParameter(decl) && ts.isIdentifier(decl.name)) {
      const fn = decl.parent;
      const call = fn.parent;
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isCallExpression(call) && call.arguments[0] === fn &&
          ts.isPropertyAccessExpression(call.expression) && /^(map|forEach|flatMap)$/.test(call.expression.name.text)) {
        return elementKeys(call.expression.expression, seen);
      }
    }
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      merge(resolveKeys(decl.initializer, seen));
      // later `x.prop = …` / `x["prop"] = …` in the same function
      const fn = enclosingFunction(decl) ?? decl.getSourceFile();
      const visit = (n: ts.Node): void => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const l = n.left;
          if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression) && l.expression.text === expr.text) out.keys.add(l.name.text);
          if (ts.isElementAccessExpression(l) && ts.isIdentifier(l.expression) && l.expression.text === expr.text && ts.isStringLiteralLike(l.argumentExpression)) out.keys.add(l.argumentExpression.text);
        }
        ts.forEachChild(n, visit);
      };
      visit(fn);
      return out;
    }
    return { keys: new Set(), complete: false, why: [`payload ${expr.text} not resolvable`] };
  }
  if (ts.isCallExpression(expr)) {
    // Column filters narrow a payload; the payload is their first argument.
    const name = ts.isIdentifier(expr.expression) ? expr.expression.text : ts.isPropertyAccessExpression(expr.expression) ? expr.expression.name.text : "";
    if (/^filterTo|Columns$/.test(name) && expr.arguments[0]) {
      const k = resolveKeys(expr.arguments[0], seen);
      k.why.push(`filtered by ${name}`);
      return k;
    }
    // A function in this file that returns an object literal.
    const local = ts.isIdentifier(expr.expression) ? findLocalFunction(expr.expression.text, expr.getSourceFile()) : null;
    if (local) return returnKeys(local, seen);
    if (ts.isAwaitExpression(expr.parent)) {/* fallthrough */}
    return { keys: new Set(), complete: false, why: [`payload from ${name || "call"}()`] };
  }
  if (ts.isAwaitExpression(expr)) return resolveKeys(expr.expression, seen);
  return { keys: new Set(), complete: false, why: [`payload ${ts.SyntaxKind[expr.kind]}`] };
}

function findLocalFunction(name: string, sf: ts.SourceFile): ts.FunctionLikeDeclaration | null {
  let found: ts.FunctionLikeDeclaration | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found = n.initializer;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Keys of every object a function returns (its own returns, not nested functions'). */
function returnKeys(fn: ts.FunctionLikeDeclaration, seen: Set<ts.Node>): KeySet {
  const out: KeySet = { keys: new Set(), complete: true, why: [] };
  const merge = (k: KeySet) => { k.keys.forEach((x) => out.keys.add(x)); if (!k.complete) { out.complete = false; out.why.push(...k.why); } };
  if (fn.body && !ts.isBlock(fn.body)) { merge(resolveKeys(fn.body as ts.Expression, seen)); return out; }
  const visit = (n: ts.Node): void => {
    if (n !== fn && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) merge(resolveKeys(n.expression, seen));
    ts.forEachChild(n, visit);
  };
  if (fn.body) visit(fn.body);
  if (out.keys.size === 0 && out.complete) return { keys: out.keys, complete: false, why: ["function returns no object literal"] };
  return out;
}

/** Keys of the elements of an array-valued expression. */
function elementKeys(expr: ts.Expression, seen: Set<ts.Node>): KeySet {
  const out: KeySet = { keys: new Set(), complete: true, why: [] };
  const merge = (k: KeySet) => { k.keys.forEach((x) => out.keys.add(x)); if (!k.complete) { out.complete = false; out.why.push(...k.why); } };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) return elementKeys(expr.expression, seen);
  if (ts.isArrayLiteralExpression(expr)) {
    for (const el of expr.elements) merge(ts.isSpreadElement(el) ? elementKeys(el.expression, seen) : resolveKeys(el, seen));
    return out;
  }
  if (ts.isIdentifier(expr)) {
    const d = findDeclaration(expr.text, expr);
    if (d && ts.isVariableDeclaration(d) && d.initializer) return elementKeys(d.initializer, seen);
  }
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const m = expr.expression.name.text;
    if (/^(filter|slice|concat|reverse|sort)$/.test(m)) return elementKeys(expr.expression.expression, seen);
    const cb = expr.arguments[0];
    if (m === "map" && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) return returnKeys(cb, seen);
  }
  return { keys: new Set(), complete: false, why: [`elements of ${expr.getText().slice(0, 40)}`] };
}

function enclosingFunction(n: ts.Node): ts.Node | null {
  let p: ts.Node | undefined = n.parent;
  while (p) { if (ts.isFunctionLike(p)) return p; p = p.parent; }
  return null;
}

/** PostgREST select list -> base columns (alias:col, col::cast, col->>path; embeds skipped). */
export function selectColumns(select: string): { columns: string[]; star: boolean } {
  const cols: string[] = [];
  let star = false, depth = 0, cur = "";
  const flush = () => {
    const item = cur.trim(); cur = "";
    if (!item) return;
    if (item === "*") { star = true; return; }
    if (item.includes("(")) return; // resource embedding rel(...)
    const body = item.includes(":") && !item.includes("::") ? item.split(":").pop()! : item.replace(/^\w+:(?!:)/, "");
    const col = body.split("::")[0].split("->")[0].trim();
    if (/^\w+$/.test(col)) cols.push(col);
  };
  for (const ch of select) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) flush(); else cur += ch;
  }
  flush();
  return { columns: cols, star };
}

function resolveString(expr: ts.Expression | undefined): string | null {
  if (!expr) return null;
  if (ts.isStringLiteralLike(expr)) return expr.text;
  if (ts.isIdentifier(expr)) {
    const decl = findDeclaration(expr.text, expr);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return resolveString(decl.initializer);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolveString(expr.left), r = resolveString(expr.right);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

/** Inside code that only runs without Supabase (local JSON files). */
function isFreeTierOnly(n: ts.Node): boolean {
  let child: ts.Node = n;
  let p: ts.Node | undefined = n.parent;
  while (p) {
    if (ts.isIfStatement(p)) {
      const cond = p.expression.getText();
      const positive = /^hasSupabase\(\)(\s*&&.*)?$/.test(cond);
      const negative = /^!hasSupabase\(\)/.test(cond);
      if (positive && p.elseStatement === child) return true;
      if (negative && p.thenStatement === child) return true;
    }
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && /Free$/.test(p.name.getText())) return true;
    child = p;
    p = p.parent;
  }
  return false;
}

function objectProp(obj: ts.Expression | undefined, key: string): ts.Expression | undefined {
  if (!obj) return undefined;
  if (ts.isIdentifier(obj)) {
    const d = findDeclaration(obj.text, obj);
    return d && ts.isVariableDeclaration(d) ? objectProp(d.initializer, key) : undefined;
  }
  if (!ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && propName(p) === key) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) {
      const d = findDeclaration(key, p);
      return d && ts.isVariableDeclaration(d) ? d.initializer : undefined;
    }
  }
  return undefined;
}

export function scanSources(srcDir: string, exclude: (file: string) => boolean = () => false): ScanResult {
  const result: ScanResult = { accesses: [], passThrough: [], tables: [], unresolved: [], freeTierOnly: 0, callSites: 0 };
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(srcDir);

  for (const file of files) {
    const rel = path.relative(path.dirname(srcDir), file);
    if (exclude(rel)) continue;
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) inspect(n, sf, rel, result);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return result;
}

function inspect(call: ts.CallExpression, sf: ts.SourceFile, file: string, r: ScanResult): void {
  const c = calleeName(call.expression);
  if (!c) return;
  const isStorageUpsert = c.name === "upsert" && (c.receiver === "storage" || c.receiver === "getStorage()");
  const kind = WRITE_CALLS.has(c.name) ? "write" : PATCH_CALLS.has(c.name) ? "patch" : QUERY_CALLS.has(c.name) ? "query"
    : c.name === "listRecords" ? "list" : c.name === "getRecord" ? "get" : isStorageUpsert ? "storage" : null;
  if (!kind) return;
  // Skip the definitions themselves (supabase-client.ts calling its own helpers with parameters).
  const line = sf.getLineAndCharacterOfPosition(call.getStart()).line + 1;
  const callText = c.receiver ? `${c.receiver}.${c.name}` : c.name;
  r.callSites++;
  if (isFreeTierOnly(call)) { r.freeTierOnly++; return; }

  const args = call.arguments;
  const addCols = (table: string, cols: Iterable<string>, k: AccessKind) => {
    for (const col of cols) r.accesses.push({ file, line, call: callText, table, column: col, kind: k });
  };
  const unresolved = (what: string) => r.unresolved.push({ file, line, call: callText, what });

  let tableExpr: ts.Expression | undefined = args[0];
  let table: string | null;
  if (kind === "storage") {
    const coll = args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : null;
    table = coll ? DEFAULT_PREFIX + coll : null;
  } else if (kind === "list") {
    tableExpr = objectProp(args[0], "table");
    table = resolveTable(tableExpr);
  } else {
    table = resolveTable(tableExpr);
  }
  if (!table) {
    const paramOf = (e: ts.Expression | undefined): boolean => {
      if (!e) return false;
      if (ts.isIdentifier(e)) {
        const d = findDeclaration(e.text, e);
        if (d && ts.isParameter(d)) return true;
        if (d && ts.isVariableDeclaration(d)) return paramOf(d.initializer);
        // shorthand `{ table }` inside listRecords({ table, ... })
        return false;
      }
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "getTableName") return paramOf(e.arguments[0]);
      return false;
    };
    const isParam = paramOf(tableExpr) || (kind === "list" && !tableExpr && !!args[0] && ts.isObjectLiteralExpression(args[0]) &&
      args[0].properties.some((p) => ts.isShorthandPropertyAssignment(p) && p.name.text === "table" && (() => { const d = findDeclaration("table", p); return !!d && ts.isParameter(d); })()));
    const isStorageParam = kind === "storage" && args[0] && ts.isIdentifier(args[0]);
    if (isParam || isStorageParam) r.passThrough.push({ file, line, call: callText, what: `table is parameter ${tableExpr?.getText() ?? args[0]?.getText()}` });
    else unresolved(`table ${tableExpr?.getText().slice(0, 50) ?? "(none)"}`);
    return;
  }

  const keysFrom = (e: ts.Expression | undefined, k: AccessKind, label: string) => {
    const ks = resolveKeys(e);
    addCols(table!, [...ks.keys].filter((x) => !(k === "filter" && (x === "or" || x === "and" || x === "not"))), k);
    if (!ks.complete) unresolved(`${label}: ${ks.why.join("; ")}`);
  };

  switch (kind) {
    case "write":
    case "storage":
      keysFrom(args[1], "write", "payload");
      break;
    case "patch":
      keysFrom(args[1], "filter", "patch filter");
      keysFrom(args[2], "write", "patch payload");
      break;
    case "get":
      addCols(table, ["id"], "filter");
      break;
    case "query":
    case "list": {
      const opts = kind === "query" ? args[1] : args[0];
      const selExpr = objectProp(opts, kind === "query" ? "select" : "columns");
      if (selExpr) {
        const sel = resolveString(selExpr);
        if (sel === null) unresolved(`select ${selExpr.getText().slice(0, 50)}`);
        else {
          const { columns, star } = selectColumns(sel);
          addCols(table, columns, "select");
          if (star || columns.length === 0) r.tables.push({ file, line, call: callText, table });
        }
      } else {
        r.tables.push({ file, line, call: callText, table }); // default select=*
      }
      const filt = objectProp(opts, "filters");
      if (filt) keysFrom(filt, "filter", "filters");
      const order = kind === "query" ? resolveString(objectProp(opts, "order")) : null;
      if (order) addCols(table, order.split(",").map((o) => o.split(".")[0].trim()).filter(Boolean), "order");
      const orderBy = kind === "list" ? objectProp(opts, "orderBy") : undefined;
      if (orderBy) {
        const col = resolveString(objectProp(orderBy, "column"));
        if (col) addCols(table, [col], "order");
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- compare

export interface Finding {
  table: string;
  /** null: the table itself is missing. */
  column: string | null;
  kind: AccessKind | "table";
  sites: string[];
  /** Present in the current schema/setup.sql but not in v1.8.0. */
  addedAfterFloor: boolean;
}

export function compare(scan: ScanResult, floor: Schema, current: Schema): Finding[] {
  const byKey = new Map<string, Finding>();
  const note = (table: string, column: string | null, kind: Finding["kind"], site: string) => {
    const key = `${table} ${column ?? ""} ${column === null ? "table" : kind}`;
    let f = byKey.get(key);
    if (!f) {
      const inCurrent = column === null ? current.has(table) : !!current.get(table)?.has(column);
      f = { table, column, kind: column === null ? "table" : kind, sites: [], addedAfterFloor: inCurrent };
      byKey.set(key, f);
    }
    if (!f.sites.includes(site)) f.sites.push(site);
  };
  for (const a of scan.accesses) {
    const site = `${a.file}:${a.line}`;
    if (!floor.has(a.table)) note(a.table, null, "table", site);
    else if (!floor.get(a.table)!.has(a.column)) note(a.table, a.column, a.kind, site);
  }
  for (const t of scan.tables) if (!floor.has(t.table)) note(t.table, null, "table", `${t.file}:${t.line}`);
  return [...byKey.values()].sort((x, y) => `${x.table}.${x.column}`.localeCompare(`${y.table}.${y.column}`));
}

// ---------------------------------------------------------------- RPCs (GIT-114)

/** setup.sql -> function names (CREATE [OR REPLACE] FUNCTION name(...)). */
export function parseFunctions(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi;
  let m: RegExpExecArray | null;
  const clean = sql.replace(/--[^\n]*/g, "");
  while ((m = re.exec(clean))) names.add(m[1]);
  return names;
}

export interface RpcRef {
  file: string;
  line: number;
  name: string;
  /** A fixed https:// URL — another project (e.g. licensing), not the customer's store. */
  external: boolean;
}

/**
 * Text of a string or template literal, with getTableName("x") substitutions
 * expanded to the default table name; any other substitution becomes "\0".
 */
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) {
    let out = n.head.text;
    for (const span of n.templateSpans) {
      const e = span.expression;
      out += ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "getTableName" &&
        e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])
        ? DEFAULT_PREFIX + e.arguments[0].text
        : "\0";
      out += span.literal.text;
    }
    return out;
  }
  return null;
}

/**
 * Every RPC name src/ can call. Two shapes:
 *   - a literal or template URL containing "/rpc/<name>";
 *   - in a file that builds "/rpc/${…}" dynamically, every `name:` property of
 *     an object literal (the candidate list the URL is built from).
 * Returns the refs and the dynamic call sites whose names could not be resolved.
 */
export function scanRpcNames(srcDir: string): { refs: RpcRef[]; unresolved: Unresolved[] } {
  const refs: RpcRef[] = [];
  const unresolved: Unresolved[] = [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(srcDir);
  for (const file of files) {
    const rel = path.relative(path.dirname(srcDir), file);
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    const dynamicSites: ts.Node[] = [];
    const nameProps: ts.PropertyAssignment[] = [];
    const visit = (n: ts.Node): void => {
      const text = literalText(n);
      if (text !== null && text.includes("/rpc/")) {
        const seg = text.slice(text.indexOf("/rpc/") + 5).split(/[/?"'\s]/)[0];
        if (seg && !seg.includes("\0")) {
          refs.push({ file: rel, line: lineOf(n), name: seg, external: /^https?:\/\//.test(text) });
        } else {
          dynamicSites.push(n);
        }
      }
      if (ts.isPropertyAssignment(n) && propName(n) === "name") nameProps.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (dynamicSites.length === 0) continue;
    let found = 0;
    for (const p of nameProps) {
      const t = literalText(p.initializer);
      if (t && /^[a-z][a-z0-9_]*$/.test(t)) {
        refs.push({ file: rel, line: lineOf(p), name: t, external: false });
        found++;
      }
    }
    if (found === 0) {
      for (const d of dynamicSites) unresolved.push({ file: rel, line: lineOf(d), call: "rpc", what: `dynamic RPC name ${d.getText().slice(0, 60)}` });
    }
  }
  return { refs, unresolved };
}
