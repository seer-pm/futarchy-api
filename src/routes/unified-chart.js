/**
 * Unified Chart Endpoint (v2)
 * 
 * GET /api/v2/proposals/:proposalId/chart?minTimestamp=...&maxTimestamp=...
 * 
 * Combines all data the UI needs in a single request:
 *   - Market metadata (prices, pool IDs, volume, timeline, tokens)
 *   - YES/NO candles (from Checkpoint or Graph Node)
 *   - Spot candles (from GeckoTerminal, rate-divided)
 * 
 * Reuses existing adapters from market-events.js — no logic duplication.
 */

import { fetchPoolsForProposal as fetchPoolsAdapter, fetchCandles } from '../adapters/candles-adapter.js';
import { resolveProposalId as resolveProposalAdapter } from '../adapters/registry-adapter.js';
import { IS_CHECKPOINT, ENDPOINTS } from '../config/endpoints.js';
import { getRateCached } from '../services/rate-provider.js';
import { getSpotPrice, fetchSpotCandles, USE_FUTARCHY_SPOT } from '../services/spot-source.js';
import { responseCache, candlesCache, spotCache, logCacheStats } from '../utils/cache.js';
import { registerForWarming } from '../utils/warmer.js';
import { RESPONSE_TTL_SEC } from '../config/cache-config.js';
import { extractTokensFromPools } from '../utils/token-from-pool.js';

// ============================================================================
// REGISTRY HELPERS (only for non-Checkpoint fallback)
// ============================================================================

const FUTARCHY_REGISTRY_ENDPOINT = ENDPOINTS.registry;
const AGGREGATOR_ADDRESS = '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1';

async function gqlFetch(url, query) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
    });
    return res.json();
}

/**
 * Lookup org-level metadata (price_precision, currency_stable_rate, etc.)
 * Only needed when not available from proposal-level metadata.
 */
