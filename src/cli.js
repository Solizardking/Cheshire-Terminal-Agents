#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  assertSponsoredMintAuthorization,
  canonicalDeployments,
  createAgentForge,
  frameworkCapabilities,
  prepareCanonicalEvmRegistration,
} from "./index.js";

const USAGE = `robinhood-agents <command> [options]

Read-only / unsigned:
  capabilities [--site URL]
  deployments [--chain 4663|46630]
  prepare-local-robinhood --file registration.json [--chain 4663|46630]
  prepare-robinhood --file registration.json [--site URL]
  inspect --platform robinhood|solana --id ID [--chain 4663|46630] [--site URL]

Live write:
  mint-solana --confirm-live-mint --file signed-mint.json [--site URL]

Environment:
  CHESHIRE_SITE_URL   default hosted API origin
  CHESHIRE_API_KEY    optional bearer credential for hosted access`;

function parseArgs(values) {
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === "confirm-live-mint") {
      flags[name] = true;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

async function readJsonFile(file, command) {
  if (!file) throw new Error(`${command} requires --file FILE`);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseChainId(value, fallback = 4663) {
  const chainId = Number(value ?? fallback);
  if (chainId !== 4663 && chainId !== 46630) throw new Error("--chain must be 4663 or 46630");
  return chainId;
}

const [command = "help", ...rawArgs] = process.argv.slice(2);

try {
  const flags = parseArgs(rawArgs);
  const forge = createAgentForge({
    baseUrl: flags.site || process.env.CHESHIRE_SITE_URL || "https://cheshireterminal.ai",
    apiKey: process.env.CHESHIRE_API_KEY,
  });
  let output;

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (command === "capabilities") {
    output = await forge.capabilities();
  } else if (command === "deployments") {
    output = flags.chain
      ? canonicalDeployments[String(parseChainId(flags.chain))]
      : { framework: frameworkCapabilities, deployments: canonicalDeployments };
  } else if (command === "prepare-local-robinhood") {
    const input = await readJsonFile(flags.file, command);
    if (input.platform && input.platform !== "robinhood") {
      throw new Error("prepare-local-robinhood only accepts platform=robinhood");
    }
    output = prepareCanonicalEvmRegistration({
      ...input,
      chainId: parseChainId(flags.chain ?? input.chainId, 46630),
    });
  } else if (command === "prepare-robinhood" || command === "prepare") {
    const input = await readJsonFile(flags.file, command);
    if ((flags.platform || input.platform || "robinhood") !== "robinhood") {
      throw new Error("Use mint-solana for the explicitly live Solana Core mint");
    }
    output = await forge.prepareRobinhood(input);
  } else if (command === "mint-solana") {
    if (!flags["confirm-live-mint"]) throw new Error("mint-solana requires --confirm-live-mint");
    const input = await readJsonFile(flags.file, command);
    assertSponsoredMintAuthorization(input);
    output = await forge.mintSolana(input);
  } else if (command === "inspect") {
    const platform = flags.platform;
    if (platform !== "robinhood" && platform !== "solana") {
      throw new Error("inspect requires --platform robinhood or --platform solana");
    }
    if (!flags.id) throw new Error("inspect requires --id ID");
    output = await forge.inspect({
      platform,
      id: flags.id,
      chainId: platform === "robinhood" ? parseChainId(flags.chain) : undefined,
    });
  } else {
    throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }

  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
