import { Analytics, PriceLevel, Side } from './types.js';

export type BookSnapshot = { bids: PriceLevel[]; asks: PriceLevel[]; sequence: number; timestamp: string };

export function computeAnalytics(symbol: string, snapshot: BookSnapshot): Analytics {
  const bestBid = snapshot.bids[0]?.price ?? null;
  const bestAsk = snapshot.asks[0]?.price ?? null;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : null;
  const bidDepth = snapshot.bids.reduce((sum, l) => sum + l.quantity, 0);
  const askDepth = snapshot.asks.reduce((sum, l) => sum + l.quantity, 0);
  const impact = (side: Side, requested: number) => {
    const levels = side === 'buy' ? snapshot.asks : snapshot.bids;
    let left = requested, notional = 0, filled = 0;
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
      averagePrice: averagePrice ? +averagePrice.toFixed(4) : null,
      slippageBps: averagePrice && reference ? +(((side === 'buy' ? averagePrice - reference : reference - averagePrice) / reference) * 10_000).toFixed(2) : null,
      filled: +filled.toFixed(4),
    };
  };
  const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
  const bidTop5 = snapshot.bids.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const askTop5 = snapshot.asks.slice(0, 5).reduce((s, l) => s + l.quantity, 0);
  const weightedImbalance = snapshot.bids.length && snapshot.asks.length ? (bidTop5 - askTop5) / (bidTop5 + askTop5) : 0;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : null;
  return {
    symbol,
    timestamp: snapshot.timestamp,
    bestBid,
    bestAsk,
    midPrice: mid,
    spread,
    relativeSpread: mid && spread ? spread / mid : null,
    bidDepth,
    askDepth,
    imbalance: +imbalance.toFixed(4),
    weightedImbalance: +weightedImbalance.toFixed(4),
    marketBuyImpact: [100, 500, 1000].map(q => impact('buy', q)),
    marketSellImpact: [100, 500, 1000].map(q => impact('sell', q)),
    estimatedFillProbability: {
      buy: +Math.min(0.98, 0.35 + Math.max(0, weightedImbalance) * .4).toFixed(3),
      sell: +Math.min(0.98, 0.35 + Math.max(0, -weightedImbalance) * .4).toFixed(3),
    },
    liquidityScore: +Math.max(0, Math.min(100, 100 - (spread ?? 0) * 100 + Math.min(bidDepth + askDepth, 2000) / 40)).toFixed(2),
  };
}
