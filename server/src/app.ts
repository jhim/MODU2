import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { CreateSetRequestSchema, EditableCardsSchema, ImportedSetRequestSchema, ListQuerySchema,
  SearchQuerySchema, SuggestionRequestSchema, UpdateSetRequestSchema, type CreateSetRequest } from '../../shared/schemas/index.js';
import { AiProviderError, type AiService } from './services/ai.js';
import type { AiUsageRecord } from './services/ai-pricing.js';
import { decodeUtf8, inspectWorkbook, parseTextImport, parseWorkbook, type ColumnMapping } from './services/imports.js';
import { exportTsv, exportXlsx } from './services/exports.js';
import { inspectImage } from './services/images.js';
import { createEphemeralAiUsageSecret, issueAiUsageSession, verifyAiUsageSession, type AiUsageSession } from './services/ai-usage-session.js';
import type { LearningRepository } from './repositories/types.js';
import { logMetric, requestId as newRequestId } from './lib/metrics.js';
import { isPromptKey, type PromptRepository } from './prompts/repository.js';
import { validatePromptTemplate, type PromptTemplate } from './prompts/templates.js';
import { buildRuntimePromptMessages, loadRuntimePrompt, promptVersionTemplate } from './prompts/runtime.js';

type User = { id: string; email?: string };
type Deps = { ai: AiService; repository: LearningRepository; promptRepository?: PromptRepository; adminUserIds?: string[]; enableTestRoutes?: boolean; allowAnonymousPersistence?: boolean; verifyAccessToken?: LearningRepository["verifyAccessToken"]; aiUsageSessionSecret?: string };
function uploadError(res: Response, message: string, status = 400) { return res.status(status).json({ error: message }); }
function isBuffer(value: unknown): value is Buffer { return Buffer.isBuffer(value); }
function classifySafeErrorMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  const normalized = message.toLowerCase();
  if (normalized.includes('schema cache') && normalized.includes('function')) return 'schema_function_cache_miss';
  if (normalized.includes('function') && normalized.includes('does not exist')) return 'missing_function';
  if (normalized.includes('column') && normalized.includes('does not exist')) return 'missing_column';
  if ((normalized.includes('relation') || normalized.includes('table')) && normalized.includes('does not exist')) return 'missing_relation';
  if (normalized.includes('permission denied')) return 'permission_denied';
  if (normalized.includes('invalid scope')) return 'invalid_scope';
  if (normalized.includes('owner required')) return 'owner_required';
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (normalized.includes('duplicate key') || normalized.includes('unique constraint')) return 'unique_constraint';
  if (normalized.includes('foreign key constraint')) return 'foreign_key_constraint';
  if (normalized.includes('check constraint')) return 'check_constraint';
  if (normalized.includes('not-null constraint')) return 'not_null_constraint';
  if (normalized.includes('invalid input syntax')) return 'invalid_input';
  return 'other';
}
function safeErrorDiagnostics(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== 'object') return {};
  const value = error as Record<string, unknown>;
  const diagnostics: Record<string, string | number> = {};
  diagnostics.error_shape = Array.isArray(error) ? 'array' : 'object';
  const fields = Object.keys(value).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)).slice(0, 12);
  if (fields.length) diagnostics.error_fields = fields.join(',');
  if (Object.hasOwn(value, 'code') && typeof value.code !== 'string') {
    diagnostics.error_code_type = value.code === null ? 'null' : typeof value.code;
  }
  const messageClass = classifySafeErrorMessage(value.message);
  if (messageClass) diagnostics.error_message_class = messageClass;
  const fields = Object.keys(value).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)).slice(0, 12);
  if (fields.length) diagnostics.error_fields = fields.join(',');
  // Supabase/Postgres codes are stable, useful for diagnosis, and do not contain row data.
  if (typeof value.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.code)) diagnostics.error_code = value.code;
  const status = value.status ?? value.statusCode;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) diagnostics.upstream_status = status;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(error.name)) diagnostics.error_name = error.name;
  else if (typeof value.name === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(value.name)) diagnostics.error_name = value.name;
  return diagnostics;
}
function validImage(bytes: Buffer, type: string): type is 'image/jpeg' | 'image/png' | 'image/webp' {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return type === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
}
function optionalBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? '';
}
async function resolveUser(req: Request, repository: LearningRepository, verify = repository.verifyAccessToken.bind(repository)): Promise<User | null> {
  const token = optionalBearer(req);
  if (token === null) return null;
  if (!token) throw Object.assign(new Error('invalid bearer token'), { status: 401 });
  const user = await verify(token);
  if (!user) throw Object.assign(new Error('invalid session'), { status: 401 });
  return user;
}
function authRequired(req: Request, res: Response, next: NextFunction, repository: LearningRepository, verify: LearningRepository["verifyAccessToken"]) {
  resolveUser(req, repository, verify).then(user => {
    if (!user) return res.status(401).json({ error: '콘텐츠를 저장하거나 수정하려면 로그인해 주세요.' });
    res.locals.user = user; next();
  }).catch(next);
}
function getAuthMiddleware(repository: LearningRepository, verify: LearningRepository["verifyAccessToken"]) {
  return (req: Request, res: Response, next: NextFunction) => authRequired(req, res, next, repository, verify);
}
function bodyCards(input: unknown) {
  const parsed = EditableCardsSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error('카드 내용을 확인해 주세요.'), { status: 400 });
  return parsed.data;
}
function errorStatus(error: any): number | undefined {
  if (typeof error?.status === 'number') return error.status;
  if (error?.code === 'P0002') return 404;
  if (error?.code === '40001') return 409;
  return undefined;
}
function contentDisposition(name: string) {
  return 'attachment; filename="' + name.replace(/[^a-zA-Z0-9._-]/g, '_') + '"';
}
function routeParam(value: string | string[] | undefined): string { return Array.isArray(value) ? value[0] ?? '' : value ?? ''; }
function stripPromptActorIds(value: object) {
  const { created_by: _createdBy, activated_by: _activatedBy, actor_user_id: _actorUserId, ...safe } = value as Record<string, unknown>;
  return safe;
}
function resolveAiUsageSession(id: string | undefined, token: string | undefined, secret: string): AiUsageSession {
  if (token && !id) throw Object.assign(new Error('AI 사용량 연결 정보가 올바르지 않습니다.'), { status: 400 });
  if (id && token) {
    if (!verifyAiUsageSession(id, token, secret)) throw Object.assign(new Error('AI 사용량 연결 정보가 만료되었거나 올바르지 않습니다.'), { status: 400 });
    return { id, token };
  }
  // Ignore legacy client-supplied UUIDs without a server signature.
  return issueAiUsageSession(secret);
}

