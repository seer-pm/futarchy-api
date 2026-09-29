/**
 * Market Events Route
 * Replaces: stag.api.tickspread.com/api/v1/market-events/proposals/:proposalId/prices
 * 
 * Uses Futarchy Registry V2 subgraph to dynamically lookup proposals by metadata key
 * Falls back to Algebra pools data + spot price from GeckoTerminal
 */

import { fetchPoolsForProposal as fetchPoolsAdapter } from '../adapters/candles-adapter.js';
import { resolveProposalId as resolveProposalAdapter, lookupOrgMetadata as lookupOrgMetadataAdapter } from '../adapters/registry-adapter.js';
import { IS_CHECKPOINT, ENDPOINTS } from '../config/endpoints.js';
import { getRateCached } from '../services/rate-provider.js';
import { getSpotPrice } from '../services/spot-price.js';
import { extractTokensFromPools } from '../utils/token-from-pool.js';

// ============================================================================
// CONFIGURATION - Easy to modify
// ============================================================================

// Futarchy Registry V2 Subgraph (used by inline Graph Node functions below)
const FUTARCHY_REGISTRY_ENDPOINT = ENDPOINTS.registry;

// Trustur Aggregator - filters which organizations to search
const AGGREGATOR_ADDRESS = '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1';

// ============================================================================

/**
 * Query Futarchy Registry to find proposal by snapshot_id in proposal metadata
 * 
 * NEW PATTERN: Search metadataEntries where:
 * - key = "snapshot_id" 
 * - value = the snapshot proposal ID
 * - proposal belongs to an org under our aggregator
 * 
 * Returns: { proposalId, proposalAddress, organizationId, organizationName } or null
 */
