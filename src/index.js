import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { encodeFunctionData, isAddress } from "viem";
import {
  assertCanonicalRuntimeCode,
  canonicalDeployments,
  getCanonicalContract,
  getCanonicalDeployment,
  inspectCanonicalRuntimeCode,
} from "./deployments.js";

export {
  assertCanonicalRuntimeCode,
  canonicalDeployments,
  getCanonicalContract,
  getCanonicalDeployment,
  inspectCanonicalRuntimeCode,
};

export {
  AGENTS_DIR,
  SCHEMA_PATH,
  PACKAGE_ROOT,
  estimateTokenUsage,
  loadCheshireSchema,
  validateCheshireAgent,
  listCatalogIdentifiers,
  loadCatalog,
  validateCatalog,
  convertCharacterToCheshireAgent,
  normalizeDefiAgent,
  characterIdentifierFromStem,
  expectedCatalogIdentifiers,
} from "./agentCatalog.js";

export const platforms = Object.freeze({
  robinhood: Object.freeze({
    vm: "evm",
    chainId: 4663,
    testnetChainId: 46630,
    identityAsset: "ERC-721 ERC-8004 registry record",
    fungibleTokenLaunch: "not-in-this-package",
  }),
  solana: Object.freeze({
    vm: "svm",
    cluster: "mainnet-beta",
    testnetCluster: "devnet",
    identityAsset: "hosted Metaplex Core asset",
    fungibleTokenLaunch: "production-paused",
  }),
});

export const frameworkCapabilities = Object.freeze({
  robinhood: Object.freeze({
    localUnsignedRegistration: true,
    hostedUnsignedRegistration: "configuration-dependent",
    registryInfrastructureDeployment: "guarded-foundry-tooling",
    identityStandard: "ERC-8004 registration-v1 compatibility",
    fungibleAgentTokenLaunch: false,
  }),
  solana: Object.freeze({
    hostedSponsoredCoreMint: "health-and-policy-dependent",
    walletAuthorization: "CLAWD_AGENT_MINT_V2",
    agentIdentityRegistration: "attempted-after-core-mint",
    fungibleAgentTokenLaunch: "production-paused",
  }),
});

export const identityRegistryAbi = Object.freeze([
  Object.freeze({
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: Object.freeze([{ name: "agentURI", type: "string" }]),
    outputs: Object.freeze([{ name: "agentId", type: "uint256" }]),
  }),
]);

export const SPONSORED_MINT_AUTHORIZATION_VERSION = "CLAWD_AGENT_MINT_V2";
export const SPONSORED_MINT_AUTHORIZATION_MAX_AGE_MS = 5 * 60 * 1_000;
export const SPONSORED_MINT_AUTHORIZATION_MAX_FUTURE_SKEW_MS = 30 * 1_000;

const ZERO_ADDRESS = /^0x0{40}$/i;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function text(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function boundedTextArray(value, field, maxItems, maxLength) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maxItems) throw new Error(`${field} cannot contain more than ${maxItems} entries`);
  return value.map((item, index) => text(item, `${field}[${index}]`, maxLength));
}

export function buildRegistration(input) {
  if (!input || typeof input !== "object") throw new Error("registration input is required");
  const image = text(input.image, "image", 2_048);
  if (!/^(https:\/\/|ipfs:\/\/|data:image\/)/i.test(image)) {
    throw new Error("image must use https://, ipfs://, or a data:image URI");
  }

  const rawServices = input.services ?? [];
  if (!Array.isArray(rawServices)) throw new Error("services must be an array");
  if (rawServices.length > 20) throw new Error("services cannot contain more than 20 entries");
  const services = rawServices.map((item, index) => ({
    name: text(item?.name, `services[${index}].name`, 64),
    endpoint: text(item?.endpoint, `services[${index}].endpoint`, 2_048),
    ...(optionalText(item?.version, `services[${index}].version`, 64)
      ? { version: optionalText(item.version, `services[${index}].version`, 64) }
      : {}),
    ...(item?.skills !== undefined
      ? { skills: boundedTextArray(item.skills, `services[${index}].skills`, 64, 128) }
      : {}),
    ...(item?.domains !== undefined
      ? { domains: boundedTextArray(item.domains, `services[${index}].domains`, 64, 128) }
      : {}),
  }));
  const supportedTrust = boundedTextArray(input.supportedTrust, "supportedTrust", 32, 64);

  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: text(input.name, "name", 160),
    description: text(input.description, "description", 4_000),
    image,
    services,
    x402Support: input.x402Support === true,
    active: input.active !== false,
    registrations: [],
    ...(supportedTrust.length ? { supportedTrust } : {}),
  };
}

