import test from "node:test";
import assert from "node:assert/strict";
import { buildRegistration, createAgentForge, createCheshireClient, prepareEvmRegistration } from "../src/index.js";
const input = { name: "Researcher", description: "Research agent", image: "ipfs://bafy", services: [] };
test("builds ERC-8004 metadata", () => assert.equal(buildRegistration(input).registrations.length, 0));
test("builds a reviewable EVM intent", () => { const intent = prepareEvmRegistration({ ...input, registry: "0x0000000000000000000000000000000000000001" }); assert.equal(intent.vm, "evm"); assert.match(intent.data, /^0x/); });
test("fails closed without a registry", () => assert.throws(() => prepareEvmRegistration({ ...input }), /trusted registry/));
test("does not disguise a live Solana mint as prepare", async () => {
  const forge = createAgentForge({ baseUrl: "https://example.test" });
  await assert.rejects(() => forge.prepare({ platform: "solana" }), /live write/);
});
test("sends API authentication and browser credentials", async () => {
  const originalFetch = globalThis.fetch;
  let observed;
  globalThis.fetch = async (url, init) => {
    observed = { url: String(url), init };
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await createCheshireClient({ baseUrl: "https://example.test", apiKey: "test-key" }).prepareRobinhood(input);
    assert.equal(observed.url, "https://example.test/api/robinhood/agents/prepare-registration");
    assert.equal(observed.init.credentials, "include");
    assert.equal(observed.init.headers.get("authorization"), "Bearer test-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
