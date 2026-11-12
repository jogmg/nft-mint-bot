import { ethers } from "ethers";
import { getProvider } from "./chains.js";
import { mintMany, mintOne } from "./mint.js";
import { getSessionCookies } from "./opensea-auth.js";
import { getDropStages, getEligibleOpenWindow } from "./opensea-drop.js";
import { assertPriceProtection, resolveTargetPrice } from "./price.js";
import { detectSeadrop, getPublicDrop } from "./seadrop.js";
import { fmtWAT } from "./time.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pre-warm OpenSea SIWE sessions for all wallets so login never sits in the
// mint critical path. Tokens are valid for hours; warming during the wait
// phase means the mint moment only pays for tx-build + send. Best-effort:
// a failed warm-up is retried lazily by mintOne at mint time.
async function prewarmOpensea(target, wallets, onEvent) {
  if (target.source !== "opensea" || !target.slug) return;
  const list = Array.isArray(wallets) ? wallets : [wallets];
  await Promise.all(
    list.map(async (w) => {
      try {
        await getSessionCookies(w);
        onEvent({
          stage: "allowlist",
          eligible: true,
          wallet: w.address,
          reason: "opensea session pre-warmed",
        });
      } catch (e) {
        onEvent({
          stage: "allowlist",
          eligible: false,
          wallet: w.address,
          reason: `pre-warm failed: ${e.message}`,
        });
      }
    })
  );
}

export function parseWhen(spec, nowMs = Date.now()) {
  const s = String(spec).trim().toLowerCase();

  // relative: optional leading "in "
  let m = s.match(
    /^(?:in\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/
  );
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    return Math.floor(nowMs / 1000) + n * mult;
  }

  // unix ms
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  // unix seconds
  if (/^\d{10}$/.test(s)) return Number(s);

  // HH:MM — interpreted as WAT (UTC+1), next occurrence.
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const WAT = 60 * 60 * 1000;
    // Shift into WAT wall-clock, set the hh:mm there, shift back to UTC.
    const d = new Date(nowMs + WAT);
    d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    let t = Math.floor((d.getTime() - WAT) / 1000);
    if (t * 1000 <= nowMs) t += 86400; // already passed today → tomorrow
    return t;
  }

  // ISO / Date-parseable
  const parsed = Date.parse(spec);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);

  throw new Error(`cannot parse time: "${spec}"`);
}

export async function resolveOpenWindow(target) {
  const provider = getProvider(target.chain);
  const sd = await detectSeadrop(target.contract, provider);
  if (!sd.version) return null;
  const drop = await getPublicDrop(sd.seadrop, target.contract, provider);
  if (!(drop.startTime > 0)) return null;
  return {
    startTime: drop.startTime,
    endTime: drop.endTime > 0 ? drop.endTime : 0,
  };
}

export async function resolveOpenTime(target) {
  const win = await resolveOpenWindow(target);
  return win ? win.startTime : null;
}

export async function mintAt(
  target,
  wallets,
  whenUnix,
  onEvent = () => {},
  opts = {}
) {
  const waitMs = Math.max(0, whenUnix * 1000 - Date.now());
  onEvent({
    stage: "scheduled",
    when: whenUnix,
    waitMs,
    wib: fmtWAT(whenUnix),
  });
  return mintWhenOpen(target, wallets, onEvent, {
    ...opts,
    startAtUnix: whenUnix,
  });
}

const HOT_LEAD_MS = 2000;
const REFRESH_MS = 30_000;

const CLOSED_RE =
  /not active|belum active|notactive|not started|notstarted|notenabled|not enabled|invalidmerkleproof|invalid merkle|simulation revert|execution reverted|mint not|before start|too early/i;
const FATAL_RE =
  /insufficient funds|invalid private key|unknown chain|no recognized mint|Price protection|price exceeded|exceeds the maximum price limit|jatah mint habis|not eligible/i;
const TERMINAL_OPENSEA_CODES = new Set([
  "InsufficientMintsRemainingError",
  "NotEligibleError",
]);

export function pickEffectiveOpenAt({
  requestedOpenAt,
  eligibleOpenAt,
  fallbackOpenAt,
} = {}) {
  const values = [requestedOpenAt, eligibleOpenAt, fallbackOpenAt].filter(
    (value) => value != null && Number.isFinite(Number(value))
  );
  return values.length ? Math.min(...values) : null;
}

export function assertOpenSeaDropNotEnded(
  stages,
  nowSec = Math.floor(Date.now() / 1000)
) {
  if (
    !Array.isArray(stages) ||
    stages.length === 0 ||
    stages.some(
      (stage) =>
        !Number.isFinite(Number(stage.startTime)) ||
        Number(stage.startTime) <= 0 ||
        !Number.isFinite(Number(stage.endTime)) ||
        Number(stage.endTime) <= 0
    )
  ) {
    return null;
  }

  const endAt = Math.max(...stages.map((stage) => Number(stage.endTime)));
  if (nowSec >= endAt) {
    throw new Error(
      `The OpenSea drop has ended (last stage closed ${fmtWAT(
        endAt
      )}) — Nothing can be minted`
    );
  }
  return endAt;
}

