# Gemini API 카테고리

Google AI Studio의 Gemini API 키 계정을 EXAONE과 같은 API 키 카테고리로 관리한다. 공식 문서: <https://ai.google.dev/gemini-api/docs>, OpenAI 호환 안내: <https://ai.google.dev/gemini-api/docs/openai>.

## 배경

- Google은 2026-06-18부터 개인·Google AI Pro/Ultra 계정의 Gemini CLI(`gemini`) 서비스를 중단하고 Antigravity CLI로 이전했다. Gemini CLI는 Code Assist 기업 라이선스 전용으로 남았다. 스위처의 Gemini CLI 도구 지원(`gemini.js`)은 그 뒤 비활성 상태이며, 개인 Google 로그인 전환은 Antigravity 카테고리가 담당한다.
- 따라서 "Gemini" 카테고리는 API 키 경로다. Google의 상태 없는 `gemini-api` CLI, OpenAI 호환 에이전트 CLI·스크립트·curl이 대상이다.

## 동작

- 구현은 `src/api-provider.js`의 공용 팩토리를 `src/gemini-api.js`가 설정으로 채운다(EXAONE도 같은 팩토리). `paths.PROVIDERS = ['exaone', 'gemini-api']`; `paths.TOOLS`에는 넣지 않으므로 셸 shim·고정 실행(`delegate`)·관리형 위임의 대상이 아니다.
- 상태는 `state.json`의 `"gemini-api": { active, profiles, labels?, checks? }`에 저장한다. 계정 홈 폴더는 만들지 않는다.
- 키는 `api-keys.js`가 `<ROOT>/api-keys/gemini-api/<계정>` 0600 파일로 저장한다. 키는 argv로 받지 않고(stdin·숨김 입력·앱 입력만), 출력·로그·`state.json`에 남기지 않는다. `AIza`로 시작하지 않으면 경고만 낸다.
- `run [계정] -- <명령...>`은 상속된 `GEMINI_*`·`GOOGLE_API_KEY`·`GOOGLE_GENAI_*`·`OPENAI_*` 변수를 제거한 뒤 선택한 계정의 키로 `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`(`https://generativelanguage.googleapis.com/v1beta/openai`)을 주입해 실행한다. 기본 모델 변수는 없다(모델명이 자주 바뀌므로 도구·스크립트가 지정).
- `check [계정]`은 `GET https://generativelanguage.googleapis.com/v1beta/models`(`x-goog-api-key` 헤더)로 키를 확인하고 `gemini*` 모델 이름(최대 20개)을 기록한다. 오류 문구는 고정 문자열이며 응답 본문은 저장하지 않는다.

## CLI

`gemini-api` 대신 별칭 `gemini`를 써도 된다.

```
cli-accounts gemini-api list [--json]
cli-accounts gemini-api add <name> [--with-api-key]
cli-accounts gemini apikey set <name>              # stdin 또는 숨김 입력
cli-accounts gemini apikey rm <name>
cli-accounts gemini use <name>                     # run에서 계정 생략 시 사용
cli-accounts gemini check [name]
cli-accounts gemini env [name]                     # 주입 변수 이름만 표시
cli-accounts gemini run [name] -- <command> [args...]
cli-accounts gemini rename <name> <new-name>
cli-accounts gemini rm <name>                      # 키 파일도 삭제
```

`cli-accounts list`·`list --json`(`tool: "gemini-api"`, `delegable: false`)·`apikey status`에 함께 나온다. `delegate gemini-api`는 거절한다.

## 패널

`Gemini API` 섹션: 계정 추가 → 키 입력, 행 클릭으로 활성 계정 전환, 메뉴에서 키 변경·제거, 연결 확인(모델 목록), 실행 명령 복사, 문서 열기, 이름 변경, 제거. 계정이 없으면 섹션을 패널에서 숨기고, 설정(톱니바퀴) 메뉴의 `Gemini API 계정 추가…`로 추가 양식을 엽니다. 취소하면 다시 숨겨집니다.

## 테스트

`test/gemini-api.js`: 격리된 상태 폴더, 가짜 키, 가짜 fetch만 사용한다. 네트워크·실제 키 없음.
