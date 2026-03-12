---
name: kiwi-tcms-test-generation
description: Generate business-level test scenarios from a feature branch and push them to Kiwi TCMS. Use when asked to "generate tests for ADS-XXXX", "push tests to Kiwi", or "update tests after PRD change".
---

<!--
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSTALLATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Copy this file to the Cursor global skills folder:

   mkdir -p ~/.agents/skills/kiwi-tcms-test-generation
   cp skills/kiwi-tcms-test-generation/SKILL.md \
      ~/.agents/skills/kiwi-tcms-test-generation/SKILL.md

2. In the copied file, replace the two placeholders below with your own values:

   Placeholder               | Description
   ──────────────────────────┼──────────────────────────────────────────────────
   <REPLACE_KIWI_URL>        | Base URL of your Kiwi TCMS instance
                             | e.g. https://tcms.example.com
   <REPLACE_MCP_SERVER_PATH> | Absolute path to src/index.js on your machine
                             | e.g. /home/alice/kiwi-tcms-mcp/src/index.js

   All other values (product name, IDs, ticket prefix, doc paths) are shown
   as concrete examples from the reference project. Adapt them to your setup
   if they differ.

3. In ~/.cursor/mcp.json, add the kiwi-tcms server under "mcpServers"
   (see the README for the full snippet).

4. Restart Cursor for the MCP server and the skill to be picked up.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
-->

# Kiwi TCMS Test Generation

## Overview

Analyse a feature branch using one or more reference documents (PRD, Superpowers design doc, implementation plan) and generate QA test scenarios in numbered steps, then push them directly to Kiwi TCMS via MCP tools. Test cases are written in business language for a non-developer QA team.

**Announce at start:** "I'm using the kiwi-tcms-test-generation skill."

**MCP server required:** `user-kiwi-tcms` (configured in `~/.cursor/mcp.json`)  
**Kiwi instance:** `<REPLACE_KIWI_URL>`  
**AWA Product ID:** 1 | **Version 14.30 ID:** 3

---

## STEP -1 — Bootstrap check (run once, before everything else)

Before any other step, verify the MCP server is configured:

```bash
cat ~/.cursor/mcp.json | grep -A 6 "kiwi-tcms"
```

**If the `kiwi-tcms` entry is missing**, offer to create it:

```
⚙️ Le MCP server Kiwi TCMS n'est pas configuré dans ~/.cursor/mcp.json.
Je peux l'ajouter maintenant. J'ai besoin de :
  - Ton username Kiwi TCMS
  - Ton password Kiwi TCMS
  (L'URL est déjà connue : <REPLACE_KIWI_URL>)
```

Then add the entry to `~/.cursor/mcp.json` under `mcpServers`:

```json
"kiwi-tcms": {
  "command": "node",
  "args": ["<REPLACE_MCP_SERVER_PATH>"],
  "env": {
    "KIWI_URL": "<REPLACE_KIWI_URL>",
    "KIWI_USERNAME": "<provided>",
    "KIWI_PASSWORD": "<provided>"
  }
}
```

Then remind: **Redémarre Cursor pour que le MCP soit pris en compte.**

**If the entry exists**, verify connectivity:

```bash
node -e "
import fetch from 'node-fetch';
import https from 'https';
const agent = new https.Agent({ rejectUnauthorized: false });
const res = await fetch('<REPLACE_KIWI_URL>/json-rpc/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'Auth.login',
    params: [process.env.KIWI_USERNAME, process.env.KIWI_PASSWORD] }),
  agent,
});
const j = await res.json();
console.log(j.result ? '✅ Connexion OK' : '❌ ' + j.error?.message);
" --input-type=module
```

If connection fails, show the error and stop. Don't proceed with a broken connection.

---

## STEP 0 — Interactive clarification (MANDATORY, always run first)

Before doing anything else, ask these two questions **one at a time**:

### Question 1 — Reference documents

List the available documents found in the project, then ask:

```
Which documents should I use as reference to generate the tests?
(You can select multiple)

[ ] PRD → docs/prds/ (critères d'acceptation par US)
[ ] Design document Superpowers → docs/plans/*-design.md (architecture, approches)
[ ] Plan d'implémentation Superpowers → docs/plans/*.md (tâches détaillées)
[ ] Autre → précise le chemin
```

**How to list available docs:** Before asking, scan:
- `docs/prds/` for files matching the ticket number or feature name
- `docs/plans/` for files matching the ticket number or feature name (both `*-design.md` and plan files)

Present the actual filenames found so the user can choose precisely.

### Question 2 — Scope

```
Quel est le périmètre de cette génération ?

( ) Tout le ticket ADS-XXXX (toutes les US)
( ) Uniquement les US nouvellement ajoutées / modifiées
( ) Une US spécifique → laquelle ?
```

Only after getting answers to both questions, proceed to Step 1.

---

## Workflow A — New generation (feature branch complete)

### Step 1 — Read selected documents

