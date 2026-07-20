/**
 * Catalog of first-class packages mirrored under monorepo packages/
 * and vendored for the open-source cheshire-terminal-agents tree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @typedef {{
 *  id: string;
 *  name: string;
 *  kind: "typescript" | "foundry" | "anchor";
 *  path: string;
 *  monorepoPath: string;
 *  entry?: string;
 *  description: string;
 * }} PackageEntry */

/** @type {PackageEntry[]} */
export const PACKAGE_CATALOG = Object.freeze([
  Object.freeze({
    id: "clawd-agent-tui",
    name: "@cheshire/clawd-agent-tui",
    kind: "typescript",
    path: "packages/clawd-agent-tui",
    monorepoPath: "packages/clawd-agent-tui",
    entry: "src/cli.ts",
    description: "ZK Shark agent TUI with nullifier / Groth16 / omnichain tools",
  }),
  Object.freeze({
    id: "headless-agent",
    name: "@cheshire/headless-agent",
    kind: "typescript",
    path: "packages/headless-agent",
    monorepoPath: "packages/headless-agent",
    entry: "src/cli.ts",
    description: "Headless Solana + Robinhood EVM agent harness (zero local retention)",
  }),
  Object.freeze({
    id: "layerzero-omnichain",
    name: "@cheshire/layerzero-omnichain",
    kind: "foundry",
    path: "packages/layerzero-omnichain",
    monorepoPath: "packages/layerzero-omnichain",
    description: "LayerZero omnichain notes / stubs (canonical contracts in my-lz-oapp/)",
  }),
  Object.freeze({
    id: "solana-agent-trust",
    name: "@cheshire/solana-agent-trust",
    kind: "anchor",
    path: "packages/solana-agent-trust",
    monorepoPath: "packages/solana-agent-trust",
    description: "Anchor reputation/validation program for MPL Core agent identities",
  }),
]);

export function listPackageIds() {
  return PACKAGE_CATALOG.map((entry) => entry.id);
}

/**
 * Resolve package directory under this robinhood-agents tree.
 * @param {string} id
 */
export function resolvePackageDir(id) {
  const entry = PACKAGE_CATALOG.find((row) => row.id === id);
  if (!entry) throw new Error(`Unknown package id: ${id}`);
  return path.join(ROOT, entry.path);
}

/**
 * Inspect local presence of all catalog packages (source only; no node_modules).
 */
export function inspectPackages() {
  return PACKAGE_CATALOG.map((entry) => {
    const abs = path.join(ROOT, entry.path);
    const packageJsonPath = path.join(abs, "package.json");
    let packageJson = null;
    if (existsSync(packageJsonPath)) {
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      } catch {
        packageJson = { error: "invalid package.json" };
      }
    }
    const markers = {
      packageJson: existsSync(packageJsonPath),
      readme: existsSync(path.join(abs, "README.md")),
      entry: entry.entry ? existsSync(path.join(abs, entry.entry)) : null,
      cargoToml: existsSync(path.join(abs, "Cargo.toml")),
      foundryToml: existsSync(path.join(abs, "foundry.toml")),
      anchorToml: existsSync(path.join(abs, "Anchor.toml")),
      src: existsSync(path.join(abs, "src")) || existsSync(path.join(abs, "programs")),
    };
    const present = existsSync(abs) && markers.readme && (
      entry.kind === "typescript"
        ? Boolean(markers.packageJson && markers.entry)
        : entry.kind === "anchor"
          ? Boolean(markers.anchorToml && markers.cargoToml)
          : Boolean(markers.foundryToml)
    );
    return {
      ...entry,
      absolutePath: abs,
      present,
      markers,
      version: packageJson?.version ?? null,
    };
  });
}
