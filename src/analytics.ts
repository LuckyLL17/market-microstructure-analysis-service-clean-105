import { OrderBook } from './order-book.js';
import { Analytics, ImpactCostDeltaPoint, MetricsDelta, Side } from './types.js';

const IMPACT_SIZES = [100, 500, 1000];
const ANALYTICS_DEPTH = 10;

/**
 * 基于传入的订单簿快照计算行情指标。
 * 回放会话传入的是会话自身的 OrderBook，因此计算结果只反映该会话已重放的事件，
 * 不会读取实时 MarketEngine 的当前盘口。
 */
export function computeAnalytics(book: Pick<OrderBook, 'snapshot'>, symbol: string): Analytics {
  const snapshot = book.snapshot(ANALYTICS_DEPTH);
  const bestBid = snapshot.bids[0]?.price ?? null;
  const bestAsk = snapshot.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const bidDepth = snapshot.bids.reduce((sum, level) => sum + level.quantity, 0);
  const askDepth = snapshot.asks.reduce((sum, level) => sum + level.quantity, 0);

  const impact = (side: Side, requested: number) => {
    const levels = side === 'buy' ? snapshot.asks : snapshot.bids;
    let left = requested;
    let notional = 0;
    let filled = 0;
    for (const level of levels) {
      const take = Math.min(left, level.quantity);
      notional += take * level.price;
      filled += take;
      left -= take;
      if (!left) break;
    }
    const averagePrice = filled ? notional / filled : null;
    const reference = side === 'buy' ? bestAsk : bestBid;
    return {
      quantity: requested,
      averagePrice: averagePrice !== null ? +averagePrice.toFixed(4) : null,
      slippageBps: averagePrice !== null && reference !== null
        ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2)
        : null,
      filled: +filled.toFixed(4),
    };
  };

  const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const topBidQty = snapshot.bids.slice(0, 5).reduce((sum, level) => sum + level.quantity, 0);
  const topAskQty = snapshot.asks.slice(0, 5).reduce((sum, level) => sum + level.quantity, 0);
  const weightedImbalance = snapshot.bids.length && snapshot.asks.length
    ? (topBidQty - topAskQty) / (topBidQty + topAskQty)
    : 0;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return {
    symbol,
    timestamp: snapshot.timestamp,
    bestBid,
    bestAsk,
    midPrice: mid,
    spread,
    relativeSpread: mid !== null && spread !== null ? spread / mid : null,
    bidDepth: +bidDepth.toFixed(4),
    askDepth: +askDepth.toFixed(4),
    imbalance: +imbalance.toFixed(4),
    weightedImbalance: +weightedImbalance.toFixed(4),
    marketBuyImpact: IMPACT_SIZES.map(quantity => impact('buy', quantity)),
    marketSellImpact: IMPACT_SIZES.map(quantity => impact('sell', quantity)),
    estimatedFillProbability: {
      buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * 0.4).toFixed(3),
      sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * 0.4).toFixed(3),
    },
    liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2),
  };
}

function change(after: number | null, before: number | null, digits: number): number | null {
  if (after === null || before === null) return null;
  return +(after - before).toFixed(digits);
}

function impactDelta(before: Analytics['marketBuyImpact'], after: Analytics['marketBuyImpact']): ImpactCostDeltaPoint[] {
  return after.map((point, index) => {
    const previous = before[index] ?? { averagePrice: null, slippageBps: null, filled: 0 };
    return {
      quantity: point.quantity,
      averagePrice: point.averagePrice,
      slippageBps: point.slippageBps,
      filled: point.filled,
      averagePriceChange: change(point.averagePrice, previous.averagePrice, 4),
      slippageBpsChange: change(point.slippageBps, previous.slippageBps, 2),
      filledChange: +(point.filled - previous.filled).toFixed(4),
    };
  });
}

/**
 * 计算一次推进前后的指标变化（价差、深度、失衡、冲击成本等）。
 * 若本次推进没有消费任何事件（空跑/已完成），调用方应直接返回 null 而不是无变化的差值。
 */
export function diffMetrics(before: Analytics, after: Analytics): MetricsDelta {
  return {
    bestBidChange: change(after.bestBid, before.bestBid, 4),
    bestAskChange: change(after.bestAsk, before.bestAsk, 4),
    midPriceChange: change(after.midPrice, before.midPrice, 4),
    spreadChange: change(after.spread, before.spread, 4),
    relativeSpreadChange: change(after.relativeSpread, before.relativeSpread, 8),
    bidDepthChange: +(after.bidDepth - before.bidDepth).toFixed(4),
    askDepthChange: +(after.askDepth - before.askDepth).toFixed(4),
    imbalanceChange: +(after.imbalance - before.imbalance).toFixed(4),
    weightedImbalanceChange: +(after.weightedImbalance - before.weightedImbalance).toFixed(4),
    marketBuyImpactChange: impactDelta(before.marketBuyImpact, after.marketBuyImpact),
    marketSellImpactChange: impactDelta(before.marketSellImpact, after.marketSellImpact),
    liquidityScoreChange: +(after.liquidityScore - before.liquidityScore).toFixed(2),
  };
}
