/**
 * 진짜 데이터베이스(SQLite/better-sqlite3) 계층.
 *
 * 기존에는 users.json 같은 파일 하나에 "모든 사용자"의 데이터를 통째로 읽고 통째로
 * 다시 써서(loadUsers/saveUsers), 사용자 A의 크레딧 하나만 바꿔도 사용자 B·C·D...의
 * 데이터까지 전부 다시 디스크에 쓰였다. 사용자가 늘면 매 요청마다 파일이 커지고,
 * 동시에 여러 요청이 들어오면 마지막에 쓴 내용이 앞의 변경을 덮어써 데이터가 사라질
 * 수 있었다. SQLite는 사용자 단위 행(row)만 갱신하고 트랜잭션으로 동시쓰기를
 * 안전하게 처리하므로 이 문제를 해결한다.
 *
 * 비용: $0. 파일 하나(data/nexta.db)로 동작하는 내장형 DB라 별도 서버·비용이 없다.
 * 단, 무료 호스팅(Render 등)에서 재배포 시 디스크가 초기화되는 문제는 이 파일
 * 자체와는 별개 — 데이터를 재배포 후에도 남기려면 호스팅의 "영구 디스크" 옵션이
 * 필요하다(README 참고).
 */
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "nexta.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  -- email에는 UNIQUE를 걸지 않는다: 체험(게스트) 계정은 전부 "체험 사용자"라는 같은
  -- 문자열을 이메일 자리에 쓰기 때문. 실제 회원가입의 이메일 중복 체크는
  -- emailExists()/getUserByEmail()로 애플리케이션 단에서 처리한다(회원가입 시 이메일
  -- 형식 검증을 통과해야 하므로 게스트 문자열과 절대 겹치지 않는다).
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    salt TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL DEFAULT '',
    credits INTEGER NOT NULL DEFAULT 0,
    ceiling INTEGER NOT NULL DEFAULT 0,
    guest INTEGER NOT NULL DEFAULT 0,
    company_name TEXT NOT NULL DEFAULT '',
    company_logo TEXT NOT NULL DEFAULT '',
    created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    at TEXT, amount INTEGER, kind TEXT, label TEXT, question TEXT, agents INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id);

  CREATE TABLE IF NOT EXISTS cardnews_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id TEXT, name TEXT, hook TEXT, image_urls TEXT, created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cardnews_user ON cardnews_history(user_id);

  -- method: 'toss'(카드 자동결제) | 'bank_transfer'(무통장입금, 관리자가 수동 확인).
  -- depositor_name은 무통장입금 신청 시 사용자가 입력한 입금자명 — 관리자가 실제 입금 내역과
  -- 대조할 때 쓴다.
  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credits INTEGER, amount INTEGER, label TEXT, status TEXT, created_at TEXT,
    method TEXT NOT NULL DEFAULT 'toss',
    depositor_name TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status_method ON orders(status, method);

  CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_key TEXT NOT NULL,
    date TEXT, question TEXT, summary TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memory_user_role ON memory(user_id, role_key);

  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    title TEXT, text TEXT, added_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_user_role ON knowledge(user_id, role);

  CREATE TABLE IF NOT EXISTS social_instagram (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    ig_user_id TEXT,
    access_token_enc TEXT,
    comment_keyword TEXT,
    dm_message TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_social_ig_user ON social_instagram(ig_user_id);

  CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT, job_id TEXT, rating TEXT, at TEXT
  );

  -- AI 호출 1건마다 실제 원가(달러)를 기록한다. 요금제/크레딧 설계를 감이 아니라
  -- 실측값으로 하기 위한 데이터 — OpenRouter가 응답에 실어주는 usage.cost를 그대로 저장.
  CREATE TABLE IF NOT EXISTS ai_cost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    job_id TEXT,
    role_key TEXT,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL,
    at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ai_cost_role ON ai_cost_log(role_key);
  CREATE INDEX IF NOT EXISTS idx_ai_cost_at ON ai_cost_log(at);

  -- 체험(게스트) 입장을 "브라우저당 1회"로 제한하기 위한 기기 식별 기록.
  -- IP 하나에 여러 사람이 물려 있어도(같은 집 공유기, 통신사 CGNAT) 각자 브라우저는
  -- 다르므로, 쿠키로 발급한 기기 ID 기준으로 판단하면 IP만으로 볼 때보다 정확하다.
  CREATE TABLE IF NOT EXISTS guest_devices (
    device_id TEXT PRIMARY KEY,
    user_id TEXT,
    ip TEXT,
    created_at TEXT
  );

  -- 인플루언서/제휴 추천 코드 registry. 대표님이 인플루언서마다 코드를 하나씩 만들어서
  -- (예: nexta-yhy8.onrender.com/?ref=코드) 링크를 나눠주면, 그 코드로 들어온 사람이
  -- 회원가입할 때 어느 코드로 왔는지 users.referred_by에 남는다.
  CREATE TABLE IF NOT EXISTS referral_codes (
    code TEXT PRIMARY KEY,
    label TEXT,
    created_at TEXT
  );

  -- 업무(job) 진행 기록. jobs는 그동안 메모리(Map)에만 있어서 서버가 재시작되면 사라졌고,
  -- "어디서 이탈하는지" 분석이 불가능했다. 이제 시작·완료·에러·중도포기를 여기 남긴다.
  CREATE TABLE IF NOT EXISTS job_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    user_id TEXT,
    kind TEXT,              -- 'pipeline'(AI 직원 업무) | 'coupang_auto'(쿠팡 자동 카드뉴스)
    question TEXT,
    agents TEXT,            -- 선택한 담당자 키들을 콤마로 이어붙임
    status TEXT,            -- 'started' | 'awaiting_approval' | 'approved' | 'abandoned' | 'error'
    error_message TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_job_log_user ON job_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_job_log_status ON job_log(status);
  CREATE INDEX IF NOT EXISTS idx_job_log_created ON job_log(created_at);

  -- AI 품질(헛소리 방지) 측정. 총괄AI의 담당자별 통과/반려 판정과, 대표의 최종 승인/보완요청을
  -- 기록해서 "AI가 헛소리를 얼마나 잡아내는지"를 감이 아니라 실제 %로 볼 수 있게 한다.
  CREATE TABLE IF NOT EXISTS quality_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,      -- 'manager_verdict' | 'ceo_decision'
    job_id TEXT,
    user_id TEXT,
    role_key TEXT,           -- manager_verdict 전용
    approved INTEGER,        -- manager_verdict 전용 (0/1)
    attempt INTEGER,         -- manager_verdict 전용 (몇 번째 검수 시도인지)
    action TEXT,             -- ceo_decision 전용 ('approve' | 'revise')
    round INTEGER,           -- ceo_decision 전용
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quality_log_type_at ON quality_log(type, at);
  CREATE INDEX IF NOT EXISTS idx_quality_log_role ON quality_log(role_key);

  -- 역할별 "시스템 기본지식" — 대표(운영자)가 미리 심어두는 전문가 수준 자료.
  -- data/knowledge.json(유저별 개인지식)과는 별개로, 유저ID 없이 role 전역으로 전 사용자에게 적용된다.
  CREATE TABLE IF NOT EXISTS default_knowledge (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    title TEXT,
    text TEXT,
    added_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_default_knowledge_role ON default_knowledge(role);

  -- 정기결제(토스페이먼츠 빌링) 구독 상태. 유저당 1행 — 재구독하면 같은 행을 덮어쓴다.
  -- status: 'active'(정상 구독중, 다음 주기에 자동 청구) | 'canceled'(취소했지만 이미 낸 기간까지는
  -- 이용 가능 — current_period_end는 그대로 두고 다음 자동청구만 안 함) | 'past_due'(자동청구 실패,
  -- 즉시 이용 중단).
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    billing_key_enc TEXT,
    customer_key TEXT,      -- 빌링키 발급 당시 쓴 토스 customerKey. 재청구할 때도 같은 값을 써야 한다.
    status TEXT NOT NULL,
    current_period_end TEXT,
    canceled_at TEXT,
    last_payment_at TEXT,
    last_failure_reason TEXT,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_subscriptions_status_period ON subscriptions(status, current_period_end);
`);

// 마이그레이션 — CREATE TABLE IF NOT EXISTS는 이미 있는 테이블에 새 컬럼을 추가해주지 않으므로,
// 기존에 배포된 DB에도 안전하게 적용되도록 컬럼이 없을 때만 추가한다.
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
// promo_optout: 자동 게시 캡션에 "Made with 넥스타" 홍보 문구를 넣을지 여부(기본 포함, 사용자가 끌 수 있음).
if (!userColumns.includes("promo_optout")) {
  db.exec("ALTER TABLE users ADD COLUMN promo_optout INTEGER NOT NULL DEFAULT 0");
}
// referred_by: 이 사용자가 가입할 때 어느 추천 코드를 타고 왔는지 (없으면 NULL = 직접 가입).
if (!userColumns.includes("referred_by")) {
  db.exec("ALTER TABLE users ADD COLUMN referred_by TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)");
}
// access_until: 실제 결제(무료 체험/테스트 충전 제외)를 한 번이라도 하면, 그 결제일로부터
// 30일 뒤 날짜(ISO)가 여기 찍힌다. 정기결제가 아니라 "한 번 결제 = 30일 이용"이라, 매번 결제할
// 때마다 이 값을 결제 시점 기준 30일 뒤로 새로 맞춘다(누적되지 않음). 값이 없으면(NULL) 아직
// 결제한 적 없는 사용자라는 뜻이고, 이 경우 예전처럼 크레딧 잔액만으로 이용 가능 여부를 판단한다.
if (!userColumns.includes("access_until")) {
  db.exec("ALTER TABLE users ADD COLUMN access_until TEXT");
}
// orders 테이블에 무통장입금 지원 컬럼 추가 (기존 배포 DB 대비).
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
if (!orderColumns.includes("method")) {
  db.exec("ALTER TABLE orders ADD COLUMN method TEXT NOT NULL DEFAULT 'toss'");
}
if (!orderColumns.includes("depositor_name")) {
  db.exec("ALTER TABLE orders ADD COLUMN depositor_name TEXT");
}
// subscriptions.plan: 'standard' | 'pro' — 재청구 때 어느 요금제 금액/크레딧으로 청구할지 알아야 한다.
const subscriptionColumns = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
if (!subscriptionColumns.includes("plan")) {
  db.exec("ALTER TABLE subscriptions ADD COLUMN plan TEXT NOT NULL DEFAULT 'standard'");
}

/* ────────────────────────── 자동 발행 (보관함 + 예약) ──────────────────────────
 * 쿠팡은 서버에서 상품 정보를 긁어올 수 없어(차단됨) 북마클릿으로만 가져올 수 있다.
 * 그래서 사용자가 한가할 때 상품을 보관함(auto_queue)에 미리 담아두고, 예약
 * (auto_schedules)에 걸린 시각이 되면 스케줄러가 보관함에서 하나씩 꺼내 발행한다.
 * "일요일에 10개 담아두면 열흘간 알아서 올라간다"가 이 구조의 목적이다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS auto_queue (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price TEXT,
    image_url TEXT,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | failed
    error TEXT,
    created_at TEXT NOT NULL,
    posted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS auto_queue_user_status_idx
    ON auto_queue (user_id, status, created_at);

  /* ── 인스타 키우기 ──────────────────────────────────────────
     타깃 하나(누구에게 보일 것인가)를 정해두면, 거기서 이번 주 올릴 콘텐츠를 뽑아
     예정 시각마다 카드뉴스나 릴스로 만들어 올린다. 쿠팡 보관함(auto_queue)과 분리한 건
     저쪽은 '상품'이 단위이고 이쪽은 '게시물'이 단위이기 때문이다. */
  CREATE TABLE IF NOT EXISTS ig_targets (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,            -- 계정 주제 (예: 30대 직장인 재테크)
    audience TEXT NOT NULL,         -- 보여줄 대상
    tone TEXT NOT NULL DEFAULT '친근함',
    hashtags TEXT,
    posts_per_week INTEGER NOT NULL DEFAULT 5,
    reel_ratio INTEGER NOT NULL DEFAULT 40,   -- 릴스 비율 %
    hour INTEGER NOT NULL DEFAULT 19,         -- 올릴 시각 (KST)
    enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ig_posts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,             -- cardnews | reels
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    bullets TEXT,                   -- JSON 배열
    caption TEXT,
    status TEXT NOT NULL DEFAULT 'planned',  -- planned | posting | done | failed | skipped
    scheduled_for TEXT NOT NULL,    -- KST 'YYYY-MM-DD HH'
    media_urls TEXT,                -- JSON 배열
    permalink TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    posted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS ig_posts_due_idx
    ON ig_posts (status, scheduled_for);
  CREATE INDEX IF NOT EXISTS ig_posts_user_idx
    ON ig_posts (user_id, created_at);

  /* 팔로워 추이 — 하루 한 번만 찍는다(같은 날 두 번 조회해도 덮어쓴다). */
  CREATE TABLE IF NOT EXISTS ig_growth (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    on_date TEXT NOT NULL,
    followers INTEGER NOT NULL,
    posts INTEGER NOT NULL,
    PRIMARY KEY (user_id, on_date)
  );

  CREATE TABLE IF NOT EXISTS auto_schedules (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    hour INTEGER NOT NULL DEFAULT 8,          -- 발행 시각(KST 0~23시)
    quantity INTEGER NOT NULL DEFAULT 2,      -- 상품 1건당 만들 카드뉴스 수
    comment_keyword TEXT NOT NULL DEFAULT '정보',
    last_run_on TEXT,                         -- 마지막 실행 날짜(KST, YYYY-MM-DD) — 하루 1회 보장
    last_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ────────────────────────── 스마트스토어 연동 ──────────────────────────
 * 네이버 커머스API는 client_id + client_secret으로 매 요청마다 서명을 만들어 토큰을 받는다.
 * 시크릿은 판매자 계정 권한 그 자체라 다른 토큰들과 같이 암호화해서 넣는다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS smartstore_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    seller_name TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ────────────────────────── 영상 생성 로그 ──────────────────────────
 * 서비스별 성공률·소요시간·실제 비용을 비교할 수 있게 모든 시도를 남긴다(지시서 5).
 * 실패도 반드시 기록한다 — 어느 서비스가 자주 죽는지는 실패 기록에만 남기 때문이다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS video_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    service TEXT NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_sec REAL,
    cost_usd REAL,
    elapsed_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS video_jobs_service_idx ON video_jobs (service, created_at DESC);
  CREATE INDEX IF NOT EXISTS video_jobs_user_idx ON video_jobs (user_id, created_at DESC);
`);

