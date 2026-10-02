/**
 * 回放会话指标验证脚本：
 *  1. 两个不同游标的会话交错执行 step/run，逐步核对盘口、指标与完成状态；
 *  2. 指标必须来自会话自身订单簿，而非实时 engine 盘口；
 *  3. 完成后重复 step/run 不重复消费，响应保持稳定；
 *  4. 空数据日与仅快照回放有稳定结果；
 *  5. 实时引擎 /api/analytics 行为回归（重构后不变）。
 * 运行：npm run verify
 */
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:6190';
let failures = 0;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
};
const deepEq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) console.log(`ok   - ${name}`);
  else { failures += 1; console.error(`FAIL - ${name}`, extra === undefined ? '' : JSON.stringify(extra)); }
};

const get = (path: string) => fetch(`${BASE}${path}`).then(r => r.json());
const post = (path: string, body?: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then(r => r.json());

// 与 src/analytics.ts 等价的独立重算：以接口返回的盘口（截到 10 档）为输入，交叉核对 metrics
function expectedMetrics(symbol: string, book: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[]; timestamp: string }) {
  const bids = book.bids.slice(0, 10);
  const asks = book.asks.slice(0, 10);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const bidDepth = bids.reduce((s, l) => s + l.quantity, 0);
  const askDepth = asks.reduce((s, l) => s + l.quantity, 0);
  const impact = (side: 'buy' | 'sell', requested: number) => {
    const levels = side === 'buy' ? asks : bids;
    let left = requested, notional = 0, filled = 0;
    for (const level of levels) { const take = Math.min(left, level.quantity); notional += take * level.price; filled += take; left -= take; if (!left) break; }
    const averagePrice = filled ? notional / filled : null;
    const reference = side === 'buy' ? bestAsk : bestBid;
    return { quantity: requested, averagePrice: averagePrice ? +averagePrice.toFixed(4) : null, slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null, filled: +filled.toFixed(4) };
  };
  const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const bidTop5 = bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const askTop5 = asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const weightedImbalance = bids.length && asks.length ? (bidTop5 - askTop5) / (bidTop5 + askTop5) : 0;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  return {
    symbol, timestamp: book.timestamp, bestBid, bestAsk, midPrice: mid, spread,
    relativeSpread: mid && spread ? spread / mid : null,
    bidDepth, askDepth,
    imbalance: +imbalance.toFixed(4), weightedImbalance: +weightedImbalance.toFixed(4),
    marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)),
    marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)),
    estimatedFillProbability: { buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3), sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3) },
    liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2),
  };
}

// 校验 step/run 响应：保留字段齐全、状态与游标自洽、指标等于按会话盘口重算的结果
const validate = (label: string, res: any, cursor: number, eventCount: number) => {
  const done = cursor >= eventCount;
  check(`${label}: cursor/status/done 自洽`, res.cursor === cursor && res.status === (done ? 'completed' : 'paused') && res.done === done, { cursor: res.cursor, status: res.status, done: res.done });
  check(`${label}: 保留 speed/eventCount 字段`, res.speed === 1 && res.eventCount === eventCount, { speed: res.speed, eventCount: res.eventCount });
  check(`${label}: book 为盘口快照`, Array.isArray(res.book?.bids) && Array.isArray(res.book?.asks) && typeof res.book?.sequence === 'number');
  check(`${label}: metrics 基于会话自身盘口`, deepEq(res.metrics, expectedMetrics(res.symbol, res.book)), { got: res.metrics, expected: expectedMetrics(res.symbol, res.book) });
};

