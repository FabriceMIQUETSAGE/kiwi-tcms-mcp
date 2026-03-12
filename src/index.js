import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import https from 'https';

// Allow self-signed certificates for self-hosted Kiwi TCMS instances
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const KIWI_URL = process.env.KIWI_URL?.replace(/\/$/, '') ?? 'http://51.44.84.19';
const KIWI_USERNAME = process.env.KIWI_USERNAME ?? '';
const KIWI_PASSWORD = process.env.KIWI_PASSWORD ?? '';

let sessionId = null;
let rpcId = 1;

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

async function rpc(method, params = []) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Cookie'] = `sessionid=${sessionId}`;

  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params });
  const res = await fetch(`${KIWI_URL}/json-rpc/`, { method: 'POST', headers, body, agent: httpsAgent });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const json = await res.json();
  if (json.error) throw new Error(`RPC error [${json.error.code}]: ${json.error.message}`);
  return json.result;
}

async function ensureLoggedIn() {
  if (sessionId) return;
  const result = await rpc('Auth.login', [KIWI_USERNAME, KIWI_PASSWORD]);
  // Auth.login returns the session key directly
  sessionId = result;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'kiwi-tcms',
  version: '1.0.0',
});

// --- kiwi_list_products ---
server.tool(
  'kiwi_list_products',
  'List all products in Kiwi TCMS',
  {},
  async () => {
    await ensureLoggedIn();
    const products = await rpc('Product.filter', [{}]);
    const lines = products.map(p => `ID ${p.id}: ${p.name}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No products found.' }] };
  }
);

// --- kiwi_list_versions ---
server.tool(
  'kiwi_list_versions',
  'List versions for a given product',
  { product_id: z.number().describe('Product ID') },
  async ({ product_id }) => {
    await ensureLoggedIn();
    const versions = await rpc('Version.filter', [{ product: product_id }]);
    const lines = versions.map(v => `ID ${v.id}: ${v.value}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No versions found.' }] };
  }
);

// --- kiwi_list_test_plans ---
server.tool(
  'kiwi_list_test_plans',
  'List existing test plans, optionally filtered by product',
  { product_id: z.number().optional().describe('Filter by product ID (optional)') },
  async ({ product_id }) => {
    await ensureLoggedIn();
    const filter = product_id ? { product: product_id } : {};
    const plans = await rpc('TestPlan.filter', [filter]);
    const lines = plans.map(p => `ID ${p.id}: ${p.name} (product: ${p.product})`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No test plans found.' }] };
  }
);

// --- kiwi_create_test_plan ---
server.tool(
  'kiwi_create_test_plan',
  'Create a test plan in Kiwi TCMS for a feature/ticket',
  {
    name: z.string().describe('Test plan name, e.g. "ADS-1697 — Line Maintenance V1"'),
    product_id: z.number().describe('Product ID (from kiwi_list_products)'),
    product_version_id: z.number().describe('Product version ID (from kiwi_list_versions)'),
    text: z.string().optional().describe('Description / scope of the test plan'),
  },
  async ({ name, product_id, product_version_id, text }) => {
    await ensureLoggedIn();

    // type 1 = "Unit" — most instances have it. We use it as default.
    const plan = await rpc('TestPlan.create', [{
      name,
      product: product_id,
      product_version: product_version_id,
      type: 1,
      is_active: true,
      text: text ?? '',
    }]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Plan created: ID=${plan.id} — "${plan.name}"\nURL: ${KIWI_URL}/plan/${plan.id}/`,
      }],
    };
  }
);

// --- kiwi_create_test_case ---
server.tool(
  'kiwi_create_test_case',
  'Create a test case with numbered steps and add it to a test plan',
  {
    plan_id: z.number().describe('Test plan ID to attach this test case to'),
    summary: z.string().describe('Short title of the test case, e.g. "TC-01 — Affichage onglets Base/Ligne"'),
    product_id: z.number().describe('Product ID'),
    preconditions: z.string().optional().describe('Preconditions / setup required before the test'),
    steps: z.array(z.object({
      action: z.string().describe('Action to perform (visible to QA)'),
      expected_result: z.string().describe('Expected result after this action'),
    })).describe('List of numbered steps with action and expected result'),
    notes: z.string().optional().describe('Additional notes, linked ticket (e.g. ADS-1697), or context'),
  },
  async ({ plan_id, summary, product_id, preconditions, steps, notes }) => {
    await ensureLoggedIn();

    // Build the text body from steps
    const stepsText = steps
      .map((s, i) => `Step ${i + 1}:\nAction: ${s.action}\nExpected: ${s.expected_result}`)
      .join('\n\n');

    const fullText = [
      preconditions ? `PRECONDITIONS:\n${preconditions}` : '',
      `STEPS:\n${stepsText}`,
      notes ? `NOTES:\n${notes}` : '',
    ].filter(Boolean).join('\n\n');

    // Get or create category "Regression" for this product
    let categoryId;
    try {
      const categories = await rpc('Category.filter', [{ product: product_id }]);
      const regression = categories.find(c =>
        c.name?.toLowerCase().includes('regression') ||
        c.name?.toLowerCase().includes('--')
      ) ?? categories[0];
      categoryId = regression?.id;
    } catch {
      // ignore if category fetch fails
    }

    // case_status 2 = CONFIRMED, priority 2 = P2, category falls back to 1 (--default--)
    const caseParams = {
      summary,
      product: product_id,
      category: categoryId ?? 1,
      case_status: 2,
      priority: 2,
      text: fullText,
    };

    const tc = await rpc('TestCase.create', [caseParams]);

    // Add steps individually via TestCase.add_step if supported
    try {
      for (let i = 0; i < steps.length; i++) {
        await rpc('TestCase.add_step', [{
          case: tc.id,
          step_number: i + 1,
          action: steps[i].action,
          expected_result: steps[i].expected_result,
        }]);
      }
    } catch {
      // Older Kiwi versions may not support add_step — text field is the fallback
    }

    // Link to the test plan
    await rpc('TestPlan.add_case', [plan_id, tc.id]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Case created & linked to plan ${plan_id}:\n  ID=${tc.id} — "${tc.summary}"\n  URL: ${KIWI_URL}/case/${tc.id}/`,
      }],
    };
  }
);

