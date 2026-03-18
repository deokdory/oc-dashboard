# Stale Session Detection 진단 리포트

**날짜:** 2026-03-18 17:15 KST
**브랜치:** `fix/stale-session-detection`
**증상:** 종료된 세션이 대시보드에서 ACTIVE로 표시됨

---

## 문제 세션

| 항목 | 값 |
|---|---|
| ID | `ses_3005e415bffeT1L55KeNtByKTO` |
| title | Provider overload 문제 진단 |
| directory | `/Users/jaemin` |
| project | `global` (worktree: `/`) |
| DB time_updated | 2026-03-18 15:32:31 (**102분 전**) |
| DB classifyStatus | `IDLE` (>5min 기준) |
| plugin status | `retry` (attempt: 7) |
| plugin ts | 1773815696575 (**100분 전**) |
| last message | `MessageAbortedError` — "The operation was aborted." |
| todos / children | 없음 |

---

## Root Cause

`isPluginEntryStale()`가 `false`를 리턴하여, stale 세션이 ACTIVE로 강제 오버라이드됨.

### staleness 판정 시뮬레이션

```
isPluginEntryStale(now, pluginTs, dbTimeUpdated, hasProcess)

  pluginStale (>10min):  True   ← 100분 전
  dbStale (>5min):       True   ← 102분 전
  hasProcess:            True   ← 이것 때문에 stale 판정 실패

  결과: True && True && !True = False (NOT stale)
```

NOT stale로 판정 → `activeSessionIds`에 추가 → status IDLE이 "ACTIVE"로 오버라이드 (server.ts line 166)

### 왜 hasProcess = True인가

```typescript
// server.ts line 137
const hasProcess = session ? activeCwds.has(session.directory) : false;
```

이 세션의 `directory`가 `/Users/jaemin` (홈 디렉토리).
현재 돌고 있는 opencode 프로세스 중 CWD가 `/Users/jaemin`인 것이 **5개**나 있음.
→ `activeCwds.has("/Users/jaemin")` = `true`

---

## 현재 Running Processes (7개)

| PID | CMD | CWD (lsof) | CPU | State |
|-----|-----|------------|-----|-------|
| 93130 | `opencode attach ...anyload-805hp` | `/Users/jaemin` | 17.0% | S+ |
| 28189 | `opencode` | `/Users/jaemin/personal/dev/oc-dashboard` | 20.3% | S+ |
| 99963 | `opencode attach ...anyload-805hp-wl-t` | `/Users/jaemin` | 11.7% | S+ |
| 92192 | `opencode` | `/Users/jaemin` | 0.1% | S |
| 93231 | `opencode attach http://deokdory-linux:4096` | `/Users/jaemin` | 0.0% | S |
| 1996 | `opencode attach ...oc-dashboard` | `/Users/jaemin` | 0.1% | S+ |
| 1494 | `opencode attach ...oc-dashboard` | `/Users/jaemin` | 0.0% | S |

### 프로세스별 실제 작업 디렉토리 vs CWD

| PID | `--dir` (실제 작업 대상) | CWD (OS-level, lsof 결과) |
|-----|--------------------------|---------------------------|
| 93130 | `/home/deokdory/projects/alcon/nrf/anyload-805hp` | `/Users/jaemin` |
| 99963 | `/home/deokdory/projects/alcon/nrf/anyload-805hp-wl-t` | `/Users/jaemin` |
| 1996 | `/home/deokdory/projects/deokdory/oc-dashboard` | `/Users/jaemin` |
| 1494 | `/Users/jaemin/projects/deokdory/oc-dashboard` | `/Users/jaemin` |
| 93231 | (없음 — 기본) | `/Users/jaemin` |
| 92192 | (로컬 직접 실행) | `/Users/jaemin` |
| 28189 | (로컬 직접 실행) | `/Users/jaemin/personal/dev/oc-dashboard` |

---

## active-sessions.json 현재 상태

경로: `~/.local/share/opencode/active-sessions.json`

