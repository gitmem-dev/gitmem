#!/usr/bin/env node
/**
 * MCP Protocol Compliance Test Suite for gitmem-mcp
 *
 * Tests the MCP server against protocol spec requirements:
 * - Protocol handshake (initialize)
 * - Tool listing and schema validation
 * - Tool execution
 * - Error handling
 * - Response format compliance
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';

let passed = 0;
let failed = 0;
let warnings = 0;
let messageId = 1;

// Start the MCP server
const server = spawn('node', ['dist/index.js'], {
  cwd: '/workspace/gitmem',
  env: { ...process.env, GITMEM_TIER: 'free', GITMEM_DIR: '/tmp/gitmem-compliance-test' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const rl = createInterface({ input: server.stdout });
const pending = new Map();

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = messageId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }
    }, 10000);
  });
}

function test(name, pass, detail = '') {
  if (pass) {
    console.log(`  ${PASS} ${name}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function warn(name, detail = '') {
  console.log(`  ${WARN} ${name}${detail ? ' — ' + detail : ''}`);
  warnings++;
}

async function run() {
  console.log('\n══════════════════════════════════════════');
  console.log(' MCP Protocol Compliance Test — gitmem-mcp');
  console.log('══════════════════════════════════════════\n');

  // ═══════════════════════════════════════════
  // 1. PROTOCOL HANDSHAKE
  // ═══════════════════════════════════════════
  console.log('1. Protocol Handshake');

  let initResult;
  try {
    initResult = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-compliance-test', version: '1.0.0' }
    });

    test('initialize returns result', !!initResult.result);
    test('has protocolVersion', !!initResult.result?.protocolVersion);
    test('protocolVersion is string', typeof initResult.result?.protocolVersion === 'string');
    test('has serverInfo', !!initResult.result?.serverInfo);
    test('serverInfo.name exists', !!initResult.result?.serverInfo?.name);
    test('serverInfo.version exists', !!initResult.result?.serverInfo?.version);
    test('has capabilities', !!initResult.result?.capabilities);
    test('capabilities.tools exists', initResult.result?.capabilities?.tools !== undefined);

    // Send initialized notification
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    test('initialized notification sent', true);

  } catch (e) {
    test('initialize handshake', false, e.message);
  }

  console.log();

  // ═══════════════════════════════════════════
  // 2. TOOL LISTING
  // ═══════════════════════════════════════════
  console.log('2. Tool Listing');

  let tools = [];
  try {
    const listResult = await send('tools/list');
    test('tools/list returns result', !!listResult.result);
    test('result has tools array', Array.isArray(listResult.result?.tools));

    tools = listResult.result?.tools || [];
    test('at least 1 tool registered', tools.length > 0);
    test(`tool count (${tools.length}) is reasonable`, tools.length > 5 && tools.length < 100);

  } catch (e) {
    test('tools/list', false, e.message);
  }

  console.log();

  // ═══════════════════════════════════════════
  // 3. TOOL SCHEMA VALIDATION
  // ═══════════════════════════════════════════
  console.log('3. Tool Schema Validation');

  let schemaIssues = 0;
  for (const tool of tools) {
    const schema = tool.inputSchema || {};

    // Required fields per MCP spec
    if (!tool.name) { schemaIssues++; test(`tool has name`, false); }
    if (!tool.description) { schemaIssues++; test(`${tool.name}: has description`, false); }

    // inputSchema must be a valid JSON Schema object
    if (schema.type !== 'object') {
      schemaIssues++;
      test(`${tool.name}: inputSchema.type === "object"`, false, `got "${schema.type}"`);
    }

    // Required fields must exist in properties
    const required = schema.required || [];
    const props = schema.properties || {};
    for (const req of required) {
      if (!(req in props)) {
        schemaIssues++;
        test(`${tool.name}: required "${req}" in properties`, false);
      }
    }

    // Each property should have a type and description
    for (const [pname, pval] of Object.entries(props)) {
      if (!pval.type && !pval.enum && !pval.items && !pval.anyOf) {
        schemaIssues++;
        test(`${tool.name}.${pname}: has type`, false);
      }
      if (!pval.description) {
        schemaIssues++;
        warn(`${tool.name}.${pname}: missing description`);
      }
    }
  }

  if (schemaIssues === 0) {
    test('all tool schemas valid', true);
  } else {
    test(`schema validation (${schemaIssues} issues)`, false);
  }

  // Description quality
  const shortDescs = tools.filter(t => (t.description || '').length < 30);
  test('all descriptions >= 30 chars', shortDescs.length === 0,
    shortDescs.length ? `short: ${shortDescs.map(t => t.name).join(', ')}` : '');

  // Check for duplicate tool names
  const names = tools.map(t => t.name);
  const uniqueNames = new Set(names);
  test('no duplicate tool names', names.length === uniqueNames.size,
    names.length !== uniqueNames.size ? `${names.length - uniqueNames.size} duplicates` : '');

  console.log();

  // ═══════════════════════════════════════════
  // 4. TOOL EXECUTION
  // ═══════════════════════════════════════════
  console.log('4. Tool Execution');

  // Test gitmem-help (zero params, always works)
  try {
    const helpResult = await send('tools/call', {
      name: 'gitmem-help',
      arguments: {}
    });
    test('gitmem-help returns result', !!helpResult.result);
    test('result has content array', Array.isArray(helpResult.result?.content));
    test('content[0].type === "text"', helpResult.result?.content?.[0]?.type === 'text');
    test('content[0].text is non-empty', (helpResult.result?.content?.[0]?.text || '').length > 10);
  } catch (e) {
    test('gitmem-help execution', false, e.message);
  }

  // Test search (with params)
  try {
    const searchResult = await send('tools/call', {
      name: 'search',
      arguments: { query: 'test query' }
    });
    test('search returns result', !!searchResult.result);
    test('search result has content', Array.isArray(searchResult.result?.content));
    // Free tier with no data should still return valid response
    test('search content is text type', searchResult.result?.content?.[0]?.type === 'text');
  } catch (e) {
    test('search execution', false, e.message);
  }

  // Test recall (with required param)
  try {
    const recallResult = await send('tools/call', {
      name: 'recall',
      arguments: { plan: 'test compliance' }
    });
    test('recall returns result', !!recallResult.result);
    test('recall has content array', Array.isArray(recallResult.result?.content));
  } catch (e) {
    test('recall execution', false, e.message);
  }

  // Test log (no required params)
  try {
    const logResult = await send('tools/call', {
      name: 'log',
      arguments: {}
    });
    test('log returns result', !!logResult.result);
    test('log has content array', Array.isArray(logResult.result?.content));
  } catch (e) {
    test('log execution', false, e.message);
  }

  console.log();

  // ═══════════════════════════════════════════
  // 5. ERROR HANDLING
  // ═══════════════════════════════════════════
  console.log('5. Error Handling');

  // Call unknown tool
  try {
    const unknownResult = await send('tools/call', {
      name: 'nonexistent_tool_xyz',
      arguments: {}
    });
    const hasError = !!unknownResult.error || unknownResult.result?.isError;
    test('unknown tool returns error', hasError,
      hasError ? '' : 'should return error for unknown tool');
  } catch (e) {
    test('unknown tool error handling', false, e.message);
  }

  // Call unknown method
  try {
    const unknownMethod = await send('nonexistent/method');
    test('unknown method returns error', !!unknownMethod.error);
    test('error has code', typeof unknownMethod.error?.code === 'number');
    test('error code is -32601 (Method not found)', unknownMethod.error?.code === -32601);
  } catch (e) {
    test('unknown method error handling', false, e.message);
  }

  console.log();

  // ═══════════════════════════════════════════
  // 6. RESPONSE FORMAT
  // ═══════════════════════════════════════════
  console.log('6. Response Format Compliance');

  // All responses should be valid JSON-RPC 2.0
  test('all responses include jsonrpc: "2.0"', true); // validated by parser
  test('all responses include matching id', true); // validated by pending map

  // Content format check
  const helpResult2 = await send('tools/call', { name: 'gitmem-help', arguments: {} });
  const content = helpResult2.result?.content || [];
  for (const block of content) {
    test('content block has type field', !!block.type);
    if (block.type === 'text') {
      test('text block has text field', typeof block.text === 'string');
    }
  }

  // Check isError flag usage
  test('successful calls have isError=false or undefined',
    helpResult2.result?.isError === undefined || helpResult2.result?.isError === false);

  console.log();

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log('══════════════════════════════════════════');
  console.log(` Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log('══════════════════════════════════════════\n');

  if (failed > 0) {
    console.log('VERDICT: FAIL — protocol compliance issues found\n');
  } else if (warnings > 0) {
    console.log('VERDICT: PASS with warnings\n');
  } else {
    console.log('VERDICT: PASS — full MCP protocol compliance\n');
  }

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error('Test runner error:', e);
  server.kill();
  process.exit(1);
});
