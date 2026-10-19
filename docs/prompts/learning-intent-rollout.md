# 학습 목적에 따른 Key/Value 생성 개선 (로컬 검토본)

## 확인한 원인

- FLASHCARD 코드 fallback 및 004 초기 seed는 짧은 키워드를 기본으로 요구하고 질문형 허용을 명시적 퀴즈 요청으로 제한했다.
- RECOMMEND와 FLASHCARD 모두 10장을 전제로 한다. 응답 Zod의 cards.length(10), complete_learning_set RPC의 개수·중복·sort_order 검증도 10장 고정이다.
- 재추천 성공 시 입력창의 refinement_request를 지운 뒤 카드 생성 요청에는 보내지 않았다. 추천 제목/학습 목표에 조건이 빠지면 복원이 불가능했다.
- DB ACTIVE가 있으면 코드 fallback보다 우선한다. fallback만 수정하거나 Railway만 배포해도 기존 ACTIVE 본문은 바뀌지 않는다.
- 현재 운영 DB ACTIVE 본문은 이번 로컬 작업에서 조회하지 않았다. 004 seed와 코드 비교는 현재 DB 버전의 실측을 대신하지 않는다.

## 구현 범위와 호환성

Key는 학습하거나 답해야 할 대상, Value는 대응하는 정답·뜻·번역·설명으로 정의한다. 고정된 콘텐츠 타입/분류 테이블 없이 모델이 사용자의 목적과 명시적 형식을 판단한다. 넌센스는 완전한 문제와 자연스러운 말장난 정답, 문장/회화는 원문과 번역, 문법은 빈칸과 정답 등을 허용한다. 한자 글자·단어 암기의 정답 노출 방지와 비교 대상 집합 유지도 보존한다.

생성 API 입력에 선택 필드 refinement_request(최대 200자)를 추가했다. 기존 요청은 그대로 유효하고 응답 JSON 구조는 동일하다. original_request는 최초 검색어 그대로 저장한다. DB 구조/저장 RPC/로그인 정책은 수정하지 않았다. 관리자 미리보기와 실제 요청은 동일한 빌더를 쓴다. 기존 FLASHCARD 템플릿의 필수 변수는 바뀌지 않는다. 새 선택 변수 {{refinement_request_json}}가 없는 이전 템플릿도 추가 조건을 안전하게 JSON 직렬화하여 User 메시지 뒤에 붙인다.

기존 key 최대 120 코드포인트, values 1~6개 및 각 500 코드포인트 제한은 유지한다. 의미상 무조건 짧게 쓰라는 제한을 제거했으며 기존 기술적 크기 제한을 없앤 것은 아니다.

## 20/30장 요구: 이번 변경으로 지원되지 않음

DB 및 응답 스키마 보존 조건을 우선하여 생성·저장 10장 계약을 유지했다. 테스트의 20/30개 원문은 전달 여부만 검증한다. 20/30장 생성 성공을 검증했다고 해석하면 안 된다. 추천 프롬프트에는 현재 한계를 message에서 알리며 더 많은 개수를 약속하지 않도록 명시했다. AI가 안내 문구를 항상 지킬지는 실제 모델 평가가 필요하다.

가변 개수 지원에 필요한 최소 후속 변경안 (구현/SQL 작성 안 함):

1. 입력에서 요청 개수를 확정/검증하고 상한(예: 1~30)을 정한다. 모호한 개수·복수 수량 해석과 사용자 확인 정책을 정한다.
2. 생성 응답 검증의 고정 길이 대신 요청 개수와 실제 개수 일치를 검증한다. 응답 필드 이름은 유지할 수 있지만 길이 제약 계약은 변경된다.
3. 별도 증분 마이그레이션으로 AI 저장 RPC의 10장, 고유 key 수, sort_order 1~10 검증을 요청 개수 기준으로 바꾼다. 과거 001~004를 다시 적용하지 않는다.
4. 카드 생성 토큰 예산·비용 상한·타임아웃, 클라이언트 10장 문구, Mock 및 회귀/E2E도 함께 조정한다.
5. 기존 10장 데이터는 수정/재생성하지 않는다.

## 프롬프트 버전 적용 준비

learning-intent-drafts.json의 RECOMMEND/FLASHCARD 본문은 코드 fallback과 같은 내용이다. 운영 DB의 새 버전은 아직 생성하지 않았다. Mock 관리자 테스트의 초안·활성화·복원은 메모리에서만 수행한다.

승인 후 순서:

