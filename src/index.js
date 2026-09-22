/**
 * Local Express Server for Futarchy Development
 * 
 * Replaces:
 * - stag.api.tickspread.com → localhost:3030/api/v1/...
 * - Algebra candles subgraph → localhost:3030/subgraphs/name/algebra-proposal-candles-v1
 * 
 * Run: npm start (or npm run dev for watch mode)
 */

import express from 'express';
import cors from 'cors';
import { handleMarketEventsRequest } from './routes/market-events.js';
import { handleGraphQLRequest } from './routes/graphql-proxy.js';
import { makeGraphQLPassthrough } from './routes/graphql-passthrough.js';
import { handleUnifiedChartRequest, refreshChart } from './routes/unified-chart.js';
import { ENDPOINTS } from './config/endpoints.js';
import { proxyCandlesQuery } from './adapters/candles-adapter.js';
import { fetchSpotCandles, USE_FUTARCHY_SPOT } from './services/spot-source.js';
import { getRateCached } from './services/rate-provider.js';
import { spotCache, logCacheStats } from './utils/cache.js';
import { startWarmer, getWarmerStatus } from './utils/warmer.js';
import { ENABLE_WARMER } from './config/cache-config.js';
const app = express();
const PORT = 3031;
// Middleware — allow all origins for local dev
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Apollo-Require-Preflight', 'X-Futarchy-Secret'],
    exposedHeaders: ['X-Cache', 'X-Cache-TTL', 'X-Response-Time'],
}));
app.use(express.json());
app.disable('etag'); // Prevent 304 — ensures browser always gets fresh response