Read each selected document fully. Extract:

**From PRD (`docs/prds/`):**
- Acceptance criteria per US
- Edge cases mentioned
- Rights and feature flags required

**From Superpowers design doc (`docs/plans/*-design.md`):**
- Architecture decisions and their rationale
- Proposed approaches (especially rejected ones → often reveal edge cases)
- Component interactions and data flows

**From Superpowers implementation plan (`docs/plans/*.md`):**
- Detailed task list → reveals which components are touched
- Testing notes written during planning
- Known risks or constraints flagged by the planner

**Cross-reference all sources.** Design docs and plans often contain test scenarios that weren't captured in the PRD (e.g. error states, race conditions, UI details).

### Step 2 — Identify scenarios

For each User Story (or selected scope), extract:

| Priority | Type | Source hint |
|----------|------|-------------|
| P1 | Happy path — main functional flow | PRD acceptance criteria |
| P1 | Rights / feature flags | PRD US-F6 pattern |
| P2 | Empty states, no data | PRD + design doc |
| P2 | Error states, conflict handling | Design doc (rejected approaches often reveal these) |
| P2 | Regression — existing features still work | Implementation plan (modified files list) |
| P3 | Edge cases at boundaries | Design doc + plan notes |

Rule: **1 test case = 1 acceptance criterion**. Max 8 steps per test case.

### Step 3 — Push to Kiwi via MCP

Call in this order:

```
1. kiwi_list_products          → confirm AWA = ID 1
2. kiwi_list_versions          → confirm 14.30 = ID 3
3. kiwi_create_test_plan       → name: "ADS-XXXX — [Feature Name]"
4. kiwi_create_test_case       → one call per test case
5. kiwi_list_builds            → find current build
6. kiwi_create_test_run        → create execution campaign for QA
```

### Step 4 — Summary

```
✅ X test cases créés
Sources utilisées : [liste des docs]

📋 Test Plan : <REPLACE_KIWI_URL>/plan/<id>/
🏃 Test Run  : <REPLACE_KIWI_URL>/runs/<id>/

| ID Kiwi | Titre | Source | US | Priorité |
|---------|-------|--------|----|---------|
```

---

## Workflow B — Update after PRD or design doc change

### Step 0 — Interactive clarification

Same as above. Additionally ask:

```
Qu'est-ce qui a changé ?
( ) Le PRD a été mis à jour
( ) Le design doc Superpowers a été mis à jour
( ) Le plan d'implémentation a été mis à jour
( ) Plusieurs documents ont changé
```

### Step 1 — Diff the changed documents

```bash
git diff main -- docs/prds/**/*ADS-XXXX*.md
git diff main -- docs/plans/*ADS-XXXX*
```

Classify changes:
- Added lines (`+`) → new US or new criteria → new test cases
- Removed lines (`-`) → abandoned US or removed criteria → disable test cases
- Modified lines → refined criteria → update test cases

### Step 2 — Map existing test cases

```
kiwi_list_test_cases(plan_id)
```

Link each existing TC (by title TC-XX) to its source US.

### Step 3 — Apply changes

| Situation | Action |
|-----------|--------|
| New US or criterion | `kiwi_create_test_case` |
| Modified criterion | `kiwi_update_test_case` |
| Abandoned US | `kiwi_disable_test_case` |
| New decision/clarification in design doc | `kiwi_update_test_case` (enrich steps) |

### Step 4 — New Test Run if needed

If the update corresponds to a new sprint or iteration, create a new Test Run.

---

## Test case format

```yaml
summary: "TC-XX — [Short title describing the scenario]"
preconditions: |
  - Required user profile (rights, role)
  - Required data in database
  - Required Izanami feature flags
steps:
  - action: "Concrete action in business language"
    expected_result: "What the QA must observe"
notes: "Ticket: ADS-XXXX | US: US-FX | Source: PRD/Design/Plan | Priority: P1"
```

**Language rules:**
- ✅ "Cliquer sur le bouton 'Start task'"
- ✅ "Vérifier que la card est affichée en rouge"
- ❌ "click on .btn-primary" (no CSS selectors)
- ❌ "check that state.deadline < 24" (no code)

---

## Fixed values for this Kiwi instance

| Field | Value |
|-------|-------|
| Product AWA | ID = 1 |
| Version 14.30 | ID = 3 |
| case_status CONFIRMED | ID = 2 |
| case_status DISABLED | ID = 3 |
| priority P2 (default) | ID = 2 |
| category --default-- | ID = 1 |

---

## Document locations summary

| Document type | Location | Generated by |
|--------------|----------|--------------|
| PRD | `docs/prds/**/*.md` | Developer (manually) |
| Design document | `docs/plans/*-design.md` | Superpowers `brainstorming` skill |
| Implementation plan | `docs/plans/*.md` | Superpowers `writing-plans` skill |
| E2E tests (reference) | `apps/awa-client/playwright/tests/` | Developer / AI |
