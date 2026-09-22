/**
 * Rate Provider Service
 * 
 * Generic ERC-4626 rate provider for any chain.
 * Fetches rate from any contract implementing getRate() -> uint256.
 */

// ============================================================================
// CHAIN CONFIGURATION
// ============================================================================

// Note: GNOSIS_RPC_URL is read by registry-adapter.js too, so both on-chain
// paths in this service move together when it is set.
const CHAIN_CONFIG = {
    1: {
        name: 'Ethereum',
        rpc: process.env.MAINNET_RPC_URL || 'https://eth.llamarpc.com',
        defaultRateProvider: null  // No default for Ethereum yet
    },
    100: {
        name: 'Gnosis',
        rpc: process.env.GNOSIS_RPC_URL || 'https://rpc.gnosis.gateway.fm',
        defaultRateProvider: '0x89C80A4540A00b5270347E02e2E144c71da2EceD'  // sDAI
    }
};

// getRate() function selector (ERC-4626 standard)
const GET_RATE_SELECTOR = '0x679aefce';

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Get rate from any ERC-4626 rate provider contract
 * 
 * @param {string} providerAddress - Rate provider contract address
 * @param {number} chainId - Chain ID (1 = Ethereum, 100 = Gnosis)
 * @returns {Promise<number>} Rate as a decimal (e.g., 1.224691)
 */
export async function getRate(providerAddress, chainId = 100) {
    const chain = CHAIN_CONFIG[chainId];

    if (!chain) {
        console.error(`[rate-provider] Unknown chain: ${chainId}`);
        return 1;
    }

    if (!providerAddress) {
        // No provider = no conversion (rate = 1)
        return 1;
    }

    try {
        const response = await fetch(chain.rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [
                    { to: providerAddress, data: GET_RATE_SELECTOR },
                    'latest'
                ]
            })
        });

        const { result, error } = await response.json();

        if (error) {
            console.error(`[rate-provider] RPC Error on ${chain.name}:`, error);
            return 1;
        }

        // Parse the uint256 result (18 decimals)
        const rateBigInt = BigInt(result);
        const rate = Number(rateBigInt) / 1e18;

        console.log(`   💰 Rate from ${providerAddress.slice(0, 10)}... on ${chain.name}: ${rate.toFixed(6)}`);
        return rate;

    } catch (error) {
        console.error(`[rate-provider] Error fetching rate on ${chain.name}:`, error.message);
        return 1;
    }
}

// ============================================================================
// CACHED VERSION
// ============================================================================

// Cache per provider+chain combination
const rateCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

/**
 * Get rate with caching (5 min TTL)
 */
export async function getRateCached(providerAddress, chainId = 100) {
    const cacheKey = `${providerAddress || 'default'}-${chainId}`;
    const cached = rateCache.get(cacheKey);
    const now = Date.now();

    if (cached && (now - cached.time) < CACHE_DURATION) {
        return cached.rate;
    }

    const rate = await getRate(providerAddress, chainId);
    rateCache.set(cacheKey, { rate, time: now });
    return rate;
}


