/**
 * Cheshire ZK Omnichain message codec (msgType 4).
 * Matches CheshireZkOmniMessenger.sol abi.encode layout:
 *   (uint16, bytes32, bytes32, bytes32, bytes32, bytes32, uint64, string, string)
 */
import { createHash, randomBytes } from "node:crypto";

export const MSG_ZK_OMNI = 4;
export const EID_SOLANA_MAINNET = 30168;
export const EID_ROBINHOOD_MAINNET = 30416;
export const MAX_ACTION_LENGTH = 64;
export const MAX_MEMO_LENGTH = 200;

const WORD = 32;

function assertHexBytes32(value, label) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(v)) {
    throw new Error(`${label} must be 0x + 64 hex chars`);
  }
  return v;
}

function assertUint64(value, label) {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << 64n) throw new Error(`${label} out of uint64 range`);
  return n;
}

function pad32(hexNo0x) {
  return hexNo0x.padStart(WORD * 2, "0");
}

function uintWord(value, bits, label) {
  const n = typeof value === "bigint" ? value : BigInt(value);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${label} exceeds uint${bits}`);
  return n.toString(16).padStart(WORD * 2, "0");
}

function encodeDynamicString(str, label, max) {
  const bytes = Buffer.from(str ?? "", "utf8");
  if (bytes.length > max) throw new Error(`${label} exceeds ${max} UTF-8 bytes`);
  const len = uintWord(BigInt(bytes.length), 256, `${label}.length`);
  const padded = bytes.toString("hex").padEnd(Math.ceil(bytes.length / WORD) * WORD * 2, "0");
  return { hex: len + padded, byteLength: WORD + Math.ceil(bytes.length / WORD) * WORD };
}

/**
 * Domain-separated nullifier (matches clawd-agent-tui / zk-primitives style).
 * SHA-256("clawd-zk-nullifier:v1" || 0x00 || secret || 0x00 || context)
 */
export function computeOmniNullifier(secret, context) {
  const secretBuf = Buffer.isBuffer(secret)
    ? secret
    : Buffer.from(String(secret).replace(/^0x/i, ""), "hex");
  if (secretBuf.length < 16) throw new Error("Secret must be at least 16 bytes");
  const h = createHash("sha256");
  h.update(Buffer.from("clawd-zk-nullifier:v1"));
  h.update(Buffer.from([0]));
  h.update(secretBuf);
  h.update(Buffer.from([0]));
  h.update(Buffer.from(String(context), "utf8"));
  return `0x${h.digest("hex")}`;
}

export function randomSecretHex(bytes = 32) {
  return `0x${randomBytes(bytes).toString("hex")}`;
}

export function payloadCommitmentFrom(parts) {
  const h = createHash("sha256");
  for (const part of parts) {
    h.update(Buffer.from(String(part)));
    h.update(Buffer.from([0]));
  }
  return `0x${h.digest("hex")}`;
}

/**
 * abi.encode for MSG_ZK_OMNI messages.
 * Head has 8 words (offsets for two dynamic strings at indices 7 and 8).
 */
export function encodeZkOmniMessage(input) {
  const msgType = MSG_ZK_OMNI;
  const agentId = assertHexBytes32(input.agentId, "agentId").slice(2);
  const controller = assertHexBytes32(input.controller, "controller").slice(2);
  const nullifier = assertHexBytes32(input.nullifier, "nullifier").slice(2);
  if (/^0{64}$/.test(nullifier)) throw new Error("nullifier cannot be zero");
  const payloadCommitment = assertHexBytes32(
    input.payloadCommitment ?? `0x${"00".repeat(32)}`,
    "payloadCommitment",
  ).slice(2);
  const modelHash = assertHexBytes32(
    input.modelHash ?? `0x${"00".repeat(32)}`,
    "modelHash",
  ).slice(2);
  const expiresAt = assertUint64(input.expiresAt, "expiresAt");

  const actionEnc = encodeDynamicString(input.action ?? "", "action", MAX_ACTION_LENGTH);
  const memoEnc = encodeDynamicString(input.memo ?? "", "memo", MAX_MEMO_LENGTH);

  // Head: 9 slots? Solidity abi.encode for
  // (uint16, bytes32, bytes32, bytes32, bytes32, bytes32, uint64, string, string)
  // actually packs: each static arg is 32-byte word; strings are offset pointers.
  // Order: msgType, agentId, controller, nullifier, payloadCommitment, modelHash, expiresAt, action offset, memo offset
  const HEAD_WORDS = 9;
  const headBytes = HEAD_WORDS * WORD;
  const actionOffset = headBytes;
  const memoOffset = headBytes + actionEnc.byteLength;

  const head = [
    uintWord(BigInt(msgType), 16, "msgType"),
    pad32(agentId),
    pad32(controller),
    pad32(nullifier),
    pad32(payloadCommitment),
    pad32(modelHash),
    uintWord(expiresAt, 64, "expiresAt"),
    uintWord(BigInt(actionOffset), 256, "action offset"),
    uintWord(BigInt(memoOffset), 256, "memo offset"),
  ].join("");

  return `0x${head}${actionEnc.hex}${memoEnc.hex}`;
}

function readWord(hex, wordIndex) {
  const start = wordIndex * WORD * 2;
  return hex.slice(start, start + WORD * 2);
}

function decodeDynamicString(hex, offsetBytes) {
  const offsetNibbles = offsetBytes * 2;
  const len = Number(BigInt(`0x${hex.slice(offsetNibbles, offsetNibbles + WORD * 2)}`));
  const dataStart = offsetNibbles + WORD * 2;
  const dataHex = hex.slice(dataStart, dataStart + len * 2);
  return Buffer.from(dataHex, "hex").toString("utf8");
}

export function decodeZkOmniMessage(payloadHex) {
  const hex = String(payloadHex).replace(/^0x/i, "").toLowerCase();
  if (hex.length < HEAD_MIN_NIBBLES) {
    throw new Error("payload too short for ZkOmni message");
  }
  const msgType = Number(BigInt(`0x${readWord(hex, 0)}`));
  if (msgType !== MSG_ZK_OMNI) {
    throw new Error(`Invalid msgType ${msgType}; expected ${MSG_ZK_OMNI}`);
  }
  const agentId = `0x${readWord(hex, 1)}`;
  const controller = `0x${readWord(hex, 2)}`;
  const nullifier = `0x${readWord(hex, 3)}`;
  const payloadCommitment = `0x${readWord(hex, 4)}`;
  const modelHash = `0x${readWord(hex, 5)}`;
  const expiresAt = Number(BigInt(`0x${readWord(hex, 6)}`));
  const actionOffset = Number(BigInt(`0x${readWord(hex, 7)}`));
  const memoOffset = Number(BigInt(`0x${readWord(hex, 8)}`));
  const action = decodeDynamicString(hex, actionOffset);
  const memo = decodeDynamicString(hex, memoOffset);
  return {
    msgType,
    agentId,
    controller,
    nullifier,
    payloadCommitment,
    modelHash,
    expiresAt,
    action,
    memo,
  };
}

const HEAD_MIN_NIBBLES = 9 * WORD * 2;

export function addressToBytes32(address) {
  const a = String(address).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error("Invalid EVM address");
  return `0x${a.slice(2).padStart(64, "0")}`;
}

export function planZkOmniMessage(input) {
  const direction = input.direction ?? "robinhood-to-solana";
  const srcEid =
    direction === "robinhood-to-solana" ? EID_ROBINHOOD_MAINNET : EID_SOLANA_MAINNET;
  const dstEid =
    direction === "robinhood-to-solana" ? EID_SOLANA_MAINNET : EID_ROBINHOOD_MAINNET;

  const secret = input.secretHex ?? randomSecretHex();
  const context =
    input.context ??
    `zk-omni:${direction}:${input.action ?? "message"}:${input.agentId ?? "0"}`;
  const nullifier = input.nullifier ?? computeOmniNullifier(secret, context);
  const payloadCommitment =
    input.payloadCommitment ??
    payloadCommitmentFrom([
      input.action ?? "",
      input.memo ?? "",
      input.agentId ?? "",
      String(input.expiresAt ?? ""),
    ]);
  const expiresAt =
    input.expiresAt ?? Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 3600);

  const controller =
    input.controller ??
    (input.controllerAddress
      ? addressToBytes32(input.controllerAddress)
      : `0x${"11".repeat(32)}`);

  const agentId = assertHexBytes32(
    input.agentId ?? `0x${"00".repeat(31)}01`,
    "agentId",
  );

  const message = {
    agentId,
    controller,
    nullifier,
    payloadCommitment,
    modelHash: input.modelHash ?? `0x${"00".repeat(32)}`,
    expiresAt,
    action: input.action ?? "zk_message",
    memo: input.memo ?? "",
  };

  const payloadHex = encodeZkOmniMessage(message);
  return {
    kind: "zk-omni",
    msgType: MSG_ZK_OMNI,
    direction,
    srcEid,
    dstEid,
    context,
    secretProvided: Boolean(input.secretHex),
    message,
    payloadHex,
    payloadBytes: (payloadHex.length - 2) / 2,
    options: {
      lzReceiveGas: direction === "robinhood-to-solana" ? 500_000 : 800_000,
      note: "Nullifier is the anti-replay key; unordered LayerZero delivery is safe.",
    },
  };
}
