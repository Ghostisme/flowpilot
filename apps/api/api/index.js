/**
 * Vercel serverless entry point for the FlowPilot NestJS API.
 *
 * Vercel routes all requests here (see vercel.json rewrites).
 * A serverless function has no persistent process, so we:
 *
 * 1. Bootstrap the Nest app once (cached in module scope)
 * 2. Initialize it without starting an HTTP listener
 * 3. Export the underlying Express instance as the handler
 *
 * Cold-start reuse: the bootstrap promise is cached, so subsequent
 * requests in the same warm function instance skip bootstrap entirely.
 */

import handler from '../dist/main.js';

export default handler;