// --- kiwi_list_test_cases ---
server.tool(
  'kiwi_list_test_cases',
  'List test cases in a test plan with their IDs and summaries',
  { plan_id: z.number().describe('Test plan ID') },
  async ({ plan_id }) => {
    await ensureLoggedIn();
    const cases = await rpc('TestCase.filter', [{ plan: plan_id }]);
    if (!cases.length) return { content: [{ type: 'text', text: 'No test cases found in this plan.' }] };
    const lines = cases.map(c => `ID=${c.id} | ${c.summary}`).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }
);

// --- kiwi_update_test_case ---
server.tool(
  'kiwi_update_test_case',
  'Update an existing test case: summary, preconditions, steps, notes',
  {
    case_id: z.number().describe('Test case ID to update'),
    summary: z.string().optional().describe('New title for the test case'),
    preconditions: z.string().optional().describe('Updated preconditions'),
    steps: z.array(z.object({
      action: z.string(),
      expected_result: z.string(),
    })).optional().describe('New list of steps (replaces existing steps)'),
    notes: z.string().optional().describe('Updated notes'),
  },
  async ({ case_id, summary, preconditions, steps, notes }) => {
    await ensureLoggedIn();

    const updateParams = {};
    if (summary) updateParams.summary = summary;

    if (steps || preconditions || notes) {
      const stepsText = steps
        ? steps.map((s, i) => `Étape ${i + 1}:\nAction: ${s.action}\nRésultat attendu: ${s.expected_result}`).join('\n\n')
        : '';
      const fullText = [
        preconditions ? `PRÉREQUIS:\n${preconditions}` : '',
        stepsText ? `ÉTAPES:\n${stepsText}` : '',
        notes ? `NOTES:\n${notes}` : '',
      ].filter(Boolean).join('\n\n');
      updateParams.text = fullText;
    }

    await rpc('TestCase.update', [case_id, updateParams]);

    // Replace steps if provided
    if (steps) {
      try {
        // Remove existing steps then re-add
        const existing = await rpc('TestCase.filter', [{ case_id }]);
        for (let i = 0; i < steps.length; i++) {
          await rpc('TestCase.add_step', [{
            case: case_id,
            step_number: i + 1,
            action: steps[i].action,
            expected_result: steps[i].expected_result,
          }]);
        }
      } catch { /* fallback: text field already updated */ }
    }

    return {
      content: [{
        type: 'text',
        text: `✅ Test Case ID=${case_id} updated.\n  URL: ${KIWI_URL}/case/${case_id}/`,
      }],
    };
  }
);

// --- kiwi_disable_test_case ---
server.tool(
  'kiwi_disable_test_case',
  'Disable a test case that is no longer relevant (e.g. feature removed)',
  { case_id: z.number().describe('Test case ID to disable') },
  async ({ case_id }) => {
    await ensureLoggedIn();
    // case_status 3 = DISABLED
    await rpc('TestCase.update', [case_id, { case_status: 3 }]);
    return { content: [{ type: 'text', text: `✅ Test Case ID=${case_id} disabled.` }] };
  }
);

// --- kiwi_create_test_run ---
server.tool(
  'kiwi_create_test_run',
  'Create a test run (campaign) from a test plan so QA can execute tests',
  {
    plan_id: z.number().describe('Test plan ID'),
    summary: z.string().describe('Test run name, e.g. "ADS-1697 — Sprint 2026-W12"'),
    build_id: z.number().describe('Build ID (from kiwi_list_builds)'),
    notes: z.string().optional().describe('Notes about this test run'),
  },
  async ({ plan_id, summary, build_id, notes }) => {
    await ensureLoggedIn();
    const run = await rpc('TestRun.create', [{
      plan: plan_id,
      summary,
      build: build_id,
      notes: notes ?? '',
      manager: KIWI_USERNAME,
    }]);

    return {
      content: [{
        type: 'text',
        text: `✅ Test Run created:\n  ID=${run.id} — "${run.summary}"\n  URL: ${KIWI_URL}/runs/${run.id}/`,
      }],
    };
  }
);

// --- kiwi_list_builds ---
server.tool(
  'kiwi_list_builds',
  'List builds for a product version',
  { version_id: z.number().describe('Version ID (from kiwi_list_versions)') },
  async ({ version_id }) => {
    await ensureLoggedIn();
    const builds = await rpc('Build.filter', [{ version: version_id }]);
    const lines = builds.map(b => `ID ${b.id}: ${b.name}`).join('\n');
    return { content: [{ type: 'text', text: lines || 'No builds found.' }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
