import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MockAiService } from '../../server/src/services/ai.js';

class AuthMemoryRepository extends MemoryLearningRepository {
  override readonly allowAnonymousPersistence = false;
  override async verifyAccessToken(token: string) {
    if (token === 'user-a') return { id: 'user-a' };
    if (token === 'user-b') return { id: 'user-b' };
    return null;
  }
}
const repository = new AuthMemoryRepository();
const app = createApp({ ai: new MockAiService(), repository, allowAnonymousPersistence: false });
let server: ReturnType<typeof app.listen>;
let baseUrl = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const auth = (token: string) => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' });

describe('MODU2 authenticated content ownership', () => {
  const cards = [{ key: 'coffee', values: ['커피', '음료'] }, { key: 'tea', values: ['차'] }];
  async function createAsA() {
    return fetch(baseUrl + '/api/learning-sets/import', { method: 'POST', headers: auth('user-a'),
      body: JSON.stringify({ title: '내 음료 카드', cards, source_mode: 'TEXT' }) });
  }
  it('requires login for permanent creation and exposes public listing to guests', async () => {
    const denied = await fetch(baseUrl + '/api/learning-sets/import', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'guest', cards, source_mode: 'TEXT' }) });
    expect(denied.status).toBe(401);
    const created = await createAsA();
    expect(created.status).toBe(201);
    const listed = await fetch(baseUrl + '/api/learning-sets?q=음료');
    expect(listed.status).toBe(200);
    expect((await listed.json()).results).toHaveLength(1);
  });
  it('allows the owner to edit and blocks another user from editing or deleting', async () => {
    const created = await createAsA();
    const set = await created.json();
    const publicRead = await fetch(baseUrl + '/api/learning-sets/' + set.id);
    expect(publicRead.status).toBe(200);
    expect((await publicRead.json()).can_edit).toBe(false);
    const otherEdit = await fetch(baseUrl + '/api/learning-sets/' + set.id, { method: 'PUT', headers: auth('user-b'),
      body: JSON.stringify({ title: '침해', cards, source_mode: 'TEXT', expected_updated_at: set.updated_at }) });
    expect(otherEdit.status).toBe(404);
    const otherDelete = await fetch(baseUrl + '/api/learning-sets/' + set.id, { method: 'DELETE', headers: auth('user-b') });
    expect(otherDelete.status).toBe(404);
    const ownEdit = await fetch(baseUrl + '/api/learning-sets/' + set.id, { method: 'PUT', headers: auth('user-a'),
      body: JSON.stringify({ title: '수정된 음료 카드', cards: [{ key: 'espresso', values: ['에스프레소'] }], source_mode: 'TEXT', expected_updated_at: set.updated_at }) });
    expect(ownEdit.status).toBe(200);
    const updated = await ownEdit.json();
    expect(updated.cards).toEqual([{ key: 'espresso', values: ['에스프레소'] }]);
    expect(updated.original_request).toBe(set.original_request);
    expect(updated.updated_at).not.toBe(set.updated_at);
    const stale = await fetch(baseUrl + '/api/learning-sets/' + set.id, { method: 'PUT', headers: auth('user-a'),
      body: JSON.stringify({ title: '낡은 수정', cards, source_mode: 'TEXT', expected_updated_at: set.updated_at }) });
    expect(stale.status).toBe(409);
  });
  it('ignores a client-supplied owner_id and uses the JWT subject for ownership', async () => {
    const response = await fetch(baseUrl + '/api/learning-sets/import', { method: 'POST', headers: auth('user-a'),
      body: JSON.stringify({ title: '소유자 위조 시도', cards, source_mode: 'TEXT', owner_id: 'user-b' }) });
    expect(response.status).toBe(201);
    const set = await response.json();
    const ownedByA = await fetch(baseUrl + '/api/learning-sets/' + set.id, { headers: { authorization: 'Bearer user-a' } });
    const ownedByB = await fetch(baseUrl + '/api/learning-sets/' + set.id, { headers: { authorization: 'Bearer user-b' } });
    expect((await ownedByA.json()).can_edit).toBe(true);
    expect((await ownedByB.json()).can_edit).toBe(false);
  });
  it('rejects an invalid bearer token even for the public all-content listing', async () => {
    const response = await fetch(baseUrl + '/api/learning-sets?scope=all', { headers: { authorization: 'Bearer invalid' } });
    expect(response.status).toBe(401);
  });  it('denies invalid or expired bearer tokens', async () => {
    const response = await fetch(baseUrl + '/api/learning-sets/import', { method: 'POST', headers: auth('invalid'),
      body: JSON.stringify({ title: 'invalid', cards, source_mode: 'TEXT' }) });
    expect(response.status).toBe(401);
  });
});