/* ────────────────────────── 워드프레스 연동 ──────────────────────────
 * 워드프레스는 OAuth 대신 "애플리케이션 비밀번호"(WP 5.6+ 기본 기능)를 쓴다. 사용자가
 * 자기 관리자 화면에서 발급한 값이라 계정 비밀번호가 아니고, 언제든 회수할 수 있다.
 * 그래도 글 작성 권한 그 자체이므로 다른 토큰들과 같이 암호화해서 넣는다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS wordpress_sites (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    site_url TEXT NOT NULL,
    username TEXT NOT NULL,
    app_password_enc TEXT NOT NULL,
    display_name TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ────────────────────────── 유튜브 연동 ──────────────────────────
 * 구글 OAuth는 refresh_token을 최초 동의 때 한 번만 내려주므로(access_type=offline +
 * prompt=consent), 재연결 시 새 값이 안 오면 기존 값을 지우지 않고 유지해야 한다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS youtube_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    channel_title TEXT,
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    access_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ────────────────────────── 틱톡 연동 ──────────────────────────
 * 액세스 토큰은 24시간, 리프레시 토큰은 365일짜리라 둘 다 저장하고 만료 전에 갱신한다.
 * 토큰은 계정 접근 권한 그 자체라 인스타 토큰과 같은 방식으로 암호화해서 넣는다.
 * 발행은 MEDIA_UPLOAD(초안) 모드만 쓴다 — 심사 없이 바로 쓸 수 있고, 사용자가
 * 틱톡 앱에서 최종 확인 후 올리는 구조라 계정 안전에도 유리하다.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_accounts (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    open_id TEXT,
    display_name TEXT,
    access_token_enc TEXT,
    refresh_token_enc TEXT,
    access_expires_at TEXT,
    scope TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

/* ────────────────────────── 수익 기록 ──────────────────────────
 * 비비들이 실제로 얼마를 벌어줬는지 보여주는 화면의 원천 데이터.
 * (date, channel) 단위로 하나만 유지한다 — 쿠팡 API를 다시 당겨도 중복되지 않고
 * 최신 값으로 덮어써진다(취소분이 반영돼 금액이 줄어들 수도 있으므로).
 * source: 'api'(자동 수집) | 'manual'(사용자 직접 입력)
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_entries (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,                       -- YYYY-MM-DD (KST)
    channel TEXT NOT NULL,                    -- coupang | adsense | tiktok | smartstore | etc
    amount INTEGER NOT NULL DEFAULT 0,        -- 원 단위
    clicks INTEGER,
    orders INTEGER,
    source TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date, channel)
  );
  CREATE INDEX IF NOT EXISTS revenue_entries_user_date_idx
    ON revenue_entries (user_id, date DESC);

  -- 채널별 API 키. 쿠팡 파트너스는 사용자마다 자기 계정 키를 쓰므로 사용자별로 저장하고,
  -- 인스타 토큰과 같은 방식으로 암호화해 둔다(평문 저장 금지).
  CREATE TABLE IF NOT EXISTS revenue_keys (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    access_key_enc TEXT,
    secret_key_enc TEXT,
    last_synced_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, channel)
  );
`);

/* ────────────────────────── users ────────────────────────── */

