# MODU2

MODU2는 React/Vite 학습 화면과 Express REST API를 하나의 Node.js 서비스로 제공하는 별도 앱입니다. `MODU2_MODE=mock`은 로컬 개발과 E2E 테스트용 AI 목업 및 메모리 저장소를 사용합니다. 운영 환경은 `MODU2_MODE=production`에서 OpenAI와 전용 Supabase 프로젝트를 사용하며, 필수 환경변수가 없으면 시작하지 않습니다.

## 로컬 개발

```powershell
npm ci
Copy-Item .env.example .env
npm run dev
```

`.env`의 `MODU2_MODE=mock`을 사용하세요. 서버는 기본적으로 `3000` 포트, Vite는 `5173` 포트에서 실행됩니다. Vite가 `/api` 요청을 로컬 API로 프록시합니다. 메모리 DB의 데이터는 서버가 재시작되면 사라집니다.

## 운영 환경변수

Railway 서비스의 Variables에서 설정합니다. Railway가 `PORT`를 주입하므로 포트를 직접 설정하지 마세요.

| 변수 | 값/용도 |
| --- | --- |
| `MODU2_MODE` | `production` |
| `NODE_ENV` | `production` 권장 |
| `OPENAI_API_KEY` | 서버 전용 비밀키 |
| `OPENAI_MODEL` | 선택사항, 기본값 `gpt-4o-mini` |
| `SUPABASE_URL` | 신규 MODU2 Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 비밀키 |
| `LOG_LEVEL` | 선택사항, 기본값 `info` |

`OPENAI_MODEL`은 Chat Completions와 JSON Schema Structured Outputs(`response_format: json_schema`)를 지원하는 모델이어야 합니다. 기본값은 `gpt-4o-mini`이며 앱은 별도의 temperature나 모델별 토큰 파라미터를 보내지 않습니다. OpenAI 오류는 요청 ID, 상태 및 오류 코드만 서버 로그에 남기고 사용자에게는 재시도 안내를 반환합니다. Railway 운영 모드에서는 ingress 프록시 한 홉만 신뢰해 IP별 rate limit을 적용하며 로컬/mock 모드는 forwarded IP를 신뢰하지 않습니다.

`OPENAI_API_KEY` 및 `SUPABASE_SERVICE_ROLE_KEY`는 Railway Variables에만 입력하세요. 브라우저 코드에서는 이 키들을 읽지 않으며, `VITE_` 접두사로 설정하지 마세요. `.env`와 `.env.*`는 Git에서 제외되고 `.env.example`만 포함됩니다.

Supabase 마이그레이션은 자동 실행되지 않으며 Railway의 pre-deploy command도 설정하지 않았습니다. 신규 MODU2 DB에 마이그레이션이 이미 적용되었는지 확인하고, 배포 과정에서 SQL을 재실행하지 마세요.

## Railway 구성

Railway Infrastructure as Code 설정은 [.railway/railway.ts](.railway/railway.ts)에 있습니다. 이 서비스는 저장소 루트에서 `npm ci --include=dev && npm run build && npm prune --omit=dev`로 빌드하고 `npm start`로 실행합니다. 빌드 후 테스트·빌드 도구를 운영 의존성 트리에서 제거합니다. `GET /api/health`가 healthcheck 경로입니다. 서버는 Railway의 `PORT`를 사용해 `0.0.0.0`에서 수신합니다.

React 앱과 API는 같은 Express 서비스에서 제공되며 브라우저는 `/api/...` 상대 경로를 호출합니다. 따라서 배포 도메인과 API 간 별도 CORS 설정이 필요하지 않습니다. 로컬 개발에서는 Vite proxy가 `/api`를 서버로 전달합니다.

새 Railway 프로젝트에서 MODU2 GitHub 저장소를 소스로 연결하고, 루트 디렉터리는 `/`, 서비스 이름은 `modu2-web`로 설정하세요. Railway CLI가 설치된 환경에서 프로젝트를 연결한 뒤 아래 순서로 설정 변경을 검토하고 적용할 수 있습니다.

```bash
railway login
railway link
railway config plan
railway config apply
```

`railway config apply`는 Railway 설정을 실제로 변경합니다. 여기서는 실행하지 않았습니다. Railway가 제공하는 public domain을 활성화하면 앱과 API를 같은 도메인에서 사용할 수 있습니다.

## GitHub 업로드

아래 명령은 새 MODU2 전용 GitHub 저장소를 만든 다음 프로젝트 루트에서 실행합니다. `<OWNER>`와 `<MODU2_REPO>`를 실제 저장소 정보로 바꾸세요.

```bash
git init -b main
git add .
git status --short
git commit -m "Prepare MODU2 for Railway"
git remote add origin https://github.com/<OWNER>/<MODU2_REPO>.git
git push -u origin main
```

`git status --short`에서 `.env`나 키 파일이 보이면 업로드 전에 제외하세요. 이 문서의 명령을 실행하거나 GitHub에 Push하지 않았습니다.

## API

- `GET /api/health` — Railway healthcheck
- `GET /api/learning-sets/search?q=...` — 완료된 콘텐츠 검색, 최대 5개
- `POST /api/ai/suggestions` — 학습 방향 추천 또는 재추천
- `POST /api/learning-sets` — idempotency key 기반 생성, Flashcard 10개 저장
- `GET /api/learning-sets/:id` — 완료 콘텐츠와 정렬된 카드 조회

## 검증

```bash
npm run build
npm test
npm run test:e2e
```

`npm test`는 Vitest 단위 테스트와 API 통합 테스트를 실행합니다. E2E는 Playwright Chromium, `MODU2_MODE=mock`, 메모리 저장소를 사용합니다. 최초 실행 시 브라우저가 필요하면 `npx playwright install chromium`으로 설치하세요.
