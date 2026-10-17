import { describe, expect, it } from 'vitest';
import { parseAdminUserIds } from '../../server/src/config/admin-user-ids.js';

describe('MODU2_ADMIN_USER_IDS validation', () => {
  it('accepts comma-separated UUIDs and normalizes/deduplicates them', () => {
    expect(parseAdminUserIds('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA, aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb'))
      .toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb']);
  });
  it('allows an unset variable only outside production', () => {
    expect(parseAdminUserIds(undefined)).toEqual([]);
    expect(() => parseAdminUserIds(undefined, { required: true })).toThrow('required in production');
  });
  it.each(['', '   ', ','.repeat(1), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa,', 'not-a-uuid'])('rejects invalid allowlist configuration: %j', value => {
    expect(() => parseAdminUserIds(value)).toThrow('MODU2_ADMIN_USER_IDS');
  });
});