export const registrationDataUri = (document) => (
  `data:application/json;base64,${Buffer.from(JSON.stringify(document), "utf8").toString("base64")}`
);

export function prepareEvmRegistration({ chainId = 46630, registry, agentURI, ...input }) {
  const manifest = getCanonicalDeployment(chainId);
  if (!isAddress(registry) || ZERO_ADDRESS.test(registry)) {
    throw new Error("a valid, nonzero trusted registry address is required");
  }
  const registration = buildRegistration(input);
  const uri = agentURI ? text(agentURI, "agentURI", 16_384) : registrationDataUri(registration);
  const canonicalIdentity = manifest.contracts.identity;
  const canonicalRegistry = registry.toLowerCase() === canonicalIdentity.address.toLowerCase();

  return Object.freeze({
    vm: "evm",
    network: "robinhood",
    chainId: Number(chainId),
    to: registry,
    data: encodeFunctionData({
      abi: identityRegistryAbi,
      functionName: "register",
      args: [uri],
    }),
    value: "0x0",
    agentURI: uri,
    registration,
    canonicalRegistry,
    canonicalAddress: canonicalIdentity.address,
    expectedRuntimeCodeHash: canonicalRegistry ? canonicalIdentity.runtimeCodeHash : null,
    expectedRuntimeBytes: canonicalRegistry ? canonicalIdentity.runtimeBytes : null,
  });
}

/** Prepare against the reviewed manifest address without contacting an RPC or wallet. */
export function prepareCanonicalEvmRegistration({ chainId = 46630, ...input }) {
  const registry = getCanonicalContract(chainId, "identity").address;
  return prepareEvmRegistration({ ...input, chainId, registry });
}

function normalizeSponsoredMintName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 64);
}

function normalizeSponsoredMintSymbol(value) {
  const symbol = String(value || "AGENT")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  return symbol || "AGENT";
}

function normalizeSponsoredMintCapabilities(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
}

function normalizeSponsoredMintImageUri(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().slice(0, 2_048);
  return /^(https:\/\/|ipfs:\/\/|ar:\/\/|data:image\/)/i.test(trimmed) ? trimmed : "";
}

function normalizeSponsoredMintRegistrationUri(input) {
  if (typeof input.customRegistrationUri === "string" && input.customRegistrationUri.trim()) {
    return input.customRegistrationUri.trim();
  }
  if (typeof input.agentRegistrationUri === "string" && input.agentRegistrationUri.trim()) {
    return input.agentRegistrationUri.trim();
  }
  // SDK-facing alias. serializeSponsoredMintRequest maps this normalized value
  // to the server-recognized customRegistrationUri field before submission.
  if (typeof input.registrationUri === "string" && input.registrationUri.trim()) {
    return input.registrationUri.trim();
  }
  if (typeof input.registrationDoc !== "string" || !input.registrationDoc) return "";
  if (/^(https:\/\/|data:)/.test(input.registrationDoc)) return input.registrationDoc;
  return `data:text/plain;base64,${Buffer.from(input.registrationDoc, "utf8").toString("base64")}`;
}

export function normalizeSponsoredMintIntent(input) {
  if (!input || typeof input !== "object") throw new Error("sponsored mint input is required");
  const owner = String(input.ownerPubkey || input.ownerAddress || input.owner || "").trim();
  const name = normalizeSponsoredMintName(input.name);
  const agentType = String(input.agentType || "general").trim().slice(0, 48) || "general";
  return Object.freeze({
    owner,
    name,
    symbol: normalizeSponsoredMintSymbol(input.symbol),
    description: String(input.description || `${agentType} AI agent on Solana`).trim().slice(0, 600),
    agentType,
    personality: String(input.personality || "neutral").trim().slice(0, 48) || "neutral",
    capabilities: Object.freeze(normalizeSponsoredMintCapabilities(input.capabilities)),
    imageUri: normalizeSponsoredMintImageUri(input.imageUri),
    registrationUri: normalizeSponsoredMintRegistrationUri(input),
  });
}