```json
{
  "ses_3005e415bffeT1L55KeNtByKTO": {
    "status": "retry",
    "ts": 1773815696575,
    "attempt": 7
  },
  "ses_2fffffbb0ffe8OTIoDeArYbeq1": {
    "status": "busy",
    "ts": 1773821635185
  }
}
```

| Session ID | status | ts age | 비고 |
|---|---|---|---|
| `ses_3005e415bffeT1L55KeNtByKTO` | retry | 100분 전 | 문제 세션 — 종료됐지만 안 지워짐 |
| `ses_2fffffbb0ffe8OTIoDeArYbeq1` | busy | <1분 전 | 현재 세션 (정상) |

---

## 문제 발생 체인

```
1. 세션이 "retry" 상태(attempt 7)에서 abort됨 (MessageAbortedError)
2. OpenCode가 idle 이벤트를 안 보냄 → plugin이 active-sessions.json에서 안 지움
3. plugin ts는 100분 전 → pluginStale = True
4. DB time_updated도 102분 전 → dbStale = True
5. 그런데 session.directory = "/Users/jaemin" 이고,
   다른 opencode attach 프로세스들의 CWD도 "/Users/jaemin"
6. → hasProcess = True → isPluginEntryStale()가 False 리턴
7. → activeSessionIds에 추가 → ACTIVE로 강제 오버라이드
```

---

## 구조적 문제

### 1. `global` 프로젝트의 directory가 홈 디렉토리

`global` 프로젝트 세션은 `directory`가 `/Users/jaemin`으로 설정됨.
홈 디렉토리는 다른 opencode 프로세스들의 CWD와 겹칠 확률이 매우 높음.
`opencode attach` 프로세스는 터미널에서 실행한 위치(보통 `~`)가 OS-level CWD가 됨.

→ **관련 없는 프로세스가 해당 세션의 "활성 프로세스"로 오인됨**

### 2. `opencode attach --dir`의 작업 디렉토리가 CWD에 반영 안 됨

`lsof`는 프로세스의 OS-level CWD를 리턴함.
`opencode attach --dir /remote/path`의 실제 작업 디렉토리는 `--dir` 인자에 있지만,
macOS 로컬 CWD는 `opencode`를 실행한 셸의 위치(`~`)를 그대로 유지함.

→ **프로세스 감지의 CWD 매칭이 attach 모드에서 무의미함**

### 3. Plugin cleanup 부재

Plugin은 `session.status: idle` 또는 `session.deleted` 이벤트에서만 엔트리를 삭제함.
프로세스 crash나 abort 시 이벤트가 안 날아가면 엔트리가 영구 잔류함.
서버 측 GC/TTL 메커니즘 없음.

---

## 관련 코드 위치

| 파일 | 위치 | 역할 |
|------|------|------|
| `stale.ts` | line 4-12 | `isPluginEntryStale()` — 3-signal 판정 |
| `stale.ts` | line 1-2 | `PLUGIN_STALE_MS=10min`, `DB_STALE_MS=5min` |
| `server.ts` | line 126-128 | 프로세스 감지 + activeCwds 구성 |
| `server.ts` | line 131-143 | plugin 기반 activeSessionIds 결정 (stale check 포함) |
| `server.ts` | line 164-166 | status 오버라이드: `isActive && status !== "ACTIVE"` → ACTIVE |
| `process.ts` | line 40-62 | `getCwd()` — lsof 기반 CWD 추출 |
| `process.ts` | line 64-94 | `getOpenCodeProcesses()` — ps aux + CWD 매핑 |
| `plugin/index.ts` | line 34-48 | plugin 이벤트 핸들러 — write/delete 로직 |

---

## DB 스키마 참고 (session 테이블)

```sql
CREATE TABLE `session` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `parent_id` text,
  `directory` text NOT NULL,
  `title` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_archived` integer,
  -- ...
);
```

- `time_updated`: millisecond unix timestamp
- `directory`: 세션의 작업 디렉토리 (global 프로젝트는 홈 디렉토리)
- `project_id`: `global`인 경우 특정 프로젝트에 속하지 않는 세션
