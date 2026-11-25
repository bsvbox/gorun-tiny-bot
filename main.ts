// gorun-tiny-bot — paper-trading bot for make.fun
// "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana" (bars-replay/v1)
//
// Strategy: regime-switching relative-strength bot, tuned offline on the
// kit's frozen dev window (136 hourly bars, 29 Oct - 3 Nov 2026).
//
//  * Every bar, rank the 7 symbols by their trailing 24h return.
//  * Regime comes from the MEDIAN trailing return across all symbols:
//    above +1% -> offensive, below -1% -> defensive, with hysteresis
//    (the band between keeps the current regime, so small data
//    perturbations do not flip it back and forth).
//  * Offensive: hold the top 2 symbols, 20% of equity each. Sell a held
//    symbol only when its rank falls to 5th or worse, so rotations are
//    sticky and fees stay low. A new symbol joins only if a slot is
//    free or it beats the worst held symbol by 1%.
//  * Defensive: sit in cash except for selective dip-bounce trades:
//    buy when the close is 1.5% below its 12h EMA on a green hour,
//    20% of equity; exit at +0.5%, after 6 bars, or at a -1.5% stop.
//    A bounce buy is skipped on a shallow pool (open depth under
//    $2M): the round trip's constant-product impact there eats the
//    small target, so those trades lose money after costs.
//  * No position is ever opened before 25 closes of history exist.
//  * Every reply passes a validation guard: buys stay inside the
//    25% max-weight cap and above the 1 USDC minimum, sells carry a
//    positive quantity, client ids are unique, and no batch ever
//    carries more than the harness's 16 orders. Anything failing the
//    guard is dropped (and logged to stderr) instead of being sent.
//  * No position is ever opened before 25 closes of history exist.
//  * Fully deterministic: every decision is a pure function of the bars
//    seen so far. No randomness, no clock, no network, no outside data.
//
// Protocol: newline-delimited JSON on stdin/stdout (agent-fun/bars-replay/v1).
// The harness sends hello, then one batch per hour, then done. The bot
// answers every batch with exactly one reply line echoing its seq.
// Orders decided on a batch fill at the next bar's open (latency 1 bar).

import * as readline from "node:readline";

// ---- fixed strategy parameters (tuned offline, see README) ----
const WINDOW = 24; // trailing-return window, in bars
const HI = 0.01; // median return above this -> offensive
const LO = -0.01; // median return below this -> defensive
const TOP_N = 2; // symbols held in offensive mode
const SELL_RANK = 4; // sell a held symbol at this rank or worse (0-based)
const SIZE_OFF_PCT = 20n; // % of equity per offensive buy (cap is 25%)
const SIZE_BOUNCE_PCT = 20n; // % of equity per bounce buy
const MIN_BOUNCE_DEPTH = 2000000000000n; // $2M open depth, micro units
const DIP = 0.015; // bounce entry: close this far below the 12h EMA
const TARGET = 0.005; // bounce exit: this far above the entry close
const STOP = 0.015; // bounce exit: this far below the entry close
const MAX_HOLD = 6; // bounce exit: bars held, at most
const COOLDOWN = 6; // bars after an offensive sell before re-buying
const EDGE = 0.01; // new symbol must beat the worst held by this much
const EMA_PERIOD = 12; // EMA used by the bounce filter
const MAX_SLIPPAGE_BPS = 500; // fill gaps are under 1.3% in the dev data
const MIN_NOTIONAL = 1000000n; // 1 USDC, in micro units (harness minimum)
const MAX_WEIGHT_BPS = 2500n; // harness cap: 25% of equity per position
const MAX_ORDERS_PER_BAR = 16; // harness cap on orders per batch

// ---- protocol shapes (only the fields this bot reads) ----
interface HelloMsg {
  type: "hello";
  symbols: { symbol: string; price_scale: number; qty_scale: number }[];
  capital: { quote_units: string };
  warmup_bars?: number;
}

interface BarMsg {
  symbol: string;
  o: string;
  h: string;
  l: string;
  c: string;
  o_depth?: string[];
  c_depth?: string[];
}