function hydrateUsage(row) {
  const o = { at: row.at, amount: row.amount };
  if (row.kind != null) o.kind = row.kind;
  if (row.label != null) o.label = row.label;
  if (row.question != null) o.question = row.question;
  if (row.agents != null) o.agents = row.agents;
  return o;
}
function hydrateCardnews(row) {
  return {
    jobId: row.job_id, name: row.name, hook: row.hook,
    imageUrls: JSON.parse(row.image_urls || "[]"), createdAt: row.created_at,
  };
}
function hydrateSocial(row) {
  if (!row) return undefined;
  return {
    instagram: {
      igUserId: row.ig_user_id, accessTokenEnc: row.access_token_enc,
      commentKeyword: row.comment_keyword, dmMessage: row.dm_message,
    },
  };
}
function hydrateUser(row) {
  if (!row) return null;
  const usage = db
    .prepare("SELECT * FROM (SELECT * FROM usage_log WHERE user_id = ? ORDER BY id DESC LIMIT 60) ORDER BY id ASC")
    .all(row.id)
    .map(hydrateUsage);
  const cardnewsHistory = db
    .prepare("SELECT * FROM cardnews_history WHERE user_id = ? ORDER BY id ASC")
    .all(row.id)
    .map(hydrateCardnews);
  const socialRow = db.prepare("SELECT * FROM social_instagram WHERE user_id = ?").get(row.id);
  return {
    id: row.id, email: row.email, salt: row.salt, hash: row.hash,
    credits: row.credits, ceiling: row.ceiling, guest: !!row.guest,
    company: { name: row.company_name || "", logo: row.company_logo || "" },
    createdAt: row.created_at,
    promoOptout: !!row.promo_optout,
    referredBy: row.referred_by || null,
    accessUntil: row.access_until || null,
    usage, cardnewsHistory,
    social: hydrateSocial(socialRow),
  };
}

function getUserById(id) {
  return hydrateUser(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}
function getUserByEmail(email) {
  return hydrateUser(db.prepare("SELECT * FROM users WHERE email = ?").get(email));
}
function emailExists(email) {
  return !!db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
}
function createUser(u) {
  db.prepare(
    `INSERT INTO users (id, email, salt, hash, credits, ceiling, guest, company_name, company_logo, created_at, referred_by)
     VALUES (@id, @email, @salt, @hash, @credits, @ceiling, @guest, '', '', @createdAt, @referredBy)`
  ).run({
    id: u.id, email: u.email, salt: u.salt || "", hash: u.hash || "",
    credits: u.credits, ceiling: u.ceiling, guest: u.guest ? 1 : 0, createdAt: u.createdAt,
    referredBy: u.referredBy || null,
  });
  return getUserById(u.id);
}
function updateCredits(id, credits, ceiling) {
  db.prepare("UPDATE users SET credits = ?, ceiling = ? WHERE id = ?").run(credits, ceiling, id);
}
function updateCompany(id, name, logo) {
  db.prepare("UPDATE users SET company_name = ?, company_logo = ? WHERE id = ?").run(name, logo, id);
}
function setPromoOptout(id, optout) {
  db.prepare("UPDATE users SET promo_optout = ? WHERE id = ?").run(optout ? 1 : 0, id);
}
function setAccessUntil(id, isoDate) {
  db.prepare("UPDATE users SET access_until = ? WHERE id = ?").run(isoDate, id);
}
const addUsageStmt = db.prepare(
  `INSERT INTO usage_log (user_id, at, amount, kind, label, question, agents)
   VALUES (@userId, @at, @amount, @kind, @label, @question, @agents)`
);
const trimUsageStmt = db.prepare(
  `DELETE FROM usage_log WHERE user_id = ? AND id NOT IN
   (SELECT id FROM usage_log WHERE user_id = ? ORDER BY id DESC LIMIT 60)`
);
function addUsage(userId, entry) {
  addUsageStmt.run({
    userId, at: entry.at, amount: entry.amount,
    kind: entry.kind || null, label: entry.label || null,
    question: entry.question || null, agents: entry.agents == null ? null : entry.agents,
  });
  trimUsageStmt.run(userId, userId);
}
const addCardnewsStmt = db.prepare(
  `INSERT INTO cardnews_history (user_id, job_id, name, hook, image_urls, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
function addCardnewsHistory(userId, entry) {
  addCardnewsStmt.run(userId, entry.jobId, entry.name, entry.hook, JSON.stringify(entry.imageUrls || []), entry.createdAt);
}

/* ────────────────────────── 결제 주문 ────────────────────────── */

function createOrder(orderId, o) {
  db.prepare(
    `INSERT INTO orders (order_id, user_id, credits, amount, label, status, created_at, method, depositor_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, o.userId, o.credits, o.amount, o.label, o.status, o.createdAt, o.method || "toss", o.depositorName || null);
}
function getOrder(orderId) {
  return db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) || null;
}
// 무통장입금 신청 대기 목록 — 관리자가 실제 입금 내역과 대조해서 승인/거절한다.
function listPendingBankTransferOrders() {
  return db
    .prepare(
      `SELECT o.*, u.email as user_email FROM orders o
       LEFT JOIN users u ON u.id = o.user_id
       WHERE o.method = 'bank_transfer' AND o.status = 'pending'
       ORDER BY o.created_at ASC`
    )
    .all();
}
function rejectOrder(orderId) {
  db.prepare("UPDATE orders SET status = 'rejected' WHERE order_id = ?").run(orderId);
}
function markOrderPaid(orderId) {
  db.prepare("UPDATE orders SET status = 'paid' WHERE order_id = ?").run(orderId);
}

/* ────────────────────────── 정기결제(구독) ────────────────────────── */

