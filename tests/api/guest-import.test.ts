import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app.js';
import { MemoryLearningRepository } from '../../server/src/repositories/memory.js';
import { MockAiService } from '../../server/src/services/ai.js';

class GuestPreviewRepository extends MemoryLearningRepository {
  override readonly allowAnonymousPersistence = false;
}
const repository = new GuestPreviewRepository();
const app = createApp({ ai: new MockAiService(), repository, allowAnonymousPersistence: false });
let server: ReturnType<typeof app.listen>;
let baseUrl = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = 'http://127.0.0.1:' + (server.address() as any).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('MODU2 anonymous creation and uploads', () => {
  it('allows an anonymous AI preview without writing it to the repository', async () => {
    const response = await fetch(baseUrl + '/api/learning-sets', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ original_request: '와인', selected_topic: '와인 기초', learning_goal: '기본 이해', client_request_id: crypto.randomUUID() }) });
    const preview = await response.json();
    expect(response.status).toBe(200);
    expect(preview.saved).toBe(false);
    expect(preview.cards).toHaveLength(10);
    const list = await fetch(baseUrl + '/api/learning-sets');
    expect((await list.json()).total).toBe(0);
  });
  it('parses UTF-8 text over the API and validates uploaded image dimensions', async () => {
    const parsed = await fetch(baseUrl + '/api/import/text/parse', { method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'key_text\tvalue_1\ncoffee\t커피' });
    expect(parsed.status).toBe(200);
    expect((await parsed.json()).cards).toEqual([{ key: 'coffee', values: ['커피'] }]);
    const png = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
    png.writeUInt32BE(2, 16); png.writeUInt32BE(2, 20);
    const photo = await fetch(baseUrl + '/api/import/photo', { method: 'POST',
      headers: { 'content-type': 'image/png' }, body: png });
    expect(photo.status).toBe(200);
    const extracted = await photo.json();
    expect(extracted.cards).toHaveLength(1);
    expect(extracted.review_card_indexes).toEqual([0]);
  });
});