interface BatchMsg {
  type: "batch";
  seq: number;
  bars: BarMsg[];
  account: {
    cash_quote_units: string;
    equity_quote_units: string;
    positions: { symbol: string; qty: string }[];
  };
}

interface DoneMsg {
  type: "done";
}

type Order =
  | {
      side: "buy";
      client_id: string;
      symbol: string;
      notional_quote_units: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      symbol: string;
      qty: string;
      max_slippage_bps: number;
    };

// ---- per-symbol state ----
interface SymState {
  closes: number[];
  ema12: number | null;
  entry: number | null; // entry close of the current position
  entryBar: number; // bar index at entry
  lastSellBar: number; // bar index of the last offensive sell
  depth: bigint; // open depth of the latest bar, micro USDC
}

const states = new Map<string, SymState>();
const priceScale = new Map<string, number>();
let symbols: string[] = [];
let offensive = false;
let bar = 0; // bars seen so far (0-based index of the bar being decided)

function stateFor(symbol: string): SymState {
  let s = states.get(symbol);
  if (!s) {
    s = {
      closes: [],
      ema12: null,
      entry: null,
      entryBar: 0,
      lastSellBar: -1e9,
      depth: 0n,
    };
    states.set(symbol, s);
  }
  return s;
}

function trailingReturn(s: SymState): number | null {
  if (s.closes.length <= WINDOW) return null;
  const now = s.closes[s.closes.length - 1];
  const then = s.closes[s.closes.length - 1 - WINDOW];
  return now / then - 1;
}

