import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export type AiUsageSession = { id: string; token: string };

function sign(id: string, secret: string) {
  return createHmac('sha256', secret).update('modu2-ai-usage-session:v1:').update(id).digest('base64url');
}

export function issueAiUsageSession(secret: string): AiUsageSession {
  const id = randomUUID();
  return { id, token: sign(id, secret) };
}

export function verifyAiUsageSession(id: string, token: string, secret: string): boolean {
  const expected = Buffer.from(sign(id, secret));
  const actual = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createEphemeralAiUsageSecret() {
  return randomBytes(32).toString('base64url');
}
