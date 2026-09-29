/**
 * Registry Adapter
 *
 * Provides a unified interface for looking up proposals from either
 * Graph Node or Checkpoint, normalizing schema differences.
 *
 * Graph Node:
 *   - Entity: proposalEntities (camelCase)
 *   - Metadata: embedded JSON in `metadata` field
 *   - Nested filters: org_: { aggregator_: { id: "..." } }
 *   - Metadata entries: metadataEntries with `where: { key: "...", organization_: { aggregator: "..." } }`
 *
 * Checkpoint:
 *   - Entity: proposalentities (lowercase)
 *   - Metadata: separate metadataentries table
 *   - Flat FK filters: organization: "0x..."
 *   - ID format: plain addresses (same as Graph Node for registry)
 */

import { ethers } from 'ethers';
import { ENDPOINTS, IS_CHECKPOINT } from '../config/endpoints.js';
import { registryCache } from '../utils/cache.js';

const AGGREGATOR_ADDRESS = '0xc5eb43d53e2fe5fdde5faf400cc4167e5b5d4fc1';
const BYTES32_ID_RE = /^0x[a-f0-9]{64}$/;

// ============================================================================
// ON-CHAIN SNAPSHOT LINK REGISTRY (canonical source of truth)
// ============================================================================

const SNAPSHOT_LINK_REGISTRY = '0xa6Bc2857906C808bc0041f3A2977F53c6b6b0823';
const FACTORY_ADDRESS = '0xa6cB18FCDC17a2B44E5cAd2d80a6D5942d30a345';
const GNOSIS_RPC = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';

const registryAbi = [
    'function getFutarchyId(bytes32 snapshotId) view returns (uint256 futarchyId, bool exists)',
];
const factoryAbi = [
    'function proposals(uint256 index) view returns (address)',
];

let _rpcProvider = null;
function getRpcProvider() {
    if (!_rpcProvider) {
        _rpcProvider = new ethers.JsonRpcProvider(GNOSIS_RPC, 100, { staticNetwork: true });
    }
    return _rpcProvider;
}

/**
 * Look up a snapshot proposal ID in the on-chain SnapshotLinkRegistry.
 * Returns the proposal address if found, null otherwise.
 */
async function onchain_lookupBySnapshotId(snapshotId) {
    try {
        const provider = getRpcProvider();
        const registry = new ethers.Contract(SNAPSHOT_LINK_REGISTRY, registryAbi, provider);
        const padded = ethers.zeroPadValue(snapshotId, 32);
        const [futarchyId, exists] = await registry.getFutarchyId(padded);
        if (!exists) return null;

        const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
        const proposalAddr = await factory.proposals(futarchyId);
        if (proposalAddr === ethers.ZeroAddress) return null;

        console.log(`   🔗 SnapshotLinkRegistry: ${snapshotId.slice(0, 10)}... → #${futarchyId} → ${proposalAddr}`);
        return proposalAddr.toLowerCase();
    } catch (e) {
        console.warn(`   ⚠️ SnapshotLinkRegistry lookup failed: ${e.message}`);
        return null;
    }
}

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

// ============================================================================
// GRAPH NODE IMPLEMENTATION
// ============================================================================

async function graphNode_lookupBySnapshotId(snapshotId) {
    const normalized = snapshotId.toLowerCase();

    const data = await gqlFetch(ENDPOINTS.registry, `{
        metadataEntries(where: {
            key: "snapshot_id",
            value: "${normalized}"
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
    }`);

    const entries = data?.metadataEntries || [];
    const matching = entries.find(entry => {
        const aggId = entry.proposal?.organization?.aggregator?.id?.toLowerCase();
        return aggId === AGGREGATOR_ADDRESS.toLowerCase();
    });

    if (!matching) return null;

    const proposal = matching.proposal;
    let config = {};
    if (proposal?.metadata) {
        try { config = JSON.parse(proposal.metadata); } catch (e) { /* ignore */ }
    }

    return normalizeProposalResult(proposal, config);
}

