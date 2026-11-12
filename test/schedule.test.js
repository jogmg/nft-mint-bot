import test from "node:test";
import assert from "node:assert/strict";
import {
  mintWhenOpen,
  assertOpenSeaDropNotEnded,
  pickEffectiveOpenAt,
  rateLimitDelayMs,
} from "../src/schedule.js";
import { fmtWAT } from "../src/time.js";
import { detectPrice } from "../src/price.js";
import { getOpenSeaBuildOrder } from "../src/mint.js";
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

test("formats a display timestamp using the configured timezone", () => {
  const unixSec = Math.floor(Date.parse("2026-11-11T12:00:00Z") / 1000);
  const previous = process.env.TIMEZONE;
  process.env.TIMEZONE = "UTC";
  try {
    assert.equal(fmtWAT(unixSec), "Wed, 11 Nov 2026 12:00 UTC");
  } finally {
    if (previous === undefined) delete process.env.TIMEZONE;
    else process.env.TIMEZONE = previous;
  }
});

test("does not treat an unknown contract price as free", async () => {
  const provider = {
    call: async () => {
      throw new Error("no code");
    },
  };
  assert.equal(
    await detectPrice("0x0000000000000000000000000000000000000001", provider),
    null
  );
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

test("prefers an earlier eligible OpenSea stage over a later scheduled time", () => {
  const requested = 1_700_000_100;
  const eligible = 1_700_000_050;
  const fallback = 1_700_000_200;

  assert.equal(
    pickEffectiveOpenAt({
      requestedOpenAt: requested,
      eligibleOpenAt: eligible,
      fallbackOpenAt: fallback,
    }),
    eligible
  );
  assert.equal(
    pickEffectiveOpenAt({
      requestedOpenAt: requested,
      eligibleOpenAt: null,
      fallbackOpenAt: fallback,
    }),
    requested
  );
});

test("fails before waiting when every OpenSea stage has ended", async () => {
  let mintCalls = 0;
  const endedStages = {
    stages: [
      { startTime: 100, endTime: 200 },
      { startTime: 200, endTime: 300 },
    ],
  };

  await assert.rejects(
    mintWhenOpen(
      { ...target, source: "opensea", slug: "jpegz" },
      wallet,
      () => {},
      {
        maxPriceWei: null,
        getDropStages: async () => endedStages,
        mintOne: async () => {
          mintCalls += 1;
        },
      }
    ),
    /The OpenSea drop has ended/
  );
  assert.equal(mintCalls, 0);
});

test("does not infer the drop ended when a stage has no end time", () => {
  assert.doesNotThrow(() =>
    assertOpenSeaDropNotEnded(
      [
        { startTime: 100, endTime: 200 },
        { startTime: 200, endTime: 0 },
      ],
      300
    )
  );
});

test("uses the authenticated OpenSea mint path before public fallback when a session is warm", () => {
  assert.deepEqual(getOpenSeaBuildOrder(true), ["authenticated", "public"]);
  assert.deepEqual(getOpenSeaBuildOrder(false), ["public", "authenticated"]);
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