function upsertSubscription(userId, s) {
  db.prepare(
    `INSERT INTO subscriptions (user_id, billing_key_enc, customer_key, status, plan, current_period_end, canceled_at, last_payment_at, last_failure_reason, created_at, updated_at)
     VALUES (@userId, @billingKeyEnc, @customerKey, @status, @plan, @currentPeriodEnd, @canceledAt, @lastPaymentAt, @lastFailureReason, @createdAt, @updatedAt)
     ON CONFLICT(user_id) DO UPDATE SET
       billing_key_enc = excluded.billing_key_enc,
       customer_key = excluded.customer_key,
       status = excluded.status,
       plan = excluded.plan,
       current_period_end = excluded.current_period_end,
       canceled_at = excluded.canceled_at,
       last_payment_at = excluded.last_payment_at,
       last_failure_reason = excluded.last_failure_reason,
       updated_at = excluded.updated_at`
  ).run({
    userId,
    billingKeyEnc: s.billingKeyEnc != null ? s.billingKeyEnc : null,
    customerKey: s.customerKey != null ? s.customerKey : null,
    status: s.status,
    plan: s.plan || "standard",
    currentPeriodEnd: s.currentPeriodEnd || null,
    canceledAt: s.canceledAt || null,
    lastPaymentAt: s.lastPaymentAt || null,
    lastFailureReason: s.lastFailureReason || null,
    createdAt: s.createdAt || new Date().toISOString(),
    updatedAt: s.updatedAt || new Date().toISOString(),
  });
}
function getSubscription(userId) {
  const row = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    userId: row.user_id,
    billingKeyEnc: row.billing_key_enc,
    customerKey: row.customer_key,
    status: row.status,
    plan: row.plan || "standard",
    currentPeriodEnd: row.current_period_end,
    canceledAt: row.canceled_at,
    lastPaymentAt: row.last_payment_at,
    lastFailureReason: row.last_failure_reason,
  };
}
function updateSubscriptionFields(userId, fields) {
  const row = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!row) return;
  const merged = {
    status: fields.status !== undefined ? fields.status : row.status,
    current_period_end: fields.currentPeriodEnd !== undefined ? fields.currentPeriodEnd : row.current_period_end,
    canceled_at: fields.canceledAt !== undefined ? fields.canceledAt : row.canceled_at,
    last_payment_at: fields.lastPaymentAt !== undefined ? fields.lastPaymentAt : row.last_payment_at,
    last_failure_reason: fields.lastFailureReason !== undefined ? fields.lastFailureReason : row.last_failure_reason,
  };
  db.prepare(
    `UPDATE subscriptions SET status = ?, current_period_end = ?, canceled_at = ?, last_payment_at = ?,
     last_failure_reason = ?, updated_at = ? WHERE user_id = ?`
  ).run(merged.status, merged.current_period_end, merged.canceled_at, merged.last_payment_at, merged.last_failure_reason, new Date().toISOString(), userId);
}
// 자동 재청구 스케줄러가 쓴다 — 활성 구독 중 이번 결제 기간이 끝난(= 오늘 청구해야 하는) 것들.
function getDueSubscriptions(nowIso) {
  return db
    .prepare("SELECT * FROM subscriptions WHERE status = 'active' AND current_period_end <= ?")
    .all(nowIso)
    .map((row) => ({
      userId: row.user_id, billingKeyEnc: row.billing_key_enc, customerKey: row.customer_key, status: row.status,
      currentPeriodEnd: row.current_period_end,
    }));
}
function getSubscriptionStats() {
  return db.prepare("SELECT status, COUNT(*) as count FROM subscriptions GROUP BY status").all();
}

/* ────────────────────────── 담당자 기억 ────────────────────────── */

function getMemoryEntries(userId, roleKey, limit) {
  return db
    .prepare("SELECT * FROM (SELECT * FROM memory WHERE user_id = ? AND role_key = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC")
    .all(userId, roleKey, limit || 5)
    .map((r) => ({ date: r.date, question: r.question, summary: r.summary }));
}
const addMemoryStmt = db.prepare(
  `INSERT INTO memory (user_id, role_key, date, question, summary) VALUES (?, ?, ?, ?, ?)`
);
const trimMemoryStmt = db.prepare(
  `DELETE FROM memory WHERE user_id = ? AND role_key = ? AND id NOT IN
   (SELECT id FROM memory WHERE user_id = ? AND role_key = ? ORDER BY id DESC LIMIT 8)`
);
function addMemoryEntry(userId, roleKey, entry) {
  addMemoryStmt.run(userId, roleKey, entry.date, entry.question, entry.summary);
  trimMemoryStmt.run(userId, roleKey, userId, roleKey);
}

/* ────────────────────────── 전문 지식(RAG 참고자료) ────────────────────────── */