function canonicalSponsoredMintIntent(intent) {
  return JSON.stringify({
    owner: intent.owner,
    name: intent.name,
    symbol: intent.symbol,
    description: intent.description,
    agentType: intent.agentType,
    personality: intent.personality,
    capabilities: intent.capabilities,
    imageUri: intent.imageUri,
    registrationUri: intent.registrationUri,
  });
}

export function sponsoredMintIntentSha256(input) {
  return sponsoredMintNormalizedIntentSha256(normalizeSponsoredMintIntent(input));
}

function sponsoredMintNormalizedIntentSha256(intent) {
  return createHash("sha256").update(canonicalSponsoredMintIntent(intent), "utf8").digest("hex");
}

/** Build exact bytes for a wallet to sign. This function never signs or submits. */
export function buildSponsoredMintAuthorization(input, timestamp = Date.now()) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("Sponsored mint timestamp must be a positive integer");
  }
  if (!String(input?.name ?? "").trim()) throw new Error("name is required");
  if (!String(input?.agentType ?? "").trim()) throw new Error("agentType is required");
  const intent = normalizeSponsoredMintIntent(input);
  if (decodeBase58(intent.owner).length !== 32) {
    throw new Error("ownerPubkey must be a valid 32-byte Solana public key");
  }
  const message = [
    SPONSORED_MINT_AUTHORIZATION_VERSION,
    `owner:${intent.owner}`,
    `name:${encodeURIComponent(intent.name)}`,
    `timestamp:${timestamp}`,
    `intent-sha256:${sponsoredMintNormalizedIntentSha256(intent)}`,
  ].join("\n");
  return Object.freeze({ intent, message, timestamp });
}

function decodeBase58(value) {
  const textValue = String(value ?? "");
  if (!textValue) return Buffer.alloc(0);
  let number = 0n;
  for (const character of textValue) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return Buffer.alloc(0);
    number = number * 58n + BigInt(digit);
  }
  let encoded = Buffer.alloc(0);
  if (number > 0n) {
    let hex = number.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    encoded = Buffer.from(hex, "hex");
  }
  let leadingZeros = 0;
  while (textValue[leadingZeros] === "1") leadingZeros += 1;
  return Buffer.concat([Buffer.alloc(leadingZeros), encoded]);
}

function decodeCanonicalSignature(value) {
  if (typeof value !== "string" || value.length < 80 || value.length > 100) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== value) return null;
  return bytes;
}

/**
 * Verify the complete signed Solana mint envelope before it is sent to Cheshire.
 * The server still enforces freshness, holder policy, and durable replay protection.
 */
export function assertSponsoredMintAuthorization(input, { now = Date.now() } = {}) {
  if (typeof input?.walletMessage !== "string" || input.walletMessage.length > 2_048) {
    throw new Error("walletMessage must be a CLAWD_AGENT_MINT_V2 message");
  }
  const match = /^CLAWD_AGENT_MINT_V2\nowner:([^\n]+)\nname:([^\n]*)\ntimestamp:([1-9][0-9]{0,15})\nintent-sha256:([a-f0-9]{64})$/.exec(input.walletMessage);
  if (!match) throw new Error("walletMessage is not a canonical CLAWD_AGENT_MINT_V2 message");
  const timestamp = Number(match[3]);
  if (!Number.isSafeInteger(timestamp)) throw new Error("walletMessage timestamp is invalid");
  if (timestamp < now - SPONSORED_MINT_AUTHORIZATION_MAX_AGE_MS) {
    throw new Error("walletMessage has expired; sign a fresh authorization");
  }
  if (timestamp > now + SPONSORED_MINT_AUTHORIZATION_MAX_FUTURE_SKEW_MS) {
    throw new Error("walletMessage timestamp is too far in the future");
  }

  const expected = buildSponsoredMintAuthorization(input, timestamp);
  if (expected.message !== input.walletMessage) {
    throw new Error("walletMessage does not approve the complete normalized mint intent");
  }
  const signature = decodeCanonicalSignature(input.walletSignature);
  if (!signature) throw new Error("walletSignature must be canonical base64 for a 64-byte Ed25519 signature");
  const publicKeyBytes = decodeBase58(expected.intent.owner);
  if (publicKeyBytes.length !== 32) throw new Error("ownerPubkey must be a valid 32-byte Solana public key");

  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
    format: "der",
    type: "spki",
  });
  if (!verifySignature(null, Buffer.from(expected.message, "utf8"), publicKey, signature)) {
    throw new Error("walletSignature does not verify for ownerPubkey and walletMessage");
  }
  return expected;
}