async function main() {
  // ---- 实时引擎回归：/api/analytics 重构后仍与实时盘口一致 ----
  const liveBook = await get('/api/orderbook/ALPHA');
  const liveAnalytics = await get('/api/analytics/ALPHA');
  check('实时 /api/analytics 与实时盘口一致（重构回归）', deepEq(liveAnalytics, expectedMetrics('ALPHA', liveBook)), { got: liveAnalytics });

  // ---- 场景 1：两个会话交错 step/run（ALPHA 2026-09-30，种子数据 1 快照 + 12 事件）----
  const a = await post('/api/replay/sessions', { symbol: 'ALPHA', tradingDay: '2026-09-30' });
  const b = await post('/api/replay/sessions', { symbol: 'ALPHA', tradingDay: '2026-09-30' });
  check('创建会话 A/B', a.eventCount === 13 && b.eventCount === 13 && a.id !== b.id, { a: a.id, b: b.id, eventCount: a.eventCount });
  const N = a.eventCount;

  let ra = await post(`/api/replay/sessions/${a.id}/step`);
  validate('A.step#1', ra, 1, N);
  check('A.step#1: event 与游标对应', ra.event?.sequence === 1, ra.event);
  check('A.step#1: 盘口等于种子快照', ra.metrics.bidDepth === 2370 && ra.metrics.askDepth === 2040 && ra.metrics.bestBid === 100 && ra.metrics.bestAsk === 100.01 && Math.abs(ra.metrics.spread - 0.01) < 1e-9, ra.metrics);
  check('A.step#1: 指标不同于实时 engine 盘口（未误用）', !deepEq(ra.metrics, liveAnalytics), { session: ra.metrics, live: liveAnalytics });

  let rb = await post(`/api/replay/sessions/${b.id}/run`, { steps: 4 });
  validate('B.run(4)', rb, 4, N);
  check('B.run(4): processed=4', rb.processed === 4, rb.processed);

  ra = await post(`/api/replay/sessions/${a.id}/run`, { steps: 3 });
  validate('A.run(3)', ra, 4, N);
  check('A.run(3) 后与 B.run(4) 同游标：盘口一致', deepEq(ra.book, rb.book));
  check('A.run(3) 后与 B.run(4) 同游标：指标一致', deepEq(ra.metrics, rb.metrics));

  rb = await post(`/api/replay/sessions/${b.id}/step`);
  validate('B.step#5', rb, 5, N);
  ra = await post(`/api/replay/sessions/${a.id}/step`);
  validate('A.step#5', ra, 5, N);
  check('A/B 同游标 5：盘口与指标一致', deepEq(ra.book, rb.book) && deepEq(ra.metrics, rb.metrics));

  rb = await post(`/api/replay/sessions/${b.id}/run`, { steps: 100 });
  validate('B.run(100) 越界钳制', rb, N, N);
  check('B.run(100): processed 钳制为剩余 8', rb.processed === 8, rb.processed);

  ra = await post(`/api/replay/sessions/${a.id}/run`);
  validate('A.run() 跑到底', ra, N, N);
  check('A.run(): processed=8（已消费 5，剩余 8）', ra.processed === 8, ra.processed);
  check('A/B 均完成：盘口与指标一致', deepEq(ra.book, rb.book) && deepEq(ra.metrics, rb.metrics));

  // ---- 场景 2：完成后重复推进不重复消费 ----
  const bDoneBook = rb.book, bDoneMetrics = rb.metrics;
  const rbExtra = await post(`/api/replay/sessions/${b.id}/step`);
  check('完成后 B.step: done 且 event=null', rbExtra.done === true && rbExtra.event === null && rbExtra.status === 'completed');
  check('完成后 B.step: 游标/盘口/指标不变', rbExtra.cursor === N && deepEq(rbExtra.book, bDoneBook) && deepEq(rbExtra.metrics, bDoneMetrics), rbExtra);
  const rbExtra2 = await post(`/api/replay/sessions/${b.id}/step`);
  check('完成后 B.step 幂等（两次响应完全一致）', deepEq(rbExtra, rbExtra2));
  const raExtra = await post(`/api/replay/sessions/${a.id}/run`, { steps: 5 });
  check('完成后 A.run(5): processed=0 且不消费', raExtra.processed === 0 && raExtra.cursor === N && deepEq(raExtra.book, bDoneBook) && deepEq(raExtra.metrics, bDoneMetrics), raExtra);
  const raExtra2 = await post(`/api/replay/sessions/${a.id}/run`);
  check('完成后 A.run() 幂等', raExtra2.processed === 0 && deepEq(raExtra.book, raExtra2.book) && deepEq(raExtra.metrics, raExtra2.metrics));

  // ---- 场景 3：空数据日 ----
  const empty = await post('/api/replay/sessions', { symbol: 'ALPHA', tradingDay: '2026-10-01' });
  check('空数据日会话 eventCount=0', empty.eventCount === 0, empty);
  const e1 = await post(`/api/replay/sessions/${empty.id}/step`);
  check('空数据日 step: 立即完成且不消费', e1.done === true && e1.status === 'completed' && e1.cursor === 0 && e1.event === null, e1);
  check('空数据日 step: 指标稳定（空盘口）', e1.metrics.spread === null && e1.metrics.bidDepth === 0 && e1.metrics.askDepth === 0 && e1.metrics.imbalance === 0 && e1.metrics.marketBuyImpact.every((i: any) => i.filled === 0 && i.averagePrice === null && i.slippageBps === null), e1.metrics);
  const e2 = await post(`/api/replay/sessions/${empty.id}/step`);
  check('空数据日重复 step 幂等', deepEq(e1, e2));
  const e3 = await post(`/api/replay/sessions/${empty.id}/run`, { steps: 10 });
  check('空数据日 run: processed=0 且指标一致', e3.processed === 0 && e3.done === true && deepEq(e3.book, e1.book) && deepEq(e3.metrics, e1.metrics), e3);

  // ---- 场景 4：仅快照的回放 ----
  const ingest = await post('/api/market-data/events', { id: 'B-1', symbol: 'BETA', tradingDay: '2026-10-02', timestamp: '2026-10-02T09:30:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 50, quantity: 1000 }, { price: 49.99, quantity: 500 }], asks: [{ price: 50.02, quantity: 800 }] });
  check('BETA 快照事件接入', ingest.accepted === true, ingest);
  const snap = await post('/api/replay/sessions', { symbol: 'BETA', tradingDay: '2026-10-02' });
  check('仅快照会话 eventCount=1', snap.eventCount === 1, snap);
  const s1 = await post(`/api/replay/sessions/${snap.id}/step`);
  check('仅快照 step: 一步完成', s1.cursor === 1 && s1.status === 'completed' && s1.done === true && s1.event?.sequence === 1, s1);
  check('仅快照 step: 盘口等于快照', deepEq(s1.book.bids, [{ price: 50, quantity: 1000 }, { price: 49.99, quantity: 500 }]) && deepEq(s1.book.asks, [{ price: 50.02, quantity: 800 }]), s1.book);
  check('仅快照 step: 指标基于会话盘口', deepEq(s1.metrics, expectedMetrics('BETA', s1.book)) && s1.metrics.bidDepth === 1500 && s1.metrics.askDepth === 800 && Math.abs(s1.metrics.spread - 0.02) < 1e-9, s1.metrics);
  const s2 = await post(`/api/replay/sessions/${snap.id}/step`);
  check('仅快照完成后重复 step 幂等', deepEq(s1, { ...s2, event: s1.event }) && s2.event === null && deepEq(s2.book, s1.book) && deepEq(s2.metrics, s1.metrics));
  const s3 = await post(`/api/replay/sessions/${snap.id}/run`, { steps: 3 });
  check('仅快照完成后 run: processed=0 且稳定', s3.processed === 0 && deepEq(s3.book, s1.book) && deepEq(s3.metrics, s1.metrics), s3);

  console.log(failures ? `\n${failures} 项校验失败` : '\n全部校验通过');
  if (failures) process.exitCode = 1;
}

// 直接用 node --import tsx 启动服务（单进程，kill 即可终止，避免 npx 包装进程链残留）
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
try {
  let up = false;
  for (let i = 0; i < 100 && !up; i++) { try { const r = await fetch(`${BASE}/api/health`); up = r.ok; } catch { await new Promise(r => setTimeout(r, 150)); } }
  if (!up) { console.error('服务启动失败\n', serverLog); process.exitCode = 1; }
  else await main();
} finally {
  server.kill('SIGTERM');
}
process.exit(process.exitCode ?? 0);
