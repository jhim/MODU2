import { describe, expect, it } from 'vitest';
import { issueAiUsageSession, verifyAiUsageSession } from '../../server/src/services/ai-usage-session.js';

describe('AI usage session capability', () => {
  it('verifies only the server-signed session id and rejects tampering', () => {
    const secret = 'test-only-server-secret';
    const session = issueAiUsageSession(secret);
    expect(verifyAiUsageSession(session.id, session.token, secret)).toBe(true);
    expect(verifyAiUsageSession(crypto.randomUUID(), session.token, secret)).toBe(false);
    expect(verifyAiUsageSession(session.id, session.token.slice(0, -1) + 'x', secret)).toBe(false);
    expect(verifyAiUsageSession(session.id, session.token, 'another-secret')).toBe(false);
  });
});
