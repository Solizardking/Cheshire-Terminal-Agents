# Cheshire ZK Omnichain Messaging

Nullifier-bound messaging between **Robinhood Chain** and **Solana** for agent intents, attestations, and encrypted-state commitments.

## Why this exists

The existing LayerZero OApp (`my-lz-oapp`, msgType **3**) authenticates agent intents with per-scope nonces.  
**msgType 4 (ZkOmni)** adds a **zero-knowledge nullifier** as the global anti-replay key so the same proof-backed action cannot be double-published across unordered delivery.

| | Authenticated Intent (3) | ZkOmni (4) |
|--|--------------------------|------------|
| Anti-replay | `(srcEid, agentId, nonce)` | `nullifier` |
| Binding | parametersHash | payloadCommitment + modelHash |
| Contract (RH) | CheshireOmnichainOApp | CheshireZkOmniMessenger |
| Best for | ordered agent commands | one-shot attest / claim / commit |

## Architecture

```text
┌────────────────────┐     LayerZero V2      ┌────────────────────┐
│ Robinhood (30416)  │ ───────────────────► │ Solana (30168)     │
│ ZkOmniMessenger    │ ◄─────────────────── │ OApp peer / clear  │
└─────────┬──────────┘                      └─────────┬──────────┘
          │                                           │
          └────────── zk-omni-relayer ────────────────┘
               observe → verify → relay → deliver
```

## Contracts

- `contracts/zk-omni/CheshireZkOmniMessenger.sol`
- `contracts/zk-omni/MockLzEndpoint.sol` (tests)
- Foundry: `forge test --match-contract CheshireZkOmniMessengerTest`

### Deploy sketch (Robinhood)

```bash
# After forge build, deploy with your RH RPC + endpoint
# Endpoint mainnet: 0x6f475642a6e85809b1c36fa62763669b1b48dd5b
# Then: setPeer(30168, bytes32(solanaStore))
```

Env (see `.env.example`):

```bash
ZK_OMNI_MESSENGER_ROBINHOOD=0x…
ZK_OMNI_PEER_SOLANA=0x…   # left-padded store pubkey
LAYERZERO_ENDPOINT_ROBINHOOD=0x6f475642a6e85809b1c36fa62763669b1b48dd5b
```

## SDK + one-shot

```js
import {
  planZkOmniMessage,
  createRelayer,
  computeOmniNullifier,
} from "cheshire-terminal-agents/zkOmni";

const plan = planZkOmniMessage({
  direction: "robinhood-to-solana",
  action: "publish_attestation",
  memo: "one-shot",
});

const relayer = createRelayer();
await relayer.init();
const job = await relayer.oneshot(plan.message ? plan : plan);
```

CLI:

```bash
npx robinhood-agents zk-omni-plan --action attest --memo demo
npx robinhood-agents zk-omni-oneshot --action publish_attestation
npx zk-omni-relayer serve --port 8787
```

## Relayer service

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | liveness + job stats |
| `GET /jobs` | list journal |
| `POST /oneshot` | plan+deliver body |

Journal: `ZK_OMNI_JOURNAL` or `.zk-omni-relayer/journal.jsonl`

Default `deliver` is **simulated** (safe offline). Production: inject a `deliver` fn that calls Endpoint send / Solana executor retry.

## User-friendly TUI

`packages/clawd-agent-tui` exposes:

- `zk_omni_plan`
- `zk_omni_oneshot`

```bash
cd packages/clawd-agent-tui
npm start -- --oneshot "help"
# interactive: ask the agent to plan a RH→Solana zk omni message
```