function getKnowledge(userId, role) {
  return db
    .prepare("SELECT * FROM knowledge WHERE user_id = ? AND role = ? ORDER BY rowid ASC")
    .all(userId, role)
    .map((r) => ({ id: r.id, title: r.title, text: r.text, addedAt: r.added_at }));
}
function addKnowledge(userId, role, item) {
  db.prepare(
    `INSERT INTO knowledge (id, user_id, role, title, text, added_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(item.id, userId, role, item.title, item.text, item.addedAt);
}
function deleteKnowledge(userId, role, id) {
  db.prepare("DELETE FROM knowledge WHERE user_id = ? AND role = ? AND id = ?").run(userId, role, id);
}

/* ────────────────────────── 시스템 기본지식 (운영자가 심어두는 전역 전문지식) ────────────────────────── */

function getDefaultKnowledge(role) {
  return db
    .prepare("SELECT * FROM default_knowledge WHERE role = ? ORDER BY rowid ASC")
    .all(role)
    .map((r) => ({ id: r.id, title: r.title, text: r.text, addedAt: r.added_at }));
}
function addDefaultKnowledge(role, item) {
  db.prepare(
    `INSERT INTO default_knowledge (id, role, title, text, added_at) VALUES (?, ?, ?, ?, ?)`
  ).run(item.id, role, item.title, item.text, item.addedAt);
}
function deleteDefaultKnowledge(role, id) {
  db.prepare("DELETE FROM default_knowledge WHERE role = ? AND id = ?").run(role, id);
}

/* ────────────────────────── 인스타그램 연동 ────────────────────────── */

function setSocialInstagram(userId, s) {
  db.prepare(
    `INSERT INTO social_instagram (user_id, ig_user_id, access_token_enc, comment_keyword, dm_message)
     VALUES (@userId, @igUserId, @accessTokenEnc, @commentKeyword, @dmMessage)
     ON CONFLICT(user_id) DO UPDATE SET
       ig_user_id = excluded.ig_user_id,
       access_token_enc = excluded.access_token_enc,
       comment_keyword = excluded.comment_keyword,
       dm_message = excluded.dm_message`
  ).run({
    userId, igUserId: s.igUserId, accessTokenEnc: s.accessTokenEnc,
    commentKeyword: s.commentKeyword, dmMessage: s.dmMessage,
  });
}
function getSocialInstagramByIgUserId(igUserId) {
  const row = db.prepare("SELECT * FROM social_instagram WHERE ig_user_id = ?").get(igUserId);
  return row ? hydrateSocial(row).instagram : null;
}

/* ────────────────────────── 체험(게스트) 기기 기록 ────────────────────────── */

function hasGuestDevice(deviceId) {
  return !!db.prepare("SELECT 1 FROM guest_devices WHERE device_id = ?").get(deviceId);
}
function recordGuestDevice(deviceId, userId, ip, createdAt) {
  db.prepare(
    "INSERT INTO guest_devices (device_id, user_id, ip, created_at) VALUES (?, ?, ?, ?)"
  ).run(deviceId, userId, ip, createdAt);
}

/* ────────────────────────── 인플루언서/제휴 추천 코드 ────────────────────────── */

function createReferralCode(code, label, createdAt) {
  db.prepare("INSERT INTO referral_codes (code, label, created_at) VALUES (?, ?, ?)").run(code, label, createdAt);
}
function referralCodeExists(code) {
  return !!db.prepare("SELECT 1 FROM referral_codes WHERE code = ?").get(code);
}
function listReferralCodes() {
  return db.prepare("SELECT * FROM referral_codes ORDER BY created_at DESC").all();
}
// 코드별 가입자 수·실제 결제 전환·결제 금액까지 한 번에 집계 — 수수료 계산의 기초 자료.
function getReferralStats() {
  return db
    .prepare(
      `SELECT
         rc.code, rc.label, rc.created_at,
         COUNT(u.id) as signups,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') THEN 1 ELSE 0 END) as paid_conversions,
         COALESCE((SELECT SUM(o.amount) FROM orders o WHERE o.status = 'paid' AND o.user_id IN
           (SELECT id FROM users WHERE referred_by = rc.code)), 0) as paid_amount_krw
       FROM referral_codes rc
       LEFT JOIN users u ON u.referred_by = rc.code
       GROUP BY rc.code
       ORDER BY signups DESC`
    )
    .all();
}

/* ────────────────────────── AI 품질(헛소리 방지) 측정 ────────────────────────── */

const logManagerVerdictStmt = db.prepare(
  `INSERT INTO quality_log (type, job_id, user_id, role_key, approved, attempt, at)
   VALUES ('manager_verdict', ?, ?, ?, ?, ?, ?)`
);
function logManagerVerdict(jobId, userId, roleKey, approved, attempt, at) {
  logManagerVerdictStmt.run(jobId, userId, roleKey, approved ? 1 : 0, attempt, at);
}
const logCeoDecisionStmt = db.prepare(
  `INSERT INTO quality_log (type, job_id, user_id, action, round, at)
   VALUES ('ceo_decision', ?, ?, ?, ?, ?)`
);
function logCeoDecision(jobId, userId, action, round, at) {
  logCeoDecisionStmt.run(jobId, userId, action, round, at);
}
function getQualityStats(sinceIso) {
  const since = sinceIso ? "AND at >= ?" : "";
  const params = sinceIso ? [sinceIso] : [];

  const mgr = db
    .prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected
              FROM quality_log WHERE type = 'manager_verdict' ${since}`)
    .get(...params);
  const totalVerdicts = mgr.total || 0;
  const rejected = mgr.rejected || 0;

  const totalJobs = db
    .prepare(`SELECT COUNT(DISTINCT job_id) as c FROM quality_log WHERE type = 'ceo_decision' ${since}`)
    .get(...params).c || 0;
  const approvedFirstTry = db
    .prepare(`SELECT COUNT(DISTINCT job_id) as c FROM quality_log WHERE type = 'ceo_decision' AND round = 1 AND action = 'approve' ${since}`)
    .get(...params).c || 0;
  const revisedAtLeastOnce = db
    .prepare(`SELECT COUNT(DISTINCT job_id) as c FROM quality_log WHERE type = 'ceo_decision' AND action = 'revise' ${since}`)
    .get(...params).c || 0;

  const byRoleRows = db
    .prepare(`SELECT role_key, COUNT(*) as sample, SUM(CASE WHEN approved = 0 THEN 1 ELSE 0 END) as rejected
              FROM quality_log WHERE type = 'manager_verdict' ${since} GROUP BY role_key`)
    .all(...params);
  const byRole = {};
  byRoleRows.forEach((r) => {
    byRole[r.role_key] = {
      reject_rate: r.sample ? Math.round((r.rejected / r.sample) * 1000) / 10 : 0,
      sample: r.sample,
    };
  });

  return {
    manager: {
      total_verdicts: totalVerdicts,
      rejected,
      reject_rate: totalVerdicts ? Math.round((rejected / totalVerdicts) * 1000) / 10 : 0,
    },
    ceo: {
      total_jobs: totalJobs,
      approved_first_try: approvedFirstTry,
      revised_at_least_once: revisedAtLeastOnce,
      first_approval_rate: totalJobs ? Math.round((approvedFirstTry / totalJobs) * 1000) / 10 : 0,
    },
    by_role: byRole,
  };
}

/* ────────────────────────── 업무(job) 진행 기록 — 이탈 지점 분석용 ────────────────────────── */

function createJobLog(jobId, userId, kind, question, agents, createdAt) {
  db.prepare(
    `INSERT INTO job_log (job_id, user_id, kind, question, agents, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'started', ?, ?)`
  ).run(jobId, userId, kind, question || null, (agents || []).join(","), createdAt, createdAt);
}
function updateJobLogStatus(jobId, status, errorMessage, updatedAt) {
  db.prepare("UPDATE job_log SET status = ?, error_message = ?, updated_at = ? WHERE job_id = ?").run(
    status, errorMessage || null, updatedAt, jobId
  );
}
// 상태별 건수(시작/승인완료/에러/중도포기) — "어디서 이탈하는지" 한눈에 보는 용도.
function getJobStats(sinceIso) {
  const where = sinceIso ? "WHERE created_at >= ?" : "";
  const params = sinceIso ? [sinceIso] : [];
  return db.prepare(`SELECT status, COUNT(*) as count FROM job_log ${where} GROUP BY status`).all(...params);
}
// 담당자(역할)별로 얼마나 자주 선택됐는지 — "질문 유형" 대신 쓸 수 있는 실질적 지표.
function getAgentPopularity(sinceIso) {
  const where = sinceIso ? "WHERE created_at >= ? AND kind = 'pipeline'" : "WHERE kind = 'pipeline'";
  const params = sinceIso ? [sinceIso] : [];
  const rows = db.prepare(`SELECT agents FROM job_log ${where}`).all(...params);
  const counts = {};
  for (const r of rows) {
    String(r.agents || "").split(",").filter(Boolean).forEach((a) => { counts[a] = (counts[a] || 0) + 1; });
  }
  return Object.entries(counts).map(([agent, count]) => ({ agent, count })).sort((a, b) => b.count - a.count);
}
// 최근 질문 원문 목록(에러/포기 여부 포함) — 실제로 뭘 물어보고 어디서 실패하는지 눈으로 확인.
function getRecentQuestions(limit) {
  return db
    .prepare("SELECT job_id, user_id, question, status, error_message, created_at FROM job_log WHERE kind = 'pipeline' ORDER BY id DESC LIMIT ?")
    .all(limit || 30);
}

/* ────────────────────────── AI 호출 원가 로그 ────────────────────────── */

const logAiCostStmt = db.prepare(
  `INSERT INTO ai_cost_log (user_id, job_id, role_key, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, at)
   VALUES (@userId, @jobId, @roleKey, @model, @promptTokens, @completionTokens, @totalTokens, @costUsd, @at)`
);
function logAiCost(entry) {
  logAiCostStmt.run({
    userId: entry.userId || null,
    jobId: entry.jobId || null,
    roleKey: entry.roleKey || null,
    model: entry.model || null,
    promptTokens: entry.promptTokens == null ? null : entry.promptTokens,
    completionTokens: entry.completionTokens == null ? null : entry.completionTokens,
    totalTokens: entry.totalTokens == null ? null : entry.totalTokens,
    costUsd: entry.costUsd == null ? null : entry.costUsd,
    at: entry.at,
  });
}
// 역할별 누적 원가 요약 — 요금제 원가율을 계산할 때 쓴다.
function getCostSummaryByRole(sinceIso) {
  const where = sinceIso ? "WHERE at >= ?" : "";
  const params = sinceIso ? [sinceIso] : [];
  return db
    .prepare(
      `SELECT role_key, COUNT(*) as calls, SUM(cost_usd) as total_cost_usd, AVG(cost_usd) as avg_cost_usd, SUM(total_tokens) as total_tokens
       FROM ai_cost_log ${where} GROUP BY role_key ORDER BY total_cost_usd DESC`
    )
    .all(...params);
}

/* ────────────────────────── 만족도 피드백 ────────────────────────── */

const addFeedbackStmt = db.prepare(
  `INSERT INTO feedback (user_id, job_id, rating, at) VALUES (?, ?, ?, ?)`
);
const trimFeedbackStmt = db.prepare(
  `DELETE FROM feedback WHERE id NOT IN (SELECT id FROM feedback ORDER BY id DESC LIMIT 500)`
);
function addFeedback(f) {
  addFeedbackStmt.run(f.userId, f.jobId, f.rating, f.at);
  trimFeedbackStmt.run();
}
function getFeedbackStats() {
  return db.prepare("SELECT rating, COUNT(*) as count FROM feedback GROUP BY rating").all();
}

