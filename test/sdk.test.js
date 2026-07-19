import test from "node:test";
import assert from "node:assert/strict";
import { buildRegistration, prepareEvmRegistration } from "../src/index.js";
const input = { name: "Researcher", description: "Research agent", image: "ipfs://bafy", services: [] };
test("builds ERC-8004 metadata", () => assert.equal(buildRegistration(input).registrations.length, 0));
test("builds a reviewable EVM intent", () => { const intent = prepareEvmRegistration({ ...input, registry: "0x0000000000000000000000000000000000000001" }); assert.equal(intent.vm, "evm"); assert.match(intent.data, /^0x/); });
test("fails closed without a registry", () => assert.throws(() => prepareEvmRegistration({ ...input }), /trusted registry/));
