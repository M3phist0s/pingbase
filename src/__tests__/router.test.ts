import { describe, it, expect } from 'vitest';

// The router logic is inside api.ts as a private `route()` function.
// We test the same regex conversion pattern directly here.

function buildRoute(path: string) {
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

function matchRoute(routePath: string, actualPath: string) {
  const { regex, paramNames } = buildRoute(routePath);
  const match = actualPath.match(regex);
  if (!match) return null;

  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = match[i + 1];
  });
  return params;
}

describe('route pattern conversion', () => {
  it('matches a static path', () => {
    const params = matchRoute('/api/monitors', '/api/monitors');
    expect(params).toEqual({});
  });

  it('does not match a different static path', () => {
    expect(matchRoute('/api/monitors', '/api/auth/login')).toBeNull();
  });

  it('extracts a single parameter', () => {
    const params = matchRoute('/api/monitors/:id', '/api/monitors/abc-123');
    expect(params).toEqual({ id: 'abc-123' });
  });

  it('extracts multiple parameters', () => {
    const params = matchRoute('/api/users/:userId/monitors/:monitorId', '/api/users/u1/monitors/m2');
    expect(params).toEqual({ userId: 'u1', monitorId: 'm2' });
  });

  it('does not match partial paths', () => {
    expect(matchRoute('/api/monitors/:id', '/api/monitors/abc/extra')).toBeNull();
    expect(matchRoute('/api/monitors/:id', '/api/monitors')).toBeNull();
  });

  it('handles slug-like parameters', () => {
    const params = matchRoute('/api/status/:slug', '/api/status/my-status-page');
    expect(params).toEqual({ slug: 'my-status-page' });
  });

  it('matches nested check route', () => {
    const params = matchRoute('/api/monitors/:id/checks', '/api/monitors/mon-1/checks');
    expect(params).toEqual({ id: 'mon-1' });
  });
});
