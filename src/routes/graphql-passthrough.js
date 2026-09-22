/**
 * Generic GraphQL passthrough.
 *
 * Forwards POST bodies to a configured upstream GraphQL endpoint
 * verbatim. Used by the futarchy.fi frontend to reach the Checkpoint
 * indexer's registry/candles GraphQL servers over HTTPS without
 * mixed-content blocks.
 *
 * Returns the upstream JSON unchanged. On upstream error or timeout
 * returns a JSON-RPC-shaped {errors:[{message}]} so the frontend's
 * GraphQL client treats it like a normal failure.
 */

// Netlify caps a synchronous function at 10s (26s on Pro). A 15s budget here
// meant the platform killed the request first and the caller got a generic
// 502 instead of the upstream-timeout message below.
const DEFAULT_TIMEOUT_MS = Number(process.env.GRAPHQL_TIMEOUT_MS || 9_000);

export function makeGraphQLPassthrough(getUpstreamUrl, label) {
    return async function handler(req, res) {
        const upstream = getUpstreamUrl();
        if (!upstream) {
            res.status(503).json({
                errors: [{ message: `[${label}] upstream URL not configured` }],
            });
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

        try {
            const upstreamRes = await fetch(upstream, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body ?? {}),
                signal: controller.signal,
            });

            const text = await upstreamRes.text();
            res.status(upstreamRes.status)
                .set('Content-Type', upstreamRes.headers.get('content-type') || 'application/json')
                .send(text);
        } catch (err) {
            const isAbort = err?.name === 'AbortError';
            console.error(`[${label}] passthrough failed:`, err?.message || err);
            res.status(isAbort ? 504 : 502).json({
                errors: [{
                    message: isAbort
                        ? `[${label}] upstream timeout after ${DEFAULT_TIMEOUT_MS}ms`
                        : `[${label}] upstream error: ${err?.message || 'unknown'}`,
                }],
            });
        } finally {
            clearTimeout(timer);
        }
    };
}