export function getTrustProxySetting(env: NodeJS.ProcessEnv = process.env): number | false {
  const productionProxy = env.MODU2_MODE === 'production'
    && (env.VERCEL === '1' || Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT));
  return productionProxy ? 1 : false;
}

export function createApp(deps: Deps) {
  const app = express();
  const aiUsageSessionSecret = deps.aiUsageSessionSecret ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? createEphemeralAiUsageSecret();
  app.disable('x-powered-by');
  app.set('trust proxy', getTrustProxySetting());
  app.use(express.json({ limit: '6mb' }));
  app.use((req, res, next) => {
    const id = newRequestId(); const started = performance.now();
    res.setHeader('x-request-id', id);
    res.on('finish', () => logMetric('api_request', { request_id: id, method: req.method,
      route: req.path, status: res.statusCode, duration_ms: Math.round(performance.now() - started) }));
    res.locals.requestId = id; next();
  });
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } });
  const photoLimiter = rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '사진 인식 요청이 많습니다. 잠시 후 다시 시도해 주세요.' } });
  const verifyToken = deps.verifyAccessToken ?? deps.repository.verifyAccessToken.bind(deps.repository);
  const requireAuth = getAuthMiddleware(deps.repository, verifyToken);
  const adminUserIds = new Set((deps.adminUserIds ?? process.env.MODU2_ADMIN_USER_IDS?.split(',') ?? []).map(id => id.trim()).filter(Boolean));
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    resolveUser(req, deps.repository, verifyToken).then(user => {
      if (!user) return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
      if (!adminUserIds.has(user.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
      res.locals.user = user; next();
    }).catch(next);
  };
  const promptRepo = deps.promptRepository ?? ((deps.repository as Partial<PromptRepository>).listPromptTemplates
    ? deps.repository as LearningRepository & PromptRepository : undefined);
  const promptKeyParam = (req: Request, res: Response): 'RECOMMEND' | 'FLASHCARD' | null => {
    const key = routeParam(req.params.promptKey).toUpperCase();
    if (isPromptKey(key)) return key;
    res.status(404).json({ error: '프롬프트 유형을 찾을 수 없습니다.' }); return null;
  };
  const promptBodySchema = z.object({ system_prompt: z.string(), developer_prompt: z.string(), user_template: z.string(), change_note: z.string().max(500).default('') });
  const previewInputSchema = z.object({ version_id: z.string().uuid().optional(), input: z.object({
    original_request: z.string().max(200).default('와인의 역사'), refinement_request: z.string().max(200).default(''),
    previous_titles: z.array(z.string().max(200)).max(6).default([]), selected_topic: z.string().max(200).default('와인의 역사'),
    learning_goal: z.string().max(500).default('와인의 역사와 주요 변화를 설명할 수 있다'),
  }).default({}) });

  const rawText = express.raw({ type: 'text/plain', limit: '2mb' });
  const rawXlsx = express.raw({ type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', limit: '5mb' });
  const rawImage = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '8mb' });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/admin/access', requireAuth, (req, res) => res.json({ is_admin: adminUserIds.has((res.locals.user as User).id) }));
  app.get('/api/admin/prompts', requireAdmin, async (_req, res, next) => {
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    try {
      const prompts = await promptRepo.listPromptTemplates();
      return res.json({ prompts: prompts.map(template => ({ ...template, versions: template.versions?.map(version => stripPromptActorIds(version)) })) });
    } catch (error) { return next(error); }
  });
  app.get('/api/admin/prompts/:promptKey/versions', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    try { return res.json({ versions: (await promptRepo.listPromptVersions(key)).map(version => stripPromptActorIds(version)) }); } catch (error) { return next(error); }
  });
  app.get('/api/admin/prompts/:promptKey/versions/:versionId', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    try {
      const version = await promptRepo.getPromptVersion(key, routeParam(req.params.versionId));
      return version ? res.json({ version: stripPromptActorIds(version) }) : res.status(404).json({ error: '프롬프트 버전을 찾을 수 없습니다.' });
    } catch (error) { return next(error); }
  });
  app.post('/api/admin/prompts/:promptKey/drafts', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    const parsed = z.object({ change_note: z.string().max(500).default('초안 작성') }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: '변경 메모를 확인해 주세요.' });
    try { return res.status(201).json({ version: stripPromptActorIds(await promptRepo.createPromptDraft(key, (res.locals.user as User).id, parsed.data.change_note)) }); }
    catch (error) { return next(error); }
  });
  app.put('/api/admin/prompts/:promptKey/drafts/:versionId', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '프롬프트 내용을 확인해 주세요.' });
    const change_note = parsed.data.change_note ?? '';
    const prompt: PromptTemplate = {
      system_prompt: parsed.data.system_prompt!,
      developer_prompt: parsed.data.developer_prompt!,
      user_template: parsed.data.user_template!,
    };
    const validation = validatePromptTemplate(key, prompt);
    if (!validation.valid) return res.status(400).json({ error: '템플릿 변수를 확인해 주세요.', validation });
    try { return res.json({ version: stripPromptActorIds(await promptRepo.updatePromptDraft(key, routeParam(req.params.versionId), (res.locals.user as User).id, prompt, change_note)) }); }
    catch (error) { return next(error); }
  });
  app.post('/api/admin/prompts/:promptKey/drafts/:versionId/validate', requireAdmin, async (req, res) => {
    const key = promptKeyParam(req, res); if (!key) return;
    const parsed = promptBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ valid: false, errors: parsed.error.issues.map(issue => issue.message) });
    const prompt: PromptTemplate = {
      system_prompt: parsed.data.system_prompt!,
      developer_prompt: parsed.data.developer_prompt!,
      user_template: parsed.data.user_template!,
    };
    return res.json(validatePromptTemplate(key, prompt));
  });
  app.post('/api/admin/prompts/:promptKey/versions/:versionId/activate', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    const parsed = z.object({ expected_active_version_id: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '현재 운영 버전 정보가 없어 적용할 수 없습니다. 새로고침 후 다시 시도해 주세요.' });
    try { return res.json({ version: stripPromptActorIds(await promptRepo.activatePromptVersion(key, routeParam(req.params.versionId), (res.locals.user as User).id, parsed.data.expected_active_version_id)) }); }
    catch (error) { return next(error); }
  });
  app.post('/api/admin/prompts/:promptKey/versions/:versionId/restore', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    const parsed = z.object({ change_note: z.string().max(500).default('이전 버전 복원') }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: '변경 메모를 확인해 주세요.' });
    try { return res.status(201).json({ version: stripPromptActorIds(await promptRepo.restorePromptVersion(key, routeParam(req.params.versionId), (res.locals.user as User).id, parsed.data.change_note)) }); }
    catch (error) { return next(error); }
  });
  app.get('/api/admin/prompts/:promptKey/audit-logs', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    try { return res.json({ audit_logs: (await promptRepo.listPromptAudit(key, Number(req.query.limit) || 50)).map(entry => stripPromptActorIds(entry)) }); } catch (error) { return next(error); }
  });
  app.post('/api/admin/prompts/:promptKey/preview', requireAdmin, async (req, res, next) => {
    const key = promptKeyParam(req, res); if (!key) return;
    if (!promptRepo) return res.status(503).json({ error: '프롬프트 저장소를 사용할 수 없습니다.' });
    const parsed = previewInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: '미리보기 입력을 확인해 주세요.' });
    try {
      let prompt = null; let versionId: string | undefined; let versionNumber: number | undefined; let fallback = false;
      if (parsed.data.version_id) {
        const version = await promptRepo.getPromptVersion(key, parsed.data.version_id);
        if (!version) return res.status(404).json({ error: '프롬프트 버전을 찾을 수 없습니다.' });
        const candidate = promptVersionTemplate(version); const validation = validatePromptTemplate(key, candidate);
        if (!validation.valid) return res.status(400).json({ error: '선택한 프롬프트의 템플릿 변수를 확인해 주세요.', validation });
        prompt = validation.value!; versionId = version.id; versionNumber = version.version_number;
      } else {
        const snapshot = await loadRuntimePrompt(promptRepo, key, res.locals.requestId);
        prompt = snapshot.prompt; versionId = snapshot.versionId; versionNumber = snapshot.versionNumber; fallback = snapshot.fallback;
      }
      const values = key === 'RECOMMEND' ? { original_request: parsed.data.input.original_request,
        refinement_request: parsed.data.input.refinement_request, previous_suggestions: parsed.data.input.previous_titles.map(title => ({ title })) }
        : { original_request: parsed.data.input.original_request, refinement_request: parsed.data.input.refinement_request, selected_topic: parsed.data.input.selected_topic,
          learning_goal: parsed.data.input.learning_goal };
      return res.json({ prompt_key: key, version_id: versionId ?? null, version_number: versionNumber ?? null,
        fallback, messages: buildRuntimePromptMessages(key, prompt, values) });
    } catch (error) { return next(error); }
  });

  app.get('/api/learning-sets/search', async (req, res, next) => {
    try {
      const parsed = SearchQuerySchema.safeParse(req.query.q);
      if (!parsed.success) return res.status(400).json({ error: '검색어는 1~100자여야 합니다.' });
      const started = performance.now(); const results = await deps.repository.search(parsed.data, 5);
      logMetric('db_query', { request_id: res.locals.requestId, kind: 'search', duration_ms: Math.round(performance.now() - started) });
      return res.json({ results: results.map(({ id, title, original_request, created_at }) => ({ id, title, original_request, created_at })) });
    } catch (error) { return next(error); }
  });
  app.post('/api/ai/suggestions', aiLimiter, async (req, res, next) => {
    let sessionId: string | undefined;
    let usageOwnerId: string | undefined;
    try {
      const parsed = SuggestionRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '학습 요청을 확인해 주세요.' });
      usageOwnerId = (await resolveUser(req, deps.repository, verifyToken))?.id;
      const suppliedSessionId = parsed.data.ai_usage_session_id;
      const suppliedToken = parsed.data.ai_usage_session_token;
      const suggestionInput = {
        original_request: parsed.data.original_request!,
        refinement_request: parsed.data.refinement_request ?? '',
        previous_suggestions: parsed.data.previous_suggestions ?? [],
      };
      const usageSession = resolveAiUsageSession(suppliedSessionId, suppliedToken, aiUsageSessionSecret);
      sessionId = usageSession.id;
      if (usageOwnerId) await deps.repository.claimAiUsageSession(sessionId, usageOwnerId);
      const result = await deps.ai.suggest(suggestionInput, res.locals.requestId);
      if (result.usage) await deps.repository.recordAiUsage({ sessionId, requestId: res.locals.requestId, operation: 'suggestions', usage: result.usage, promptUsage: result.promptUsage, ownerId: usageOwnerId });
      return res.json({ ...result.data, ai_usage_session_id: sessionId, ai_usage_session_token: usageSession.token });
    } catch (error) {
      if (error instanceof AiProviderError && error.usage && sessionId) {
        try { await deps.repository.recordAiUsage({ sessionId, requestId: res.locals.requestId, operation: 'suggestions', usage: error.usage, promptUsage: error.promptUsage, ownerId: usageOwnerId }); }
        catch { logMetric('ai_usage_persist_error', { request_id: res.locals.requestId, operation: 'suggestions' }); }
      }
      return next(error);
    }
  });

  app.get('/api/learning-sets', async (req, res, next) => {
    try {
      const parsed = ListQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: '목록 검색 조건을 확인해 주세요.' });
      const user = await resolveUser(req, deps.repository, verifyToken);
      if (parsed.data.scope === 'mine' && !user) return res.status(401).json({ error: '내 콘텐츠를 보려면 로그인해 주세요.' });
      const result = await deps.repository.listContent({ query: parsed.data.q, sort: parsed.data.sort, page: parsed.data.page, pageSize: parsed.data.page_size, scope: parsed.data.scope, ownerId: user?.id });
      return res.json(result);
    } catch (error) { return next(error); }
  });

  app.post('/api/learning-sets', aiLimiter, async (req, res, next) => {
    try {
      const parsed = CreateSetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '학습 주제와 요청 정보를 확인해 주세요.' });
      const input: CreateSetRequest = parsed.data;
      const usageSession = resolveAiUsageSession(input.ai_usage_session_id, input.ai_usage_session_token, aiUsageSessionSecret);
      input.ai_usage_session_id = usageSession.id;
      input.ai_usage_session_token = usageSession.token;
      const user = await resolveUser(req, deps.repository, verifyToken);
      if (user) await deps.repository.claimAiUsageSession(usageSession.id, user.id);
      // Production guests can study a generated preview, but no row is persisted until login.
      const persist = Boolean(user) || deps.allowAnonymousPersistence === true || deps.repository.allowAnonymousPersistence === true || process.env.MODU2_MODE === 'mock';
      if (!persist) {
        const sessionId = usageSession.id;
        const generated = await deps.ai.generate(input, res.locals.requestId);
        if (generated.usage) await deps.repository.recordAiUsage({ sessionId, requestId: res.locals.requestId,
            operation: 'flashcard_generation', usage: generated.usage, promptUsage: generated.promptUsage, ownerId: user?.id });
        return res.status(200).json({ id: randomUUID(), title: generated.data.title, original_request: input.original_request,
          selected_topic: input.selected_topic, learning_goal: input.learning_goal, status: 'COMPLETED',
          created_at: new Date().toISOString(), source_mode: 'AI', cards: generated.data.cards, saved: false,
          ai_usage_session_id: sessionId, ai_usage_session_token: usageSession.token });
      }
      const reserveStarted = performance.now();
      const reservation = await deps.repository.reserve({ requestId: input.client_request_id, originalRequest: input.original_request,
        selectedTopic: input.selected_topic, learningGoal: input.learning_goal, ...(user ? { ownerId: user.id } : {}),
        aiUsageSessionId: usageSession.id });
      const aiUsageSessionId = reservation.set.ai_usage_session_id ?? input.ai_usage_session_id ?? randomUUID();
      logMetric('db_reserve', { request_id: res.locals.requestId, duration_ms: Math.round(performance.now() - reserveStarted) });
      if (!reservation.created) {
        if (reservation.set.owner_id && user?.id !== reservation.set.owner_id) return res.status(409).json({ error: '요청 ID를 다시 만들어 주세요.' });
        if (reservation.set.status === 'COMPLETED') {
          const existing = await deps.repository.getCompleted(reservation.set.id);
          if (existing) return res.json({ ...existing, saved: Boolean(existing.owner_id) });
        }
        return res.status(409).json({ error: reservation.set.status === 'FAILED' ? '이전 생성이 실패했습니다. 새 요청으로 다시 시도해 주세요.' : '같은 요청을 처리하고 있습니다.' });
      }
      try {
        let generated: Awaited<ReturnType<AiService['generate']>> | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            generated = await deps.ai.generate(input, res.locals.requestId);
            if (generated.usage) await deps.repository.recordAiUsage({ sessionId: aiUsageSessionId,
              requestId: res.locals.requestId, operation: 'flashcard_generation', usage: generated.usage, promptUsage: generated.promptUsage, ownerId: user?.id });
            break;
          } catch (error) {
            const rejectedUsage = (error as Error & { aiUsage?: AiUsageRecord | null }).aiUsage
              ?? (error instanceof AiProviderError ? error.usage : null);
            if (rejectedUsage) await deps.repository.recordAiUsage({ sessionId: aiUsageSessionId,
              requestId: res.locals.requestId, operation: 'flashcard_generation', usage: rejectedUsage,
              promptUsage: (error as Error & { promptUsage?: import('./services/ai.js').AiPromptUsage }).promptUsage ?? (error instanceof AiProviderError ? error.promptUsage : undefined), ownerId: user?.id });
            if (error instanceof ZodError && attempt === 0) { logMetric('generation_retry', { request_id: res.locals.requestId, attempt: attempt + 1 }); continue; }
            throw error;
          }
        }
        if (!generated) throw new AiProviderError('flashcard_generation');
        const cards = bodyCards(generated.data.cards);
        const started = performance.now();
        const completed = await deps.repository.complete(reservation.set.id, generated.data.title, cards);
        logMetric('db_write', { request_id: res.locals.requestId, duration_ms: Math.round(performance.now() - started) });
        return res.status(201).json({ ...completed, saved: Boolean(user) });
      } catch (error) { await deps.repository.fail(reservation.set.id).catch(() => undefined); throw error; }
    } catch (error) { return next(error); }
  });

  app.post('/api/learning-sets/import', requireAuth, async (req, res, next) => {
    try {
      const parsed = ImportedSetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '제목과 카드 내용을 확인해 주세요.' });
      const usageSession = parsed.data.ai_usage_session_id || parsed.data.ai_usage_session_token
        ? resolveAiUsageSession(parsed.data.ai_usage_session_id, parsed.data.ai_usage_session_token, aiUsageSessionSecret)
        : undefined;
      if (usageSession) await deps.repository.claimAiUsageSession(usageSession.id, res.locals.user.id);
      const set = await deps.repository.createOwned({ ownerId: res.locals.user.id, title: parsed.data.title,
        cards: parsed.data.cards, sourceMode: parsed.data.source_mode,
        ...((parsed.data.source_mode === 'PHOTO' || parsed.data.source_mode === 'AI') && usageSession ? { aiUsageSessionId: usageSession.id } : {}) });
      return res.status(201).json({ ...set, saved: true });
    } catch (error) { return next(error); }
  });

  app.get('/api/import/template', async (_req, res) => {
    const workbook = await exportXlsx([{ key: 'apple', values: ['사과', '과일'] }]);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('content-disposition', contentDisposition('modu2-flashcards-template.xlsx')).send(workbook);
  });

  app.post('/api/import/text/parse', rawText, (req, res) => {
    if (!req.is('text/plain') || !isBuffer(req.body)) return uploadError(res, 'UTF-8 텍스트 파일만 가져올 수 있습니다.', 415);
    try {
      const parsed = parseTextImport(decodeUtf8(req.body));
      return res.json(parsed);
    } catch (error) { return uploadError(res, error instanceof Error ? error.message : '텍스트를 읽지 못했습니다.'); }
  });

  app.post('/api/import/excel/inspect', rawXlsx, async (req, res) => {
    if (!req.is('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') || !isBuffer(req.body)) return uploadError(res, 'XLSX 파일만 가져올 수 있습니다.', 415);
    try { return res.json({ sheets: await inspectWorkbook(req.body) }); }
    catch (error) { return uploadError(res, error instanceof Error ? error.message : 'Excel 파일을 읽지 못했습니다.'); }
  });
  app.post('/api/import/excel/parse', rawXlsx, async (req, res) => {
    if (!req.is('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') || !isBuffer(req.body)) return uploadError(res, 'XLSX 파일만 가져올 수 있습니다.', 415);
    try {
      const parseIntHeader = (key: string) => req.header(key) ? Number(req.header(key)) : undefined;
      const values = req.header('x-value-columns')?.split(',').map(Number).filter(Number.isFinite);
      const keyColumn = parseIntHeader('x-key-column');
      const mapping: ColumnMapping | undefined = keyColumn ? { keyColumn, valueColumns: values ?? [] } : undefined;
      return res.json(await parseWorkbook(req.body, req.header('x-sheet-name') ?? undefined, mapping));
    } catch (error) { return uploadError(res, error instanceof Error ? error.message : 'Excel 파일을 읽지 못했습니다.'); }
  });

  app.post('/api/import/photo', photoLimiter, rawImage, async (req, res, next) => {
    const mime = req.header('content-type')?.split(';')[0]?.trim() ?? '';
    if (!isBuffer(req.body) || !validImage(req.body, mime)) return uploadError(res, 'JPG, PNG, WebP 형식의 사진만 업로드할 수 있습니다.', 415);
    if (req.body.byteLength > 8 * 1024 * 1024) return uploadError(res, '사진은 8MB 이하만 업로드할 수 있습니다.', 413);
    const sessionHeader = req.header('x-ai-usage-session-id');
    const sessionTokenHeader = req.header('x-ai-usage-session-token');
    if (sessionHeader && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionHeader)) {
      return uploadError(res, 'AI 사용량 연결 ID가 올바르지 않습니다.');
    }
    let usageSession: AiUsageSession;
    try { usageSession = resolveAiUsageSession(sessionHeader, sessionTokenHeader, aiUsageSessionSecret); }
    catch (error) { return uploadError(res, error instanceof Error ? error.message : 'AI 사용량 연결 정보가 올바르지 않습니다.', 400); }
    const sessionId = usageSession.id;
    let usageOwnerId: string | undefined;
    try {
      usageOwnerId = (await resolveUser(req, deps.repository, verifyToken))?.id;
      if (usageOwnerId) await deps.repository.claimAiUsageSession(sessionId, usageOwnerId);
      inspectImage(req.body, mime);
      const extracted = await deps.ai.extractImage(req.body, mime, res.locals.requestId);
      if (extracted.usage) await deps.repository.recordAiUsage({ sessionId, requestId: res.locals.requestId,
        operation: 'image_extraction', usage: extracted.usage, promptUsage: extracted.promptUsage, ownerId: usageOwnerId });
      return res.json({ cards: extracted.data.cards.map(({ key, values }) => ({ key, values })),
        review_card_indexes: extracted.data.cards.flatMap((card, index) => card.needs_review ? [index] : []),
        ai_usage_session_id: sessionId, ai_usage_session_token: usageSession.token });
    } catch (error) {
      if (error instanceof AiProviderError && error.usage) {
        try { await deps.repository.recordAiUsage({ sessionId, requestId: res.locals.requestId, operation: 'image_extraction', usage: error.usage, promptUsage: error.promptUsage, ownerId: usageOwnerId }); }
        catch { logMetric('ai_usage_persist_error', { request_id: res.locals.requestId, operation: 'image_extraction' }); }
      }
      return next(error);
    }
  });

  app.post('/api/learning-sets/:id/import-preview', requireAuth, async (req, res, next) => {
    try {
      const parsed = ImportedSetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '업로드한 제목과 카드 내용을 확인해 주세요.' });
      const current = await deps.repository.getOwned(String(req.params.id), res.locals.user.id);
      if (!current) return res.status(404).json({ error: '수정할 수 있는 콘텐츠를 찾을 수 없습니다.' });
      return res.json({ current: { title: current.title, cards: current.cards, updated_at: current.updated_at },
        proposed: parsed.data, changes: { before: current.cards?.length ?? 0, after: parsed.data.cards.length } });
    } catch (error) { return next(error); }
  });

  app.put('/api/learning-sets/:id', requireAuth, async (req, res, next) => {
    try {
      const parsed = UpdateSetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '수정할 제목과 카드 내용을 확인해 주세요.' });
      const set = await deps.repository.updateOwned({ id: String(req.params.id), ownerId: res.locals.user.id,
        expectedUpdatedAt: parsed.data.expected_updated_at, title: parsed.data.title,
        cards: parsed.data.cards, sourceMode: parsed.data.source_mode });
      return res.json({ ...set, saved: true });
    } catch (error) { return next(error); }
  });
  app.delete('/api/learning-sets/:id', requireAuth, async (req, res, next) => {
    try {
      const deleted = await deps.repository.deleteOwned(String(req.params.id), res.locals.user.id);
      return deleted ? res.status(204).end() : res.status(404).json({ error: '삭제할 수 있는 콘텐츠를 찾을 수 없습니다.' });
    } catch (error) { return next(error); }
  });

  app.get('/api/learning-sets/:id/export', async (req, res, next) => {
    try {
      const set = await deps.repository.getCompleted(String(req.params.id));
      if (!set?.cards) return res.status(404).json({ error: '학습 콘텐츠를 찾을 수 없습니다.' });
      if (req.query.format === 'txt') {
        res.type('text/plain; charset=utf-8').setHeader('content-disposition', contentDisposition('modu2-' + set.id + '.txt'));
        return res.send('\uFEFF' + (await import('./services/exports.js')).exportTsv(set.cards));
      }
      if (req.query.format !== 'xlsx') return res.status(400).json({ error: '파일 형식을 지정해 주세요.' });
      const bytes = await exportXlsx(set.cards);
      return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .setHeader('content-disposition', contentDisposition('modu2-' + set.id + '.xlsx')).send(bytes);
    } catch (error) { return next(error); }
  });

  app.get('/api/learning-sets/:id', async (req, res, next) => {
    try {
      const set = await deps.repository.getCompleted(String(req.params.id));
      if (!set) return res.status(404).json({ error: '학습 콘텐츠를 찾을 수 없습니다.' });
      const user = await resolveUser(req, deps.repository, verifyToken);
      const { owner_id, ...publicSet } = set;
      return res.json({ ...publicSet, can_edit: Boolean(user && owner_id && user.id === owner_id), saved: Boolean(owner_id) });
    } catch (error) { return next(error); }
  });

  if (deps.enableTestRoutes && process.env.NODE_ENV === 'test') {
    app.post('/api/test/seed', async (_req, res, next) => {
      try {
        const created = await deps.repository.reserve({ requestId: newRequestId(), originalRequest: '와인', selectedTopic: '와인 기초 지식', learningGoal: '와인의 기본 개념을 이해한다' });
        const cards = Array.from({ length: 10 }, (_, i) => ({ key: '테스트 카드 ' + (i + 1), values: ['설명 ' + (i + 1)] }));
        const set = await deps.repository.complete(created.set.id, '와인 기초 지식', cards);
        return res.json({ id: set.id });
      } catch (error) { return next(error); }
    });
  }

  const clientDist = path.resolve(process.cwd(), 'public');
  app.use(express.static(clientDist));
  app.get('*path', (_req, res, next) => res.sendFile(path.join(clientDist, 'index.html'), error => { if (error) next(error); }));
  const errors: ErrorRequestHandler = (error, req, res, _next) => {
    const id = res.locals.requestId;
    const status = errorStatus(error);
    if (status && status >= 400 && status < 500) return res.status(status).json({ error: status === 413 ? "업로드 파일이 허용된 크기를 초과했습니다." : "요청 내용을 확인해 주세요.", request_id: id });
    if (status === 401) return res.status(401).json({ error: '로그인 세션이 만료되었습니다. 다시 로그인해 주세요.' });
    if (status === 404) return res.status(404).json({ error: '수정할 수 있는 콘텐츠를 찾을 수 없습니다.' });
    if (status === 409) return res.status(409).json({ error: '다른 변경 사항이 저장되었습니다. 새로고침 후 다시 시도해 주세요.' });
    if (error instanceof AiProviderError) {
      logMetric('api_error', { request_id: id, method: req.method, route: req.path, operation: error.operation,
        error_type: error.name, upstream_status: error.upstreamStatus, ...safeErrorDiagnostics(error) });
      const message = error.operation === 'suggestions' ? 'AI 주제 추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : error.operation === 'image_extraction' ? '사진을 읽지 못했습니다. 글자가 선명한 사진으로 다시 시도해 주세요.'
          : '학습 카드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.';
      return res.status(503).json({ error: message, request_id: id });
    }
    logMetric('api_error', { request_id: id, method: req.method, route: req.path, response_status: 500,
      error_type: error instanceof Error ? error.name : 'unknown', ...safeErrorDiagnostics(error) });
    res.status(500).json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', request_id: id });
  };
  app.use(errors);
  return app;
}