/**
 * Serialize the signed normalized intent to fields accepted by the hosted
 * `/mint` route. In particular, the SDK alias `registrationUri` is sent as
 * `customRegistrationUri`, so the server reconstructs the exact signed digest.
 */
export function serializeSponsoredMintRequest(input, verifiedIntent) {
  const intent = verifiedIntent ?? assertSponsoredMintAuthorization(input).intent;
  const request = {
    ...input,
    ownerPubkey: intent.owner,
    name: intent.name,
    symbol: intent.symbol,
    description: intent.description,
    agentType: intent.agentType,
    personality: intent.personality,
    capabilities: [...intent.capabilities],
    imageUri: intent.imageUri,
    customRegistrationUri: intent.registrationUri,
  };
  delete request.owner;
  delete request.ownerAddress;
  delete request.registrationUri;
  delete request.agentRegistrationUri;
  delete request.registrationDoc;
  return request;
}

function normalizeBaseUrl(value) {
  const url = new URL(value || "https://cheshireterminal.ai");
  if (!/^https?:$/.test(url.protocol)) throw new Error("baseUrl must use HTTPS or HTTP");
  if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
  if (url.hash) throw new Error("baseUrl must not contain a fragment");
  return url;
}

export function createCheshireClient({
  baseUrl = "https://cheshireterminal.ai",
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required");
  const origin = normalizeBaseUrl(baseUrl);
  const request = async (path, init) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    const response = await fetchImpl(new URL(path, origin), {
      ...init,
      headers,
      credentials: "include",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  const post = (path, body) => request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return Object.freeze({
    capabilities: async () => {
      const [robinhood, solana] = await Promise.all([
        request("/api/robinhood/agents/config"),
        request("/api/metaplex-agents/health"),
      ]);
      return { framework: frameworkCapabilities, robinhood, solana };
    },
    prepareRobinhood: (input) => post("/api/robinhood/agents/prepare-registration", input),
    mintSolana: (input) => {
      const verified = assertSponsoredMintAuthorization(input);
      return post("/api/metaplex-agents/mint", serializeSponsoredMintRequest(input, verified.intent));
    },
    getRobinhood: (id, chainId = 4663) => {
      getCanonicalDeployment(chainId);
      return request(`/api/robinhood/agents/${encodeURIComponent(id)}?chainId=${chainId}`);
    },
    getSolana: (asset) => request(`/api/metaplex-agents/fetch/${encodeURIComponent(asset)}`),
  });
}

export function createAgentForge(options) {
  const client = createCheshireClient(options);
  return Object.freeze({
    capabilities: client.capabilities,
    prepareRobinhood: client.prepareRobinhood,
    prepareLocalRobinhood: prepareCanonicalEvmRegistration,
    mintSolana: client.mintSolana,
    prepare: ({ platform, ...input }) => {
      if (platform === "robinhood") return client.prepareRobinhood(input);
      if (platform === "solana") {
        return Promise.reject(new Error(
          "Solana Core minting is a live write; call mintSolana with a fresh CLAWD_AGENT_MINT_V2 authorization",
        ));
      }
      return Promise.reject(new Error("platform must be robinhood or solana"));
    },
    inspect: ({ platform, id, chainId }) => {
      if (platform === "robinhood") return client.getRobinhood(id, chainId);
      if (platform === "solana") return client.getSolana(id);
      return Promise.reject(new Error("platform must be robinhood or solana"));
    },
  });
}
