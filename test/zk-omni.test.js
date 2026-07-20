import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeOmniNullifier,
  decodeZkOmniMessage,
  encodeZkOmniMessage,
  MSG_ZK_OMNI,
  planZkOmniMessage,
  createRelayer,
  addressToBytes32,
} from "../src/zkOmni/index.js";

test("computeOmniNullifier is deterministic and domain-separated", () => {
  const secret = "0x" + "ab".repeat(32);
  const a = computeOmniNullifier(secret, "ctx-a");
  const b = computeOmniNullifier(secret, "ctx-a");
  const c = computeOmniNullifier(secret, "ctx-b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test("encode/decode ZkOmni round-trip", () => {
  const message = {
    agentId: "0x" + "01".repeat(32),
    controller: addressToBytes32("0xA11CE00000000000000000000000000000000001"),
    nullifier: computeOmniNullifier("0x" + "cd".repeat(32), "round-trip"),
    payloadCommitment: "0x" + "11".repeat(32),
    modelHash: "0x" + "22".repeat(32),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    action: "publish_attestation",
    memo: "hello-zk-omni",
  };
  const hex = encodeZkOmniMessage(message);
  assert.equal(hex.startsWith("0x"), true);
  const decoded = decodeZkOmniMessage(hex);
  assert.equal(decoded.msgType, MSG_ZK_OMNI);
  assert.equal(decoded.agentId, message.agentId);
  assert.equal(decoded.controller, message.controller.toLowerCase());
  assert.equal(decoded.nullifier, message.nullifier);
  assert.equal(decoded.payloadCommitment, message.payloadCommitment);
  assert.equal(decoded.modelHash, message.modelHash);
  assert.equal(decoded.expiresAt, message.expiresAt);
  assert.equal(decoded.action, message.action);
  assert.equal(decoded.memo, message.memo);
});

test("planZkOmniMessage builds robinhood→solana plan", () => {
  const plan = planZkOmniMessage({
    direction: "robinhood-to-solana",
    agentId: "0x" + "00".repeat(31) + "07",
    controllerAddress: "0x1234567890123456789012345678901234567890",
    action: "commit_state",
    memo: "one-shot",
    secretHex: "0x" + "ef".repeat(32),
  });
  assert.equal(plan.msgType, 4);
  assert.equal(plan.srcEid, 30416);
  assert.equal(plan.dstEid, 30168);
  assert.equal(plan.message.action, "commit_state");
  const decoded = decodeZkOmniMessage(plan.payloadHex);
  assert.equal(decoded.nullifier, plan.message.nullifier);
});

test("relayer oneshot delivers and rejects nullifier replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zk-omni-"));
  const journalPath = join(dir, "journal.jsonl");
  try {
    const relayer = createRelayer({ journalPath });
    await relayer.init();

    const job = await relayer.oneshot({
      direction: "solana-to-robinhood",
      agentId: "0x" + "aa".repeat(32),
      controllerAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      action: "attest",
      memo: "relay-test",
      secretHex: "0x" + "99".repeat(32),
    });

    assert.equal(job.status, "delivered");
    assert.ok(job.txHash);
    assert.equal(relayer.status().byStatus.delivered, 1);

    await assert.rejects(
      () =>
        relayer.oneshot({
          direction: "solana-to-robinhood",
          agentId: "0x" + "aa".repeat(32),
          controllerAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          action: "attest",
          memo: "relay-test",
          secretHex: "0x" + "99".repeat(32),
        }),
      /Nullifier already observed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("relayer health status shape", async () => {
  const relayer = createRelayer({ journalPath: null });
  // journal with null path — override after construct
  relayer.journal.path = null;
  await relayer.init();
  const status = relayer.status();
  assert.equal(status.running, false);
  assert.equal(status.jobs, 0);
  assert.ok(status.byStatus);
});