async function graphNode_lookupInOrgMetadata(snapshotId) {
    const normalized = snapshotId.toLowerCase();

    const data = await gqlFetch(ENDPOINTS.registry, `{
        metadataEntries(where: {
            key: "${normalized}",
            organization_: { aggregator: "${AGGREGATOR_ADDRESS}" }
        }) {
            value
            organization {
                id
                name
            }
        }
    }`);

    const entry = data?.metadataEntries?.[0];
    if (!entry) return null;

    return {
        proposalId: entry.value?.toLowerCase(),
        proposalAddress: entry.value?.toLowerCase(),
        originalProposalId: entry.value,
        organizationId: entry.organization?.id,
        organizationName: entry.organization?.name,
    };
}

async function graphNode_lookupOrgMetadata(orgId, key) {
    if (!orgId) return null;

    const data = await gqlFetch(ENDPOINTS.registry, `{
        metadataEntries(where: {
            key: "${key}",
            organization: "${orgId}"
        }) {
            value
        }
    }`);

    return data?.metadataEntries?.[0]?.value || null;
}

// ============================================================================
// CHECKPOINT IMPLEMENTATION
// ============================================================================

async function checkpoint_lookupBySnapshotId(snapshotId) {
    const normalized = snapshotId.toLowerCase();

    // Single nested query — Checkpoint supports full nesting!
    // Replaces 4 sequential queries (~4100ms) with 1 query (~500ms)
    const metaData = await gqlFetch(ENDPOINTS.registry, `{
        metadataentries(where: {
            key: "snapshot_id",
            value_contains_nocase: "${normalized}"
        }, first: 5) {
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
    }`);

    // Exact match client-side (value_contains_nocase may return partial matches)
    const entries = (metaData?.metadataentries || [])
        .filter(e => e.value?.toLowerCase() === normalized);

    // Filter by our aggregator
    const matching = entries.find(entry => {
        const aggId = entry.proposal?.organization?.aggregator?.id?.toLowerCase();
        return aggId === AGGREGATOR_ADDRESS.toLowerCase();
    });

    if (!matching) return null;

    const proposal = matching.proposal;
    let config = {};
    if (proposal?.metadata) {
        try { config = JSON.parse(proposal.metadata); } catch (e) { /* ignore */ }
    }

    return normalizeProposalResult(proposal, config);
}

async function checkpoint_lookupInOrgMetadata(snapshotId) {
    const normalized = snapshotId.toLowerCase();

    // Get organizations for our aggregator first
    const orgData = await gqlFetch(ENDPOINTS.registry, `{
        organizations(where: { aggregator: "${AGGREGATOR_ADDRESS}" }) {
            id
            name
        }
    }`);

    const orgs = orgData?.organizations || [];

    // Check each org for a metadata entry with key === snapshotId
    for (const org of orgs) {
        const metaData = await gqlFetch(ENDPOINTS.registry, `{
            metadataentries(where: {
                key: "${normalized}",
                organization: "${org.id}"
            }) {
                value
            }
        }`);

        const entry = metaData?.metadataentries?.[0];
        if (entry) {
            return {
                proposalId: entry.value?.toLowerCase(),
                proposalAddress: entry.value?.toLowerCase(),
                originalProposalId: entry.value,
                organizationId: org.id,
                organizationName: org.name,
            };
        }
    }

    return null;
}

async function checkpoint_getProposalMetadata(proposalId) {
    const data = await gqlFetch(ENDPOINTS.registry, `{
        metadataentries(where: { proposal: "${proposalId}" }, first: 200) {
            key
            value
        }
    }`);
    return data?.metadataentries || [];
}

async function checkpoint_lookupOrgMetadata(orgId, key) {
    if (!orgId) return null;

    const data = await gqlFetch(ENDPOINTS.registry, `{
        metadataentries(where: {
            key: "${key}",
            organization: "${orgId}"
        }) {
            value
        }
    }`);

    return data?.metadataentries?.[0]?.value || null;
}

// ============================================================================
// FETCH PROPOSAL BY ADDRESS (used after on-chain registry resolves an address)
// ============================================================================

async function fetchProposalByAddress(proposalAddress) {
    const entityName = IS_CHECKPOINT ? 'proposalentities' : 'proposalEntities';
    const data = await gqlFetch(ENDPOINTS.registry, `{
        ${entityName}(where: { proposalAddress: "${proposalAddress}" }) {
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
    }`);

    const proposals = data?.[entityName] || [];
    const proposal = proposals.find(p => {
        const aggId = p.organization?.aggregator?.id?.toLowerCase();
        return aggId === AGGREGATOR_ADDRESS.toLowerCase();
    }) || proposals[0];

    if (!proposal) return null;

    let config = {};
    if (proposal.metadata) {
        try { config = JSON.parse(proposal.metadata); } catch (e) { /* ignore */ }
    }

    return normalizeProposalResult(proposal, config);
}

