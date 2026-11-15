# EXAONE API 카테고리

LG AI연구원 EXAONE API Platform(K-EXAONE 2.5)용 API 키 계정을 Claude·Codex와 같은 급의 카테고리로 관리한다. 공식 문서: <https://docs.exaone.ai/ko/docs/k-exaone-2.5>, Agent 연결 안내: <https://docs.exaone.ai/ko/docs/agent-start>.

## 모델

- EXAONE은 OpenAI 호환 `POST https://api.exaone.ai/v1/chat/completions`만 제공한다. 격리할 CLI 홈이 없으므로 `paths.TOOLS`에 넣지 않고, Antigravity처럼 별도 카테고리(`paths.PROVIDERS = ['exaone']`)로 둔다. 셸 shim·고정 실행(`delegate`)·관리형 작업 위임의 대상이 아니다.
- 상태는 `state.json`의 `exaone: { active, profiles, labels?, checks? }`에 저장한다. 계정 홈 폴더는 만들지 않는다.
- 키는 `api-keys.js`가 `<ROOT>/api-keys/exaone/<계정>` 0600 파일로 저장한다. 키는 argv로 받지 않고(stdin·숨김 입력·앱 입력만), 출력·로그·`state.json`에 남기지 않는다.
- `exaone run [계정] -- <명령...>`은 상속된 `EXAONE_*`·`OPENAI_*` 변수를 제거한 뒤 선택한 계정의 키로 `EXAONE_API_KEY`, `EXAONE_BASE_URL`, `EXAONE_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`을 주입해 명령을 실행한다. OpenAI 호환 에이전트 CLI(예: Hermes, OpenCode), 스크립트, curl이 대상이다. Codex CLI는 2026-02부터 chat/completions를 지원하지 않아 대상이 아니다.
- `exaone check [계정]`은 `GET /v1/models`로 키를 확인하고 모델 목록과 Rate limit 헤더(`x-{second,minute,day}-rate-limit[-remaining]`)를 기록한다. 오류 문구는 고정 문자열이며 응답 본문은 저장하지 않는다.

## CLI

```
cli-accounts exaone list [--json]
cli-accounts exaone add <name> [--with-api-key]
cli-accounts exaone apikey set <name>          # stdin 또는 숨김 입력
cli-accounts exaone apikey rm <name>
cli-accounts exaone use <name>                 # run에서 계정 생략 시 사용
cli-accounts exaone check [name]
cli-accounts exaone env [name]                 # 주입 변수 이름만 표시
cli-accounts exaone run [name] -- <command> [args...]
cli-accounts exaone rename <name> <new-name>
cli-accounts exaone rm <name>                  # 키 파일도 삭제
```

`cli-accounts list`는 `exaone:` 섹션을 함께 보여 주고, `list --json`의 `accounts`에는 `{ tool: "exaone", profileId, active, apiKey, delegable: false, baseUrl, model }` 행이 포함된다. `add exaone <name>`, `apikey set exaone <name>`, `run exaone --profile <name> -- ...` 형태도 같은 동작으로 연결된다.

## 앱

패널의 "EXAONE API" 섹션에서 계정 추가 → API 키 입력, 행 클릭으로 활성 전환, 더 보기 메뉴에서 키 변경·제거, 연결 확인, 실행 명령 복사, 문서 열기, 이름 변경, 제거를 제공한다. 키 값은 메인 프로세스로만 전달되고 렌더러 상태에는 마스킹된 끝 4자만 남는다. 계정이 하나도 없으면 섹션을 숨기고 설정 메뉴의 `EXAONE API 계정 추가…`로 추가 양식을 연다.

## 검증

`node test/exaone.js`: 상태 분리, 키 파일 권한·마스킹, 환경 주입(상속 변수 제거, 계정별 키), 연결 확인 파싱(모델·Rate limit·고정 오류 문구·키 비노출), 실행 종료 코드 전달, 소스·설치 lib 양쪽의 콘솔 CLI 경로(add/apikey/list/env/run/rm, 위임·로그인 거절)를 가짜 키와 가짜 fetch로 확인한다. 실제 네트워크·실제 키는 사용하지 않는다.