/* ────────────────────────── 관리자 대시보드 — 회원 현황 ────────────────────────── */

function getUserStats() {
  const total = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  const guests = db.prepare("SELECT COUNT(*) as c FROM users WHERE guest = 1").get().c;
  const real = total - guests;
  const paidUsers = db.prepare("SELECT COUNT(DISTINCT user_id) as c FROM orders WHERE status = 'paid'").get().c;
  return { total, guests, real, paidUsers };
}
// created_at이 "오전 03:20" 같은 시각만 담긴 문자열이라 날짜별 집계는 못 하고(가입 순서만 있음),
// 최근 가입한 회원 목록으로 대신 보여준다.
function getRecentSignups(limit) {
  return db
    .prepare("SELECT id, email, guest, credits, created_at FROM users ORDER BY rowid DESC LIMIT ?")
    .all(limit || 20)
    .map((r) => ({ id: r.id, email: r.email, guest: !!r.guest, credits: r.credits, createdAt: r.created_at }));
}

/* ────────────────────────── 자동 발행 (보관함 + 예약) ────────────────────────── */

function hydrateQueueItem(row) {
  return {
    id: row.id, name: row.name, price: row.price || "", imageUrl: row.image_url || "",
    category: row.category, status: row.status, error: row.error || null,
    createdAt: row.created_at, postedAt: row.posted_at || null,
  };
}
function addQueueItem(userId, item) {
  db.prepare(
    `INSERT INTO auto_queue (id, user_id, name, price, image_url, category, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(item.id, userId, item.name, item.price || "", item.imageUrl || "", item.category, item.createdAt);
}
function listQueue(userId, limit) {
  return db
    .prepare("SELECT * FROM auto_queue WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit || 50)
    .map(hydrateQueueItem);
}
function countPendingQueue(userId) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM auto_queue WHERE user_id = ? AND status = 'pending'").get(userId);
  return Number(row?.n || 0);
}
/** 예약 실행 때 꺼낼 다음 상품 — 먼저 담은 것부터(FIFO). */
function nextPendingQueueItem(userId) {
  const row = db
    .prepare("SELECT * FROM auto_queue WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 1")
    .get(userId);
  return row ? hydrateQueueItem(row) : null;
}
function markQueueItem(id, status, error, postedAt) {
  db.prepare("UPDATE auto_queue SET status = ?, error = ?, posted_at = ? WHERE id = ?")
    .run(status, error || null, postedAt || null, id);
}
function deleteQueueItem(userId, id) {
  db.prepare("DELETE FROM auto_queue WHERE id = ? AND user_id = ?").run(id, userId);
}

function hydrateSchedule(row) {
  if (!row) return null;
  return {
    userId: row.user_id, enabled: !!row.enabled, hour: row.hour, quantity: row.quantity,
    commentKeyword: row.comment_keyword, lastRunOn: row.last_run_on || null,
    lastResult: row.last_result || null,
  };
}
function getSchedule(userId) {
  return hydrateSchedule(db.prepare("SELECT * FROM auto_schedules WHERE user_id = ?").get(userId));
}
function upsertSchedule(userId, s) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO auto_schedules (user_id, enabled, hour, quantity, comment_keyword, created_at, updated_at)
     VALUES (@userId, @enabled, @hour, @quantity, @commentKeyword, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       enabled = excluded.enabled, hour = excluded.hour, quantity = excluded.quantity,
       comment_keyword = excluded.comment_keyword, updated_at = excluded.updated_at`
  ).run({
    userId, enabled: s.enabled ? 1 : 0, hour: s.hour, quantity: s.quantity,
    commentKeyword: s.commentKeyword || "정보", now,
  });
}
/** 오늘(KST) 아직 안 돈, 예약 시각이 지난 활성 예약들. */
function getDueSchedules(todayKst, hourKst) {
  return db
    .prepare(
      `SELECT * FROM auto_schedules
       WHERE enabled = 1 AND hour <= ? AND (last_run_on IS NULL OR last_run_on <> ?)`
    )
    .all(hourKst, todayKst)
    .map(hydrateSchedule);
}
function markScheduleRun(userId, todayKst, result) {
  db.prepare("UPDATE auto_schedules SET last_run_on = ?, last_result = ?, updated_at = ? WHERE user_id = ?")
    .run(todayKst, String(result || "").slice(0, 300), new Date().toISOString(), userId);
}

/* ────────────────────────── 수익 기록 ────────────────────────── */

/** (date, channel) 하나만 유지 — 다시 당겨도 중복 없이 최신 값으로 덮어쓴다. */
function upsertRevenue(userId, e) {
  db.prepare(
    `INSERT INTO revenue_entries (user_id, date, channel, amount, clicks, orders, source, updated_at)
     VALUES (@userId, @date, @channel, @amount, @clicks, @orders, @source, @updatedAt)
     ON CONFLICT(user_id, date, channel) DO UPDATE SET
       amount = excluded.amount, clicks = excluded.clicks, orders = excluded.orders,
       source = excluded.source, updated_at = excluded.updated_at`
  ).run({
    userId, date: e.date, channel: e.channel,
    amount: Math.round(Number(e.amount) || 0),
    clicks: e.clicks == null ? null : Math.round(Number(e.clicks) || 0),
    orders: e.orders == null ? null : Math.round(Number(e.orders) || 0),
    source: e.source || "manual", updatedAt: new Date().toISOString(),
  });
}
function upsertRevenueMany(userId, entries) {
  const run = db.transaction((list) => { list.forEach((e) => upsertRevenue(userId, e)); });
  run(entries);
}
function deleteRevenue(userId, date, channel) {
  db.prepare("DELETE FROM revenue_entries WHERE user_id = ? AND date = ? AND channel = ?")
    .run(userId, date, channel);
}
/** fromDate(포함) 이후 기록. 대시보드의 합계·추이·채널별 집계가 모두 여기서 나온다. */
function listRevenue(userId, fromDate) {
  return db
    .prepare(
      `SELECT date, channel, amount, clicks, orders, source FROM revenue_entries
       WHERE user_id = ? AND date >= ? ORDER BY date DESC`
    )
    .all(userId, fromDate)
    .map((r) => ({
      date: r.date, channel: r.channel, amount: r.amount,
      clicks: r.clicks, orders: r.orders, source: r.source,
    }));
}
function getRevenueTotal(userId, fromDate, toDate) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) AS total FROM revenue_entries
       WHERE user_id = ? AND date >= ? AND date <= ?`
    )
    .get(userId, fromDate, toDate);
  return Number(row?.total || 0);
}

function getRevenueKey(userId, channel) {
  const row = db.prepare("SELECT * FROM revenue_keys WHERE user_id = ? AND channel = ?").get(userId, channel);
  if (!row) return null;
  return {
    channel: row.channel, accessKeyEnc: row.access_key_enc, secretKeyEnc: row.secret_key_enc,
    lastSyncedAt: row.last_synced_at || null, lastError: row.last_error || null,
  };
}
function setRevenueKey(userId, channel, accessKeyEnc, secretKeyEnc) {
  db.prepare(
    `INSERT INTO revenue_keys (user_id, channel, access_key_enc, secret_key_enc, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel) DO UPDATE SET
       access_key_enc = excluded.access_key_enc, secret_key_enc = excluded.secret_key_enc,
       last_error = NULL, updated_at = excluded.updated_at`
  ).run(userId, channel, accessKeyEnc, secretKeyEnc, new Date().toISOString());
}
function deleteRevenueKey(userId, channel) {
  db.prepare("DELETE FROM revenue_keys WHERE user_id = ? AND channel = ?").run(userId, channel);
}
function markRevenueSync(userId, channel, error) {
  db.prepare("UPDATE revenue_keys SET last_synced_at = ?, last_error = ? WHERE user_id = ? AND channel = ?")
    .run(new Date().toISOString(), error ? String(error).slice(0, 300) : null, userId, channel);
}
/** 자동 수집 스케줄러가 쓴다 — 키가 등록된 모든 사용자. */
function listRevenueKeyUsers(channel) {
  return db
    .prepare("SELECT user_id FROM revenue_keys WHERE channel = ? AND access_key_enc IS NOT NULL")
    .all(channel)
    .map((r) => r.user_id);
}

/* ────────────────────────── 틱톡 연동 ────────────────────────── */

function getTiktokAccount(userId) {
  const row = db.prepare("SELECT * FROM tiktok_accounts WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    userId: row.user_id, openId: row.open_id, displayName: row.display_name,
    accessTokenEnc: row.access_token_enc, refreshTokenEnc: row.refresh_token_enc,
    accessExpiresAt: row.access_expires_at, scope: row.scope, lastError: row.last_error || null,
  };
}
function upsertTiktokAccount(userId, a) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tiktok_accounts (user_id, open_id, display_name, access_token_enc, refresh_token_enc,
       access_expires_at, scope, last_error, created_at, updated_at)
     VALUES (@userId, @openId, @displayName, @accessTokenEnc, @refreshTokenEnc, @accessExpiresAt, @scope, NULL, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       open_id = excluded.open_id, display_name = excluded.display_name,
       access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
       access_expires_at = excluded.access_expires_at, scope = excluded.scope,
       last_error = NULL, updated_at = excluded.updated_at`
  ).run({
    userId, openId: a.openId || null, displayName: a.displayName || null,
    accessTokenEnc: a.accessTokenEnc, refreshTokenEnc: a.refreshTokenEnc,
    accessExpiresAt: a.accessExpiresAt, scope: a.scope || null, now,
  });
}
function deleteTiktokAccount(userId) {
  db.prepare("DELETE FROM tiktok_accounts WHERE user_id = ?").run(userId);
}
function markTiktokError(userId, error) {
  db.prepare("UPDATE tiktok_accounts SET last_error = ?, updated_at = ? WHERE user_id = ?")
    .run(error ? String(error).slice(0, 300) : null, new Date().toISOString(), userId);
}

