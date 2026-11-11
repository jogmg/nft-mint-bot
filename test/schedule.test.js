import test from "node:test";
import assert from "node:assert/strict";
import { mintWhenOpen, rateLimitDelayMs } from "../src/schedule.js";
import { parseRetryAfter } from "../src/opensea-drop.js";

const target = {
  source: "direct",
  contract: "0x0000000000000000000000000000000000000001",
  chain: "ethereum",
  amount: 1,
};
const wallet = { address: "0x0000000000000000000000000000000000000002" };

test("parses Retry-After seconds and HTTP dates", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal(parseRetryAfter("2.5", now), 2500);
  assert.equal(parseRetryAfter("Wed, 11 Nov 2026 12:00:04 GMT", now), 4000);
  assert.equal(parseRetryAfter("invalid", now), null);
});

test("uses server retry delay or capped exponential jitter", () => {
  assert.equal(rateLimitDelayMs(1, 2500), 2500);
  assert.equal(
    rateLimitDelayMs(1, null, () => 0),
    500
  );
  assert.equal(
    rateLimitDelayMs(1, null, () => 1),
    1000
  );
  assert.equal(
    rateLimitDelayMs(20, null, () => 1),
    30000
  );
});

test("waits for Retry-After after a 429, then retries", async () => {
  const waits = [];
  const events = [];
  let calls = 0;
  const result = { status: "success", hash: "0xabc" };

  const minted = await mintWhenOpen(
    target,
    wallet,
    (event) => events.push(event),
    {
      startAtUnix: Math.floor(Date.now() / 1000) - 1,
      maxPriceWei: null,
      timeoutMs: 2000,
      sleep: async (ms) => waits.push(ms),
      mintOne: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("opensea gql MintActionTimelineQuery 429");
          error.status = 429;
          error.retryAfterMs = 1800;
          throw error;
        }
        return result;
      },
    }
  );

  assert.deepEqual(minted, [result]);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1800]);
  assert.equal(
    events.find((event) => event.stage === "rate_limited")?.delayMs,
    1800
  );
});

test("stops immediately when OpenSea reports allocation exhausted", async () => {
  let calls = 0;
  const error = new Error("opensea: jatah mint habis (sudah mint maksimal)");
  error.code = "InsufficientMintsRemainingError";

  await assert.rejects(
    mintWhenOpen(target, wallet, () => {}, {
      startAtUnix: Math.floor(Date.now() / 1000) - 1,
      maxPriceWei: null,
      mintOne: async () => {
        calls += 1;
        throw error;
      },
    }),
    /jatah mint habis/
  );
  assert.equal(calls, 1);
});
