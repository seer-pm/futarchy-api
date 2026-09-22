/**
 * Netlify Functions entrypoint.
 *
 * The app is a plain Express server. Netlify has no long-lived process to
 * bind a port, so serverless-http adapts it: one function handles every
 * route, and netlify.toml rewrites all paths to it. Express keeps doing the
 * routing, which is why /charts/* and /registry/graphql behave exactly as
 * they do locally.
 *
 * What does NOT survive here: the in-memory caches and the background
 * warmer. Each invocation may get a cold container, so anything that relies
 * on state between requests is best treated as absent (src/index.js skips
 * the warmer when NETLIFY is set).
 */

import serverless from 'serverless-http';
import { app } from '../../src/index.js';

export const handler = serverless(app);
