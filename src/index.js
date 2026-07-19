import { encodeFunctionData, isAddress } from "viem";

export const platforms = Object.freeze({
  robinhood: { vm: "evm", chainId: 4663, testnetChainId: 46630 },
  solana: { vm: "svm", cluster: "mainnet-beta", testnetCluster: "devnet" },
});

export const identityRegistryAbi = [{ type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] }];

function text(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return result;
}

export function buildRegistration(input) {
  if (!input || typeof input !== "object") throw new Error("registration input is required");
  const image = text(input.image, "image", 2048);
  if (!/^(https:\/\/|ipfs:\/\/|data:image\/)/i.test(image)) throw new Error("image must use https://, ipfs://, or a data:image URI");
  const services = (input.services || []).map((item, i) => ({
    name: text(item?.name, `services[${i}].name`, 64), endpoint: text(item?.endpoint, `services[${i}].endpoint`, 2048),
    ...(item.version ? { version: text(item.version, `services[${i}].version`, 64) } : {}),
    ...(Array.isArray(item.skills) ? { skills: item.skills.map((value) => text(value, `services[${i}].skills`, 128)) } : {}),
    ...(Array.isArray(item.domains) ? { domains: item.domains.map((value) => text(value, `services[${i}].domains`, 128)) } : {}),
  }));
  if (services.length > 20) throw new Error("services cannot contain more than 20 entries");
  return { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: text(input.name, "name", 160), description: text(input.description, "description", 4000), image, services, x402Support: input.x402Support === true, active: input.active !== false, registrations: [], ...(input.supportedTrust?.length ? { supportedTrust: input.supportedTrust.map((v) => text(v, "supportedTrust", 64)) } : {}) };
}

export const registrationDataUri = (doc) => `data:application/json;base64,${Buffer.from(JSON.stringify(doc)).toString("base64")}`;

export function prepareEvmRegistration({ chainId = 46630, registry, agentURI, ...input }) {
  if (chainId !== 4663 && chainId !== 46630) throw new Error("chainId must be 4663 or 46630");
  if (!isAddress(registry)) throw new Error("a valid, trusted registry address is required");
  const registration = buildRegistration(input);
  const uri = agentURI || registrationDataUri(registration);
  return { vm: "evm", network: "robinhood", chainId, to: registry, data: encodeFunctionData({ abi: identityRegistryAbi, functionName: "register", args: [uri] }), value: "0x0", agentURI: uri, registration };
}

export function createCheshireClient({ baseUrl = "https://cheshireterminal.ai", apiKey } = {}) {
  const request = async (path, init) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
    const response = await fetch(new URL(path, baseUrl), { ...init, headers, credentials: "include" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  };
  const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    capabilities: async () => ({ robinhood: await request("/api/robinhood/agents/config"), solana: await request("/api/metaplex-agents/health") }),
    prepareRobinhood: (input) => post("/api/robinhood/agents/prepare-registration", input),
    mintSolana: (input) => post("/api/metaplex-agents/mint", input),
    registerSolanaAdmin: (input) => post("/api/metaplex-agents/register", input),
    getRobinhood: (id, chainId = 4663) => request(`/api/robinhood/agents/${encodeURIComponent(id)}?chainId=${chainId}`),
    getSolana: (asset) => request(`/api/metaplex-agents/fetch/${encodeURIComponent(asset)}`),
  };
}

export function createAgentForge(options) {
  const client = createCheshireClient(options);
  return {
    capabilities: client.capabilities,
    prepareRobinhood: client.prepareRobinhood,
    mintSolana: client.mintSolana,
    prepare: ({ platform, ...input }) => platform === "robinhood"
      ? client.prepareRobinhood(input)
      : Promise.reject(new Error("Solana minting is a live write; call mintSolana with a fresh walletMessage and walletSignature")),
    inspect: ({ platform, id, chainId }) => platform === "robinhood" ? client.getRobinhood(id, chainId) : platform === "solana" ? client.getSolana(id) : Promise.reject(new Error("platform must be robinhood or solana")),
  };
}