/* ────────────────────────── 유튜브 연동 ────────────────────────── */

function getYoutubeAccount(userId) {
  const row = db.prepare("SELECT * FROM youtube_accounts WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    userId: row.user_id, channelTitle: row.channel_title,
    accessTokenEnc: row.access_token_enc, refreshTokenEnc: row.refresh_token_enc,
    accessExpiresAt: row.access_expires_at, lastError: row.last_error || null,
  };
}
/**
 * refreshTokenEnc가 null이면 기존 값을 유지한다 — 구글은 재동의 때 refresh_token을
 * 다시 주지 않는 경우가 있어서, 그대로 덮어쓰면 갱신 수단을 잃어버린다.
 */
function upsertYoutubeAccount(userId, a) {
  const now = new Date().toISOString();
  const existing = getYoutubeAccount(userId);
  db.prepare(
    `INSERT INTO youtube_accounts (user_id, channel_title, access_token_enc, refresh_token_enc,
       access_expires_at, last_error, created_at, updated_at)
     VALUES (@userId, @channelTitle, @accessTokenEnc, @refreshTokenEnc, @accessExpiresAt, NULL, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       channel_title = excluded.channel_title,
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       access_expires_at = excluded.access_expires_at,
       last_error = NULL, updated_at = excluded.updated_at`
  ).run({
    userId,
    channelTitle: a.channelTitle != null ? a.channelTitle : existing?.channelTitle || null,
    accessTokenEnc: a.accessTokenEnc,
    refreshTokenEnc: a.refreshTokenEnc || existing?.refreshTokenEnc || null,
    accessExpiresAt: a.accessExpiresAt, now,
  });
}
function deleteYoutubeAccount(userId) {
  db.prepare("DELETE FROM youtube_accounts WHERE user_id = ?").run(userId);
}
function markYoutubeError(userId, error) {
  db.prepare("UPDATE youtube_accounts SET last_error = ?, updated_at = ? WHERE user_id = ?")
    .run(error ? String(error).slice(0, 300) : null, new Date().toISOString(), userId);
}

/* ────────────────────────── 워드프레스 연동 ────────────────────────── */

function getWordpressSite(userId) {
  const row = db.prepare("SELECT * FROM wordpress_sites WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    userId: row.user_id, siteUrl: row.site_url, username: row.username,
    appPasswordEnc: row.app_password_enc, displayName: row.display_name,
    lastError: row.last_error || null,
  };
}
function upsertWordpressSite(userId, s) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO wordpress_sites (user_id, site_url, username, app_password_enc, display_name, last_error, created_at, updated_at)
     VALUES (@userId, @siteUrl, @username, @appPasswordEnc, @displayName, NULL, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       site_url = excluded.site_url, username = excluded.username,
       app_password_enc = excluded.app_password_enc, display_name = excluded.display_name,
       last_error = NULL, updated_at = excluded.updated_at`
  ).run({
    userId, siteUrl: s.siteUrl, username: s.username,
    appPasswordEnc: s.appPasswordEnc, displayName: s.displayName || null, now,
  });
}
function deleteWordpressSite(userId) {
  db.prepare("DELETE FROM wordpress_sites WHERE user_id = ?").run(userId);
}
function markWordpressError(userId, error) {
  db.prepare("UPDATE wordpress_sites SET last_error = ?, updated_at = ? WHERE user_id = ?")
    .run(error ? String(error).slice(0, 300) : null, new Date().toISOString(), userId);
}

/* ────────────────────────── 영상 생성 로그 ────────────────────────── */

function logVideoAttempt(userId, a) {
  db.prepare(
    `INSERT INTO video_jobs (user_id, category, service, ok, error, duration_sec, cost_usd, elapsed_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId, a.category, a.service, a.ok ? 1 : 0, a.error || null,
    a.durationSec == null ? null : Number(a.durationSec),
    a.costUsd == null ? null : Number(a.costUsd),
    a.elapsedMs == null ? null : Math.round(a.elapsedMs),
    new Date().toISOString(),
  );
}
/** 서비스별 성공률·평균 시간·누적 비용 — 어디에 돈이 새는지 보기 위한 집계. */
function getVideoServiceStats() {
  return db
    .prepare(
      `SELECT service,
              COUNT(*) AS attempts,
              SUM(ok) AS successes,
              ROUND(AVG(elapsed_ms) / 1000.0, 1) AS avg_sec,
              ROUND(SUM(COALESCE(cost_usd, 0)), 4) AS total_usd
       FROM video_jobs GROUP BY service ORDER BY attempts DESC`
    )
    .all()
    .map((r) => ({
      service: r.service,
      attempts: r.attempts,
      successes: r.successes || 0,
      successRate: r.attempts ? Math.round(((r.successes || 0) / r.attempts) * 100) : 0,
      avgSec: r.avg_sec,
      totalUsd: r.total_usd,
    }));
}
/** 이번 달 사용자별 영상 원가 — 요금제 대비 적자 감시용. */
function getUserVideoCostThisMonth(userId, monthPrefix) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS n
       FROM video_jobs WHERE user_id = ? AND ok = 1 AND created_at LIKE ?`
    )
    .get(userId, monthPrefix + "%");
  return { usd: Number(row?.usd || 0), count: Number(row?.n || 0) };
}

/* ────────────────────────── 스마트스토어 연동 ────────────────────────── */

function getSmartstoreAccount(userId) {
  const row = db.prepare("SELECT * FROM smartstore_accounts WHERE user_id = ?").get(userId);
  if (!row) return null;
  return {
    userId: row.user_id, clientId: row.client_id, clientSecretEnc: row.client_secret_enc,
    sellerName: row.seller_name, lastError: row.last_error || null,
  };
}
function upsertSmartstoreAccount(userId, a) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO smartstore_accounts (user_id, client_id, client_secret_enc, seller_name, last_error, created_at, updated_at)
     VALUES (@userId, @clientId, @clientSecretEnc, @sellerName, NULL, @now, @now)
     ON CONFLICT(user_id) DO UPDATE SET
       client_id = excluded.client_id, client_secret_enc = excluded.client_secret_enc,
       seller_name = excluded.seller_name, last_error = NULL, updated_at = excluded.updated_at`
  ).run({ userId, clientId: a.clientId, clientSecretEnc: a.clientSecretEnc, sellerName: a.sellerName || null, now });
}
function deleteSmartstoreAccount(userId) {
  db.prepare("DELETE FROM smartstore_accounts WHERE user_id = ?").run(userId);
}
function markSmartstoreError(userId, error) {
  db.prepare("UPDATE smartstore_accounts SET last_error = ?, updated_at = ? WHERE user_id = ?")
    .run(error ? String(error).slice(0, 300) : null, new Date().toISOString(), userId);
}