// Strip the legacy `/charts` path prefix so URLs like
//   /charts/api/v2/proposals/:id/chart
//   /charts/api/v1/market-events/...
// route to the same handlers as the unprefixed paths. The prefix existed on
// the AWS API Gateway (path-based routing to the EC2 backend); after the GCP
// migration the Cloud Run service serves Express directly with no prefix.
// The Snapshot widget at snapshot-labs/sx-monorepo still uses the prefixed
// URL (`https://api.futarchy.fi/charts` as default base), so we accept both.
app.use((req, _res, next) => {
    if (req.url.startsWith('/charts/')) {
        req.url = req.url.slice('/charts'.length);
    } else if (req.url === '/charts') {
        req.url = '/';
    }
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Warmer status
app.get('/warmer', (req, res) => {
    res.json(getWarmerStatus());
});

// ============================================
// ⚡ UNIFIED CHART ENDPOINT (v2) — single call for everything
// Route: /api/v2/proposals/:proposalId/chart?minTimestamp=...&maxTimestamp=...
// ============================================
app.get('/api/v2/proposals/:proposalId/chart', handleUnifiedChartRequest);

// ============================================
// FUTARCHY API (v1 — legacy, kept for backward compatibility)
// Route: /api/v1/market-events/proposals/:proposalId/prices
// ============================================
app.get('/api/v1/market-events/proposals/:proposalId/prices', handleMarketEventsRequest);

// ============================================
// SPOT CANDLES (GeckoTerminal → rate-divided)
// Route: /api/v1/spot-candles?ticker=...&minTimestamp=...&maxTimestamp=...
// ============================================

app.get('/api/v1/spot-candles', async (req, res) => {
    const { ticker, minTimestamp, maxTimestamp } = req.query;
    if (!ticker) return res.status(400).json({ error: 'ticker required' });

    const min = parseInt(minTimestamp) || 0;
    const max = parseInt(maxTimestamp) || Math.floor(Date.now() / 1000);

    try {
        // When using futarchy-spot, skip cache — SQLite IS the cache
        // When using CoinGecko, use spot cache to avoid rate limits
        let spotData;
        if (USE_FUTARCHY_SPOT) {
            spotData = await fetchSpotCandles(ticker, 500, max + 3600, min);
        } else {
            // Identify if the request represents a historical chart (> 3 days old)
            const now = Math.floor(Date.now() / 1000);
            const isHistorical = max < (now - 3 * 86400);
            const cacheKey = isHistorical ? `${ticker}:hist:${Math.floor(max / 86400)}` : ticker;

            spotData = spotCache.get(cacheKey);
            if (!spotData) {
                spotData = await fetchSpotCandles(ticker, 500, max + 3600, min);
                if (spotData?.candles?.length > 0) spotCache.set(cacheKey, spotData);
            }
        }

        // Compute rate divisor when ticker has :: rate provider
        let rateDivisor = 1;
        // Only divide if the ticker contains a rate provider and is NOT a composite pool.
        // Composite pools natively divide their prices in the backend proxy (spot-price.js).
        if (ticker.includes('::') && !ticker.startsWith('composite::')) {
            const rateProviderAddress = ticker.split('::')[1]?.split('-')[0];
            const networkPart = ticker.split('-').pop() || 'xdai';
            const chainId = networkPart === 'xdai' ? 100 : 1;
            if (rateProviderAddress) {
                rateDivisor = await getRateCached(rateProviderAddress, chainId);
            }
        }

        const candles = (spotData?.candles || [])
            .filter(c => c.time >= min && c.time <= max)
            .map(c => ({
                periodStartUnix: String(c.time),
                close: String(c.value / rateDivisor)
            }));

        console.log(`📊 [Spot Candles] ticker=${ticker.slice(0, 20)}... → ${candles.length} candles (rate: ${rateDivisor.toFixed(4)})`);
        logCacheStats();
        res.json({ spotCandles: candles });
    } catch (error) {
        console.error('❌ Spot candles error:', error.message);
        res.status(500).json({ error: error.message, spotCandles: [] });
    }
});

// ============================================
// ALGEBRA CANDLES GRAPHQL PROXY
// Route: /subgraphs/name/algebra-proposal-candles-v1
// Proxies: d3ugkaojqkfud0.cloudfront.net/subgraphs/name/algebra-proposal-candles-v1
// ============================================
app.post('/subgraphs/name/algebra-proposal-candles-v1', handleGraphQLRequest);

// ============================================
// CHECKPOINT INDEXER PASSTHROUGH (HTTPS)
// The Checkpoint indexers (registry: 3003, candles: 3001) only speak
// HTTP, so the browser app on https://futarchy.fi can't reach them
// directly (mixed content). These two routes are transparent JSON
// passthroughs that forward GraphQL POSTs to the configured upstream.
// ============================================
app.post('/registry/graphql', makeGraphQLPassthrough(() => ENDPOINTS.registry, 'registry'));

// Isolated mainnet candles checkpoint (chain 1) — plain passthrough, no id
// translation: the mainnet instance stores un-prefixed pool ids.
app.post('/candles-mainnet/graphql', makeGraphQLPassthrough(() => ENDPOINTS.candlesMainnet, 'candles-mainnet'));

// /candles/graphql translates plain pool IDs (0xabc...) to chain-prefixed
// (100-0xabc...) and rewrites response IDs back. This keeps the older
// frontend (which assumes Graph Node IDs) working against Checkpoint
// without per-call changes. In Graph Node mode it's a transparent passthrough.
app.post('/candles/graphql', async (req, res) => {
    try {
        const { query, variables } = req.body || {};
        if (!query) {
            return res.status(400).json({ errors: [{ message: '[candles] missing query' }] });
        }
        // Default to Gnosis (100); callers can override via $chainId variable
        // or a ?chainId= query param (lets per-chain frontend endpoint URLs
        // route without threading variables through every hook).
        const chainId = parseInt(variables?.chainId) || parseInt(req.query?.chainId) || 100;
        const result = await proxyCandlesQuery(query, variables || {}, chainId);
        res.json(result);
    } catch (err) {
        console.error('[candles] passthrough failed:', err?.message || err);
        res.status(502).json({
            errors: [{ message: `[candles] upstream error: ${err?.message || 'unknown'}` }],
        });
    }
});

// Export the configured app so a serverless wrapper can mount it without
// binding a port (netlify/functions/api.js). Netlify's runtime is ephemeral:
// there is no long-lived process to listen, and the background warmer below
// would never get to run a second tick anyway.
export { app };

// Under Netlify the function wrapper owns the request lifecycle, so skip the
// listener and the warmer entirely.
const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);

if (!IS_SERVERLESS) app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('🚀 Futarchy Local Server Running');
    console.log('─'.repeat(50));
    console.log(`   Port: ${PORT}`);
    console.log('');
    console.log('📍 Endpoints:');
    console.log(`   GET  http://localhost:${PORT}/api/v2/proposals/:id/chart`);
    console.log(`   GET  http://localhost:${PORT}/api/v1/market-events/proposals/:id/prices`);
    console.log(`   GET  http://localhost:${PORT}/warmer  (status)`);
    console.log('');
    console.log('🔧 To use in frontend, change URLs to:');
    console.log(`   VITE_FUTARCHY_API_URL=http://localhost:${PORT}`);
    console.log('─'.repeat(50));

    // Start background warmer
    // Start background warmer (disabled when using futarchy-spot — its worker handles refresh)
    if (USE_FUTARCHY_SPOT) {
        console.log('🔥 [Warmer] Disabled (using futarchy-spot — SQLite is the cache)');
    } else if (ENABLE_WARMER) {
        startWarmer(async (params) => {
            await refreshChart(params);
        });
    } else {
        console.log('🔥 [Warmer] Disabled (ENABLE_WARMER=false)');
    }
});