export function rateLimitDelayMs(
  attempt,
  retryAfterMs = null,
  random = Math.random
) {
  if (retryAfterMs != null && Number.isFinite(Number(retryAfterMs))) {
    return Math.max(0, Number(retryAfterMs));
  }
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}

function isFatalMintError(error, message) {
  return (
    TERMINAL_OPENSEA_CODES.has(error.code) ||
    (FATAL_RE.test(message) && !CLOSED_RE.test(message))
  );
}

export async function mintWhenOpen(
  target,
  wallets,
  onEvent = () => {},
  opts = {}
) {
  const list = Array.isArray(wallets) ? wallets : [wallets];

  const pollMs = opts.pollMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 10 min watch window (polling phase only)
  const wait = opts.sleep ?? sleep;
  // Injectable for tests; defaults to the real engine. Prod behavior unchanged.
  const attemptMint = opts.mintOne ?? mintOne;
  const attemptMany = opts.mintMany ?? mintMany;

  // Resolve the launch window. Prefer the earliest valid launch across the
  // explicit request, the authenticated OpenSea eligible stage, and the
  // on-chain fallback. This keeps scheduled runs stage-aware when the wallet is
  // eligible for a GTD/presale stage that opens earlier than the raw wall-clock.
  let openAt = opts.startAtUnix ?? null;
  let endAt = opts.endAtUnix ?? 0;
  let eligibleStage = null;
  let fallbackOpenAt = null;
  let openSeaDrop = null;

  if (target.source === "opensea" && target.slug) {
    try {
      openSeaDrop = await (opts.getDropStages ?? getDropStages)(target.slug);
    } catch {
      /* OpenSea stage data is best-effort; retain the on-chain fallback. */
    }
    assertOpenSeaDropNotEnded(openSeaDrop?.stages);
  }

  // Resolve price protection: explicit maxPriceWei or auto-lock to initial detected price.
  let maxPriceWei = opts.maxPriceWei;
  if (maxPriceWei === undefined) {
    try {
      const pInfo = await resolveTargetPrice(target, list[0]);
      if (pInfo && pInfo.priceWei != null) {
        maxPriceWei = pInfo.priceWei;
        onEvent({
          stage: "price_protect",
          maxPriceWei,
          maxPriceEth: pInfo.priceEth,
          auto: true,
          source: pInfo.source,
        });
      }
    } catch {
      /* if price can't be resolved, maxPriceWei remains undefined */
    }
  } else if (maxPriceWei != null) {
    onEvent({
      stage: "price_protect",
      maxPriceWei,
      maxPriceEth: ethers.formatEther(maxPriceWei),
      auto: false,
    });
  }

  if (target.source === "opensea" && target.slug) {
    try {
      const cookie = await getSessionCookies(list[0]);
      const win = await getEligibleOpenWindow(
        target.slug,
        list[0].address,
        cookie,
        openSeaDrop
      );
      if (win) {
        eligibleStage = win;
        openAt = pickEffectiveOpenAt({
          requestedOpenAt: openAt,
          eligibleOpenAt: win.startTime,
          fallbackOpenAt,
        });
        endAt = win.endTime;
        const label =
          win.stageType === "PUBLIC_SALE"
            ? "public"
            : win.stageType === "SIGNED_PRESALE"
            ? "presale/GTD"
            : win.stageType === "MERKLE_PRESALE"
            ? "allowlist"
            : `stage ${win.stageIndex}`;
        const priceTxt = win.priceUnit
          ? `${win.priceUnit} ${win.symbol}`
          : "FREE";
        onEvent({
          stage: "eligible_stage",
          stageIndex: win.stageIndex,
          stageType: win.stageType,
          label,
          price: priceTxt,
          openAt: win.startTime,
          wib: fmtWAT(win.startTime),
        });
      }
    } catch {
      /* eligibility resolve failed → fall through to on-chain */
    }
  }
  if (openAt == null) {
    try {
      const win = await resolveOpenWindow(target);
      if (win) {
        fallbackOpenAt = win.startTime;
        openAt = pickEffectiveOpenAt({
          requestedOpenAt: openAt,
          eligibleOpenAt: eligibleStage?.startTime ?? null,
          fallbackOpenAt,
        });
        endAt = win.endTime;
      }
    } catch {
      openAt = null;
    }
  }

  const nowSec = () => Math.floor(Date.now() / 1000);
  assertOpenSeaDropNotEnded(openSeaDrop?.stages, nowSec());
  if (openAt != null && endAt > 0 && nowSec() >= endAt) {
    throw new Error(
      `The stage has ended (closes ${fmtWAT(endAt)}) — Nothing can be minted`
    );
  }

  // Two-phase wait (osnm-z pattern):
  //  1. Coarse loop far from open — re-probe the on-chain window each REFRESH_MS
  //     so a shifted start time is picked up; abort if the drop ended meanwhile.
  //  2. Hot path — once within HOT_LEAD_MS of open, busy-sleep to the exact
  //     second so the tx is submitted on the first live block, not a poll later.
  if (openAt != null) {
    while (true) {
      if (opts.signal?.aborted) throw new Error("schedule cancelled");
      assertOpenSeaDropNotEnded(openSeaDrop?.stages, nowSec());
      const remainingMs = openAt * 1000 - Date.now();
      if (remainingMs <= HOT_LEAD_MS) break;

      const chunk = Math.min(remainingMs - HOT_LEAD_MS, REFRESH_MS);
      onEvent({ stage: "waiting_open", openAt, wib: fmtWAT(openAt) });
      await sleep(chunk);

      // Re-probe the SAME source the window came from, so an OpenSea
      // eligibility-anchored target never falls back to the on-chain PUBLIC
      // window (that would silently jump the wait from GTD to public open).
      // A creator can move the start; follow it. Best-effort — keep the old
      // openAt if the probe fails transiently.
      if (opts.startAtUnix == null) {
        try {
          if (eligibleStage) {
            const cookie = await getSessionCookies(list[0]);
            const win = await getEligibleOpenWindow(
              target.slug,
              list[0].address,
              cookie
            );
            if (win) {
              if (win.endTime > 0 && nowSec() >= win.endTime) {
                throw new Error(
                  `The stage has ended (closes ${fmtWAT(
                    win.endTime
                  )}) — Nothing can be minted.`
                );
              }
              if (maxPriceWei != null && win.priceUnit != null) {
                const curWei =
                  ethers.parseEther(String(win.priceUnit)) *
                  BigInt(target.amount || 1);
                assertPriceProtection({
                  actualPriceWei: curWei,
                  maxPriceWei,
                  context: "stage update",
                });
              }
              eligibleStage = win;
              openAt = win.startTime;
              endAt = win.endTime;
            }
          } else {
            const win = await resolveOpenWindow(target);
            if (win) {
              if (win.endTime > 0 && nowSec() >= win.endTime) {
                throw new Error(
                  `The stage has ended (closes ${fmtWAT(
                    win.endTime
                  )}) — Nothing can be minted.`
                );
              }
              openAt = win.startTime;
              endAt = win.endTime;
            }
            if (maxPriceWei != null) {
              try {
                const provider = getProvider(target.chain);
                const sd = await detectSeadrop(target.contract, provider);
                if (sd.version) {
                  const drop = await getPublicDrop(
                    sd.seadrop,
                    target.contract,
                    provider
                  );
                  if (drop.mintPrice != null) {
                    const curWei = drop.mintPrice * BigInt(target.amount || 1);
                    assertPriceProtection({
                      actualPriceWei: curWei,
                      maxPriceWei,
                      context: "drop update",
                    });
                  }
                }
              } catch (e) {
                if (/Price protection/i.test(e.message)) throw e;
              }
            }
          }
        } catch (e) {
          if (/The stage has ended|Price protection/i.test(e.message)) throw e;
        }
      }
    }

    // Warm OpenSea sessions before the hot path so login is off the critical
    // path and tokens are fresh at open. No-op for non-OpenSea targets.
    await prewarmOpensea(target, list, onEvent);

    // Hot path: sleep precisely to the open second.
    while (true) {
      if (opts.signal?.aborted) throw new Error("schedule cancelled");
      const remainingMs = openAt * 1000 - Date.now();
      if (remainingMs <= 0) break;
      await sleep(remainingMs);
    }
  } else {
    // No known open time (generic contract): warm now, poll the simulation.
    await prewarmOpensea(target, list, onEvent);
  }

  // Start the poll watch-window after the wait, so the full timeout covers the
  // polling phase — never consumed by waiting for open.
  const deadline = Date.now() + timeoutMs;
  onEvent({ stage: "polling", pollMs });

  let attempts = 0;
  let rateLimitAttempts = 0;
  let lastErr = "unknown";
  const mintOpts = { ...opts, maxPriceWei };
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("schedule cancelled");
    assertOpenSeaDropNotEnded(openSeaDrop?.stages, nowSec());
    attempts += 1;
    try {
      // Probe openness with the first wallet. A fatal (non-timing) error
      // aborts; a closed-style revert means keep polling; success means open
      // → fan out to the remaining wallets.
      const first = await attemptMint(target, list[0], onEvent, mintOpts);
      if (list.length === 1) return [first];
      const rest = await attemptMany(target, list.slice(1), onEvent, mintOpts);
      return [first, ...rest];
    } catch (e) {
      lastErr = e.shortMessage || e.message;
      if (isFatalMintError(e, lastErr)) throw e;
      if (e.status === 429) {
        rateLimitAttempts += 1;
        const delayMs = rateLimitDelayMs(
          rateLimitAttempts,
          e.retryAfterMs,
          opts.random
        );
        onEvent({
          stage: "rate_limited",
          attempts,
          delayMs,
          retryAfterMs: e.retryAfterMs,
        });
        await wait(Math.min(delayMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      rateLimitAttempts = 0;
      if (attempts % 10 === 0)
        onEvent({ stage: "still_closed", attempts, lastErr });
      await wait(pollMs);
    }
  }
  throw new Error(
    `watch window elapsed (${attempts} attempts). last: ${lastErr}`
  );
}
