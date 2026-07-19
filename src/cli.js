#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createAgentForge } from "./index.js";
const [command, ...args] = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const forge = createAgentForge({ baseUrl: flag("site", process.env.CHESHIRE_SITE_URL || "https://cheshireterminal.ai"), apiKey: process.env.CHESHIRE_API_KEY });
try {
  if (command === "capabilities") console.log(JSON.stringify(await forge.capabilities(), null, 2));
  else if (command === "prepare-robinhood" || command === "prepare") {
    const file = flag("file"); if (!file) throw new Error("prepare-robinhood requires --file registration.json");
    const input = JSON.parse(await readFile(file, "utf8"));
    if (flag("platform", input.platform || "robinhood") !== "robinhood") throw new Error("Use mint-solana for the live Solana write");
    console.log(JSON.stringify(await forge.prepareRobinhood(input), null, 2));
  } else if (command === "mint-solana") {
    if (!args.includes("--confirm-live-mint")) throw new Error("mint-solana requires --confirm-live-mint");
    const file = flag("file"); if (!file) throw new Error("mint-solana requires --file signed-mint.json");
    const input = JSON.parse(await readFile(file, "utf8"));
    if (!input.ownerPubkey || !input.walletMessage || !input.walletSignature) throw new Error("signed Solana mint requires ownerPubkey, walletMessage, and walletSignature");
    console.log(JSON.stringify(await forge.mintSolana(input), null, 2));
  } else if (command === "inspect") console.log(JSON.stringify(await forge.inspect({ platform: flag("platform"), id: flag("id"), chainId: Number(flag("chain", "4663")) }), null, 2));
  else console.log("robinhood-agents <capabilities|prepare-robinhood|mint-solana|inspect> [--platform robinhood|solana] [--file JSON] [--id ID] [--site URL]");
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
