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

  -- 체험(게스트) 입장을 "브라우저당 1회"로 제한하기 위한 기기 식별 기록.
  -- IP 하나에 여러 사람이 물려 있어도(같은 집 공유기, 통신사 CGNAT) 각자 브라우저는
  -- 다르므로, 쿠키로 발급한 기기 ID 기준으로 판단하면 IP만으로 볼 때보다 정확하다.
  CREATE TABLE IF NOT EXISTS guest_devices (
    device_id TEXT PRIMARY KEY,
    user_id TEXT,
    ip TEXT,
    created_at TEXT
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
    `INSERT INTO users (id, email, salt, hash, credits, ceiling, guest, company_name, company_logo, created_at)
     VALUES (@id, @email, @salt, @hash, @credits, @ceiling, @guest, '', '', @createdAt)`
  ).run({
    id: u.id, email: u.email, salt: u.salt || "", hash: u.hash || "",
    credits: u.credits, ceiling: u.ceiling, guest: u.guest ? 1 : 0, createdAt: u.createdAt,
  });
  return getUserById(u.id);
}
function updateCredits(id, credits, ceiling) {
  db.prepare("UPDATE users SET credits = ?, ceiling = ? WHERE id = ?").run(credits, ceiling, id);
}
function updateCompany(id, name, logo) {
  db.prepare("UPDATE users SET company_name = ?, company_logo = ? WHERE id = ?").run(name, logo, id);
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

module.exports = {
  getUserById, getUserByEmail, emailExists, createUser, updateCredits, updateCompany,
  addUsage, addCardnewsHistory,
  createOrder, getOrder, markOrderPaid,
  getMemoryEntries, addMemoryEntry,
  getKnowledge, addKnowledge, deleteKnowledge,
  setSocialInstagram, getSocialInstagramByIgUserId,
  addFeedback,
  hasGuestDevice, recordGuestDevice,
};
