<div align="center">

# CLI Account Switch

[English](README.md) | **한국어**

**Claude Code와 Codex CLI의 계정을 한곳에서 관리하세요.**

로컬 프로필 전환 · CLI 실행 · 사용량 확인 · 작업 관리

![Preview](https://img.shields.io/badge/status-preview-orange)
![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[시작하기](#시작하기) · [주요 기능](#주요-기능) · [동작 원리](#동작-원리) · [개발 및 빌드](#개발-및-빌드)

</div>

---

CLI Account Switch는 Claude Code와 Codex CLI의 여러 로컬 계정 프로필을 관리하는 Electron 데스크톱 앱입니다. 프로필마다 설정 홈을 분리하고, 선택한 프로필로 공식 CLI를 실행합니다. 로그인과 모델 요청은 사용자가 설치한 공식 CLI가 처리합니다.

> **Preview** — 현재 버전은 `0.2.0-preview.8`입니다. 서명·공증된 설치 파일은 아직 제공하지 않습니다. Windows 빌드 설정은 포함되어 있으나 Windows에서 관리형 작업 실행은 지원하지 않습니다. [릴리스 노트](docs/releases/v0.2.0-preview.8.md).

## 화면 미리보기

아래 데스크톱 화면 3장은 실제 앱의 화면 코드에 데모 데이터를 넣어 촬영했습니다. 계정명·사용량·모델 목록·작업 상태·터미널 출력은 예시이며, 실제 계정이나 실행 결과가 아닙니다.

### 계정 프로필

Claude Code와 Codex의 프로필을 선택하고 로컬 사용량 기록을 확인합니다.

<img src="docs/images/account-profiles.png" alt="Claude Code와 Codex 계정 프로필 선택 화면 — 데모 데이터" width="460">

### 새 작업과 모델 선택

프로젝트 폴더, 작업을 총괄할 담당과 모델, 함께 작업할 계정을 설정합니다.

![새 작업 설정과 계정별 모델 선택 — 데모 데이터](docs/images/model-dropdowns.png)

### 작업 상태와 터미널 출력

위임한 작업의 상태와 읽기 전용 터미널 출력을 한 화면에서 확인합니다.

![작업 상태와 터미널 출력 — 데모 데이터](docs/images/terminal-desktop.png)

### Scriptable 위젯 디자인 미리보기

계정별 사용량과 기록 시각을 표시하는 위젯의 참고 화면입니다. **macOS에서 생성한 레이아웃 미리보기이며 실제 iPhone 캡처가 아닙니다.** 표시된 값은 현재 사용량을 의미하지 않습니다. 이 저장소에는 위젯 코드와 연결 서버가 포함되어 있지 않습니다.

<img src="docs/images/scriptable-widget-preview.png" alt="Scriptable 사용량 위젯의 레이아웃 미리보기 — 실제 iPhone 캡처 아님" width="660">

## 주요 기능

| 기능 | 설명 |
| --- | --- |
| **계정 프로필 관리** | Claude Code와 Codex의 프로필을 각각 추가하고 선택합니다. |
| **프로필별 CLI 실행** | 선택한 프로필의 설정 홈으로 새 CLI 세션을 실행합니다. |
| **스킬·지침 공통 관리** | 기본 홈의 스킬·지침·설정을 새 프로필에 연결해 계정마다 중복 관리하지 않습니다. |
| **저장된 메모리 공유** | Codex 기본 홈의 `memories` 폴더가 있으면 새 프로필에 연결합니다. 대화 세션 자체를 이전하지는 않습니다. |
| **로컬 사용량 확인** | Claude status-line 기록과 Codex 세션 기록에서 사용량을 읽습니다. |
| **작업 관리** | 작업 진행, 검토 및 결과 전달 상태를 확인합니다. |
| **작업 맥락 저장·세션 재개** | 목표·결과·검토·세션 ID를 저장하고, 다음 총괄 턴에서 같은 CLI 세션을 재개합니다. |
| **웹 대시보드** | 로컬 브라우저에서 작업 제출·상태 확인·응답·중단과 터미널 출력 조회를 제공합니다. |
| **모델 선택** | 작업 조정과 위임 작업에 사용할 모델을 계정별로 선택합니다. |
| **터미널 출력 확인** | 주기적으로 갱신되는 작업 출력을 읽기 전용으로 확인합니다. |
| **프로젝트 폴더 선택** | 앱의 폴더 선택 창 또는 웹 대시보드의 서버 측 폴더 탐색을 사용합니다. |
| **OpenClaw 연동** | 선택적으로 플러그인을 설치해 현재 대화와 작업 흐름을 연결합니다. |

## 시작하기

### 준비 사항

- Node.js **24 이상**, npm, Git
- 사용하려는 공식 CLI: Claude Code(`claude`), Codex(`codex`)
- 각 서비스에 접근할 수 있는 사용자 계정
- Electron 앱을 실행할 수 있는 데스크톱 환경

공식 CLI는 별도로 설치해야 합니다. 이 앱은 서비스 계정이나 구독 권한을 제공하지 않습니다.

### 소스에서 실행

```sh
git clone https://github.com/HoonStyle/cli-account-switcher.git
cd cli-account-switcher
npm ci
npm start
```

빌드된 프리뷰 설치 파일은 [GitHub Releases](https://github.com/HoonStyle/cli-account-switcher/releases)에서 받을 수 있습니다.

### 첫 실행

1. 메뉴 바 또는 트레이에서 앱을 엽니다. 앱은 기본적으로 숨겨진 상태로 시작합니다.
2. 사용할 CLI의 프로필을 추가합니다.
3. 해당 프로필에서 공식 CLI의 로그인 절차를 진행합니다.
4. 프로필을 선택한 뒤 새 CLI 세션이나 작업을 실행합니다.
5. 사용량 표시가 필요하면 로컬 사용량 수집 기능을 설정합니다.

> 계정 전환은 **새로 실행하는 세션부터** 적용됩니다. 기존 터미널 세션이나 별도의 인증 저장소를 사용하는 다른 앱의 계정은 자동으로 변경되지 않습니다.

## 동작 원리

```text
CLI Account Switch
  ├─ Claude 프로필 → CLAUDE_CONFIG_DIR → 공식 Claude Code CLI
  └─ Codex 프로필  → CODEX_HOME        → 공식 Codex CLI
                                           └─ 해당 서비스와 직접 통신
```

| CLI | 프로필별 설정 홈 | 실행 환경변수 |
| --- | --- | --- |
| Claude Code | `~/.cli-accounts-distribution/claude/<profile>/` | `CLAUDE_CONFIG_DIR` |
| Codex | `~/.cli-accounts-distribution/codex/<profile>/` | `CODEX_HOME` |

새 프로필은 자체 로컬 디렉터리와 공식 로그인 절차를 사용합니다. 다른 계정의 자격증명을 복사해 로그인하지 않습니다.

### 기본 프로필과 데이터

`default` 프로필은 공식 CLI의 기존 기본 홈인 `~/.claude` 또는 `~/.codex`를 사용하며, 설정 홈 환경변수를 별도로 지정하지 않습니다. 따라서 CLI를 직접 사용할 때의 기본 로그인 및 status-line 설정을 공유합니다.

앱 데이터는 기본적으로 `~/.cli-accounts-distribution`에 저장됩니다. `CLI_ACCOUNTS_ROOT`로 경로를 변경할 수 있지만, 다른 도구의 데이터 디렉터리와 혼용하지 마십시오. 사용량 수집 훅을 중복 설정하지 않고, PATH에서 사용할 CLI 래퍼도 명확하게 선택해야 합니다.

## 스킬·지침·메모리 공유

계정별 로그인은 분리하면서 스킬과 작업 지침은 공통으로 사용할 수 있습니다. 새 프로필을 추가할 때 공식 CLI 기본 홈에 있는 다음 항목을 프로필 폴더에 연결합니다.

| CLI | 공유 원본 | 연결하는 항목 |
| --- | --- | --- |
| Claude Code | `~/.claude/` | `settings.json`, `CLAUDE.md`, `plugins`, `skills`, `agents`, `commands`, `hooks`, `rules` |
| Codex | `~/.codex/` | `config.toml`, `AGENTS.md`, `skills`, `plugins`, `rules`, `memories` |

예를 들어 `~/.codex/skills`를 연결한 프로필들은 같은 스킬 폴더를 참조합니다. 링크된 파일이나 폴더를 수정하면 같은 원본을 참조하는 다른 프로필에도 영향을 줍니다. 별도 스킬 저장소로 옮기는 기능이 아니라, **CLI 기본 홈을 공통 관리 위치로 사용하는 방식**입니다.

### 저장된 맥락과 대화 세션의 차이

`CLAUDE.md`·`AGENTS.md` 같은 작업 지침과 Codex의 `memories` 폴더는 공유 대상입니다. 다만 앱이 대화를 요약해 메모리를 작성하는 것은 아닙니다. `memories`의 생성·사용 여부는 해당 CLI의 동작에 따릅니다.

대화 기록과 실행 중인 세션은 공유 목록에 포함되지 않습니다. 따라서 **계정 전환만으로 이전 대화 전체나 실행 중인 작업 맥락이 자동 복원되지는 않습니다.**

### 적용 조건

- 앱에서 새 프로필을 추가하면 설정 공유가 기본 적용됩니다.
- 생성 시점에 원본이 있는 항목만 연결하며, 프로필에 이미 존재하는 항목은 덮어쓰지 않습니다.
- 기본적으로 심볼릭 링크를 사용합니다. Windows 디렉터리는 junction을 사용하며, 파일 링크에 실패하면 일회성 복사로 대체합니다. 복사된 파일은 이후 자동 동기화되지 않습니다.
- 원본을 나중에 추가해도 기존 프로필에 새 링크가 자동 생성되지는 않습니다.
- 공유 없이 프로필을 만들려면 앱이 설치한 `cli-accounts` 명령에서 `--no-share`를 사용합니다.

```sh
cli-accounts add codex isolated --no-share
```

## 작업 맥락 저장과 세션 재개

관리형 작업은 목표, 프로젝트 경로, 기준 커밋, 참여 계정, 실행 시도, 위임 결과, 검토 상태 및 총괄 세션 ID를 로컬 SQLite에 저장합니다. 기본 위치는 `~/.cli-accounts-distribution/runtime/tasks.sqlite`입니다. 실행별 프롬프트와 결과 등은 같은 런타임 디렉터리의 실행 기록에 보관됩니다.

총괄 에이전트의 후속 턴에서는 Claude의 `--resume` 또는 Codex의 `exec resume`으로 같은 세션을 이어갑니다. 위임 작업의 결과·검토 상태·사용자 추가 입력도 후속 프롬프트에 전달합니다. OpenClaw 연동에서는 연결된 대화의 식별자를 사용합니다.

이는 **관리형 작업의 맥락 유지**입니다. 일반 터미널의 모든 대화를 수집하거나, 다른 계정으로 세션을 자동 이전하는 기능은 아닙니다. 서비스 재시작 시 저장된 실행 상태와 결과를 대조하며, 실행 여부가 불확실하면 무조건 재실행하지 않고 확인이 필요한 상태로 남깁니다. 원래 CLI 세션과 프로필 데이터도 유지되어야 합니다.

작업 기록에는 프롬프트·프로젝트 경로·출력이 포함될 수 있으므로 런타임 디렉터리를 공개 저장소에 올리지 마십시오.

### 실행 정책과 복구

`executionPolicy`의 기본값은 `edit-only`입니다. 쓰기 가능한 Claude 작업에서 `build-test`를 명시하면 macOS에서 제한된 빌드·테스트 명령을 실행할 수 있습니다. 지원되는 샌드박스 옵션이 있는 Claude Code 2.1.290 이상과 해당 SDK가 필요하며, 업데이트만으로 기존 작업의 권한이 확대되지는 않습니다.

실행 전 준비 단계에서 중단된 작업은 재시도·라운드 한도 안에서 재개할 수 있습니다. 후속 위임에는 이전 작업 공간의 파일을 결과 버전과 함께 명시적으로 전달할 수 있으며, 원본 프로젝트에 자동 병합하지 않습니다.

## 웹 대시보드

앱과 같은 작업 관리 화면을 로컬 브라우저에서도 사용할 수 있습니다. 소스 디렉터리에서 실행합니다.

```sh
node src/cli.js dashboard
# 브라우저에서 http://127.0.0.1:18473 열기
```

앱이 설치한 `cli-accounts` 명령이 PATH에 있다면 다음 명령도 사용할 수 있습니다.

```sh
cli-accounts dashboard
cli-accounts dashboard --port 18474
```

- 프로젝트 폴더·담당 계정·모델을 선택하고 작업을 제출합니다.
- 작업 상태, 위임 결과, 검토 상태와 읽기 전용 터미널 출력을 확인합니다.
- 필요한 추가 답변을 보내거나 확인 절차를 거쳐 작업을 중단합니다.
- 폴더 선택은 **서버가 실행되는 컴퓨터의 파일시스템**을 기준으로 합니다.

아래 이미지는 실제 HTTP 대시보드를 데모 데이터로 실행해 촬영했습니다. 실제 계정이나 작업 실행 결과가 아닙니다.

![로컬 웹 대시보드 — 데모 데이터](docs/images/web-dashboard.png)

### 접속 범위와 보안

서버는 기본적으로 `127.0.0.1`에만 바인딩하며, 호스트·Origin·요청 헤더를 검증합니다. 별도의 사용자 로그인 기능은 제공하지 않습니다. 대시보드는 작업 실행과 파일 경로·출력 조회 기능을 포함하므로 인터넷에 직접 노출하지 마십시오.

`--public-origin https://host`는 역방향 프록시용 허용 Origin을 추가할 뿐, 인증이나 HTTPS 서버를 구성하지 않습니다. 원격 접속이 필요한 경우 별도의 인증·접근 제어·TLS를 갖춘 프록시 구성이 필요합니다.

## 사용량과 인증

- **Claude Code:** status-line을 통해 기록된 로컬 사용량을 읽습니다.
- **Codex:** 로컬 세션에 기록된 사용량을 읽습니다.
- 로그인과 서비스 통신에 필요한 자격증명은 공식 CLI가 관리합니다.
- 앱은 계정 자격증명을 읽어 이메일 등 메타데이터를 수집하거나 사용량 엔드포인트를 직접 호출하지 않습니다. 계정은 프로필 이름으로 구분합니다.

사용량은 공식 CLI가 지원하는 기록을 남긴 뒤에 표시됩니다. 기록이 없거나 오래된 경우 값이 비어 있거나 현재 상태와 다를 수 있습니다. **실시간 잔액·할당량 표시는 보장하지 않습니다.**

## OpenClaw 연동

```sh
npm run build:plugin
openclaw plugins install ./plugins/openclaw
```

- 플러그인 매니페스트의 최소 OpenClaw 버전은 **2026.9.6**입니다. 실제 설치 버전과의 API 호환성은 별도 확인이 필요합니다.
- 플러그인은 앱의 데이터 디렉터리를 사용합니다. 동일한 플러그인·도구 ID를 가진 플러그인을 중복 설치하지 마십시오.
- 작업 결과 전달에는 명시적인 확인이 필요합니다. 전송과 확인 사이의 결과가 불명확한 경우 정확히 한 번 전달을 보장하지 않습니다.
- `account_tasks get`은 짧은 요약을 반환합니다. 전체 근거는 `context`, `task`, `final` 보기에서 반환된 `nextOffset`과 `queryRevision`으로 이어 읽으십시오. 요약만으로 검토를 완료하지 않습니다.
- 대시보드는 읽기 전용 Gateway 조회로 최근 OpenClaw 활동을 별도로 표시합니다. 연결이 끊긴 기록은 이전 기록으로 표시하며, 실행 종료를 사용자 목표 완료로 간주하지 않습니다.

## 개발 및 빌드

### 테스트

```sh
npm ci
npm test                 # 기본 동작 검증
npm run test:runtime     # 런타임 검증 — macOS
npm run test:dashboard   # 대시보드 및 Electron UI 검증 — macOS
npm run test:reset-ui    # 렌더러 회귀 검증 — macOS
npm run build:plugin     # OpenClaw 플러그인 빌드
```

Electron UI 테스트에는 데스크톱 실행 환경이 필요합니다.

### 설치 파일 빌드

```sh
npm run dist:mac   # macOS universal DMG
npm run dist:win   # Windows NSIS 설치 파일 및 portable 빌드
```

산출물은 `dist/`에 생성됩니다. 빌드는 해당 운영체제 환경에서 수행하십시오. 현재 macOS 빌드는 서명·공증을 구성하지 않습니다.

### GitHub Actions

[검증·빌드 워크플로](.github/workflows/ci.yml)는 `main` push와 pull request에서 macOS·Windows 기본 테스트 및 플러그인 빌드를 실행합니다. macOS에서는 런타임·대시보드·렌더러 테스트도 실행합니다.

수동 실행(`workflow_dispatch`) 시 설치 파일을 빌드하고 아티팩트를 7일간 보관합니다. 별도 [게시 워크플로](.github/workflows/publish-release.yml)에 성공한 빌드 실행 ID와 정확한 커밋 SHA를 전달하면 출처를 검증한 뒤 설치 파일·체크섬을 프리릴리스로 게시합니다. 서명·공증과 Windows 런타임 검증은 별도 작업입니다.

## 제한사항

- 현재 지원 목록에 활성화된 CLI는 Claude Code와 Codex입니다.
- Windows 설치 파일 빌드 설정은 포함되어 있지만, Windows에서 관리형 작업 실행은 지원하지 않습니다.
- 사용량은 로컬 기록에 의존하며 서비스의 현재 할당량과 일치하지 않을 수 있습니다.
- 프로필 전환은 기존 CLI 세션이나 다른 앱의 독립된 인증 상태를 변경하지 않습니다.
- 각 서비스의 약관과 접근 권한은 그대로 적용됩니다. 계정 생성, 구독 공유, 인증 프록시, 사용 제한에 따른 자동 계정 순환 및 접근 제한 우회를 제공하지 않습니다.

## 라이선스

[MIT License](LICENSE) · Copyright (c) 2026 HoonStyle

외부 CLI와 서비스에는 각 제공자의 라이선스 및 이용약관이 별도로 적용됩니다.
