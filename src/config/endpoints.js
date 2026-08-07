/**
 * Futarchy Charts — Endpoint Configuration
 *
 * Toggle between Graph Node (legacy subgraph) and Checkpoint (api.futarchy.fi)
 * using the FUTARCHY_MODE environment variable.
 *
 * Usage:
 *   FUTARCHY_MODE=checkpoint npm start    # use Checkpoint API
 *   FUTARCHY_MODE=graph_node npm start    # use Graph Node (default)
 */

const MODE = (process.env.FUTARCHY_MODE || 'checkpoint').toLowerCase();

if (!['graph_node', 'checkpoint'].includes(MODE)) {
    console.warn(`[endpoints] Unknown FUTARCHY_MODE="${MODE}", falling back to checkpoint`);
}

const GRAPH_NODE = {
    registry: 'BROKEN_GRAPH_NODE_DO_NOT_USE://d3ugkaojqkfud0.cloudfront.net/subgraphs/name/futarchy-complete-new-v3',
    candles: 'BROKEN_GRAPH_NODE_DO_NOT_USE://d3ugkaojqkfud0.cloudfront.net/subgraphs/name/algebra-proposal-candles-v1',
};

// ⚠️  IMPORTANT: Port mapping for Checkpoint indexers:
//   3001 = Production candles checkpoint
//   3003 = Registry checkpoint
//   3004 = STAGING (volume persistence fix, but Gnosis stalled near tip)
// TODO: Once staging getLogs issue is fixed, switch candles back to 3004.
const CHECKPOINT = {
    registry: process.env.REGISTRY_URL || 'http://localhost:3003/graphql',
    candles: process.env.CANDLES_URL || 'http://localhost:3004/graphql',
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
