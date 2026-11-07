import { describe, expect, it, vi } from 'vitest';
import { createSupabaseDiagnosticFetch } from '../../server/src/repositories/supabase.js';

describe('Supabase network diagnostics', () => {
  it('logs safe fetch cause metadata only for learning set list RPC failures', async () => {
    const cause = Object.assign(new Error('private network details'), {
      code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: 'private-host',
    });
    const failure = new TypeError('fetch failed', { cause });
    const baseFetch = vi.fn().mockRejectedValue(failure);
    const diagnosticFetch = createSupabaseDiagnosticFetch(baseFetch as typeof fetch);
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await expect(diagnosticFetch('https://project.example.supabase.co/rest/v1/rpc/list_learning_sets', {
        headers: { Authorization: 'Bearer secret-token' },
      })).rejects.toBe(failure);
      const entries = log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      expect(entries[0]).toMatchObject({ event: 'supabase_network_error', operation: 'list_learning_sets',
        error_name: 'TypeError', cause_name: 'Error', cause_code: 'ECONNREFUSED', cause_errno: -111,
        cause_syscall: 'connect' });
      expect(JSON.stringify(entries)).not.toMatch(/private network details|private-host|secret-token|project\\.example/);
    } finally {
      log.mockRestore();
    }
  });
});
