/**
 * Candles Adapter
 *
 * Provides a unified interface for fetching pool and candle data from either
 * Graph Node or Checkpoint, normalizing schema differences.
 *
 * Graph Node:
 *   - Pool ID: plain address (0xf834...)
 *   - Proposal filter: proposal: "0x45e1..."
 *   - Candle time: periodStartUnix
 *   - Pool query includes nested: proposal { marketName, companyToken { ... } }
 *
 * Checkpoint:
 *   - Pool ID: chain-prefixed (100-0xf834...)
 *   - Proposal filter: proposal: "100-0x45e1..."
 *   - Candle time: time (also has periodStartUnix)
 *   - Pool query: flat fields (token0, token1 as addresses, proposal as string)
 */

import { ENDPOINTS, IS_CHECKPOINT } from '../config/endpoints.js';

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

async function gqlFetch(url, query, variables = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (json.errors) {
        throw new Error(`GraphQL: ${json.errors[0].message}`);
    }
    return json.data;
}

/**
 * Strip chain prefix from Checkpoint IDs (e.g., "100-0xf834..." → "0xf834...")
 */
function stripChainPrefix(id) {
    if (!id) return id;
    const match = id.match(/^\d+-(.+)$/);
    return match ? match[1] : id;
}

/**
 * Add chain prefix for Checkpoint IDs (e.g., "0xf834..." → "100-0xf834...")
 */

// Route candles queries to the right checkpoint instance by chain:
// chain 1 runs as an isolated deployment (see futarchy-indexers
// docker-compose.mainnet.yml); everything else stays on the shared instance.
function candlesUpstream(chainId = 100) {
    return parseInt(chainId) === 1 && ENDPOINTS.candlesMainnet
        ? ENDPOINTS.candlesMainnet
        : ENDPOINTS.candles;
}

function addChainPrefix(id, chainId = 100) {
    if (!id) return id;
    // Don't double-prefix
    if (/^\d+-/.test(id)) return id;
    return `${chainId}-${id}`;
}

// ============================================================================
// GRAPH NODE IMPLEMENTATION
// ============================================================================

