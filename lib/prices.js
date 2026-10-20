// Cachey_McCacheface - API list prices, per model.
// Turns one usage record into API-equivalent dollars: what the same tokens
// would cost on Anthropic's first-party API. Not plan quota - how a
// subscription weights these tokens against its limits is not published.
//
// Source: Anthropic Claude API pricing as of 2026-09-25. A model missing from
// this table is reported as unpriced, never guessed - add it here when it ships.
// Deliberately absent: claude-haiku-5-5. Its price is tiered by prompt size
// ($0.10/$0.50 up to 100K prompt tokens, $0.50/$2.50 above) and its cache rates
// weren't published where this was sourced; this flat table can't express it.

// $ per million tokens: base input, output, 5-minute cache write, 1-hour cache
// write, cache read. Cache writes are 1.25x (5m) and 2x (1h) base input
// everywhere; the cache-read multiplier is NOT uniform (0.1x on most models,
// 0.05x on Opus 5.5, 0.025x on Fable 5.1), which is why one weight can't serve.
export const PRICES_AS_OF = "2026-09-25";
export const PRICES = {
  "claude-fable-5-1": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 0.25 },
  "claude-fable-5": { input: 10, output: 50, write5m: 12.5, write1h: 20, read: 1.0 },
  "claude-opus-5-5": { input: 4, output: 20, write5m: 5, write1h: 8, read: 0.2 },
  "claude-opus-5": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, write5m: 6.25, write1h: 10, read: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, write5m: 2.5, write1h: 4, read: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, write5m: 3.75, write1h: 6, read: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, write5m: 1.25, write1h: 2, read: 0.1 },
};

// Fast mode bills input and output at 2x (Opus 5.5: $8/$40). Applying 2x to the
// cache columns too is an assumption: Anthropic does not list fast-mode cache rates.
export const FAST_MULTIPLIER = 2;

// $10 per 1,000 web searches. Confirmed against Claude Code's own cost tracker
// (a Haiku entry with 14 searches reproduces its costUSD to the cent).
export const WEB_SEARCH_USD = 0.01;

// Not real models: Claude Code writes these for locally generated messages.
const IGNORED = new Set(["", "<synthetic>"]);

/**
 * Normalize a transcript model id to a PRICES key: drop a date snapshot suffix
 * (claude-haiku-4-5-20251001) and a bracketed variant tag (claude-opus-5-5[1m]).
 * @param {string} model model id as written in the transcript
 * @returns {string} normalized id
 */
export function modelKey(model) {
  return String(model || "").replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/**
 * Price one usage record at API list rates.
 * Cache writes with no 1h/5m breakdown are priced at the 5-minute rate (the
 * API default); records that carry the breakdown are priced exactly.
 * @param {{model:string,input:number,output:number,read:number,write:number,w1h:number,w5m:number,fast?:boolean,webSearch?:number}} r
 * @returns {{usd:number, known:boolean, ignored:boolean}} known=false means the model is not in PRICES (usd is 0)
 */
export function priceRecord(r) {
  if (IGNORED.has(r.model || "")) return { usd: 0, known: true, ignored: true };
  const p = PRICES[modelKey(r.model)];
  if (!p) return { usd: 0, known: false, ignored: false };
  const split = (r.w1h || 0) + (r.w5m || 0);
  const unsplit = Math.max(0, (r.write || 0) - split);
  let usd =
    ((r.input || 0) * p.input +
      (r.output || 0) * p.output +
      (r.read || 0) * p.read +
      (r.w5m || 0) * p.write5m +
      (r.w1h || 0) * p.write1h +
      unsplit * p.write5m) /
    1e6;
  if (r.fast) usd *= FAST_MULTIPLIER;
  usd += (r.webSearch || 0) * WEB_SEARCH_USD;
  return { usd, known: true, ignored: false };
}

/**
 * Dollars a re-warm wasted versus staying warm: the rebuilt tokens were billed
 * at the write rate when a warm cache would have read them.
 * @param {{model:string,write:number,w1h:number,w5m:number}} r the re-warm turn
 * @returns {number|null} usd, or null for an unpriced model
 */
export function reWarmPenaltyUsd(r) {
  const p = PRICES[modelKey(r.model)];
  if (!p) return null;
  const unsplit = Math.max(0, (r.write || 0) - (r.w1h || 0) - (r.w5m || 0));
  return (
    ((r.w1h || 0) * (p.write1h - p.read) + ((r.w5m || 0) + unsplit) * (p.write5m - p.read)) / 1e6
  );
}

/**
 * Dollars spent reading cached context.
 * @param {{model:string,read:number}} r
 * @returns {number|null} usd, or null for an unpriced model
 */
export function readUsd(r) {
  const p = PRICES[modelKey(r.model)];
  return p ? ((r.read || 0) * p.read) / 1e6 : null;
}
