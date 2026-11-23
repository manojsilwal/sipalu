import type { Router, RequestHandler } from 'express';

/**
 * Wraps every route handler on an Express 4 Router so rejected promises
 * automatically forward to the centralized error middleware (fixes DEF-002).
 */
export function wrapAsyncRouter(router: Router): Router {
  const stack = (router as unknown as { stack: Array<{ route?: { stack: Array<{ handle: RequestHandler }> } }> }).stack;
  for (const layer of stack) {
    if (layer.route?.stack) {
      for (const routeLayer of layer.route.stack) {
        const orig = routeLayer.handle;
        if (orig.length <= 3) {
          routeLayer.handle = (req, res, next) => {
            Promise.resolve(orig(req, res, next)).catch(next);
          };
        }
      }
    }
  }
  return router;
}
