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

  CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credits INTEGER, amount INTEGER, label TEXT, status TEXT, created_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);

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
    `INSERT INTO orders (order_id, user_id, credits, amount, label, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(orderId, o.userId, o.credits, o.amount, o.label, o.status, o.createdAt);
}
function getOrder(orderId) {
  return db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) || null;
}
function markOrderPaid(orderId) {
  db.prepare("UPDATE orders SET status = 'paid' WHERE order_id = ?").run(orderId);
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

module.exports = {
  getUserById, getUserByEmail, emailExists, createUser, updateCredits, updateCompany, setPromoOptout,
  addUsage, addCardnewsHistory,
  createOrder, getOrder, markOrderPaid,
  getMemoryEntries, addMemoryEntry,
  getKnowledge, addKnowledge, deleteKnowledge,
  setSocialInstagram, getSocialInstagramByIgUserId,
  addFeedback, getFeedbackStats,
  hasGuestDevice, recordGuestDevice,
  logAiCost, getCostSummaryByRole,
  createReferralCode, referralCodeExists, listReferralCodes, getReferralStats,
  createJobLog, updateJobLogStatus, getJobStats, getAgentPopularity, getRecentQuestions,
  getUserStats, getRecentSignups,
};