// ============================================================================
// NORMALIZATION
// ============================================================================

function normalizeProposalResult(proposal, config) {
    return {
        proposalId: proposal?.id?.toLowerCase(),
        proposalAddress: proposal?.proposalAddress?.toLowerCase(),
        originalProposalId: proposal?.id,
        organizationId: proposal?.organization?.id,
        organizationName: proposal?.organization?.name,
        coingeckoTicker: config.coingecko_ticker || null,
        closeTimestamp: config.closeTimestamp ? parseInt(config.closeTimestamp) : null,
        startCandleUnix: config.startCandleUnix ? parseInt(config.startCandleUnix) : null,
        twapStartTimestamp: config.twapStartTimestamp ? parseInt(config.twapStartTimestamp) : null,
        twapDurationHours: config.twapDurationHours ? parseInt(config.twapDurationHours) : null,
        twapDescription: config.twapDescription || null,
        chain: config.chain ? parseInt(config.chain) : null,
        pricePrecision: config.price_precision ? parseInt(config.price_precision) : null,
        currencyStableRate: config.currency_stable_rate || null,
        currencyStableSymbol: config.currency_stable_symbol || null,
    };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Resolve a Snapshot proposal ID to Futarchy proposal data.
 * Works identically regardless of backend mode.
 *
 * @param {string} proposalId - Snapshot proposal ID or trading contract address
 * @returns {Promise<Object>} Normalized proposal data
 */
export async function resolveProposalId(proposalId) {
    const normalized = proposalId.toLowerCase();

    // Check cache first (5 min TTL)
    const cached = registryCache.get(normalized);
    if (cached) {
        console.log(`   ⚡ Registry cache hit: ${normalized.slice(0, 10)}...`);
        return cached;
    }

    // 1. Try on-chain SnapshotLinkRegistry (canonical, no stale entries)
    const onchainAddr = await onchain_lookupBySnapshotId(normalized);
    if (onchainAddr) {
        const onchainResult = await fetchProposalByAddress(onchainAddr);
        if (onchainResult) {
            registryCache.set(normalized, onchainResult);
            return onchainResult;
        }
    }

    // 2. Fall back to metadataentries snapshot_id lookup
    const lookupFn = IS_CHECKPOINT ? checkpoint_lookupBySnapshotId : graphNode_lookupBySnapshotId;
    const snapshotResult = await lookupFn(normalized);
    if (snapshotResult) {
        registryCache.set(normalized, snapshotResult);
        return snapshotResult;
    }

    // 3. Fall back to org metadata lookup
    const orgLookupFn = IS_CHECKPOINT ? checkpoint_lookupInOrgMetadata : graphNode_lookupInOrgMetadata;
    const orgResult = await orgLookupFn(normalized);
    if (orgResult) {
        registryCache.set(normalized, orgResult);
        return orgResult;
    }

    // 4. Snapshot proposal IDs are bytes32 values. If no explicit mapping was
    // found above, do not fall through to a generic empty market response.
    if (BYTES32_ID_RE.test(normalized)) {
        return null;
    }

    // 5. A trading contract address may still be registered: take its chain,
    // ticker and close time from the registry rather than the bare stub below.
    const byAddress = await fetchProposalByAddress(normalized);
    if (byAddress) {
        registryCache.set(normalized, byAddress);
        return byAddress;
    }

    // 6. Use ID directly for unregistered Futarchy proposal/trading addresses.
    const fallback = {
        proposalId: normalized,
        proposalAddress: normalized,
        originalProposalId: proposalId,
        organizationId: null,
        organizationName: null,
    };
    registryCache.set(normalized, fallback);
    return fallback;
}

/**
 * Lookup organization-level metadata.
 *
 * @param {string} orgId - Organization ID
 * @param {string} key - Metadata key
 * @returns {Promise<string|null>} Metadata value
 */
export async function lookupOrgMetadata(orgId, key) {
    return IS_CHECKPOINT
        ? checkpoint_lookupOrgMetadata(orgId, key)
        : graphNode_lookupOrgMetadata(orgId, key);
}
