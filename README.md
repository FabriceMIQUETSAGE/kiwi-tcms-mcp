# kiwi-tcms-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes [Kiwi TCMS](https://kiwitcms.org/) as a set of AI-callable tools. It lets an AI assistant (e.g. Cursor, Claude Desktop) create and manage test plans, test cases, and test runs directly from a conversation.

## Features

The server registers the following tools:

| Tool | Description |
|---|---|
| `kiwi_list_products` | List all products |
| `kiwi_list_versions` | List versions for a product |
| `kiwi_list_test_plans` | List test plans, optionally filtered by product |
| `kiwi_create_test_plan` | Create a new test plan |
| `kiwi_list_test_cases` | List test cases in a test plan |
| `kiwi_create_test_case` | Create a test case with numbered steps and link it to a plan |
| `kiwi_update_test_case` | Update an existing test case |
| `kiwi_disable_test_case` | Disable a test case that is no longer relevant |
| `kiwi_list_builds` | List builds for a product version |
| `kiwi_create_test_run` | Create a test run (campaign) from a test plan |

## Requirements

- Node.js 18+
- A running Kiwi TCMS instance (self-hosted or cloud)

## Installation

```bash
npm install
```

## Configuration

The server is configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `KIWI_URL` | `http://51.44.84.19` | Base URL of your Kiwi TCMS instance |
| `KIWI_USERNAME` | _(empty)_ | Login username |
| `KIWI_PASSWORD` | _(empty)_ | Login password |

> Self-signed TLS certificates are accepted automatically, which is useful for self-hosted instances.

## Usage

### Running the server directly

```bash
KIWI_URL=https://your-kiwi-instance \
KIWI_USERNAME=your_user \
KIWI_PASSWORD=your_pass \
npm start
```

The server communicates over **stdio** using the MCP protocol.

### Cursor / Claude Desktop integration

Add the server to your MCP configuration file (e.g. `~/.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kiwi-tcms": {
      "command": "node",
      "args": ["/absolute/path/to/kiwi-tcms-mcp/src/index.js"],
      "env": {
        "KIWI_URL": "https://your-kiwi-instance",
        "KIWI_USERNAME": "your_user",
        "KIWI_PASSWORD": "your_pass"
      }
    }
  }
}
```

Once configured, you can ask the AI to create test plans and cases in natural language:

> "Generate test cases for ADS-1697 and push them to Kiwi TCMS under the AWA product."

## One-off scripts

`push-ads-1697.js` is an example standalone script that creates a full test plan (10 test cases + a test run) for ticket ADS-1697 directly via the JSON-RPC API, without going through the MCP server. It serves as a reference for bulk-loading test cases programmatically:

```bash
node push-ads-1697.js
```

## Cursor AI Skill

A ready-to-use [Cursor agent skill](https://docs.cursor.com/context/rules-for-ai) is included in `skills/kiwi-tcms-test-generation/SKILL.md`. Once installed, you can ask Cursor to generate and push a full test plan from a feature branch with a single prompt.

### What the skill does

- Reads your PRD, design docs, and implementation plans
- Extracts test scenarios (happy path, edge cases, access control, regressions)
- Pushes test cases to Kiwi TCMS via the MCP tools
- Supports both **new generation** and **updating after a doc change**

### Installation

**1. Copy the skill to the Cursor global skills folder:**

```bash
mkdir -p ~/.agents/skills/kiwi-tcms-test-generation
cp skills/kiwi-tcms-test-generation/SKILL.md \
   ~/.agents/skills/kiwi-tcms-test-generation/SKILL.md
```

**2. Edit the copied file and replace all placeholders** (search for `<REPLACE_`):

| Placeholder | Description | Example |
|---|---|---|
| `<REPLACE_KIWI_URL>` | Base URL of your Kiwi TCMS instance | `https://tcms.example.com` |
| `<REPLACE_MCP_SERVER_PATH>` | Absolute path to `src/index.js` on your machine | `/home/alice/kiwi-tcms-mcp/src/index.js` |

All other values in the skill (product name/ID, version, ticket prefix, doc paths) are concrete examples from the reference project — adapt them to your setup if they differ.

**3. Make sure the MCP server is registered** in `~/.cursor/mcp.json` (see [Cursor / Claude Desktop integration](#cursor--claude-desktop-integration) above).

**4. Restart Cursor** for the skill and the MCP server to be picked up.

### Usage

Once installed, trigger it with a natural language prompt in Cursor:

> "Generate tests for ADS-1234 and push them to Kiwi TCMS."  
> "Update Kiwi tests after the PRD change on ADS-1234."

## Project structure

```
src/
  index.js                              # MCP server — tool definitions and JSON-RPC helpers
skills/
  kiwi-tcms-test-generation/
    SKILL.md                            # Cursor AI skill template (copy to ~/.agents/skills/)
push-ads-1697.js                        # Standalone example: bulk-create test cases for ADS-1697
package.json
```

## How it works

1. On first tool call the server authenticates with `Auth.login` and stores the session cookie.
2. Every subsequent call reuses that session — no re-login overhead.
3. Tools communicate with the Kiwi TCMS [JSON-RPC API](https://kiwitcms.readthedocs.io/en/latest/api/index.html) (`POST /json-rpc/`).
4. When creating test cases, steps are stored both in the text field (for older Kiwi versions) and via `TestCase.add_step` (for newer versions that support it).
