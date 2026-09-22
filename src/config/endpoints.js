/**
 * Futarchy Charts — Endpoint Configuration
 *
 * Toggle between Graph Node and Checkpoint using the FUTARCHY_MODE
 * environment variable.
 *
 * Usage:
 *   FUTARCHY_MODE=graph_node npm start    # use Goldsky-hosted subgraphs (default)
 *   FUTARCHY_MODE=checkpoint npm start    # use self-hosted Checkpoint indexers
 *
 * Goldsky hosts standard Graph Node subgraphs, so graph_node mode is the
 * right one for it: IDs are plain addresses (no "<chainId>-" prefix) and
 * entity references come back nested, which is exactly what the graph_node
 * branch of candles-adapter.js already expects. Nothing needs translating.
 */

const MODE = (process.env.FUTARCHY_MODE || 'graph_node').toLowerCase();

if (!['graph_node', 'checkpoint'].includes(MODE)) {
    console.warn(`[endpoints] Unknown FUTARCHY_MODE="${MODE}", falling back to checkpoint`);
}

// Goldsky-hosted subgraphs (seer-pm/futarchy-indexers). The old self-hosted
// Graph Node behind CloudFront is gone; these replace it.
const GOLDSKY_PROJECT = process.env.GOLDSKY_PROJECT || 'project_cmair7jgkzena01x58241cqow';
const goldsky = (name, version) =>
    `https://api.goldsky.com/api/public/${GOLDSKY_PROJECT}/subgraphs/${name}/${version}/gn`;

const GRAPH_NODE = {
    registry: process.env.REGISTRY_URL || goldsky('futarchy-registry-gnosis', '1.0.0'),
    candles: process.env.CANDLES_URL || goldsky('futarchy-candles-gnosis', '1.0.0'),
    // Mainnet (chain 1) is not deployed yet. Leaving this unset makes
    // candlesUpstream() fall back to the Gnosis endpoint, which would answer
    // chain-1 queries with Gnosis data instead of erroring — set
    // CANDLES_MAINNET_URL as soon as a mainnet subgraph exists.
    candlesMainnet: process.env.CANDLES_MAINNET_URL || null,
};

// ⚠️  IMPORTANT: Port mapping for Checkpoint indexers:
//   3001 = Production candles checkpoint
//   3003 = Registry checkpoint
//   3004 = STAGING (volume persistence fix, but Gnosis stalled near tip)
// TODO: Once staging getLogs issue is fixed, switch candles back to 3004.
const CHECKPOINT = {
    registry: process.env.REGISTRY_URL || 'http://localhost:3003/graphql',
    // 3004 was a staging instance that no longer exists; 3001 is what the
    // proposals-candles docker-compose actually publishes.
    candles: process.env.CANDLES_URL || 'http://localhost:3001/graphql',
    // Isolated mainnet candles checkpoint (chain 1); see futarchy-indexers
    // proposals-candles/checkpoint/docker-compose.mainnet.yml (VM port 3002)
    candlesMainnet: process.env.CANDLES_MAINNET_URL || 'http://localhost:3002/graphql',
};

export const ENDPOINTS = MODE === 'checkpoint' ? CHECKPOINT : GRAPH_NODE;
export const IS_CHECKPOINT = MODE === 'checkpoint';
export { MODE };

console.log(`[endpoints] Mode: ${MODE.toUpperCase()}`);
console.log(`[endpoints] Registry: ${ENDPOINTS.registry}`);
console.log(`[endpoints] Candles:  ${ENDPOINTS.candles}`);
if (ENDPOINTS.candlesMainnet) console.log(`[endpoints] CandlesMainnet: ${ENDPOINTS.candlesMainnet}`);
