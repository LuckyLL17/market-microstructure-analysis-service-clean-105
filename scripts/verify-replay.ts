import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { OrderBook } from '../src/order-book.js';
import { computeAnalytics, diffMetrics } from '../src/analytics.js';
import { Analytics, MarketEvent, MetricsDelta } from '../src/types.js';

const BASE = 'http://127.0.0.1:6190';
const passed: string[] = [];
function near(a: unknown, b: unknown, path: string): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * (1 + Math.abs(b)) ? null : `${path}: ${a} !== ${b}`;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return a === b ? null : `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}: array length`;
    for (let i = 0; i < a.length; i++) { const d = near(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  const ka = Object.keys(a as object); const kb = Object.keys(b as object);
  if (ka.length !== kb.length || ka.some(k => !(k in (b as object)))) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`;
  for (const key of ka) {
    const d = near((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
    if (d) return d;
  }
  return null;
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const diff = near(actual, expected, '$');
  if (diff) {
    console.error(`FAIL: ${name} -> ${diff}`);
    console.error('actual  =', JSON.stringify(actual));
    console.error('expected=', JSON.stringify(expected));
    process.exit(1);
  }
  passed.push(name);
}
function ok(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) { console.error(`FAIL: ${name}`, JSON.stringify(detail)); process.exit(1); }
  passed.push(name);
}

async function api(path: string, options: { method?: string; body?: unknown } = {}): Promise<any> {
  const method = options.method ?? 'GET';
  const hasBody = options.body !== undefined;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
    body: method === 'POST' ? JSON.stringify(hasBody ? options.body : {}) : undefined,
  });
  return res.json();
}

// ---- 启动服务 ----
const server = spawn('node', ['dist/server.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
let serverExited: number | null = null;
server.on('exit', code => { serverExited = code; });
try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (serverExited !== null) throw new Error(`server exited early (${serverExited}):\n${serverLog}`);
    try { const h = await api('/api/health'); if (h.status === 'ok') { ready = true; break; } } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw new Error(`server failed to start:\n${serverLog}`);

  const emptyAnalytics: Analytics = {
    symbol: 'ALPHA', timestamp: '', bestBid: null, bestAsk: null, midPrice: null, spread: null,
    relativeSpread: null, bidDepth: 0, askDepth: 0, imbalance: 0, weightedImbalance: 0,
    marketBuyImpact: [100, 500, 1000].map(q => ({ quantity: q, averagePrice: null, slippageBps: null, filled: 0 })),
    marketSellImpact: [100, 500, 1000].map(q => ({ quantity: q, averagePrice: null, slippageBps: null, filled: 0 })),
    estimatedFillProbability: { buy: 0.35, sell: 0.35 }, liquidityScore: 100,
  };

  // ---- 标准事件序列（用独立影子簿逐步重放，作为唯一真值）----
  const canonical: MarketEvent[] = [];
  const shadow = new OrderBook('ALPHA');
  const bookAt: Array<ReturnType<OrderBook['snapshot']>> = [shadow.snapshot(20)];
  const analyticsAt: Analytics[] = [computeAnalytics(shadow, 'ALPHA')];
  function advanceShadow(event: MarketEvent): void {
    canonical.push(event);
    shadow.apply(event);
    bookAt.push(shadow.snapshot(20));
    analyticsAt.push(computeAnalytics(shadow, 'ALPHA'));
  }

  const BASE_FIELDS = ['id', 'symbol', 'tradingDay', 'cursor', 'status', 'speed', 'eventCount', 'processed', 'done', 'book', 'metrics', 'metricsBefore', 'metricsDelta'];
  function expectBaseFields(name: string, r: any, speed: number): void {
    for (const field of BASE_FIELDS) ok(`${name}.${name ? field : field}`, field in r, r);
    eq(`${name}:speed 不被破坏`, r.speed, speed);
    ok(`${name}:book 结构稳定`, !!r.book && Array.isArray(r.book.bids) && Array.isArray(r.book.asks));
    ok(`${name}:metrics 结构稳定`, r.metrics && Array.isArray(r.metrics.marketBuyImpact) && Array.isArray(r.metrics.marketSellImpact));
  }

  // =====================================================================
  // A. 探针会话：逐步重放 2026-09-30（snapshot + 12 事件，共 13 步）
  // =====================================================================
  const probe = await api('/api/replay/sessions', { method: 'POST', body: { symbol: 'ALPHA', tradingDay: '2026-09-30' } });
  eq('A0: 新建会话 cursor=0', probe.cursor, 0);
  eq('A0: 新建会话 status=ready', probe.status, 'ready');
  eq('A0: 新建会话 eventCount=13', probe.eventCount, 13);
  eq('A0: 新建会话空 book', probe.book, { bids: [], asks: [], sequence: 0, timestamp: '' });

  let impactChangedSteps = 0;
  for (let i = 1; i <= 13; i++) {
    const before = analyticsAt[i - 1];
    const r = await api(`/api/replay/sessions/${probe.id}/step`, { method: 'POST' });
    advanceShadow(r.event);
    expectBaseFields(`A${i}-step`, r, 1);
    eq(`A${i}:cursor`, r.cursor, i);
    eq(`A${i}:status`, r.status, i === 13 ? 'completed' : 'paused');
    eq(`A${i}:done`, r.done, i === 13);
    eq(`A${i}:processed=1`, r.processed, 1);
    eq(`A${i}:event 是当前游标事件`, r.event, canonical[i - 1]);
    eq(`A${i}:book 来自会话自身订单簿`, r.book, bookAt[i]);
    eq(`A${i}:metrics 来自会话自身订单簿`, r.metrics, analyticsAt[i]);
    eq(`A${i}:metricsBefore 是推进前指标`, r.metricsBefore, before);
    const expectedDelta: MetricsDelta = diffMetrics(before, analyticsAt[i]);
    eq(`A${i}:metricsDelta`, r.metricsDelta, expectedDelta);
    if (r.metricsDelta.marketBuyImpactChange.some((p: any) => p.filledChange !== 0 || p.slippageBpsChange !== 0) ||
        r.metricsDelta.marketSellImpactChange.some((p: any) => p.filledChange !== 0 || p.slippageBpsChange !== 0)) impactChangedSteps++;
  }
  ok('A: 至少一步出现冲击成本变化', impactChangedSteps > 0, { impactChangedSteps });
  const finalMetrics = analyticsAt[13];
  const finalBook = bookAt[13];

  // 完成后再 step：不能重复消费
  const again = await api(`/api/replay/sessions/${probe.id}/step`, { method: 'POST' });
  expectBaseFields('A-repeat-step', again, 1);
  eq('A-repeat:cursor 不回退不增长', again.cursor, 13);
  eq('A-repeat:status=completed', again.status, 'completed');
  eq('A-repeat:processed=0', again.processed, 0);
  eq('A-repeat:event=null', again.event, null);
  eq('A-repeat:metricsBefore=null', again.metricsBefore, null);
  eq('A-repeat:metricsDelta=null', again.metricsDelta, null);
  eq('A-repeat:book 稳定', again.book, finalBook);
  eq('A-repeat:metrics 稳定', again.metrics, finalMetrics);

  // 完成后再 run：同样不能重复消费
  const againRun = await api(`/api/replay/sessions/${probe.id}/run`, { method: 'POST', body: { steps: 5 } });
  eq('A-run-repeat:processed=0', againRun.processed, 0);
  eq('A-run-repeat:cursor', againRun.cursor, 13);
  eq('A-run-repeat:metricsDelta=null', againRun.metricsDelta, null);
  eq('A-run-repeat:book 稳定', againRun.book, finalBook);

  // =====================================================================
  // B. 两个不同游标/速度的会话交错 step/run
  // =====================================================================
  const s1 = await api('/api/replay/sessions', { method: 'POST', body: { speed: 2 } });
  const s2 = await api('/api/replay/sessions', { method: 'POST', body: { speed: 3 } });
  eq('B: S1/S2 事件数一致', [s1.eventCount, s2.eventCount], [13, 13]);

  const r1 = await api(`/api/replay/sessions/${s1.id}/run`, { method: 'POST', body: { steps: 3 } });
  expectBaseFields('B-S1-run3', r1, 2);
  eq('B-S1-run3:cursor', r1.cursor, 3);
  eq('B-S1-run3:status', r1.status, 'paused');
  eq('B-S1-run3:processed', r1.processed, 3);
  eq('B-S1-run3:book', r1.book, bookAt[3]);
  eq('B-S1-run3:metrics', r1.metrics, analyticsAt[3]);
  eq('B-S1-run3:metricsBefore 为空盘指标', r1.metricsBefore, emptyAnalytics);
  eq('B-S1-run3:delta 聚合 3 步', r1.metricsDelta, diffMetrics(analyticsAt[0], analyticsAt[3]));

  const r2 = await api(`/api/replay/sessions/${s2.id}/step`, { method: 'POST' });
  expectBaseFields('B-S2-step1', r2, 3);
  eq('B-S2-step1:cursor', r2.cursor, 1);
  eq('B-S2-step1:book', r2.book, bookAt[1]);
  eq('B-S2-step1:metrics', r2.metrics, analyticsAt[1]);

  // 交错期间 S1 状态不受 S2 影响
  const g1 = await api(`/api/replay/sessions/${s1.id}`);
  eq('B: 交错后 S1 cursor 仍是 3', g1.cursor, 3);
  eq('B: 交错后 S1 speed 仍是 2', g1.speed, 2);

  const r3 = await api(`/api/replay/sessions/${s1.id}/step`, { method: 'POST' });
  eq('B-S1-step:cursor=4', r3.cursor, 4);
  eq('B-S1-step:book', r3.book, bookAt[4]);
  eq('B-S1-step:metricsBefore', r3.metricsBefore, analyticsAt[3]);
  eq('B-S1-step:delta', r3.metricsDelta, diffMetrics(analyticsAt[3], analyticsAt[4]));

  const r4 = await api(`/api/replay/sessions/${s2.id}/run`, { method: 'POST', body: { steps: 2 } });
  eq('B-S2-run2:processed', r4.processed, 2);
  eq('B-S2-run2:cursor=3', r4.cursor, 3);
  eq('B-S2-run2:book', r4.book, bookAt[3]);
  eq('B-S2-run2:metrics', r4.metrics, analyticsAt[3]);

  const r5 = await api(`/api/replay/sessions/${s2.id}/step`, { method: 'POST' });
  eq('B-S2-step:cursor=4', r5.cursor, 4);
  eq('B-S2-step:book', r5.book, bookAt[4]);
  eq('B-S2-step:metrics', r5.metrics, analyticsAt[4]);
  // 两个会话到达同一游标时盘口与指标必须一致（各自独立计算）
  eq('B: S1@4 与 S2@4 盘口一致', r3.book, r5.book);
  eq('B: S1@4 与 S2@4 指标一致', r3.metrics, r5.metrics);

  // ---- 向实时 engine 注入一个会横扫买盘的污染事件 ----
  const pollution = {
    id: 'POLL-1', symbol: 'ALPHA', tradingDay: '2026-09-30',
    timestamp: '2026-09-30T10:00:00.000Z', sequence: 100, type: 'new_order',
    orderId: 'POLL-1', side: 'sell', price: 90, quantity: 10000,
  };
  const ingested = await api('/api/market-data/events', { method: 'POST', body: pollution });
  eq('C: 污染事件被实时 engine 接收', ingested.accepted, true);
  const liveAnalytics = await api('/api/analytics/ALPHA');
  ok('C: 实时 engine 盘口已被污染（不同于会话游标4）', JSON.stringify(liveAnalytics) !== JSON.stringify(analyticsAt[4]));

  // S2 在污染后继续推进：事件序列在创建时已固化，且指标只读会话自己的 book
  const r6 = await api(`/api/replay/sessions/${s2.id}/step`, { method: 'POST' });
  eq('C-S2:cursor=5', r6.cursor, 5);
  eq('C-S2:book 不受实时 engine 污染影响', r6.book, bookAt[5]);
  eq('C-S2:metrics 不受实时 engine 污染影响', r6.metrics, analyticsAt[5]);
  eq('C-S2:event 仍是固化的标准事件', r6.event, canonical[4]);
  const g2 = await api(`/api/replay/sessions/${s2.id}`);
  eq('C-S2:eventCount 仍为 13（创建时固化）', g2.eventCount, 13);

  // 污染后新建的会话能看到新事件（固化时点不同）
  const s3 = await api('/api/replay/sessions', { method: 'POST', body: {} });
  eq('C-S3:eventCount=14（含污染事件）', s3.eventCount, 14);
  const r7 = await api(`/api/replay/sessions/${s3.id}/step`, { method: 'POST' });
  eq('C-S3:第一步仍是 snapshot', r7.event, canonical[0]);
  eq('C-S3:book 与标准游标1一致', r7.book, bookAt[1]);

  // S1 大步 run 到完成
  const r8 = await api(`/api/replay/sessions/${s1.id}/run`, { method: 'POST', body: { steps: 100 } });
  expectBaseFields('C-S1-run-all', r8, 2);
  eq('C-S1:processed=9', r8.processed, 9);
  eq('C-S1:cursor=13', r8.cursor, 13);
  eq('C-S1:status=completed', r8.status, 'completed');
  eq('C-S1:done', r8.done, true);
  eq('C-S1:book', r8.book, finalBook);
  eq('C-S1:metrics', r8.metrics, finalMetrics);
  eq('C-S1:delta=4->13', r8.metricsDelta, diffMetrics(analyticsAt[4], analyticsAt[13]));

  // S1 重复推进不消费
  const r9 = await api(`/api/replay/sessions/${s1.id}/step`, { method: 'POST' });
  eq('C-S1-repeat-step:processed=0', r9.processed, 0);
  eq('C-S1-repeat-step:cursor 不变', r9.cursor, 13);
  eq('C-S1-repeat-step:delta=null', r9.metricsDelta, null);
  eq('C-S1-repeat-step:metricsBefore=null', r9.metricsBefore, null);
  const r10 = await api(`/api/replay/sessions/${s1.id}/run`, { method: 'POST', body: {} });
  eq('C-S1-repeat-run:processed=0', r10.processed, 0);
  eq('C-S1-repeat-run:delta=null', r10.metricsDelta, null);
  eq('C-S1-repeat-run:book 稳定', r10.book, finalBook);

  // S2 无 steps 参数直接跑到完成
  const r11 = await api(`/api/replay/sessions/${s2.id}/run`, { method: 'POST', body: {} });
  eq('C-S2-run-all:processed=8', r11.processed, 8);
  eq('C-S2-run-all:cursor=13', r11.cursor, 13);
  eq('C-S2-run-all:status=completed', r11.status, 'completed');
  eq('C-S2-run-all:book', r11.book, finalBook);
  eq('C-S2-run-all:metrics', r11.metrics, finalMetrics);
  const r12 = await api(`/api/replay/sessions/${s2.id}/step`, { method: 'POST' });
  eq('C-S2-repeat:processed=0', r12.processed, 0);
  eq('C-S2-repeat:status=completed', r12.status, 'completed');

  // steps 为负数等异常输入也不能消费
  const rNeg = await api(`/api/replay/sessions/${s2.id}/run`, { method: 'POST', body: { steps: -5 } });
  eq('C-S2-negative-steps:processed=0', rNeg.processed, 0);
  eq('C-S2-negative-steps:cursor 稳定', rNeg.cursor, 13);

  // =====================================================================
  // D. 只有 snapshot 的回放日
  // =====================================================================
  const snapshotOnly = {
    id: 'SNAP-1', symbol: 'ALPHA', tradingDay: '2026-10-01',
    timestamp: '2026-10-01T09:30:00.000Z', sequence: 200, type: 'snapshot',
    bids: [{ price: 10.0, quantity: 100 }, { price: 9.99, quantity: 200 }],
    asks: [{ price: 10.01, quantity: 150 }, { price: 10.02, quantity: 250 }],
  };
  await api('/api/market-data/events', { method: 'POST', body: snapshotOnly });

  const s4 = await api('/api/replay/sessions', { method: 'POST', body: { tradingDay: '2026-10-01', speed: 5 } });
  eq('D: eventCount=1', s4.eventCount, 1);
  eq('D: 初始 status=ready', s4.status, 'ready');

  const d1 = await api(`/api/replay/sessions/${s4.id}/step`, { method: 'POST' });
  const snapShadow = new OrderBook('ALPHA');
  snapShadow.apply(snapshotOnly);
  const snapBook = snapShadow.snapshot(20);
  const snapAnalytics = computeAnalytics(snapShadow, 'ALPHA');
  expectBaseFields('D-step', d1, 5);
  eq('D: 一步即完成', [d1.cursor, d1.status, d1.done, d1.processed], [1, 'completed', true, 1]);
  eq('D:book=snapshot 盘口', d1.book, snapBook);
  eq('D:metrics=snapshot 指标', d1.metrics, snapAnalytics);
  eq('D:metricsBefore=空盘指标', d1.metricsBefore, emptyAnalytics);
  eq('D:delta=空盘->snapshot', d1.metricsDelta, diffMetrics(emptyAnalytics, snapAnalytics));
  eq('D: 价差=0.01', d1.metrics.spread, 0.01);
  eq('D: 买深度=300', d1.metrics.bidDepth, 300);
  eq('D: 卖深度=400', d1.metrics.askDepth, 400);

  const d2 = await api(`/api/replay/sessions/${s4.id}/step`, { method: 'POST' });
  eq('D-repeat:processed=0', d2.processed, 0);
  eq('D-repeat:book 稳定', d2.book, snapBook);
  eq('D-repeat:metrics 稳定', d2.metrics, snapAnalytics);
  eq('D-repeat:delta=null', d2.metricsDelta, null);

  // 另一个只有 snapshot 的会话用 run 一次跑完
  const s5 = await api('/api/replay/sessions', { method: 'POST', body: { tradingDay: '2026-10-01' } });
  const d3 = await api(`/api/replay/sessions/${s5.id}/run`, { method: 'POST', body: {} });
  eq('D-S5-run:processed=1', d3.processed, 1);
  eq('D-S5-run:completed', d3.status, 'completed');
  eq('D-S5-run:book', d3.book, snapBook);
  const d4 = await api(`/api/replay/sessions/${s5.id}/run`, { method: 'POST', body: {} });
  eq('D-S5-run-repeat:processed=0', d4.processed, 0);
  eq('D-S5-run-repeat:cursor 稳定', d4.cursor, 1);
  eq('D-S5-run-repeat:delta=null', d4.metricsDelta, null);

  // =====================================================================
  // E. 空数据日
  // =====================================================================
  const s6 = await api('/api/replay/sessions', { method: 'POST', body: { tradingDay: '2026-10-02', speed: 9 } });
  eq('E: eventCount=0', s6.eventCount, 0);
  eq('E: 创建即 completed', s6.status, 'completed');
  eq('E: nextEvent=null', s6.nextEvent, null);

  const e1 = await api(`/api/replay/sessions/${s6.id}/step`, { method: 'POST' });
  expectBaseFields('E-step', e1, 9);
  eq('E-step:cursor=0', e1.cursor, 0);
  eq('E-step:status=completed', e1.status, 'completed');
  eq('E-step:done', e1.done, true);
  eq('E-step:processed=0', e1.processed, 0);
  eq('E-step:event=null', e1.event, null);
  eq('E-step:book 为空', e1.book, { bids: [], asks: [], sequence: 0, timestamp: '' });
  eq('E-step:metrics 为稳定空盘指标', e1.metrics, emptyAnalytics);
  eq('E-step:metricsBefore=null', e1.metricsBefore, null);
  eq('E-step:metricsDelta=null', e1.metricsDelta, null);

  const e2 = await api(`/api/replay/sessions/${s6.id}/run`, { method: 'POST', body: {} });
  eq('E-run:processed=0', e2.processed, 0);
  eq('E-run:cursor 稳定', e2.cursor, 0);
  eq('E-run:metrics 稳定', e2.metrics, emptyAnalytics);
  eq('E-run:metricsDelta=null', e2.metricsDelta, null);
  eq('E-run:book 为空', e2.book, { bids: [], asks: [], sequence: 0, timestamp: '' });

  // =====================================================================
  // F. 实时接口与现有字段未被破坏
  // =====================================================================
  const liveBook = await api('/api/orderbook/ALPHA');
  ok('F: /api/orderbook 仍返回盘口', Array.isArray(liveBook.bids) && Array.isArray(liveBook.asks));
  ok('F: /api/analytics 仍返回完整指标', liveBook && typeof (await api('/api/analytics/ALPHA')).liquidityScore === 'number');
  const health = await api('/api/health');
  eq('F: health', health.status, 'ok');

  console.log(`\n全部 ${passed.length} 项核对通过 ✔`);
} finally {
  server.kill();
}
