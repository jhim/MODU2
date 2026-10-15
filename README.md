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

## 학습 콘텐츠 관리 및 계정

2차 기능은 기존 학습 검색·AI 추천·10장 생성·학습 흐름을 유지하면서 공개 콘텐츠 목록과 본인 콘텐츠 관리를 추가합니다.

- 회원가입/로그인은 Supabase Auth 이메일·비밀번호를 사용합니다. 이메일 인증과 비밀번호 재설정 메일을 사용하므로 Supabase Auth의 Site URL 및 Redirect URLs에 로컬 주소와 Railway 도메인을 등록하세요.
- 기존 202610150001_init_modu2.sql은 다시 실행하지 마세요. 배포 전 MODU2 전용 Supabase SQL Editor에서 [202610150002_content_management.sql](supabase/migrations/202610150002_content_management.sql)을 검토 후 한 번만 적용해야 합니다. 운영 DB에는 여기서 적용하지 않았습니다.
- 증분 마이그레이션은 owner_id와 source_mode 컬럼, 목록 RPC, 사용자 소유 콘텐츠 생성·수정·삭제 RPC를 추가합니다. 기존 소유자 없는 COMPLETED 콘텐츠는 그대로 공개 읽기 전용으로 남습니다.
- anon/authenticated 직접 쓰기 권한은 부여하지 않습니다. 서버가 Supabase Auth JWT를 검증한 뒤, 검증된 사용자 ID와 콘텐츠 소유자를 RPC 안에서 함께 확인합니다. 수정은 행 잠금과 updated_at 버전 비교를 거쳐 카드 전체를 원자적으로 바꿉니다.
- 로그아웃 또는 비로그인 상태에서는 공개 콘텐츠를 검색·학습하고, AI 카드나 파일 추출 결과를 임시로 검토할 수 있습니다. 서버에는 저장되지 않으며, 영구 저장 시 로그인을 요구합니다.
- JPG/PNG/WebP 이미지는 최대 8MB, 30MP 이하이며, TXT는 UTF-8 최대 2MB, XLSX 업로드는 5MB·500행·16열 한도입니다. 이미지 원본은 저장하지 않습니다. XLSX 수식은 실행하지 않고 수식 셀을 포함한 파일은 거부합니다.
- TXT와 XLSX는 key_text, value_1 … value_6 표준 열을 사용합니다. 내보낸 파일을 다시 가져오면 카드 값과 순서를 복원합니다.

## 2차 운영 환경변수

Railway의 Build Variables와 Runtime Variables에 아래 설정을 분리해 입력하세요. 공개 VITE_ 값은 브라우저 빌드에 포함되지만, anon key는 공개 클라이언트 키입니다. service role과 OpenAI 비밀키는 서버 변수로만 둡니다.

| 변수 | 구분 | 설명 |
| --- | --- | --- |
| MODU2_MODE | 빌드/런타임 | production; mock/메모리 자동 전환 금지 |
| OPENAI_API_KEY | 런타임 비밀 | 서버에서 AI 추천·생성·이미지 인식에 사용 |
| OPENAI_MODEL | 런타임 | Structured Outputs와 이미지 입력을 지원하는 모델, 기본 gpt-4o-mini |
| SUPABASE_URL | 런타임 | MODU2 전용 Supabase URL |
| SUPABASE_SERVICE_ROLE_KEY | 런타임 비밀 | 서버 전용 데이터 접근 및 RPC 호출 |
| VITE_SUPABASE_URL | 빌드 공개 | 브라우저 Supabase Auth URL |
| VITE_SUPABASE_ANON_KEY | 빌드 공개 | 브라우저 로그인용 공개 anon key |

로컬 mock에서 Supabase 로그인·JWT 검증을 시험할 때는 .env에 SUPABASE_ANON_KEY도 설정합니다. 이는 공개 anon key이며 service role key로 대체하지 않습니다. mock 데이터는 메모리에만 남고 재시작하면 사라집니다. VITE_ 값이 없으면 프론트 로그인 UI가 비활성화됩니다.

## 파일 업로드 및 AI 보호

- AI 요청은 IP당 분당 최대 10회, 사진 인식은 분당 최대 3회로 제한합니다.
- 사진 원본 8MB 및 30MP 제한, XLSX 최대 5MB와 압축 해제 크기 제한, TXT 최대 2MB로 메모리·비용을 제한합니다.
- OpenAI 클라이언트는 30초 타임아웃과 1회 재시도를 사용합니다. 추천 응답은 최대 1,600 completion token, AI 카드 생성은 6,500, 사진 추출은 4,000으로 제한합니다. OpenAI 클라이언트는 요청당 30초 타임아웃과 최대 1회 재시도를 적용합니다. OpenAI 프로젝트의 월 사용량 한도와 알림도 설정하세요.
- 파일명, 카드 본문, 사진, API 키는 로그에 기록하지 않습니다. 사진 인식 결과에서 불확실한 카드는 검토 표시 후 사용자가 저장 전에 확인합니다.

### 편집 버전 복구

소유 콘텐츠를 수정할 때 기존 제목, 출처, 카드 전체가 `learning_set_revision`에 같은 DB 트랜잭션으로 저장됩니다. 이전 버전 확인과 복구는 MODU2 Supabase SQL Editor에서 다음처럼 할 수 있습니다.

```sql
select revision_id, saved_at, title
from public.learning_set_revision
where learning_set_id = '<콘텐츠 UUID>' and owner_id = '<소유자 UUID>'
order by saved_at desc;

select public.restore_owned_learning_set_revision(
  '<소유자 UUID>'::uuid,
  '<콘텐츠 UUID>'::uuid,
  '<복구할 revision_id>'::uuid,
  (select updated_at from public.learning_set where id = '<콘텐츠 UUID>'::uuid)
);
```

복구 함수도 소유자 확인, 행 잠금, 최신 `updated_at` 비교를 수행합니다. 공개 역할에는 스냅샷 테이블이나 복구 RPC 권한을 주지 않습니다.