import path from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { ZodError } from 'zod';
import { CreateSetRequestSchema, SearchQuerySchema, SuggestionRequestSchema, type CreateSetRequest } from '../../shared/schemas/index.js';
import { AiProviderError, type AiService } from './services/ai.js';
import type { LearningRepository } from './repositories/types.js';
import { logMetric, requestId as newRequestId } from './lib/metrics.js';

export function getTrustProxySetting(env: NodeJS.ProcessEnv = process.env): number | false {
  const isRailwayProduction = env.MODU2_MODE === 'production'
    && Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT);
  return isRailwayProduction ? 1 : false;
}

export function createApp(deps: { ai: AiService; repository: LearningRepository; enableTestRoutes?: boolean }) {
  const app = express();
  app.disable('x-powered-by');
  // Trust only Railway's single ingress hop; local/mock runs do not trust forwarded headers.
  app.set('trust proxy', getTrustProxySetting());
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    const id = newRequestId(); const started = performance.now();
    res.setHeader('x-request-id', id);
    res.on('finish', () => logMetric('api_request', { request_id: id, method: req.method, route: req.path, status: res.statusCode,
      duration_ms: Math.round(performance.now() - started) }));
    res.locals.requestId = id;
    next();
  });
  const aiLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/learning-sets/search', async (req, res, next) => {
    try {
      const parsed = SearchQuerySchema.safeParse(req.query.q);
      if (!parsed.success) return res.status(400).json({ error: '검색어는 1~100자여야 합니다.' });
      const started = performance.now();
      const results = await deps.repository.search(parsed.data, 5);
      logMetric('db_query', { request_id: res.locals.requestId, kind: 'search', duration_ms: Math.round(performance.now() - started) });
      return res.json({ results: results.map(({ id, title, original_request, created_at }) => ({ id, title, original_request, created_at })) });
    } catch (error) { return next(error); }
  });
  app.post('/api/ai/suggestions', aiLimiter, async (req, res, next) => {
    try {
      const parsed = SuggestionRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '학습 요청을 확인해 주세요.' });
      const result = await deps.ai.suggest(parsed.data, res.locals.requestId);
      return res.json(result);
    } catch (error) { return next(error); }
  });
  app.post('/api/learning-sets', aiLimiter, async (req, res, next) => {
    try {
      const parsed = CreateSetRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: '학습 주제와 요청 정보를 확인해 주세요.' });
      const input: CreateSetRequest = parsed.data;
      const reserveStarted = performance.now();
      const reservation = await deps.repository.reserve({ requestId: input.client_request_id, originalRequest: input.original_request,
        selectedTopic: input.selected_topic, learningGoal: input.learning_goal });
      logMetric('db_reserve', { request_id: res.locals.requestId, duration_ms: Math.round(performance.now() - reserveStarted) });
      if (!reservation.created) {
        if (reservation.set.status === 'COMPLETED') {
          const existing = await deps.repository.getCompleted(reservation.set.id);
          if (existing) return res.json(existing);
        }
        return res.status(409).json({ error: reservation.set.status === 'FAILED' ? '이전 생성이 실패했습니다. 새 요청으로 다시 시도해 주세요.' : '같은 요청을 처리하고 있습니다.' });
      }
      try {
        let generated;
        let validationTime = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
          let candidate;
          try { candidate = await deps.ai.generate(input, res.locals.requestId); }
          catch (error) {
            if (error instanceof ZodError && attempt === 0) {
              logMetric('generation_retry', { request_id: res.locals.requestId, attempt: attempt + 1 });
              continue;
            }
            throw error;
          }
          const validationStarted = performance.now();
          const validation = await import('../../shared/schemas/index.js').then(({ GeneratedSetSchema }) => GeneratedSetSchema.safeParse(candidate));
          validationTime += performance.now() - validationStarted;
          if (validation.success) { generated = validation.data; break; }
          logMetric('generation_retry', { request_id: res.locals.requestId, attempt: attempt + 1 });
        }
        if (!generated) throw new AiProviderError('flashcard_generation');
        logMetric('json_validation', { request_id: res.locals.requestId, duration_ms: Math.round(validationTime) });
        const dbStarted = performance.now();
        const completed = await deps.repository.complete(reservation.set.id, generated.title, generated.cards);
        logMetric('db_write', { request_id: res.locals.requestId, duration_ms: Math.round(performance.now() - dbStarted) });
        return res.status(201).json(completed);
      } catch (error) {
        await deps.repository.fail(reservation.set.id).catch(() => undefined);
        throw error;
      }
    } catch (error) { return next(error); }
  });
  app.get('/api/learning-sets/:id', async (req, res, next) => {
    try {
      const started = performance.now();
      const set = await deps.repository.getCompleted(req.params.id);
      logMetric('db_query', { request_id: res.locals.requestId, kind: 'get_set', duration_ms: Math.round(performance.now() - started) });
      if (!set) return res.status(404).json({ error: '학습 콘텐츠를 찾을 수 없습니다.' });
      return res.json(set);
    } catch (error) { return next(error); }
  });

  if (deps.enableTestRoutes && process.env.NODE_ENV === 'test') {
    app.post('/api/test/seed', async (_req, res, next) => {
      try {
        const created = await deps.repository.reserve({ requestId: newRequestId(), originalRequest: '와인', selectedTopic: '와인 기초 지식', learningGoal: '와인의 기본 개념을 이해한다' });
        const cards = Array.from({ length: 10 }, (_, i) => ({ key: `테스트 카드 ${i + 1}`, values: [`설명 ${i + 1}`] }));
        const set = await deps.repository.complete(created.set.id, '와인 기초 지식', cards);
        return res.json({ id: set.id });
      } catch (error) { return next(error); }
    });
  }

  // Railway serves the compiled SPA and API from one Node process.
  const clientDist = path.resolve(process.cwd(), 'dist/client');
  app.use(express.static(clientDist));
  app.get('*path', (_req, res, next) => {
    res.sendFile(path.join(clientDist, 'index.html'), error => { if (error) next(error); });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const id = res.locals.requestId;
    if (error instanceof AiProviderError) {
      logMetric('api_error', { request_id: id, error_type: error.name, upstream_status: error.upstreamStatus });
      const message = error.operation === 'suggestions'
        ? 'AI 주제 추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'
        : '학습 카드 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.';
      return res.status(503).json({ error: message, request_id: id });
    }
    logMetric('api_error', { request_id: id, error_type: error instanceof Error ? error.name : 'unknown' });
    res.status(500).json({ error: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', request_id: id });
  };
  app.use(errors);
  return app;
}