async function lookupProposalBySnapshotId(snapshotProposalId) {
    const normalizedId = snapshotProposalId.toLowerCase();

    // Query metadataEntries at the Proposal level with snapshot_id key
    // Also fetch the proposal's metadata to get coingecko_ticker, closeTimestamp, etc.
    const query = `{
        metadataEntries(where: { 
            key: "snapshot_id",
            value: "${normalizedId}"
        }) {
            value
            proposal {
                id
                proposalAddress
                title
                metadata
                organization { 
                    id 
                    name 
                    aggregator { id }
                }
            }
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            // Filter by aggregator in code since nested GraphQL filter isn't supported
            const matching = data.data.metadataEntries.find(entry => {
                const aggregatorId = entry.proposal?.organization?.aggregator?.id?.toLowerCase();
                return aggregatorId === AGGREGATOR_ADDRESS.toLowerCase();
            });

            if (matching) {
                const proposal = matching.proposal;
                console.log(`   🔍 Found by snapshot_id in "${proposal?.organization?.name || 'unknown'}"`);
                console.log(`   📋 Proposal: ${proposal?.title || 'N/A'}`);

                // Parse proposal metadata to extract config
                let proposalConfig = {};
                if (proposal?.metadata) {
                    try {
                        proposalConfig = JSON.parse(proposal.metadata);
                        console.log(`   📦 Metadata: chain=${proposalConfig.chain}, ticker=${proposalConfig.coingecko_ticker ? 'yes' : 'no'}`);
                    } catch (e) {
                        console.log(`   ⚠️ Failed to parse proposal metadata`);
                    }
                }

                return {
                    proposalId: proposal?.id,  // Metadata contract address
                    proposalAddress: proposal?.proposalAddress,  // Trading contract address
                    organizationId: proposal?.organization?.id,
                    organizationName: proposal?.organization?.name,
                    // Config from proposal metadata (not organization!)
                    coingeckoTicker: proposalConfig.coingecko_ticker || null,
                    closeTimestamp: proposalConfig.closeTimestamp ? parseInt(proposalConfig.closeTimestamp) : null,
                    startCandleUnix: proposalConfig.startCandleUnix ? parseInt(proposalConfig.startCandleUnix) : null,
                    twapStartTimestamp: proposalConfig.twapStartTimestamp ? parseInt(proposalConfig.twapStartTimestamp) : null,
                    twapDurationHours: proposalConfig.twapDurationHours ? parseInt(proposalConfig.twapDurationHours) : null,
                    twapDescription: proposalConfig.twapDescription || null,
                    chain: proposalConfig.chain ? parseInt(proposalConfig.chain) : null,
                    // NEW: Org-level fields now also at proposal level
                    pricePrecision: proposalConfig.price_precision ? parseInt(proposalConfig.price_precision) : null,
                    currencyStableRate: proposalConfig.currency_stable_rate || null,
                    currencyStableSymbol: proposalConfig.currency_stable_symbol || null
                };
            }
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ snapshot_id lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * FALLBACK: Query by organization metadata key (legacy pattern)
 * Some organizations store proposal mappings at the org level
 */
async function lookupProposalInOrgMetadata(snapshotProposalId) {
    const normalizedId = snapshotProposalId.toLowerCase();

    const query = `{
        metadataEntries(where: { 
            key: "${normalizedId}",
            organization_: { aggregator: "${AGGREGATOR_ADDRESS}" }
        }) {
            value
            organization { 
                id 
                name 
            }
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const entry = data.data.metadataEntries[0];
            console.log(`   🔍 Found by org metadata in "${entry.organization?.name || 'unknown'}"`);
            return {
                proposalId: entry.value,  // The value is the proposal address
                proposalAddress: entry.value,
                organizationId: entry.organization?.id,
                organizationName: entry.organization?.name
            };
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ Org metadata lookup failed: ${error.message}`);
        return null;
    }
}

// ============================================================================
// ⭐ COINGECKO TICKER LOOKUP
// ============================================================================
// 
// Store in database with key "coingecko_ticker" and value like:
//   PNK/WETH+!sDAI/WETH-hour-500-xdai
// 
// This will be used to fetch spot price data from GeckoTerminal
// ============================================================================

/**
 * Query Futarchy Registry for organization's coingecko_ticker metadata
 * This allows each organization to configure their spot price ticker
 */
async function lookupTickerInRegistry(organizationId) {
    if (!organizationId) return null;

    const query = `{
        metadataEntries(where: { 
            key: "coingecko_ticker",
            organization: "${organizationId}"
        }) {
            value
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const ticker = data.data.metadataEntries[0].value;
            console.log(`   📊 Found coingecko_ticker: ${ticker}`);
            return ticker;
        }

        console.log(`   ℹ️ No coingecko_ticker found for org, using default`);
        return null;
    } catch (error) {
        console.log(`   ⚠️ Ticker lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * Query Futarchy Registry for organization's chart_start_range metadata
 * This allows overriding the chart start date for specific proposals
 * Store as Unix timestamp (e.g., "1769385600" for Jan 26, 2026)
 */
async function lookupChartStartRangeInRegistry(organizationId) {
    if (!organizationId) return null;

    const query = `{
        metadataEntries(where: { 
            key: "chart_start_range",
            organization: "${organizationId}"
        }) {
            value
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const chartStart = parseInt(data.data.metadataEntries[0].value);
            if (!isNaN(chartStart)) {
                console.log(`   📅 Found chart_start_range: ${chartStart} (${new Date(chartStart * 1000).toISOString()})`);
                return chartStart;
            }
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ chart_start_range lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * Query Futarchy Registry for organization's price_precision metadata
 * This controls decimal places in the price legend (default: 6)
 * Store as string (e.g., "2" for 2 decimal places)
 */
async function lookupPricePrecisionInRegistry(organizationId) {
    if (!organizationId) return null;

    const query = `{
        metadataEntries(where: { 
            key: "price_precision",
            organization: "${organizationId}"
        }) {
            value
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const precision = parseInt(data.data.metadataEntries[0].value);
            if (!isNaN(precision) && precision >= 0 && precision <= 10) {
                console.log(`   🎯 Found price_precision: ${precision}`);
                return precision;
            }
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ price_precision lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * Query Futarchy Registry for organization's currency_stable_rate metadata
 * This is a rate provider address for converting currency token to USD
 * When present, YES/NO chart prices should be multiplied by this rate
 * Store as address (e.g., "0x89c80a4540a00b5270347e02e2e144c71da2eced")
 */
async function lookupCurrencyRateProviderInRegistry(organizationId) {
    if (!organizationId) return null;

    const query = `{
        metadataEntries(where: { 
            key: "currency_stable_rate",
            organization: "${organizationId}"
        }) {
            value
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const rateProviderAddress = data.data.metadataEntries[0].value;
            if (rateProviderAddress && rateProviderAddress.startsWith('0x')) {
                console.log(`   💱 Found currency_stable_rate: ${rateProviderAddress.slice(0, 10)}...`);
                return rateProviderAddress;
            }
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ currency_stable_rate lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * Query Futarchy Registry for organization's currency_stable_symbol metadata
 * This is the display symbol for the stable currency (e.g., "xDAI", "USD")
 * Store as string (e.g., "xDAI")
 */
async function lookupCurrencyStableSymbolInRegistry(organizationId) {
    if (!organizationId) return null;

    const query = `{
        metadataEntries(where: { 
            key: "currency_stable_symbol",
            organization: "${organizationId}"
        }) {
            value
        }
    }`;

    try {
        const response = await fetch(FUTARCHY_REGISTRY_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });

        const data = await response.json();

        if (data.data?.metadataEntries?.length > 0) {
            const symbol = data.data.metadataEntries[0].value;
            if (symbol) {
                console.log(`   💵 Found currency_stable_symbol: ${symbol}`);
                return symbol;
            }
        }

        return null;
    } catch (error) {
        console.log(`   ⚠️ currency_stable_symbol lookup failed: ${error.message}`);
        return null;
    }
}

/**
 * Resolve Snapshot proposal ID to Futarchy proposal ID
 * 
 * Priority:
 * 1. Try snapshot_id lookup in proposal metadata (NEW - most reliable)
 * 2. Fall back to organization metadata key lookup (legacy)
 * 3. Use the ID directly as-is (last resort)
 * 
 * Returns: { proposalId, proposalAddress, organizationId, organizationName }
 */
async function resolveProposalId(proposalId) {
    const normalized = proposalId.toLowerCase();

    // 1. Try snapshot_id lookup (NEW - preferred method)
    const snapshotResult = await lookupProposalBySnapshotId(normalized);
    if (snapshotResult) {
        return {
            proposalId: snapshotResult.proposalId?.toLowerCase(),  // Metadata contract
            proposalAddress: snapshotResult.proposalAddress?.toLowerCase(),  // Trading contract
            originalProposalId: snapshotResult.proposalId,
            organizationId: snapshotResult.organizationId,
            organizationName: snapshotResult.organizationName,
            // Pass through all config from proposal metadata
            coingeckoTicker: snapshotResult.coingeckoTicker,
            closeTimestamp: snapshotResult.closeTimestamp,
            startCandleUnix: snapshotResult.startCandleUnix,
            twapStartTimestamp: snapshotResult.twapStartTimestamp,
            twapDurationHours: snapshotResult.twapDurationHours,
            twapDescription: snapshotResult.twapDescription,
            chain: snapshotResult.chain,
            // NEW: Org-level fields now also at proposal level
            pricePrecision: snapshotResult.pricePrecision,
            currencyStableRate: snapshotResult.currencyStableRate,
            currencyStableSymbol: snapshotResult.currencyStableSymbol
        };
    }

    // 2. Fall back to org metadata lookup (legacy pattern)
    const orgResult = await lookupProposalInOrgMetadata(normalized);
    if (orgResult) {
        return {
            proposalId: orgResult.proposalId?.toLowerCase(),
            proposalAddress: orgResult.proposalAddress?.toLowerCase(),
            originalProposalId: orgResult.proposalId,
            organizationId: orgResult.organizationId,
            organizationName: orgResult.organizationName
        };
    }

    // 3. Use ID directly (assume it's already a Futarchy proposal ID)
    console.log(`   ℹ️ No registry mapping found, using proposal ID directly`);
    return {
        proposalId: normalized,
        proposalAddress: normalized,  // Assume it's the trading contract directly
        originalProposalId: proposalId,  // Keep original case
        organizationId: null,
        organizationName: null
    };
}

// Mocked timeline: start = 2 days ago, end = 3 days from now
function getMockedTimeline() {
    const now = Date.now();
    const start = now - (2 * 24 * 60 * 60 * 1000); // 2 days ago
    const end = now + (3 * 24 * 60 * 60 * 1000);   // 3 days from now
    return {
        start: Math.floor(start / 1000),
        end: Math.floor(end / 1000)
    };
}

export async function handleMarketEventsRequest(req, res) {
    const { proposalId } = req.params;

    console.log(`📊 [Market Events] Request: ${proposalId.slice(0, 10)}...`);

    try {
        // Dynamically resolve proposal ID using registry
        const resolved = IS_CHECKPOINT
            ? await resolveProposalAdapter(proposalId)
            : await resolveProposalId(proposalId);

        if (!resolved) {
            return res.status(404).json({
                status: 'not_found',
                error: 'No Futarchy market is linked to this Snapshot proposal',
                proposal_id: proposalId
            });
        }

        // Use proposalAddress (trading contract) for pool lookup
        const tradingContractId = resolved.proposalAddress || resolved.proposalId;
        console.log(`   🔗 Resolved to trading contract: ${tradingContractId?.slice(0, 10)}...`);

        // ⭐ NEW: Use config from proposal metadata first, fallback to org
        const ticker = resolved.coingeckoTicker || null;
        const chartStartRange = resolved.startCandleUnix || null;
        const closeTimestamp = resolved.closeTimestamp || null;

        if (ticker) {
            console.log(`   📊 Ticker from proposal: ${ticker.slice(0, 30)}...`);
        }
        if (chartStartRange) {
            console.log(`   📅 Chart start: ${new Date(chartStartRange * 1000).toISOString().split('T')[0]}`);
        }

        // ⭐ Use proposal-level first, fallback to org lookup
        const pricePrecision = resolved.pricePrecision ?? await lookupPricePrecisionInRegistry(resolved.organizationId);
        const currencyRateProvider = resolved.currencyStableRate ?? await lookupCurrencyRateProviderInRegistry(resolved.organizationId);
        const currencyStableSymbol = resolved.currencyStableSymbol ?? await lookupCurrencyStableSymbolInRegistry(resolved.organizationId);

        // Get chain from proposal metadata (default: 100 = Gnosis)
        const chainId = resolved.chain || 100;

        // Fetch currency rate using chain-aware provider
        const currencyRate = await getRateCached(currencyRateProvider, chainId);

        // ⭐ Only fetch spot price if coingecko_ticker is configured
        // If ticker includes :: it has a rate provider built-in, otherwise apply currencyRate
        let spotPrice = null;
        if (ticker) {
            const rawSpotPrice = await getSpotPrice(ticker);
            // Check if ticker already has rate provider (::)
            const tickerHasRateProvider = ticker.includes('::');
            if (rawSpotPrice !== null) {
                // Conditional prices are: pool.price * currencyRate (sDAI → xDAI ≈ USD)
                // Spot must be in the same unit (xDAI ≈ USD):
                //   :: ticker: GeckoTerminal pool is GNO/WXDAI → already in xDAI, keep as-is
                //   no :: ticker: price is in sDAI → multiply by currencyRate to get xDAI
                spotPrice = tickerHasRateProvider ? rawSpotPrice : rawSpotPrice * currencyRate;
            }
            console.log(`   💹 Spot price: $${spotPrice?.toFixed(4) || 'N/A'} (rate ${tickerHasRateProvider ? 'built-in' : 'applied'})`);
        } else {
            console.log(`   ⏭️ Skipping spot price (no coingecko_ticker in proposal metadata)`);
        }

        // Fetch pools from Algebra subgraph using trading contract address
        const pools = await fetchPoolsAdapter(tradingContractId, chainId);
        console.log(`   📦 Found ${pools.length} pools`);

        // Find YES/NO pool: prefer CONDITIONAL, fall back to PREDICTION (newer
        // markets like GIP-150 v2 don't have CONDITIONAL pools), then EXPECTED_VALUE.
        function findPoolByOutcome(side) {
            return pools.find(p => p.outcomeSide === side && p.type === 'CONDITIONAL')
                || pools.find(p => p.outcomeSide === side && p.type === 'PREDICTION')
                || pools.find(p => p.outcomeSide === side && p.type === 'EXPECTED_VALUE');
        }
        const yesPool = findPoolByOutcome('YES');
        const noPool = findPoolByOutcome('NO');

        console.log(`   [DEBUG] Getting tokens...`);
        // Get company token from proposal (Graph Node has nested objects, Checkpoint doesn't).
        // Checkpoint fallback walks all pools and parses names — supports
        // CONDITIONAL ("YES_X / YES_Y"), EXPECTED_VALUE ("YES_X / Y"), and
        // PREDICTION ("YES_Y / Y", currency-only) shapes.
        const proposal = pools[0]?.proposal;
        let companyToken = proposal?.companyToken;
        let currencyToken = proposal?.currencyToken;

        if (!companyToken?.symbol || !currencyToken?.symbol) {
            const fromPools = extractTokensFromPools(pools);
            companyToken  = companyToken?.symbol  ? companyToken  : fromPools.companyToken;
            currencyToken = currencyToken?.symbol ? currencyToken : fromPools.currencyToken;
        }

        // Convert prices to USD using chain-aware currency rate
        const yesPrice = yesPool ? parseFloat(yesPool.price) * currencyRate : 0;
        const noPrice = noPool ? parseFloat(noPool.price) * currencyRate : 0;

        // Get timeline from proposal metadata (prefer real data over mocked)
        const now = Math.floor(Date.now() / 1000);
        const timelineStart = chartStartRange || (now - 2 * 24 * 60 * 60);  // Default: 2 days ago
        const timelineEnd = closeTimestamp || (now + 3 * 24 * 60 * 60);     // Default: 3 days from now

        console.log(`   [DEBUG] Building response...`);
        // Build response with REAL pool IDs (essential for candles query)
        const response = {
            status: 'ok',
            event_id: resolved.originalProposalId,  // Original case for links
            conditional_yes: {
                price_usd: yesPrice,
                pool_id: yesPool?.id || ''  // Real pool ID from subgraph
            },
            conditional_no: {
                price_usd: noPrice,
                pool_id: noPool?.id || ''   // Real pool ID from subgraph
            },
            spot: {
                price_usd: spotPrice,
                // ⭐ Include ticker so graphql-proxy can fetch spot candles
                pool_ticker: ticker || null
            },
            company_tokens: {
                base: {
                    tokenSymbol: companyToken?.symbol || 'TOKEN'
                },
                currency: {
                    tokenSymbol: currencyToken?.symbol || 'CURRENCY',
                    stableSymbol: currencyStableSymbol || null  // e.g., "xDAI" from metadata
                }
            },
            timeline: {
                start: timelineStart,
                end: timelineEnd,
                chain_id: chainId,  // Chain ID for pool ID prefixing (100=Gnosis, 1=Mainnet)
                chart_start_range: chartStartRange || null,
                close_timestamp: closeTimestamp || null,  // NEW: explicit close timestamp
                price_precision: pricePrecision,
                // If rate provider is configured, include the rate for YES/NO price conversion
                currency_rate: currencyRateProvider ? currencyRate : null
            },
            // Volume: use currency volume (consistent with unified-chart.js v2)
            volume: {
                conditional_yes: yesPool ? (() => {
                    const currencyVol = yesPool.token0?.role?.includes('CURRENCY')
                        ? yesPool.volumeToken0
                        : yesPool.token1?.role?.includes('CURRENCY')
                            ? yesPool.volumeToken1
                            : yesPool.volumeToken1;
                    const rawCurrency = parseFloat(currencyVol || '0');
                    const volumeUsd = String(rawCurrency * (currencyRate || 1));
                    return {
                        status: 'ok',
                        pool_id: yesPool.id,
                        volume: String(rawCurrency),
                        volume_usd: volumeUsd
                    };
                })() : undefined,
                conditional_no: noPool ? (() => {
                    const currencyVol = noPool.token0?.role?.includes('CURRENCY')
                        ? noPool.volumeToken0
                        : noPool.token1?.role?.includes('CURRENCY')
                            ? noPool.volumeToken1
                            : noPool.volumeToken1;
                    const rawCurrency = parseFloat(currencyVol || '0');
                    const volumeUsd = String(rawCurrency * (currencyRate || 1));
                    return {
                        status: 'ok',
                        pool_id: noPool.id,
                        volume: String(rawCurrency),
                        volume_usd: volumeUsd
                    };
                })() : undefined
            }
        };

        if (yesPool && noPool) {
            console.log(`   ✅ YES: $${yesPrice.toFixed(4)} (${yesPool.id.slice(0, 10)}...), NO: $${noPrice.toFixed(4)} (${noPool.id.slice(0, 10)}...)`);
            console.log(`   [DEBUG] Sending res.json...`);
            res.json(response);
            console.log(`   [DEBUG] Finished!`);
        } else {
            console.log(`   ⚠️ Missing pools - YES: ${!!yesPool}, NO: ${!!noPool}`);
            console.log(`   [DEBUG] Sending res.json (missing pools)...`);
            res.json(response);
            console.log(`   [DEBUG] Finished!`);
        }

    } catch (error) {
        console.error('   ❌ Error:', error.message);
        res.status(500).json({ error: error.message });
    }
}