/* ────────────────────────── 인스타 키우기 ────────────────────────── */

function hydrateTarget(r) {
  if (!r) return null;
  return {
    topic: r.topic, audience: r.audience, tone: r.tone, hashtags: r.hashtags || "",
    postsPerWeek: r.posts_per_week, reelRatio: r.reel_ratio, hour: r.hour, enabled: !!r.enabled,
  };
}
function getIgTarget(userId) {
  return hydrateTarget(db.prepare("SELECT * FROM ig_targets WHERE user_id = ?").get(userId));
}
function upsertIgTarget(userId, t) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO ig_targets (user_id, topic, audience, tone, hashtags, posts_per_week, reel_ratio, hour, enabled, created_at, updated_at)" +
    " VALUES (@userId, @topic, @audience, @tone, @hashtags, @postsPerWeek, @reelRatio, @hour, @enabled, @now, @now)" +
    " ON CONFLICT(user_id) DO UPDATE SET" +
    "   topic = excluded.topic, audience = excluded.audience, tone = excluded.tone," +
    "   hashtags = excluded.hashtags, posts_per_week = excluded.posts_per_week," +
    "   reel_ratio = excluded.reel_ratio, hour = excluded.hour, enabled = excluded.enabled," +
    "   updated_at = excluded.updated_at"
  ).run({
    userId, topic: t.topic, audience: t.audience, tone: t.tone || "친근함", hashtags: t.hashtags || "",
    postsPerWeek: t.postsPerWeek, reelRatio: t.reelRatio, hour: t.hour, enabled: t.enabled ? 1 : 0, now,
  });
}

function hydrateIgPost(r) {
  const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
  return {
    id: r.id, kind: r.kind, title: r.title, hook: r.hook,
    bullets: parse(r.bullets, []), caption: r.caption || "",
    status: r.status, scheduledFor: r.scheduled_for,
    mediaUrls: parse(r.media_urls, []), permalink: r.permalink || null,
    error: r.error || null, createdAt: r.created_at, postedAt: r.posted_at || null,
  };
}
function addIgPosts(userId, posts) {
  const stmt = db.prepare(
    "INSERT INTO ig_posts (id, user_id, kind, title, hook, bullets, caption, scheduled_for, created_at)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const now = new Date().toISOString();
  db.transaction((rows) => {
    for (const p of rows) {
      stmt.run(p.id, userId, p.kind, p.title, p.hook, JSON.stringify(p.bullets || []),
        p.caption || "", p.scheduledFor, now);
    }
  })(posts);
}
function listIgPosts(userId, limit) {
  return db.prepare("SELECT * FROM ig_posts WHERE user_id = ? ORDER BY scheduled_for ASC LIMIT ?")
    .all(userId, limit || 40).map(hydrateIgPost);
}
function deleteIgPost(userId, id) {
  db.prepare("DELETE FROM ig_posts WHERE id = ? AND user_id = ? AND status IN ('planned','failed')")
    .run(id, userId);
}
/** 예정 시각이 지난 '계획됨' 게시물. 한 주기에 몰아 올리지 않도록 호출부에서 순차 처리한다. */
function getDueIgPosts(nowKstSlot, limit) {
  return db.prepare(
    "SELECT * FROM ig_posts WHERE status = 'planned' AND scheduled_for <= ?" +
    " ORDER BY scheduled_for ASC LIMIT ?"
  ).all(nowKstSlot, limit || 5).map((r) => Object.assign(hydrateIgPost(r), { userId: r.user_id }));
}
function markIgPost(id, status, fields) {
  const f = fields || {};
  db.prepare(
    "UPDATE ig_posts SET status = ?, media_urls = COALESCE(?, media_urls)," +
    " permalink = COALESCE(?, permalink), error = ?, posted_at = COALESCE(?, posted_at)" +
    " WHERE id = ?"
  ).run(status, f.mediaUrls ? JSON.stringify(f.mediaUrls) : null,
    f.permalink || null, f.error || null, f.postedAt || null, id);
}
/** 같은 게시물이 두 번 올라가지 않도록, 집는 순간 posting으로 잠근다. */
function claimIgPost(id) {
  return db.prepare("UPDATE ig_posts SET status = 'posting' WHERE id = ? AND status = 'planned'")
    .run(id).changes === 1;
}

function recordIgGrowth(userId, onDate, followers, posts) {
  db.prepare(
    "INSERT INTO ig_growth (user_id, on_date, followers, posts) VALUES (?, ?, ?, ?)" +
    " ON CONFLICT(user_id, on_date) DO UPDATE SET followers = excluded.followers, posts = excluded.posts"
  ).run(userId, onDate, followers, posts);
}
function listIgGrowth(userId, days) {
  return db.prepare("SELECT on_date, followers, posts FROM ig_growth WHERE user_id = ? ORDER BY on_date DESC LIMIT ?")
    .all(userId, days || 30).reverse()
    .map((r) => ({ date: r.on_date, followers: r.followers, posts: r.posts }));
}

module.exports = {
  getSmartstoreAccount, upsertSmartstoreAccount, deleteSmartstoreAccount, markSmartstoreError,
  logVideoAttempt, getVideoServiceStats, getUserVideoCostThisMonth,
  getWordpressSite, upsertWordpressSite, deleteWordpressSite, markWordpressError,
  getYoutubeAccount, upsertYoutubeAccount, deleteYoutubeAccount, markYoutubeError,
  getTiktokAccount, upsertTiktokAccount, deleteTiktokAccount, markTiktokError,
  upsertRevenue, upsertRevenueMany, deleteRevenue, listRevenue, getRevenueTotal,
  getRevenueKey, setRevenueKey, deleteRevenueKey, markRevenueSync, listRevenueKeyUsers,
  getIgTarget, upsertIgTarget, addIgPosts, listIgPosts, deleteIgPost,
  getDueIgPosts, markIgPost, claimIgPost, recordIgGrowth, listIgGrowth,
  addQueueItem, listQueue, countPendingQueue, nextPendingQueueItem, markQueueItem, deleteQueueItem,
  getSchedule, upsertSchedule, getDueSchedules, markScheduleRun,
  getUserById, getUserByEmail, emailExists, createUser, updateCredits, updateCompany, setPromoOptout, setAccessUntil,
  addUsage, addCardnewsHistory,
  createOrder, getOrder, markOrderPaid, listPendingBankTransferOrders, rejectOrder,
  upsertSubscription, getSubscription, updateSubscriptionFields, getDueSubscriptions, getSubscriptionStats,
  getMemoryEntries, addMemoryEntry,
  getKnowledge, addKnowledge, deleteKnowledge,
  getDefaultKnowledge, addDefaultKnowledge, deleteDefaultKnowledge,
  setSocialInstagram, getSocialInstagramByIgUserId,
  addFeedback, getFeedbackStats,
  hasGuestDevice, recordGuestDevice,
  logAiCost, getCostSummaryByRole,
  createReferralCode, referralCodeExists, listReferralCodes, getReferralStats,
  createJobLog, updateJobLogStatus, getJobStats, getAgentPopularity, getRecentQuestions,
  getUserStats, getRecentSignups,
  logManagerVerdict, logCeoDecision, getQualityStats,
};
