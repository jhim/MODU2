import { createServer } from 'node:http';

const token = 'e2e-valid-token';
const user = {
  id: 'e2e-test-user', aud: 'authenticated', role: 'authenticated', email: 'test@example.com',
  email_confirmed_at: '2026-10-16T00:00:00.000Z', app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {}, identities: [], created_at: '2026-10-16T00:00:00.000Z', updated_at: '2026-10-16T00:00:00.000Z',
};

function send(res, status, body) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': res.req?.headers?.['access-control-request-headers'] ?? 'apikey, authorization, content-type, x-client-info',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'content-type': 'application/json',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export const mockAuthServer = createServer(async (req, res) => {
  res.req = req;
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.url?.startsWith('/auth/v1/token?grant_type=password')) {
    for await (const _chunk of req) { /* Consume request body. */ }
    return send(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'e2e-refresh-token', user });
  }
  if (req.url === '/auth/v1/user' && req.headers.authorization === `Bearer ${token}`) return send(res, 200, user);
  if (req.url?.startsWith('/auth/v1/token?grant_type=refresh_token')) {
    return send(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'e2e-refresh-token', user });
  }
  if (req.url === '/auth/v1/logout') return send(res, 204);
  return send(res, 401, { message: 'Invalid token' });
});