async function graphNode_fetchPools(proposalAddress, chainId = 100) {
    const query = `{
        pools(where: { proposal: "${proposalAddress}" }) {
            id
            name
            type
            outcomeSide
            price
            isInverted
            volumeToken0
            volumeToken1
            token0 {
                id
                symbol
                role
            }
            token1 {
                id
                symbol
                role
            }
            proposal {
                id
                marketName
                companyToken {
                    id
                    symbol
                }
                currencyToken {
                    id
                    symbol
                }
            }
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    return data?.pools || [];
}

async function graphNode_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId = 100) {
    const query = `{
        candles(
            first: 1000
            orderBy: periodStartUnix
            orderDirection: asc
            where: {
                pool: "${poolId}",
                period: "3600",
                periodStartUnix_gte: "${minTimestamp}",
                periodStartUnix_lte: "${maxTimestamp}"
            }
        ) {
            periodStartUnix
            close
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    return data?.candles || [];
}

async function graphNode_getLatestPrice(poolId, maxTimestamp = null, chainId = 100) {
    const whereClause = maxTimestamp
        ? `pool: "${poolId}", period: "3600", periodStartUnix_lte: "${maxTimestamp}"`
        : `pool: "${poolId}", period: "3600"`;

    const query = `{
        candles(
            first: 1
            orderBy: periodStartUnix
            orderDirection: desc
            where: { ${whereClause} }
        ) {
            close
            periodStartUnix
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    const candle = data?.candles?.[0];
    return candle ? parseFloat(candle.close) : 0;
}

// ============================================================================
// CHECKPOINT IMPLEMENTATION
// ============================================================================

async function checkpoint_fetchPools(proposalAddress, chainId = 100) {
    const prefixedProposal = addChainPrefix(proposalAddress, chainId);

    const query = `{
        pools(where: { proposal: "${prefixedProposal}" }) {
            id
            name
            type
            outcomeSide
            price
            isInverted
            volumeToken0
            volumeToken1
            token0
            token1
            proposal
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    const rawPools = data?.pools || [];

    // Normalize to match Graph Node shape
    return rawPools.map(pool => ({
        ...pool,
        // Strip chain prefix from pool ID for consistent downstream usage
        id: stripChainPrefix(pool.id),
        // Checkpoint volumes are in raw wei (18 decimals) — normalize to human-readable
        volumeToken0: pool.volumeToken0
            ? String(parseFloat(pool.volumeToken0) / 1e18)
            : '0',
        volumeToken1: pool.volumeToken1
            ? String(parseFloat(pool.volumeToken1) / 1e18)
            : '0',
        // Checkpoint returns token0/token1 as addresses, not objects
        // Use isInverted to assign roles:
        //   Default:  token0 = COMPANY, token1 = CURRENCY
        //   Inverted: token0 = CURRENCY, token1 = COMPANY
        token0: typeof pool.token0 === 'string'
            ? { id: pool.token0, symbol: null, role: pool.isInverted ? 'CURRENCY' : 'COMPANY' }
            : pool.token0,
        token1: typeof pool.token1 === 'string'
            ? { id: pool.token1, symbol: null, role: pool.isInverted ? 'COMPANY' : 'CURRENCY' }
            : pool.token1,
        // Checkpoint has flat proposal reference
        proposal: typeof pool.proposal === 'string'
            ? { id: stripChainPrefix(pool.proposal), marketName: null, companyToken: null, currencyToken: null }
            : pool.proposal,
    }));
}

async function checkpoint_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId = 100) {
    const prefixedPool = addChainPrefix(poolId, chainId);

    // Checkpoint has both `time` (raw swap ts) and `periodStartUnix` (snapped to period)
    // We use `periodStartUnix` for consistency with Graph Node output
    const query = `{
        candles(
            first: 1000
            orderBy: time
            orderDirection: asc
            where: {
                pool: "${prefixedPool}",
                period: 3600,
                time_gte: ${minTimestamp},
                time_lte: ${maxTimestamp}
            }
        ) {
            periodStartUnix
            close
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    const rawCandles = data?.candles || [];

    // Normalize: use periodStartUnix directly (same field name as Graph Node)
    return rawCandles.map(c => ({
        periodStartUnix: String(c.periodStartUnix),
        close: c.close,
    }));
}

async function checkpoint_getLatestPrice(poolId, maxTimestamp = null, chainId = 100) {
    const prefixedPool = addChainPrefix(poolId, chainId);
    const whereClause = maxTimestamp
        ? `pool: "${prefixedPool}", period: 3600, time_lte: ${maxTimestamp}`
        : `pool: "${prefixedPool}", period: 3600`;

    const query = `{
        candles(
            first: 1
            orderBy: time
            orderDirection: desc
            where: { ${whereClause} }
        ) {
            close
            time
        }
    }`;

    const data = await gqlFetch(candlesUpstream(chainId), query);
    const candle = data?.candles?.[0];
    return candle ? parseFloat(candle.close) : 0;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Fetch all pools for a proposal.
 * Returns pools in Graph Node format (plain address IDs) regardless of backend.
 *
 * @param {string} proposalAddress - Trading contract address (plain, no prefix)
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<Array>} Normalized pool objects
 */
export async function fetchPoolsForProposal(proposalAddress, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_fetchPools(proposalAddress, chainId)
        : graphNode_fetchPools(proposalAddress, chainId);
}

/**
 * Fetch candles for a pool within a time range.
 * Returns candles with { periodStartUnix, close } regardless of backend.
 *
 * @param {string} poolId - Pool address (plain, no prefix)
 * @param {number} minTimestamp - Start timestamp
 * @param {number} maxTimestamp - End timestamp
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<Array>} Normalized candle objects
 */
export async function fetchCandles(poolId, minTimestamp, maxTimestamp, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId)
        : graphNode_fetchCandles(poolId, minTimestamp, maxTimestamp, chainId);
}

/**
 * Get latest price from candles for a pool.
 *
 * @param {string} poolId - Pool address (plain, no prefix)
 * @param {number} [maxTimestamp] - Optional max timestamp
 * @param {number} [chainId=100] - Chain ID (only used in Checkpoint mode)
 * @returns {Promise<number>} Latest close price
 */
export async function getLatestPrice(poolId, maxTimestamp = null, chainId = 100) {
    return IS_CHECKPOINT
        ? checkpoint_getLatestPrice(poolId, maxTimestamp, chainId)
        : graphNode_getLatestPrice(poolId, maxTimestamp, chainId);
}

/**
 * Proxy a raw GraphQL candles query.
 * Used by the graphql-proxy route to forward requests to the correct endpoint.
 *
 * In Graph Node mode: forwards as-is.
 * In Checkpoint mode: translates the query variables (adds chain prefix to pool IDs,
 * changes periodStartUnix to time) and normalizes the response back.
 *
 * @param {string} query - Raw GraphQL query
 * @param {object} variables - Query variables
 * @param {number} [chainId=100] - Chain ID
 * @returns {Promise<object>} Raw GraphQL response data
 */
export async function proxyCandlesQuery(query, variables = {}, chainId = 100) {
    if (!IS_CHECKPOINT) {
        // Graph Node: pass through directly
        const data = await gqlFetch(candlesUpstream(chainId), query, variables);
        return { data };
    }

    // Checkpoint mode: adapt variables (prefix pool IDs) and query fields
    const adaptedVars = { ...variables };

    // Prefix any plain-address pool IDs in known variables. Scalar values
    // get prefixed; arrays get each entry prefixed (for $ids: [String!]!).
    const VAR_KEYS_TO_PREFIX = ['yesPoolId', 'noPoolId', 'poolId', 'id', 'ids'];
    for (const key of VAR_KEYS_TO_PREFIX) {
        const v = adaptedVars[key];
        if (typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) {
            adaptedVars[key] = addChainPrefix(v, chainId);
        } else if (Array.isArray(v)) {
            adaptedVars[key] = v.map(x =>
                typeof x === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x)
                    ? addChainPrefix(x, chainId) : x
            );
        }
    }

    // Adapt query: only normalize the BigInt-style `period: "3600"` literal
    // to Checkpoint's Int form. We DO NOT rewrite `periodStartUnix` to `time`
    // anymore — Checkpoint exposes both as separate fields:
    //   • `time`             = raw last-swap timestamp (e.g. 1778344370 = 18:32)
    //   • `periodStartUnix`  = period-snapped boundary (e.g. 1778342400 = 18:00)
    // The old rewrite collapsed them, returning raw `time` to clients that
    // asked for `periodStartUnix` and breaking any consumer that tried to
    // align candles to hour boundaries (e.g. carry-forward fill).
    let adaptedQuery = query
        .replace(/period:\s*"3600"/g, 'period: 3600');

    // Prefix inline pool/proposal IDs in the query string. Catches:
    //   - scalar filter:        pool: "0xabc..." | proposal: "0xabc..."
    //   - list filter:          pool_in: ["0x...", "0x..."] | proposal_in: [...]
    //   - id lookup:            pool(id: "0xabc...") | proposal(id: "0xabc...")
    //   - id list lookup:       id_in: ["0xabc...", "0xabc..."]
    adaptedQuery = adaptedQuery
        .replace(/(pool|proposal):\s*"(0x[a-fA-F0-9]{40})"/g,
            (_m, field, addr) => `${field}: "${addChainPrefix(addr, chainId)}"`)
        .replace(/(pool_in|proposal_in|id_in):\s*\[([^\]]+)\]/g,
            (_m, field, list) => {
                const rewritten = list.replace(
                    /"(0x[a-fA-F0-9]{40})"/g,
                    (_mm, addr) => `"${addChainPrefix(addr, chainId)}"`
                );
                return `${field}: [${rewritten}]`;
            })
        .replace(/(pool|proposal)\s*\(\s*id\s*:\s*"(0x[a-fA-F0-9]{40})"/g,
            (_m, entity, addr) => `${entity}(id: "${addChainPrefix(addr, chainId)}"`);

    console.log(`   [PROXY] Adapted query pool refs for chain ${chainId}`);

    const rawData = await gqlFetch(candlesUpstream(chainId), adaptedQuery, adaptedVars);

    // Normalize response:
    //   - Strip "<chainId>-" prefix from any `id` field (frontend expects plain
    //     addresses). No longer synthesize `periodStartUnix` from `time` —
    //     callers should select the field they actually want.
    const normalizedData = stripPrefixesAndNormalize(rawData);
    return { data: normalizedData };
}

// Pattern for Checkpoint-style chain-prefixed identifiers ("100-0xabc...").
const CHAIN_PREFIXED_RE = /^\d+-0x[a-fA-F0-9]{40}$/;

function stripPrefixesAndNormalize(value) {
    if (Array.isArray(value)) {
        return value.map(stripPrefixesAndNormalize);
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            // Strip "<chainId>-" from any string field that holds a Checkpoint
            // entity reference (id, proposal, pool, tokenIn, tokenOut, …).
            // Detection by VALUE shape avoids missing future fields and is
            // safe — no plain-text response field happens to look like
            // "<digits>-0x<40-hex>".
            if (typeof v === 'string' && CHAIN_PREFIXED_RE.test(v)) {
                out[k] = stripChainPrefix(v);
            } else {
                out[k] = stripPrefixesAndNormalize(v);
            }
        }
        return out;
    }
    return value;
}
