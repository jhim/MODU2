import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app.js';
import { MockAiService, OpenAiService } from './services/ai.js';
import { MemoryLearningRepository } from './repositories/memory.js';
import { SupabaseLearningRepository } from './repositories/supabase.js';
import type { LearningRepository } from './repositories/types.js';

const mode = process.env.MODU2_MODE;
const railwayRuntime = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_ENVIRONMENT);
const productionRuntime = process.env.NODE_ENV === 'production' || railwayRuntime;
if (mode !== 'mock' && mode !== 'production') throw new Error('MODU2_MODE must be explicitly set to "mock" or "production".');
if (productionRuntime && mode !== 'production') throw new Error('MODU2_MODE=production is required in Railway and production environments.');

let repository: LearningRepository;
let ai: MockAiService | OpenAiService;
let verifyAccessToken: LearningRepository['verifyAccessToken'] | undefined;
if (mode === 'mock') {
  repository = new MemoryLearningRepository();
  ai = new MockAiService();
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } });
    verifyAccessToken = async token => {
      const { data, error } = await authClient.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? undefined };
    };
  }
} else {
  const missing = [
    ['OPENAI_API_KEY', process.env.OPENAI_API_KEY], ['SUPABASE_URL', process.env.SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error('MODU2_MODE=production requires: ' + missing.join(', ') + '.');
  repository = SupabaseLearningRepository.fromEnv(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  ai = new OpenAiService(process.env.OPENAI_API_KEY!, process.env.OPENAI_MODEL || 'gpt-4o-mini');
}
const app = createApp({ ai, repository, verifyAccessToken, aiUsageSessionSecret: process.env.SUPABASE_SERVICE_ROLE_KEY,
  enableTestRoutes: mode === 'mock' && process.env.NODE_ENV === 'test' });
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.info('MODU2 listening on 0.0.0.0:' + port));
