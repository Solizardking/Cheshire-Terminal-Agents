/**
 * RH crypto-agent skill pack vendored from go-bot — discovery + completeness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RH_CRYPTO_AGENT_PACK_DIR,
  RH_CRYPTO_AGENT_PACK_INDEX_PATH,
  getRhCryptoAgentSkillsDir,
  inspectRhCryptoAgentPack,
  listRhCryptoAgentSkillIds,
  listSkillDirectoriesWithSkillMd,
  loadRhCryptoAgentCatalog,
  loadRhCryptoAgentPackIndex,
  clawdbotSkillsDirExportLine,
} from "../src/skillPack.js";
import { listCatalogIdentifiers, validateCatalog } from "../src/agentCatalog.js";

test("RH skill pack pack-index is present and complete", () => {
  assert.ok(
    existsSync(RH_CRYPTO_AGENT_PACK_INDEX_PATH),
    "pack-index.json must be vendored",
  );
  const pack = loadRhCryptoAgentPackIndex();
  assert.equal(pack.id, "rh-crypto-agent");
  assert.ok(Array.isArray(pack.skills));
  assert.equal(pack.skills.length, pack.skillCount);
  assert.equal(pack.skills.length, 16, "open RH pack is 16 skills");
  assert.ok(pack.skills.includes("rh-bonded-launch"));
  assert.ok(pack.skills.includes("rh-launchpad-v3"));
  assert.ok(pack.skills.includes("viem-integration"));
});

test("inspectRhCryptoAgentPack verifies every SKILL.md from pack-index", () => {
  const report = inspectRhCryptoAgentPack();
  assert.equal(report.ok, true, `missing skills: ${report.missing.join(", ")}`);
  assert.equal(report.skillCount, 16);
  for (const skill of report.skills) {
    assert.equal(skill.skillMd, true, `${skill.id} needs SKILL.md`);
    assert.ok(existsSync(join(skill.path, "SKILL.md")));
    const body = readFileSync(join(skill.path, "SKILL.md"), "utf8");
    assert.ok(body.length > 40, `${skill.id} SKILL.md too short`);
  }
  // Pack-index is the source of truth — drive listing from shipped helper
  assert.deepEqual(listRhCryptoAgentSkillIds(), report.skills.map((s) => s.id));
});

test("CLAWDBOT_SKILLS_DIR points at pack root with skill directories", () => {
  const dir = getRhCryptoAgentSkillsDir();
  assert.equal(dir, RH_CRYPTO_AGENT_PACK_DIR);
  assert.ok(existsSync(join(dir, "pack-index.json")));
  const dirs = listSkillDirectoriesWithSkillMd(dir);
  assert.ok(dirs.includes("rh-bonded-launch"));
  assert.ok(dirs.includes("swap-integration"));
  // pack-index skills ⊆ directory listing
  for (const id of listRhCryptoAgentSkillIds()) {
    assert.ok(dirs.includes(id), `directory missing for ${id}`);
  }
  assert.match(clawdbotSkillsDirExportLine(), /CLAWDBOT_SKILLS_DIR=/);
  assert.match(clawdbotSkillsDirExportLine(), /rh-crypto-agent/);
});

test("catalog.json covers pack skill slugs", () => {
  const catalog = loadRhCryptoAgentCatalog();
  assert.ok(catalog.length >= 16);
  const slugs = new Set(catalog.map((e) => e.slug || e.name));
  for (const id of listRhCryptoAgentSkillIds()) {
    assert.ok(slugs.has(id), `catalog missing slug ${id}`);
  }
});

test("agent catalog non-regression after skill pack vendoring", () => {
  const ids = listCatalogIdentifiers();
  assert.ok(ids.length >= 50, `expected full agent catalog, got ${ids.length}`);
  const report = validateCatalog();
  assert.equal(report.ok, true, JSON.stringify(report.failed || report, null, 2));
  // forge skill still present
  assert.ok(
    existsSync(
      join(RH_CRYPTO_AGENT_PACK_DIR, "..", "robinhood-agent-forge", "SKILL.md"),
    ),
    "robinhood-agent-forge must remain alongside the RH pack",
  );
});