function decide(batch: BatchMsg): Order[] {
  const orders: Order[] = [];

  // 1. Ingest this batch's bars (one close per symbol).
  for (const b of batch.bars) {
    const st = stateFor(b.symbol);
    const scale = priceScale.get(b.symbol) ?? 0;
    const close = Number(b.c) / 10 ** scale;
    st.closes.push(close);
    st.depth = b.o_depth && b.o_depth.length > 0 ? BigInt(b.o_depth[0]) : 0n;
    const k = 2 / (EMA_PERIOD + 1);
    st.ema12 = st.ema12 === null ? close : close * k + st.ema12 * (1 - k);
  }

  // 2. Need a full window of history before any trading.
  const rets = new Map<string, number>();
  for (const sym of symbols) {
    const r = trailingReturn(stateFor(sym));
    if (r === null) return orders; // not ready yet: reply with no orders
    rets.set(sym, r);
  }

  // 3. Regime from the median trailing return (hysteresis band).
  const sorted = [...rets.values()].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median > HI) offensive = true;
  else if (median < LO) offensive = false;

  // 4. Rank symbols by trailing return, best first.
  const ranked = [...symbols].sort((a, b) => rets.get(b)! - rets.get(a)!);
  const rank = new Map(ranked.map((s, i) => [s, i]));

  const held = new Map<string, string>();
  for (const p of batch.account.positions) {
    if (BigInt(p.qty) > 0n) held.set(p.symbol, p.qty);
  }
  const equity = BigInt(batch.account.equity_quote_units);
  let cashLeft = BigInt(batch.account.cash_quote_units);

  const buyNotional = (pct: bigint): bigint => {
    const n = (equity * pct) / 100n;
    return n > cashLeft ? cashLeft : n;
  };

  for (const sym of symbols) {
    const st = stateFor(sym);
    const closes = st.closes;
    const close = closes[closes.length - 1];
    const qty = held.get(sym);

    if (qty !== undefined) {
      // --- holding a position: exit rules depend on the regime ---
      if (offensive) {
        if (rank.get(sym)! >= SELL_RANK) {
          orders.push({
            side: "sell",
            client_id: `s-${sym}-${bar}`,
            symbol: sym,
            qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          st.lastSellBar = bar;
          st.entry = null;
        }
      } else {
        const entry = st.entry ?? close;
        if (
          close >= entry * (1 + TARGET) ||
          bar - st.entryBar >= MAX_HOLD ||
          close < entry * (1 - STOP)
        ) {
          orders.push({
            side: "sell",
            client_id: `s-${sym}-${bar}`,
            symbol: sym,
            qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          st.entry = null;
        }
      }
      continue;
    }

    // --- flat: entry rules ---
    if (offensive) {
      if (rank.get(sym)! >= TOP_N) continue;
      if (bar - st.lastSellBar < COOLDOWN) continue;
      if (held.size >= TOP_N) {
        let worst = Infinity;
        for (const h of held.keys()) worst = Math.min(worst, rets.get(h)!);
        if (rets.get(sym)! <= worst + EDGE) continue;
      }
      const notional = buyNotional(SIZE_OFF_PCT);
      if (notional < MIN_NOTIONAL) continue;
      orders.push({
        side: "buy",
        client_id: `b-${sym}-${bar}`,
        symbol: sym,
        notional_quote_units: notional.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      cashLeft -= notional;
      st.entry = close;
      st.entryBar = bar;
    } else {
      // defensive dip-bounce: oversold vs the 12h EMA, on a green hour,
      // and only on a pool deep enough that impact does not eat the target
      if (closes.length < 2 || st.ema12 === null) continue;
      const prev = closes[closes.length - 2];
      if (close < st.ema12 * (1 - DIP) && close > prev && st.depth >= MIN_BOUNCE_DEPTH) {
        const notional = buyNotional(SIZE_BOUNCE_PCT);
        if (notional < MIN_NOTIONAL) continue;
        orders.push({
          side: "buy",
          client_id: `b-${sym}-${bar}`,
          symbol: sym,
          notional_quote_units: notional.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        cashLeft -= notional;
        st.entry = close;
        st.entryBar = bar;
      }
    }
  }

  return validateOrders(orders, equity);
}

// Guard: keep every reply inside the harness caps by construction.
// A strategy bug must never emit an order the harness rejects, because
// a rejected buy silently changes the trade sequence (the position
// never opens and the next bar's decision sees stale state). Drops
// are logged to stderr so a bad run is visible in the grade output.
function validateOrders(orders: Order[], equity: bigint): Order[] {
  const kept: Order[] = [];
  const seen = new Set<string>();
  const maxNotional = (equity * MAX_WEIGHT_BPS) / 10000n;
  for (const o of orders) {
    if (seen.has(o.client_id)) {
      process.stderr.write(`guard: duplicate client_id ${o.client_id}\n`);
      continue;
    }
    seen.add(o.client_id);
    if (o.side === "buy") {
      const n = BigInt(o.notional_quote_units);
      if (n < MIN_NOTIONAL || n > maxNotional) {
        process.stderr.write(
          `guard: buy ${o.symbol} notional ${n} outside [${MIN_NOTIONAL}, ${maxNotional}]\n`,
        );
        continue;
      }
    } else {
      if (BigInt(o.qty) <= 0n) {
        process.stderr.write(`guard: sell ${o.symbol} non-positive qty\n`);
        continue;
      }
    }
    kept.push(o);
  }
  if (kept.length > MAX_ORDERS_PER_BAR) {
    process.stderr.write(
      `guard: ${kept.length} orders exceed ${MAX_ORDERS_PER_BAR}, keeping first ${MAX_ORDERS_PER_BAR}\n`,
    );
    return kept.slice(0, MAX_ORDERS_PER_BAR);
  }
  return kept;
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: HelloMsg | BatchMsg | DoneMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      symbols = msg.symbols.map((s) => s.symbol);
      for (const s of msg.symbols) priceScale.set(s.symbol, s.price_scale);
      continue;
    }
    if (msg.type === "done") {
      break;
    }
    if (msg.type === "batch") {
      let orders: Order[] = [];
      try {
        orders = decide(msg);
      } catch (err) {
        // Never crash the run: answer with no orders and keep going.
        process.stderr.write(`decide failed at bar ${bar}: ${err}\n`);
        orders = [];
      }
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
      bar += 1;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err}\n`);
  process.exit(1);
});
