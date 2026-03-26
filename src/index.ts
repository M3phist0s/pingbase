// -- PingBase: main Worker entry --
// Handles HTTP requests (API) and Cron Triggers (monitoring engine)

import type { Env } from './types';
import { runChecks, flushCheckBuffer } from './monitor';
import { handleApiRequest } from './api';

export default {
  // HTTP request handler — serves the REST API
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'pingbase' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Status page route: /s/:slug
    if (url.pathname.startsWith('/s/')) {
      const slug = url.pathname.split('/')[2];
      if (slug) {
        const { renderStatusPage } = await import('./status-page');
        const html = renderStatusPage(slug);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }

    return new Response('PingBase Monitoring Engine', { status: 200 });
  },

  // Cron Trigger handler — runs every minute
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run monitoring checks on every cron tick (every minute)
    ctx.waitUntil(runChecks(env));

    // Flush write buffer to D1 every minute
    // The cron fires every minute, so this gives us ~60s batching
    ctx.waitUntil(flushCheckBuffer(env));
  },
} satisfies ExportedHandler<Env>;
