#!/usr/bin/env node
/**
 * Import character + DeFi agents into robinhood-agents/agents as Cheshire-schema JSON.
 *
 * Sources:
 *   - agents/characters/*.json (except package.json)
 *   - agents/defi-agents/src/*.json
 * Schema:
 *   - agents/defi-agents/schema/Cheshire_agent_schema.json (vendored under schema/)
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENTS_DIR,
  PACKAGE_ROOT,
  SCHEMA_PATH,
  convertCharacterToCheshireAgent,
  normalizeDefiAgent,
  validateCheshireAgent,
  characterIdentifierFromStem,
} from "../src/agentCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_ROOT, "..");
const CHARACTERS_DIR = join(REPO_ROOT, "agents", "characters");
const DEFI_SRC_DIR = join(REPO_ROOT, "agents", "defi-agents", "src");
const DEFI_SCHEMA = join(REPO_ROOT, "agents", "defi-agents", "schema", "Cheshire_agent_schema.json");

function ensureSchema() {
  mkdirSync(dirname(SCHEMA_PATH), { recursive: true });
  if (!existsSync(DEFI_SCHEMA)) {
    throw new Error(`Missing schema at ${DEFI_SCHEMA}`);
  }
  copyFileSync(DEFI_SCHEMA, SCHEMA_PATH);
}

function listJsonStems(dir, exclude = new Set()) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !exclude.has(f))
    .map((f) => basename(f, ".json"))
    .sort();
}

function main() {
  ensureSchema();
  mkdirSync(AGENTS_DIR, { recursive: true });

  const characterStems = listJsonStems(CHARACTERS_DIR, new Set(["package.json"]));
  const defiStems = listJsonStems(DEFI_SRC_DIR);

  const results = { written: [], failed: [] };

  for (const stem of defiStems) {
    const identifier = stem;
    try {
      const source = JSON.parse(readFileSync(join(DEFI_SRC_DIR, `${stem}.json`), "utf8"));
      const agent = normalizeDefiAgent(source, identifier);
      const validation = validateCheshireAgent(agent);
      if (!validation.ok) {
        throw new Error(validation.errors.join("; "));
      }
      const outPath = join(AGENTS_DIR, `${identifier}.json`);
      writeFileSync(outPath, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
      results.written.push({ identifier, source: "defi", path: outPath });
    } catch (err) {
      results.failed.push({ identifier, source: "defi", error: err.message });
    }
  }

  for (const stem of characterStems) {
    const identifier = characterIdentifierFromStem(stem);
    try {
      const source = JSON.parse(readFileSync(join(CHARACTERS_DIR, `${stem}.json`), "utf8"));
      const agent = convertCharacterToCheshireAgent(source, identifier);
      const validation = validateCheshireAgent(agent);
      if (!validation.ok) {
        throw new Error(validation.errors.join("; "));
      }
      const outPath = join(AGENTS_DIR, `${identifier}.json`);
      writeFileSync(outPath, `${JSON.stringify(agent, null, 2)}\n`, "utf8");
      results.written.push({ identifier, source: "character", path: outPath });
    } catch (err) {
      results.failed.push({ identifier, source: "character", error: err.message });
    }
  }

  const summary = {
    schema: SCHEMA_PATH,
    agentsDir: AGENTS_DIR,
    characterSourceCount: characterStems.length,
    defiSourceCount: defiStems.length,
    written: results.written.length,
    failed: results.failed.length,
    identifiers: results.written.map((w) => w.identifier).sort(),
    failures: results.failed,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (results.failed.length > 0) {
    process.exitCode = 1;
  }
}

main();
