/**
 * Cheshire ZK Omnichain relayer.
 *
 * Observes outbound ZkOmni plans / events, verifies codec + nullifier freshness
 * against a local journal, and records delivery lifecycle. Designed to run as a
 * long-lived process or be driven one-shot from tests/CLI.
 *
 * Lifecycle: observed → verified → queued → relayed → delivered | failed
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import {
  decodeZkOmniMessage,
  encodeZkOmniMessage,
  MSG_ZK_OMNI,
  planZkOmniMessage,
} from "./codec.js";

export const RELAY_STATUSES = Object.freeze([
  "observed",
  "verified",
  "queued",
  "relayed",
  "delivered",
  "failed",
]);

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export class ZkOmniJournal {
  /**
   * @param {{ path?: string }} [opts]
   */
  constructor(opts = {}) {
    this.path = opts.path || null;
    /** @type {Map<string, object>} */
    this.byId = new Map();
    /** @type {Set<string>} */
    this.consumedNullifiers = new Set();
  }

  async load() {
    if (!this.path) return;
    try {
      const raw = await readFile(this.path, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        this.byId.set(row.id, row);
        if (row.nullifier && row.status !== "failed") {
          this.consumedNullifiers.add(row.nullifier.toLowerCase());
        }
      }
    } catch (err) {
      if (err && err.code === "ENOENT") return;
      throw err;
    }
  }

  async append(row) {
    this.byId.set(row.id, row);
    if (row.nullifier && row.status !== "failed") {
      this.consumedNullifiers.add(String(row.nullifier).toLowerCase());
    }
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(row)}\n`, "utf8");
  }

  async rewrite() {
    if (!this.path) return;
    await mkdir(dirname(this.path), { recursive: true });
    const body = [...this.byId.values()].map((r) => JSON.stringify(r)).join("\n");
    await writeFile(this.path, body ? `${body}\n` : "", "utf8");
  }

  list(filter = {}) {
    let rows = [...this.byId.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.direction) rows = rows.filter((r) => r.direction === filter.direction);
    return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  hasNullifier(nullifier) {
    return this.consumedNullifiers.has(String(nullifier).toLowerCase());
  }
}

export class ZkOmniRelayer {
  /**
   * @param {{
   *   journal?: ZkOmniJournal,
   *   journalPath?: string,
   *   deliver?: (job: object) => Promise<{ ok: boolean, txHash?: string, error?: string }>,
   *   logger?: (msg: string, meta?: object) => void,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.journal =
      opts.journal ??
      new ZkOmniJournal({
        path: opts.journalPath ?? join(process.cwd(), ".zk-omni-relayer", "journal.jsonl"),
      });
    this.deliver =
      opts.deliver ??
      (async (job) => ({
        ok: true,
        txHash: `sim-${sha256Hex(job.payloadHex).slice(0, 16)}`,
        simulated: true,
      }));
    this.logger = opts.logger ?? (() => {});
    this.running = false;
    this._timer = null;
    this.stats = {
      observed: 0,
      verified: 0,
      delivered: 0,
      failed: 0,
      startedAt: null,
    };
  }

  async init() {
    await this.journal.load();
    this.stats.startedAt = nowIso();
  }

  /**
   * Ingest a planned or observed ZkOmni message.
   * @param {object} input plan fields or { payloadHex }
   */
  async observe(input) {
    let plan;
    if (input.payloadHex && !input.message) {
      const decoded = decodeZkOmniMessage(input.payloadHex);
      plan = {
        kind: "zk-omni",
        msgType: MSG_ZK_OMNI,
        direction: input.direction ?? "robinhood-to-solana",
        srcEid: input.srcEid,
        dstEid: input.dstEid,
        message: decoded,
        payloadHex: input.payloadHex,
      };
    } else {
      plan = input.payloadHex ? input : planZkOmniMessage(input);
    }

    const nullifier = plan.message?.nullifier ?? plan.nullifier;
    if (!nullifier) throw new Error("observe requires a nullifier");

    if (this.journal.hasNullifier(nullifier)) {
      const err = new Error(`Nullifier already observed/consumed: ${nullifier}`);
      err.code = "NULLIFIER_REPLAY";
      throw err;
    }

    // Round-trip codec verification
    const reencoded = encodeZkOmniMessage(plan.message);
    if (reencoded.toLowerCase() !== plan.payloadHex.toLowerCase()) {
      // Allow if we built from fields via planZkOmniMessage (canonical)
      const decoded = decodeZkOmniMessage(plan.payloadHex);
      if (decoded.nullifier.toLowerCase() !== nullifier.toLowerCase()) {
        throw new Error("payloadHex does not decode to the provided nullifier");
      }
    }

    const expiresAt = Number(plan.message.expiresAt);
    if (expiresAt && expiresAt <= Math.floor(Date.now() / 1000)) {
      const err = new Error("Message already expired");
      err.code = "EXPIRED";
      throw err;
    }

    const job = {
      id: randomUUID(),
      status: "observed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      direction: plan.direction,
      srcEid: plan.srcEid,
      dstEid: plan.dstEid,
      nullifier,
      agentId: plan.message.agentId,
      action: plan.message.action,
      payloadHex: plan.payloadHex,
      message: plan.message,
      attempts: 0,
      lastError: null,
      txHash: null,
    };

    await this.journal.append(job);
    this.stats.observed += 1;
    this.logger("observed", { id: job.id, nullifier });
    return job;
  }

  async verify(id) {
    const job = this.journal.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    const decoded = decodeZkOmniMessage(job.payloadHex);
    if (decoded.msgType !== MSG_ZK_OMNI) throw new Error("bad msgType");
    if (decoded.nullifier.toLowerCase() !== job.nullifier.toLowerCase()) {
      throw new Error("nullifier mismatch");
    }
    job.status = "verified";
    job.updatedAt = nowIso();
    await this.journal.rewrite();
    this.stats.verified += 1;
    this.logger("verified", { id });
    return job;
  }

  async queue(id) {
    const job = this.journal.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    if (job.status !== "verified" && job.status !== "observed") {
      throw new Error(`Cannot queue from status ${job.status}`);
    }
    if (job.status === "observed") await this.verify(id);
    job.status = "queued";
    job.updatedAt = nowIso();
    await this.journal.rewrite();
    return job;
  }

  async processOne(id) {
    const job = this.journal.get(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    if (job.status !== "queued" && job.status !== "verified" && job.status !== "observed") {
      return job;
    }
    if (job.status === "observed") await this.verify(id);
    if (job.status === "verified") await this.queue(id);

    job.attempts += 1;
    job.status = "relayed";
    job.updatedAt = nowIso();
    await this.journal.rewrite();
    this.logger("relayed", { id: job.id, attempt: job.attempts });

    try {
      const result = await this.deliver(job);
      if (!result?.ok) throw new Error(result?.error || "deliver failed");
      job.status = "delivered";
      job.txHash = result.txHash ?? null;
      job.updatedAt = nowIso();
      job.lastError = null;
      await this.journal.rewrite();
      this.stats.delivered += 1;
      this.logger("delivered", { id: job.id, txHash: job.txHash });
      return job;
    } catch (err) {
      job.status = "failed";
      job.lastError = err instanceof Error ? err.message : String(err);
      job.updatedAt = nowIso();
      await this.journal.rewrite();
      this.stats.failed += 1;
      this.logger("failed", { id: job.id, error: job.lastError });
      return job;
    }
  }

  async processQueue(limit = 10) {
    const queued = this.journal
      .list()
      .filter((j) => ["observed", "verified", "queued"].includes(j.status))
      .slice(0, limit);
    const results = [];
    for (const job of queued) {
      results.push(await this.processOne(job.id));
    }
    return results;
  }

  /**
   * One-shot: plan → observe → verify → deliver.
   */
  async oneshot(input) {
    const job = await this.observe(input);
    return this.processOne(job.id);
  }

  status() {
    const byStatus = Object.fromEntries(RELAY_STATUSES.map((s) => [s, 0]));
    for (const row of this.journal.list()) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }
    return {
      running: this.running,
      stats: this.stats,
      byStatus,
      journalPath: this.journal.path,
      jobs: this.journal.list().length,
    };
  }

  startPolling(intervalMs = 2000) {
    if (this.running) return;
    this.running = true;
    this._timer = setInterval(() => {
      this.processQueue().catch((err) => {
        this.logger("poll_error", { error: err instanceof Error ? err.message : String(err) });
      });
    }, intervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stopPolling() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Tiny health HTTP server for deploy checks.
   */
  listen(port = 8787, host = "127.0.0.1") {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      res.setHeader("content-type", "application/json");
      try {
        if (url.pathname === "/health") {
          res.end(JSON.stringify({ ok: true, service: "zk-omni-relayer", ...this.status() }));
          return;
        }
        if (url.pathname === "/jobs") {
          res.end(JSON.stringify({ jobs: this.journal.list() }));
          return;
        }
        if (url.pathname.startsWith("/jobs/") && req.method === "GET") {
          const id = url.pathname.slice("/jobs/".length);
          const job = this.journal.get(id);
          if (!job) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "not found" }));
            return;
          }
          res.end(JSON.stringify(job));
          return;
        }
        if (url.pathname === "/oneshot" && req.method === "POST") {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const job = await this.oneshot(body);
          res.end(JSON.stringify(job));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    server.listen(port, host);
    this.logger("listen", { host, port });
    return server;
  }
}

export function createRelayer(opts) {
  return new ZkOmniRelayer(opts);
}
