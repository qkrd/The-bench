# Supabase 연동 가이드

이 프로젝트는 Supabase REST API를 통해 회원 정보(`app_users`)와 사용자별 PC 사양(`user_specs`)을 저장합니다.  
Supabase가 아직 연결되지 않은 상태에서도 브라우저 `localStorage` 기반 로컬 폴백과 공용 계정(`admin` / `admin`)으로 바로 동작합니다.

## 1. Supabase 프로젝트 생성

1. [Supabase](https://supabase.com/)에 로그인한 뒤 **New Project**를 클릭합니다.
2. Organization을 선택하고 프로젝트 이름(예: `hardware-monitor`), 데이터베이스 비밀번호, 리전(예: `Northeast Asia (Seoul)`)을 지정합니다.
3. **Create new project**를 누르고 프로젝트 프로비저닝이 완료될 때까지 기다립니다.

## 2. `schema.sql` 실행

1. Supabase 대시보드 왼쪽 메뉴에서 **SQL Editor**를 엽니다.
2. **New query**를 클릭한 뒤, 이 저장소의 `supabase/schema.sql` 파일 내용을 전체 복사해 붙여넣습니다.
3. **Run** 버튼을 눌러 실행합니다. (`Success. No rows returned` 또는 정상 완료 메시지가 표시됩니다.)
4. 왼쪽 메뉴의 **Table Editor**에서 `app_users`, `user_specs` 테이블이 생성되었는지 확인합니다.

> 참고: `schema.sql`에는 데모용 RLS(Row Level Security) 정책과 기본 `admin` 계정 시드가 포함되어 있으며, 여러 번 실행해도 안전합니다.

## 3. URL 및 Anon Key 확인

1. Supabase 대시보드 왼쪽 하단의 **Project Settings** → **Data API** (또는 **API** / **API Keys**)로 이동합니다.
2. 아래 두 값을 복사합니다.
   - **Project URL**: 예) `https://your-project-ref.supabase.co`
   - **Anon Key** (`anon` `public` 또는 Publishable key): JWT 형태의 공개 클라이언트 키

## 4. 웹사이트 설정에 입력

### 방법 A: 웹사이트 UI에서 직접 입력 (권장)
1. 웹사이트 상단 또는 설정 모달의 **Supabase 연결 설정**을 엽니다.
2. **Project URL**과 **Anon Key**를 입력하고 저장합니다.
3. 저장된 설정은 브라우저 `localStorage`(`hw_supabase_config`)에 보관되며, 상태 표시가 `Supabase Cloud`로 전환됩니다.

### 방법 B: `js/config.js`에 기본값으로 고정
모든 브라우저에서 기본 연결값을 사용하려면 `js/config.js` 파일의 `window.SUPABASE_CONFIG`에 값을 입력할 수 있습니다.
```js
window.SUPABASE_CONFIG = {
  url: "https://your-project-ref.supabase.co",
  anonKey: "your-anon-public-key"
};
```
(UI에서 `localStorage`에 설정을 저장한 경우 `localStorage` 값이 우선 적용됩니다.)