1. 관리자 계정으로 현재 ACTIVE 버전의 ID/번호/전체 본문을 읽어 보관하고 초안을 복제한다. 현재 운영 버전이 seed에서 달라졌다면 변경을 비교하여 필요한 운영 규칙을 보존한다.
2. 코드 변경을 승인·배포한 다음, 각 초안에 JSON의 system_prompt/developer_prompt/user_template/change_note를 저장한다. 새 선택 변수는 이전 서버에서는 검증 거절되므로 신규 템플릿 활성화 전에 서버 배포가 필요하다.
3. 관리자 미리보기에서 여덟 예제의 원본 요청·추가 조건을 대조한다. 일반 사용자 API에 프롬프트를 반환하지 않는다.
4. 사용자 승인 후 expected_active_version_id로 동시 변경을 검사하며 새 버전을 활성화한다. 기존 ACTIVE 본문 직접 수정·이력 삭제는 하지 않는다.
5. 필요 시 이전 버전 내용으로 새 DRAFT를 복원하고 검토·활성화한다. 코드 롤백 전에 이전 템플릿(새 선택 변수 없는 버전)으로 되돌리면 구형 서버와 호환된다.

## 검증 한계

Mock fixture 및 가짜 OpenAI 전송 응답은 요청 원문·조건 전달, 형식, 응답 스키마, usage, 관리자 미리보기, 저장 및 비공개 프롬프트 보호를 검증한다. 실제 AI의 정확성·재치·중복 여부·난이도 준수는 보장하지 않는다. 운영 데이터/프롬프트 버전/SQL을 변경하지 않으며 실제 OpenAI 호출, Push, 배포는 하지 않는다.

공식 참고: https://developers.openai.com/api/docs/guides/prompt-engineering

## 로컬 검증 결과

- npm run build: PASS (서버/클라이언트 TypeScript 포함).
- npm test: 21개 파일, 97개 테스트 PASS. 최초 추가 테스트의 저장소 조회 메서드 오기(get -> getCompleted)를 수정한 후 전체 재검증했다.
- npm run test:e2e: 기존/일반 사용자 그룹 7개 + Mock Auth 관리자 그룹 2개, 합계 9개 PASS. 1365px/390px에서 여덟 요청의 원문·추가 조건·앞뒷면 표시를 검사했다.
- git diff --check: PASS. E2E의 Auth 포함 번들에 기존 500KB 초과 경고가 있으나 빌드는 성공했다.
- 실운영 ACTIVE 본문 비교/운영 DRAFT 생성/실제 모델 품질 검증: SKIP. 로컬 초안 JSON만 준비했다.
- 20/30장 생성·저장: 미구현. 별도 계약/증분 RPC 변경 승인 후 작업해야 한다.

## 변경 파일 목록

- server/src/prompts/index.ts: 목적 기반 생성 규칙, 추천 조건 보존, fallback 및 새 User 템플릿.
- server/src/prompts/templates.ts: 선택 추가 조건 변수와 구형 템플릿 문맥 보완.
- shared/schemas/index.ts: 생성 요청의 선택 refinement_request 입력. 응답 스키마 변경 없음.
- client/src/pages/App.tsx: 재추천에 사용한 조건을 카드 생성 요청으로 전달.
- server/src/app.ts: 관리자 카드 미리보기의 추가 조건 전달.
- client/src/components/PromptAdminPage.tsx: 카드 미리보기 추가 조건 입력 및 선택 변수 안내.
- server/src/services/mock-flashcards.ts: 테스트용 형식별 예제와 추가 조건 반영.
- tests/unit/ai-prompts.test.ts: 새 형식 규칙 회귀 검증.
- tests/unit/flashcard-generation.test.ts: 확장된 User 메시지 검증.
- tests/unit/learning-intent.test.ts: 여덟 입력, 모의 전송, usage, 구형 템플릿, 초안 동기화 및 기존 10장 경계.
- tests/api/learning-intent.test.ts: 요청 문맥/관리자 미리보기/비공개 프롬프트/기존 데이터 보존.
- tests/e2e/learning-flow.spec.ts: 재추천 조건의 생성 요청 전달 회귀 검증.
- tests/e2e/learning-intent.spec.ts: PC/모바일 여덟 요청의 브라우저 흐름 검증.
- docs/prompts/learning-intent-drafts.json: 새 관리자 초안으로 저장할 본문 두 개.
- docs/prompts/learning-intent-rollout.md: 원인, 한계, 최소 후속 변경안, 적용/복구 순서 및 검증 결과.

## 운영 적용 승인 후 보완

사용자가 10장 호환 유지와 운영 배포·새 프롬프트 활성화를 승인했다. 홈 및 추천 화면에 20장·30장 요청도 현재는 10장으로 생성·저장된다는 고정 안내를 추가했다. 안내는 모델 응답에 의존하지 않으며 PC/모바일 E2E에서 확인한다.