async function lookupOrgMetadataField(orgId, key) {
    if (!orgId) return null;
    try {
        const query = `{
            metadataEntries(where: { key: "${key}", organization: "${orgId}" }) { value }
        }`;
        const data = await gqlFetch(FUTARCHY_REGISTRY_ENDPOINT, query);
        return data?.data?.metadataEntries?.[0]?.value || null;
    } catch { return null; }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

export async function handleUnifiedChartRequest(req, res) {
    const { proposalId } = req.params;
    const minTimestamp = parseInt(req.query.minTimestamp) || 0;
    const maxTimestamp = parseInt(req.query.maxTimestamp) || Math.floor(Date.now() / 1000);
    const includeSpot = req.query.includeSpot !== 'false'; // default true
    const applyCurrencyRate = req.query.applyCurrencyRate === 'true'; // default false

    // ── Response-level cache ──
    const cacheKey = `${proposalId}:${minTimestamp}:${maxTimestamp}:${includeSpot}:${applyCurrencyRate}`;
    const cachedResponse = responseCache.get(cacheKey);
    if (cachedResponse) {
        console.log(`⚡ [Unified Chart] CACHE HIT ${proposalId.slice(0, 10)}... (0ms)`);
        logCacheStats();
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-TTL', String(RESPONSE_TTL_SEC));
        res.set('X-Response-Time', '0ms');
        return res.json(cachedResponse);
    }

    console.log(`⚡ [Unified Chart] ${proposalId.slice(0, 10)}... (${minTimestamp}→${maxTimestamp}) spot=${includeSpot} applyCurrencyRate=${applyCurrencyRate}`);
    const t0 = Date.now();

    try {
        // ── Step 1: Resolve proposal using EXISTING adapter ──
        const t1 = Date.now();
        const resolved = await resolveProposalAdapter(proposalId);

        if (!resolved) {
            return res.status(404).json({
                status: 'not_found',
                error: 'No Futarchy market is linked to this Snapshot proposal',
                proposal_id: proposalId
            });
        }

        const tradingContractId = resolved.proposalAddress || resolved.proposalId;
        const ticker = resolved.coingeckoTicker || null;
        const chartStartRange = resolved.startCandleUnix || null;
        const closeTimestamp = resolved.closeTimestamp || null;
        const chainId = resolved.chain || 100;

        // Clamp minTimestamp to startCandleUnix so the first candle matches the registry start
        const effectiveMinTimestamp = chartStartRange
            ? Math.max(minTimestamp, chartStartRange)
            : minTimestamp;

        if (chartStartRange && effectiveMinTimestamp !== minTimestamp) {
            console.log(`   📅 Clamped minTimestamp ${minTimestamp} → ${effectiveMinTimestamp} (startCandleUnix=${chartStartRange})`);
        }

        console.log(`   🔗 Resolved: ${tradingContractId?.slice(0, 10)}... chain=${chainId} ticker=${ticker?.slice(0, 20) || 'none'} (${Date.now() - t1}ms)`);

        // ── Step 2: Fetch pools ──
        const t2 = Date.now();
        const pools = await fetchPoolsAdapter(tradingContractId, chainId);

        // Pool-type preference: CONDITIONAL is the legacy/canonical YES/NO pool
        // (YES_TOKEN/YES_CURRENCY). Newer markets like GIP-150 v2 are deployed
        // with PREDICTION pools (YES_sDAI/sDAI = probability) and EXPECTED_VALUE
        // pools (YES_TOKEN/CURRENCY = projected value) instead. Fall back to
        // PREDICTION (probability semantics match what UI shows as "YES Price")
        // and finally EXPECTED_VALUE so something is always returned when pools exist.
        function findPoolByOutcome(side) {
            return pools.find(p => p.outcomeSide === side && p.type === 'CONDITIONAL')
                || pools.find(p => p.outcomeSide === side && p.type === 'PREDICTION')
                || pools.find(p => p.outcomeSide === side && p.type === 'EXPECTED_VALUE');
        }
        const yesPool = findPoolByOutcome('YES');
        const noPool = findPoolByOutcome('NO');

        console.log(`   📦 Pools: YES=${!!yesPool} NO=${!!noPool} (${Date.now() - t2}ms)`);

        // ── Step 3: Org-level metadata (fallback when not on proposal) ──
        const t3 = Date.now();
        const pricePrecision = resolved.pricePrecision ?? await lookupOrgMetadataField(resolved.organizationId, 'price_precision');
        const currencyRateProvider = resolved.currencyStableRate ?? await lookupOrgMetadataField(resolved.organizationId, 'currency_stable_rate');
        const currencyStableSymbol = resolved.currencyStableSymbol ?? await lookupOrgMetadataField(resolved.organizationId, 'currency_stable_symbol');

        console.log(`   📋 Org metadata fallbacks (${Date.now() - t3}ms)`);

        // ── Step 4: Fetch data in PARALLEL (spot only if includeSpot) ──
        const t4 = Date.now();
        const tRate = Date.now();
        const tYes = Date.now();
        const tNo = Date.now();
        const tSpot = Date.now();

        const [currencyRate, yesCandles, noCandles, spotData] = await Promise.all([
            getRateCached(currencyRateProvider, chainId).then(r => { console.log(`      💱 Rate: ${r?.toFixed(4) || 'N/A'} (${Date.now() - tRate}ms)`); return r; }),
            yesPool ? (candlesCache.get(`yes:${yesPool.id}:${effectiveMinTimestamp}:${maxTimestamp}`) || fetchCandles(yesPool.id, effectiveMinTimestamp, maxTimestamp, chainId).then(c => { candlesCache.set(`yes:${yesPool.id}:${effectiveMinTimestamp}:${maxTimestamp}`, c); console.log(`      📈 YES candles: ${c.length} (${Date.now() - tYes}ms)`); return c; })) : Promise.resolve([]),
            noPool ? (candlesCache.get(`no:${noPool.id}:${effectiveMinTimestamp}:${maxTimestamp}`) || fetchCandles(noPool.id, effectiveMinTimestamp, maxTimestamp, chainId).then(c => { candlesCache.set(`no:${noPool.id}:${effectiveMinTimestamp}:${maxTimestamp}`, c); console.log(`      📉 NO candles: ${c.length} (${Date.now() - tNo}ms)`); return c; })) : Promise.resolve([]),
            (includeSpot && ticker) ? (async () => {
                if (USE_FUTARCHY_SPOT) return fetchSpotCandles(ticker, 500, maxTimestamp + 3600, effectiveMinTimestamp).then(s => { console.log(`      💹 Spot: ${s?.candles?.length || 0} raw [futarchy-spot] (${Date.now() - tSpot}ms)`); return s; });
                
                // Identify if the request represents a historical chart (> 3 days old)
                const now = Math.floor(Date.now() / 1000);
                const isHistorical = maxTimestamp < (now - 3 * 86400);
                // Use a different cache key to prevent live dates from poisoning historical queries
                const cacheKey = isHistorical ? `${ticker}:hist:${Math.floor(maxTimestamp / 86400)}` : ticker;

                const cached = spotCache.get(cacheKey);
                if (cached) return cached;

                const s = await fetchSpotCandles(ticker, 500, maxTimestamp + 3600, effectiveMinTimestamp);
                if (s?.candles?.length > 0) spotCache.set(cacheKey, s);
                console.log(`      💹 Spot: ${s?.candles?.length || 0} raw (${Date.now() - tSpot}ms) key=${cacheKey}`);
                return s;
            })() : Promise.resolve(null),
        ]);

        console.log(`   ⏱️ Parallel fetch total: ${Date.now() - t4}ms`);

        // ── Step 5: Process spot candles (exclude composite from rate logic) ──
        let spotCandles = [];
        let spotPrice = null;
        if (spotData && ticker) {
            let rateDivisor = 1;
            // Only divide if the ticker contains a rate provider and is NOT a composite pool.
            // Composite pools natively divide their prices in the backend proxy (spot-price.js).
            if (ticker.includes('::') && !ticker.startsWith('composite::')) {
                rateDivisor = currencyRate || 1;
            }

            spotCandles = (spotData.candles || [])
                .filter(c => c.time >= effectiveMinTimestamp && c.time <= maxTimestamp)
                .map(c => ({
                    periodStartUnix: String(c.time),
                    close: String(c.value / rateDivisor)
                }));

            const rawSpotPrice = spotData.price;
            if (rawSpotPrice !== null) {
                spotPrice = rawSpotPrice / rateDivisor;
            }
        }

        // ── Step 6: Extract token info ──
        // Graph Node responses include nested companyToken/currencyToken on the
        // proposal; Checkpoint doesn't, so we walk all available pools and
        // parse names (CONDITIONAL > EXPECTED_VALUE > PREDICTION).
        const proposal = pools[0]?.proposal;
        let companyToken = proposal?.companyToken;
        let currencyToken = proposal?.currencyToken;

        if (!companyToken?.symbol || !currencyToken?.symbol) {
            const fromPools = extractTokensFromPools(pools);
            companyToken  = companyToken?.symbol  ? companyToken  : fromPools.companyToken;
            currencyToken = currencyToken?.symbol ? currencyToken : fromPools.currencyToken;
        }

        // ── Step 7: Prices ──
        const yesPrice = yesPool ? parseFloat(yesPool.price) * (currencyRate || 1) : 0;
        const noPrice = noPool ? parseFloat(noPool.price) * (currencyRate || 1) : 0;

        // ── Step 8: Volume (always in currency terms, e.g. sDAI) ──
        function extractVolume(pool) {
            if (!pool) return undefined;
            const currencyVol = pool.token0?.role?.includes('CURRENCY')
                ? pool.volumeToken0 : pool.token1?.role?.includes('CURRENCY')
                    ? pool.volumeToken1 : pool.volumeToken1;
            const rawCurrency = parseFloat(currencyVol || '0');
            // volume_usd = currency volume * rate (sDAI→xDAI)
            const volumeUsd = String(rawCurrency * (currencyRate || 1));
            return { status: 'ok', pool_id: pool.id, volume: String(rawCurrency), volume_usd: volumeUsd };
        }

        // ── Build unified response ──
        const now = Math.floor(Date.now() / 1000);

        // ── Apply currency rate to candles if requested ──
        const rate = currencyRate || 1;
        const shouldApplyRate = applyCurrencyRate && rate !== 1;

        function applyRateToCandles(candles) {
            if (!shouldApplyRate) return candles;
            return candles.map(c => ({
                ...c,
                open: c.open ? String(parseFloat(c.open) * rate) : c.open,
                high: c.high ? String(parseFloat(c.high) * rate) : c.high,
                low: c.low ? String(parseFloat(c.low) * rate) : c.low,
                close: c.close ? String(parseFloat(c.close) * rate) : c.close,
            }));
        }

        const response = {
            market: {
                event_id: resolved.originalProposalId,
                trading_address: tradingContractId,
                conditional_yes: { price_usd: yesPrice, pool_id: yesPool?.id || '' },
                conditional_no: { price_usd: noPrice, pool_id: noPool?.id || '' },
                spot: { price_usd: spotPrice, pool_ticker: ticker || null },
                company_tokens: {
                    base: { tokenSymbol: companyToken?.symbol || 'TOKEN' },
                    currency: { tokenSymbol: currencyToken?.symbol || 'CURRENCY', stableSymbol: currencyStableSymbol || null }
                },
                timeline: {
                    start: chartStartRange || (now - 2 * 24 * 3600),
                    end: closeTimestamp || (now + 3 * 24 * 3600),
                    chain_id: chainId,
                    chart_start_range: chartStartRange || null,
                    start_candle_unix: chartStartRange ? parseInt(chartStartRange) : null,
                    close_timestamp: closeTimestamp || null,
                    price_precision: pricePrecision ? parseInt(pricePrecision) : null,
                    currency_rate: currencyRateProvider ? currencyRate : null,
                    currency_rate_applied: shouldApplyRate
                },
                volume: {
                    conditional_yes: extractVolume(yesPool),
                    conditional_no: extractVolume(noPool)
                }
            },
            candles: {
                yes: applyRateToCandles(yesCandles),
                no: applyRateToCandles(noCandles),
                spot: spotCandles
            }
        };

        const elapsed = Date.now() - t0;
        console.log(`   ✅ Done: YES=${yesCandles.length} NO=${noCandles.length} SPOT=${spotCandles.length} (${elapsed}ms)`);
        logCacheStats();
        responseCache.set(cacheKey, response);
        // With CoinGecko Pro API key (250 req/min), warmer can include spot data
        registerForWarming(cacheKey, { proposalId, minTimestamp, maxTimestamp, includeSpot: true });
        res.set('X-Cache', 'MISS');
        res.set('X-Cache-TTL', String(RESPONSE_TTL_SEC));
        res.set('X-Response-Time', `${elapsed}ms`);
        res.json(response);

    } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
}

/**
 * Internal refresh function for the cache warmer.
 * Calls the handler with mock req/res to rebuild all caches.
 */
export async function refreshChart({ proposalId, minTimestamp, maxTimestamp, includeSpot }) {
    const mockReq = {
        params: { proposalId },
        query: {
            minTimestamp: String(minTimestamp),
            maxTimestamp: String(maxTimestamp),
            includeSpot: includeSpot ? 'true' : 'false',
        },
    };
    const mockRes = {
        json: () => { },
        set: () => { },
        status: () => ({ json: () => { } }),
    };
    await handleUnifiedChartRequest(mockReq, mockRes);
}
