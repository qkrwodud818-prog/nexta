/**
 * 가상오피스 — AI 직원팀 서버 (신트라 방식: 고정 역할 + 총괄AI 구조)
 *
 * 구조 요약 (비전공자용):
 *   대표(사용자)가 업무를 시키면서, 어떤 담당자(들)를 쓸지 고른다.
 *   1) 고른 담당자들이 서로 대화 없이 각자 독립적으로 일한다 (병렬로 동시에).
 *      - 담당자마다 "지난 작업 기억"과 "대표님이 등록해 둔 전문 지식"을 참고해서 일한다.
 *   2) 총괄AI가 모든 담당자의 결과물을 모아서 검사한다.
 *      - 근거가 부실하면 그 담당자에게만 다시 시킨다 (다른 담당자는 그대로 둠).
 *      - 통과하면 대표님 눈높이에 맞게 정리한 보고서 + 저장 위치 추천을 만든다.
 *   3) 대표에게 올려서 승인 또는 보완 요청을 받는다.
 *
 * 진행 상황은 일이 벌어지는 즉시 화면으로 보내진다(SSE).
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const { generateCardNews } = require("./social/cardnews");
const { publishCarouselPost, verifyWebhook, handleCommentWebhook } = require("./social/instagram");
const db = require("./db"); // SQLite(better-sqlite3) 기반 저장소 — data/nexta.db

const app = express();
app.set("trust proxy", 1); // Render 등 프록시 뒤에서도 req.ip가 실제 접속자 IP를 가리키게 함
app.disable("x-powered-by"); // "Express를 쓴다"는 것 자체를 응답 헤더로 광고하지 않는다
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
// verify 콜백으로 원본 바이트를 남겨둔다 — 인스타그램 웹훅 서명 검증에 필요(아래 참고).
app.use(express.json({ limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

// 인플루언서 추천 링크(?ref=코드)로 들어오면, 나중에 회원가입할 때 "누가 데려왔는지" 알 수 있도록
// 90일짜리 쿠키에 코드를 기억해둔다. 등록된 코드가 아니면 무시한다(장난으로 아무 값이나 붙여도 안 남게).
const REF_COOKIE_MAX_AGE = 60 * 60 * 24 * 90;
app.use((req, res, next) => {
  const ref = req.query && req.query.ref;
  if (ref && /^[a-zA-Z0-9_-]{2,40}$/.test(ref) && db.referralCodeExists(ref)) {
    res.setHeader("Set-Cookie", "vo_ref=" + encodeURIComponent(ref) + "; Path=/; Max-Age=" + REF_COOKIE_MAX_AGE + "; SameSite=Lax");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// 실제 주소. (테스트할 때만 OPENROUTER_URL 환경변수로 가짜 서버를 가리킬 수 있다)
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MAX_MANAGER_RETRY = 1;  // 총괄AI가 반려했을 때, 그 담당자만 다시 시키는 최대 횟수
const MAX_CEO_ROUNDS = 3;     // 대표가 보완 요청할 수 있는 최대 횟수
const JOB_TTL_MS = 60 * 60 * 1000; // 1시간 지나면 메모리에서 정리

/* ────────────────────────── 공통 유틸 ────────────────────────── */

function parseJSON(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* 아래로 */ }
    }
    return null;
  }
}

function loadModelConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config", "models.json"), "utf-8");
  return JSON.parse(raw);
}

// 모델 ID를 사람이 보기 좋은 이름으로 (화면에는 회사 이름만 보여준다)
function friendlyModel(entry) {
  return String(entry.provider || "").replace(/\s*\(무료\)\s*/, "").trim() || "AI";
}

/* ────────────────────── 모델 선택(자동 전환) / 호출 ────────────────────── */

/**
 * 신트라처럼: 역할마다 "경제형"과 "품질형" 모델 풀을 두고, 상황에 맞게 자동으로 골라 쓴다.
 * - 담당자(조사·작성 등)는 경제형(무료) 모델을 먼저 쓰고, 실패하면 자동으로 품질 TOP5로 전환한다.
 * - 총괄AI(검수·판단)처럼 신뢰도가 중요한 역할은 처음부터 품질 TOP5를 쓴다.
 * - 여러 담당자가 같은 모델만 쓰지 않도록, 배정된 rank만큼 순서를 회전시켜 자연히 다른 회사
 *   모델(Anthropic/OpenAI/Google/DeepSeek 등)이 섞여 쓰이게 한다 — 신트라의 "모델 풀 자동 전환"과 동일한 방식.
 */
function resolveCandidates(config, roleKey) {
  const assignment = config.역할배정[roleKey];
  if (!assignment) throw new Error("역할 배정이 없습니다: " + roleKey);

  const rotate = (list, startIndex) => {
    if (!list.length) return [];
    const i = ((startIndex % list.length) + list.length) % list.length;
    return list.slice(i).concat(list.slice(0, i));
  };

  const quality = [...config.품질_TOP5]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ model: r.model, provider: r.provider }));

  const qualityFrom = (startRank) => rotate(quality, (startRank || 1) - 1);

  if (assignment.pool === "경제") {
    const economy = config.경제형_모델.map((e) => ({ model: e.model, provider: e.provider }));
    return rotate(economy, (assignment.rank || 1) - 1).concat(qualityFrom(assignment.rank));
  }
  return qualityFrom(assignment.rank);
}

/**
 * OpenRouter 호출.
 * 웹검색은 모델 이름 뒤에 ":online"을 붙이는 방식이 아니라 plugins 파라미터로 지정한다.
 */
async function callOpenRouter(model, prompt, useSearch, maxTokens) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("API_KEY_MISSING");
  }
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens || 1600,
    usage: { include: true }, // 응답에 실제 원가(달러)를 같이 받는다 — 요금제 원가율 계산용
  };
  if (useSearch) {
    body.plugins = [{ id: "web", max_results: 5 }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENROUTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("OpenRouter 오류(" + res.status + "): " + errText.slice(0, 300));
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && msg.content;
  if (!text || !String(text).trim()) throw new Error("응답이 비어 있음");

  const citations = (msg.annotations || [])
    .filter((a) => a && a.type === "url_citation" && a.url_citation)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url }));

  const usage = data.usage || {};
  return {
    text: String(text).trim(),
    citations,
    usage: {
      promptTokens: usage.prompt_tokens != null ? usage.prompt_tokens : null,
      completionTokens: usage.completion_tokens != null ? usage.completion_tokens : null,
      totalTokens: usage.total_tokens != null ? usage.total_tokens : null,
      costUsd: usage.cost != null ? usage.cost : null,
    },
  };
}

// userId/jobId/roleKey는 원가 로그에 남기기 위한 값(생략 가능 — 없으면 그냥 기록을 안 남긴다).
async function callWithFallback(config, roleKey, prompt, useSearch, maxTokens, logCtx) {
  const candidates = resolveCandidates(config, roleKey);
  let lastError = null;
  for (const entry of candidates) {
    try {
      const result = await callOpenRouter(entry.model, prompt, useSearch, maxTokens);
      // 원가 기록은 부가 기능이다 — 여기서 오류가 나도 방금 성공한 응답을 버리면 안 된다.
      if (logCtx) {
        try {
          db.logAiCost({
            userId: logCtx.userId, jobId: logCtx.jobId, roleKey,
            model: entry.model,
            promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens, costUsd: result.usage.costUsd,
            at: new Date().toISOString(),
          });
        } catch (logErr) {
          console.warn("[원가 로그 기록 실패 — 응답 자체는 정상 처리]", logErr.message);
        }
      }
      return { text: result.text, citations: result.citations, modelUsed: friendlyModel(entry), modelId: entry.model };
    } catch (err) {
      if (err.message === "API_KEY_MISSING") throw err;
      lastError = err;
      console.warn("[모델 실패 → 다음 모델로]", entry.model, "-", err.message);
    }
  }
  throw lastError || new Error("모든 모델 호출에 실패했습니다");
}

/* ────────────────────── 회원 · 로그인(세션) · 크레딧 ──────────────────────
 * 상품형: 여러 고객이 각자 가입해서 자기 크레딧으로 사용한다.
 * data/nexta.db (SQLite)에 저장한다 — 실제 DB이므로 사용자별 행만 갱신되고
 * 동시 요청에도 안전하다. 단, 무료 호스팅(Render 등)에서 재배포 시 디스크가
 * 초기화될 수 있는 문제는 별개다 — 영구 디스크가 필요하면 README 참고.
 * ⚠️ 실제 결제(돈 받기)는 아직 없다. '충전'은 테스트용으로 크레딧만 올려준다.
 *    나중에 이 자리에 토스페이먼츠 등 결제대행사(PG)를 연결한다. (아래 /api/topup 참고)
 */
const SESSION_SECRET = process.env.SESSION_SECRET || "virtual-office-dev-secret-change-me";
const SIGNUP_BONUS = 300;   // 가입 시 무료로 주는 크레딧
const TEST_TOPUP = 300;     // 테스트 충전 1회당 올려주는 크레딧
const COST_PER_AGENT = 10;  // 담당자 1명당 차감 크레딧
const COST_MANAGER = 20;    // 총괄AI 검수 차감 크레딧
const COST_CARDNEWS = 30;   // 카드뉴스 1건 생성 시 차감 크레딧

// 결제(토스페이먼츠) — 사업자가 실제 가맹 승인을 받으면 .env의 TOSS_CLIENT_KEY / TOSS_SECRET_KEY를
// 라이브 키(live_ck_..., live_sk_...)로 교체하기만 하면 된다. 지금은 테스트 키가 없으면 결제 버튼이
// "준비 중" 안내로 대체되어, 실서비스처럼 보이되 잘못된 키로 결제 시도가 되는 일은 없다.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || "";
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || "";
const CREDIT_PACKAGES = {
  small: { credits: 500, amount: 5000, label: "500 크레딧" },
  medium: { credits: 1500, amount: 12000, label: "1,500 크레딧 (20% 더)" },
  large: { credits: 4000, amount: 28000, label: "4,000 크레딧 (30% 더)" },
};

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch (e) { return false; }
}
function signValue(value) {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return value + "." + sig;
}
function unsignValue(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i), sig = signed.slice(i + 1);
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch (e) { return null; }
  return value;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// CSRF 토큰 — 로그인 시 세션 쿠키와 함께 "읽을 수 있는" 쿠키로 발급하고, 화면단(JS)이 이 값을
// 그대로 X-CSRF-Token 헤더에 실어 보내게 한다(더블 서브밋 쿠키 방식). 공격자의 다른 사이트는
// 이 쿠키값을 읽을 수 없으므로(Same-Origin 정책) 값을 맞춰 보낼 수 없다.
function makeCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}
// 한 응답 안에서 setSession/clearSession/기기쿠키 등 여러 곳이 각자 쿠키를 하나씩 추가해도
// 서로 덮어쓰지 않도록 Set-Cookie 헤더를 누적한다(res.setHeader는 기본적으로 통째로 교체함).
function addCookie(res, cookieStr) {
  const existing = res.getHeader("Set-Cookie");
  const arr = existing ? (Array.isArray(existing) ? existing.slice() : [existing]) : [];
  arr.push(cookieStr);
  res.setHeader("Set-Cookie", arr);
}
function setSession(res, userId) {
  const token = encodeURIComponent(signValue(userId));
  const maxAge = 60 * 60 * 24 * 30;
  const csrf = makeCsrfToken();
  addCookie(res, "vo_session=" + token + "; HttpOnly; Path=/; Max-Age=" + maxAge + "; SameSite=Lax");
  addCookie(res, "vo_csrf=" + csrf + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax");
}
function clearSession(res) {
  addCookie(res, "vo_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
  addCookie(res, "vo_csrf=; Path=/; Max-Age=0; SameSite=Lax");
}
// 체험(게스트) 입장을 "브라우저당 1회"로 제한하기 위한 기기 식별 쿠키.
// 쿠키를 지우면 다시 체험할 수 있지만, 최소한 무심코 여러 번 누르는 것과 의도적으로
// 계속 초기화하는 것 사이의 문턱은 만들어준다. IP 상한과 함께 써서 이중으로 막는다.
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // 브라우저가 허용하는 쿠키 최대 수명(약 400일)
function getOrCreateDeviceId(req, res) {
  const existing = parseCookies(req).vo_device;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const id = crypto.randomBytes(16).toString("hex");
  addCookie(res, "vo_device=" + id + "; HttpOnly; Path=/; Max-Age=" + DEVICE_COOKIE_MAX_AGE + "; SameSite=Lax");
  return id;
}
// 세션을 바꾸지 않는 상태변경 요청(POST/PUT/DELETE)을 검사한다. 로그인 전 접근하는
// signup/login/guest, 그리고 메타(인스타그램)가 서버 대 서버로 직접 호출하는 웹훅은
// 브라우저 쿠키를 쓰지 않으므로 검사 대상에서 제외한다.
// /api/admin/*은 쿠키 세션이 아니라 별도 비밀키(ADMIN_KEY)로 보호되므로 CSRF 대상이 아니다
// (공격자 페이지가 그 키 값을 알 방법이 없어 위조 요청을 만들 수 없다).
const CSRF_EXEMPT_PATHS = new Set(["/api/signup", "/api/login", "/api/guest", "/webhooks/instagram"]);
function isCsrfExempt(path) {
  return CSRF_EXEMPT_PATHS.has(path) || path.indexOf("/api/admin/") === 0;
}
function csrfProtection(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (isCsrfExempt(req.path)) return next();
  const cookieToken = parseCookies(req).vo_csrf;
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "요청이 올바르지 않습니다. 새로고침 후 다시 시도해 주세요." });
  }
  next();
}
app.use(csrfProtection);

// 로그인 유지(슬라이딩 세션) — 로그인 쿠키는 30일짜리인데, 그동안 한 번이라도 사이트를 쓰면
// 만료 시각을 다시 30일 뒤로 늘려준다. 그래서 계속 방문하는 한 로그아웃을 직접 누르기 전까지는
// 로그인 상태가 계속 유지된다. 정적 파일(이미지 등) 요청까지는 굳이 늘릴 필요 없어 건너뛴다.
app.use((req, res, next) => {
  if (req.path.startsWith("/assets/") || req.path.startsWith("/cardnews/")) return next();
  const cookies = parseCookies(req);
  if (cookies.vo_session && cookies.vo_csrf) {
    const maxAge = 60 * 60 * 24 * 30;
    addCookie(res, "vo_session=" + cookies.vo_session + "; HttpOnly; Path=/; Max-Age=" + maxAge + "; SameSite=Lax");
    addCookie(res, "vo_csrf=" + cookies.vo_csrf + "; Path=/; Max-Age=" + maxAge + "; SameSite=Lax");
  }
  next();
});

// 결제·비밀정보 암호화 — 인스타그램 액세스 토큰처럼 그대로 새어나가면 계정을 탈취당할 수 있는
// 값은 파일에 평문으로 저장하지 않는다. SESSION_SECRET에서 파생한 키로 AES-256-GCM 암호화한다.
const ENCRYPTION_KEY = crypto.createHash("sha256").update(String(SESSION_SECRET)).digest();
function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function decryptSecret(payload) {
  const buf = Buffer.from(String(payload), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
function currentUser(req) {
  const userId = unsignValue(parseCookies(req).vo_session);
  if (!userId) return null;
  return db.getUserById(userId);
}
function publicUser(u) {
  return {
    email: u.email,
    credits: u.credits,
    ceiling: u.ceiling || u.credits || 1,
    usage: (u.usage || []).slice(-12).reverse(),
    company: u.company || { name: "", logo: "" },
    cardnewsHistory: (u.cardnewsHistory || []).slice(-20).reverse(),
    promoOptout: !!u.promoOptout,
  };
}
// 작업이 실제로 끝나(보고서가 나온) 시점에 한 번만 차감한다 — 도중에 오류가 나면 차감하지 않는다.
function chargeUser(userId, amount, meta) {
  const u = db.getUserById(userId);
  if (!u) return null;
  const credits = Math.max(0, (u.credits || 0) - amount);
  db.updateCredits(userId, credits, u.ceiling);
  db.addUsage(userId, Object.assign({ at: nowKR(), amount }, meta || {}));
  return credits;
}

function getMemoryContext(userId, roleKey) {
  const recent = db.getMemoryEntries(userId, roleKey, 5);
  if (!recent.length) return "";
  return (
    "[지난 작업 기억 — 예전에 이 담당자가 했던 일이다. 참고만 하고, 이번 지시를 우선한다]\n" +
    recent.map((m, i) => (i + 1) + ". (" + m.date + ") 질문: " + m.question + " → 그때 결과 요약: " + m.summary).join("\n") +
    "\n\n"
  );
}
function addMemory(userId, roleKey, question, summary) {
  db.addMemoryEntry(userId, roleKey, {
    date: nowKR(),
    question: String(question || "").slice(0, 200),
    summary: String(summary || "").slice(0, 300),
  });
}

function getKnowledgeContext(userId, role) {
  const list = db.getKnowledge(userId, role);
  if (!list.length) return "";
  let joined = list.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
  if (joined.length > 6000) joined = joined.slice(0, 6000) + "\n...(자료가 길어 일부만 표시됨)";
  return (
    "[대표님이 미리 등록해 둔 전문 지식/참고자료 — 이 내용을 최우선 참고 자료로 활용한다]\n" +
    joined + "\n\n"
  );
}

// 브랜드 가이드 — 특정 담당자 전용이 아니라 '모든' 담당자가 공통으로 지켜야 하는 말투·금칙어·규칙.
const BRAND_KEY = "브랜드가이드";
function getBrandContext(userId) {
  const list = db.getKnowledge(userId, BRAND_KEY);
  if (!list.length) return "";
  let joined = list.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
  if (joined.length > 3000) joined = joined.slice(0, 3000) + "\n...(생략)";
  return (
    "[브랜드 가이드 — 모든 답변에서 반드시 지킬 말투·금칙어·표기 규칙. 이 규칙을 최우선으로 지킨다]\n" +
    joined + "\n\n"
  );
}

/* ────────────────────── 작업(job) 관리 + 실시간 전송 ────────────────────── */

const jobs = new Map();

function createJob(question, agentKeys, userId, cost, quick) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    question,
    agentKeys,
    userId,
    cost: cost || 0,
    quick: !!quick,
    charged: false,
    events: [],
    listeners: [],
    finished: false,
    ceoResolve: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function nowKR() {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Seoul",
  });
}

function emit(job, event) {
  if (!event.time) event.time = nowKR();
  job.events.push(event);
  const payload = "data: " + JSON.stringify(event) + "\n\n";
  for (const res of job.listeners) {
    try { res.write(payload); } catch (e) { /* 끊긴 화면은 무시 */ }
  }
}
// 통계용 기록일 뿐이다 — 여기서 실패한다고 이미 잘 진행되던(또는 성공한) 실제 업무를
// "에러"로 뒤집으면 안 되므로 항상 조용히 실패를 삼킨다.
function safeUpdateJobLogStatus(jobId, status, errorMessage, updatedAt) {
  try { db.updateJobLogStatus(jobId, status, errorMessage, updatedAt); }
  catch (e) { console.warn("[업무 기록 갱신 실패 — 무시하고 계속]", e.message); }
}
function safeCreateJobLog(jobId, userId, kind, question, agents, createdAt) {
  try { db.createJobLog(jobId, userId, kind, question, agents, createdAt); }
  catch (e) { console.warn("[업무 기록 생성 실패 — 무시하고 계속]", e.message); }
}

function waitForCeo(job) {
  return new Promise((resolve) => { job.ceoResolve = resolve; });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      for (const res of job.listeners) { try { res.end(); } catch (e) {} }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

/* ────────────────────────── 담당자(직원) 정의 ──────────────────────────
 * 신트라와 동일하게: 역할이 고정되어 있고, 대표가 이번 업무에 어떤 담당자를 쓸지 고른다.
 * 담당자끼리는 서로 대화하지 않는다 — 전부 총괄AI에게만 결과를 보고한다.
 */
const SPECIALISTS = {
  // 신트라(Sintra) 12명 헬퍼와 1:1로 대응하는 한국어 버전 (Buddy→전략기획, Cassie→고객문의,
  // Commet→이커머스, Dexter→재무분석, Emmie→이메일, Gigi→성장코치, Milli→영업관리,
  // Penn→카피라이터, Scouty→채용, Seomi→SEO, Soshie→SNS콘텐츠, Vizzy→비서)
  전략기획: {
    label: "전략기획 담당",
    roleKey: "전문_전략기획",
    useSearch: true,
    desc: "사업 방향, 신규 아이템, 성장 전략에 대한 조사와 제안을 한다.",
  },
  고객문의: {
    label: "고객문의 응대 담당",
    roleKey: "전문_고객문의",
    useSearch: false,
    desc: "고객이 보낼 법한 문의에 대한 답변 초안을 작성한다 (실제 발송은 하지 않는다).",
  },
  이커머스: {
    label: "이커머스 운영 담당",
    roleKey: "전문_이커머스",
    useSearch: true,
    desc: "온라인 판매채널(스마트스토어, 쿠팡 등) 운영과 관련된 정리·제안을 한다.",
  },
  재무분석: {
    label: "재무분석 담당",
    roleKey: "전문_재무분석",
    useSearch: false,
    desc: "매출·비용·수익성 같은 숫자를 정리하고 분석한다 (실제 회계 처리는 하지 않는다).",
  },
  이메일: {
    label: "이메일 담당",
    roleKey: "전문_이메일",
    useSearch: false,
    desc: "고객·거래처에 보낼 이메일 초안을 작성한다 (실제 발송은 하지 않는다).",
  },
  성장코치: {
    label: "성장 코치",
    roleKey: "전문_성장코치",
    useSearch: false,
    desc: "대표님의 업무 습관, 목표 관리, 우선순위 정리를 돕는다.",
  },
  영업관리: {
    label: "영업관리 담당",
    roleKey: "전문_영업관리",
    useSearch: false,
    desc: "영업 프로세스, 고객 관리, 제안서 구조를 정리한다.",
  },
  카피라이터: {
    label: "카피라이터",
    roleKey: "전문_카피라이터",
    useSearch: false,
    desc: "광고 문구, 제품 설명, 상세페이지 문구를 작성한다.",
  },
  채용: {
    label: "채용 담당",
    roleKey: "전문_채용",
    useSearch: false,
    desc: "채용 공고문 작성과 지원자 서류 검토 기준을 만든다.",
  },
  SEO: {
    label: "SEO 담당",
    roleKey: "전문_SEO",
    useSearch: true,
    desc: "검색 노출을 높이기 위한 키워드와 콘텐츠 구조를 제안한다.",
  },
  SNS콘텐츠: {
    label: "SNS·블로그 콘텐츠 담당",
    roleKey: "전문_SNS콘텐츠",
    useSearch: false,
    desc: "SNS나 블로그에 바로 올릴 수 있는 글 초안을 작성한다 (실제 게시는 하지 않는다).",
  },
  비서: {
    label: "비서 (이미지 기획)",
    roleKey: "전문_비서",
    useSearch: false,
    desc: "이미지가 필요한 곳에 쓸 이미지 기획안(장면 설명, 문구, 구도)을 글로 작성한다. " +
      "실제 이미지 파일 생성은 다음 단계에서 별도 연결 예정.",
  },
};
const SPECIALIST_KEYS = Object.keys(SPECIALISTS);

/* ────────────────────────── 프롬프트 ────────────────────────── */

const 한국어전용 =
  "매우 중요한 규칙: 반드시 100% 한국어로만 답하세요. 영어 단어, 중국어, 일본어, 그 밖의 " +
  "다른 언어를 단 한 글자도 섞지 마세요. 사람·회사·제품의 고유명사도 가능하면 한글로 표기하세요 " +
  "(예: OpenAI → 오픈AI). 이 규칙을 어기면 안 됩니다.\n\n";

function 전문가지시(spec, question, ceoFeedback, reworkFeedback, memoryCtx, knowledgeCtx, brandCtx) {
  return (
    한국어전용 +
    "당신은 1인 사업가(대표)를 돕는 AI 직원이며, 담당 역할은 [" + spec.label + "]입니다.\n" +
    "담당 설명: " + spec.desc + "\n" +
    "중요: 다른 담당자와 이야기를 나누지 않습니다. 오직 당신의 담당 범위 안에서만, 아는 만큼 정확하게 답하세요.\n\n" +
    (brandCtx || "") +
    knowledgeCtx +
    memoryCtx +
    "[대표의 이번 지시]\n" + question + "\n\n" +
    (ceoFeedback ? "[대표님이 직접 보완 요청한 내용 — 반드시 반영]\n" + ceoFeedback + "\n\n" : "") +
    (reworkFeedback ? "[총괄AI의 보완 지시 — 반드시 반영해서 다시 작성]\n" + reworkFeedback + "\n\n" : "") +
    "작성 규칙:\n" +
    "- 담당 역할 범위 안에서만 답한다. 다른 담당자 몫의 일은 하지 않는다.\n" +
    "- 확인된 사실만 쓰고, 확실하지 않으면 '확인 안 됨'이라고 솔직히 쓴다. 지어내지 않는다.\n" +
    "- 숫자나 시점이 있으면 반드시 함께 적는다.\n" +
    "- 전문용어 없이, 처음 듣는 사람도 이해할 쉬운 말로 쓴다.\n" +
    "- 실제로 메일을 보내거나 SNS에 게시하거나 결제·구독을 하지 않는다. 초안/제안만 작성한다.\n\n" +
    "다시 한번 강조: 반드시 100% 한국어로만 작성하세요."
  );
}

function 총괄검수지시(question, ceoFeedback, outputs) {
  const 섹션 = outputs
    .map((o, i) => "[" + (i + 1) + ". 담당자 키 \"" + o.key + "\" (" + o.label + ")의 결과물]\n" + o.text)
    .join("\n\n");
  const keyList = outputs.map((o) => "\"" + o.key + "\"").join(", ");

  return (
    한국어전용 +
    "당신은 AI 직원팀을 총괄하는 '총괄AI'입니다. 아래는 각 담당자가 서로 대화 없이 독립적으로 " +
    "작업한 결과물입니다. 당신이 할 일:\n" +
    "1) 신빙성 검사 — 근거 없이 단정하거나 출처가 부실한 부분이 있는지 확인한다.\n" +
    "2) 대표님(전문 지식이 없는 1인 사업가) 눈높이에 맞게 정리해서 설명한다.\n" +
    "3) 결과물을 어디에 보관하면 좋을지 추천한다 (파일 보관 / 노션 정리 / 디스코드 공유 중 성격에 맞는 것 하나).\n" +
    "4) 담당자별로 통과(approved:true)/반려(approved:false) 판정을 내린다. 대표님을 오래 기다리게 하면 " +
    "안 되므로, 완벽하지 않아도 대표가 판단하기에 충분하면 통과시킨다. 핵심 질문을 아예 다루지 않았거나 " +
    "완전히 지어낸 것으로 보일 때만 반려한다.\n\n" +
    "[대표의 이번 지시]\n" + question + "\n\n" +
    (ceoFeedback ? "[대표님 보완 요청]\n" + ceoFeedback + "\n\n" : "") +
    섹션 + "\n\n" +
    "반드시 아래 담당자 키만 그대로 사용해서 verdicts를 채우세요: " + keyList + "\n" +
    "JSON만 출력하세요. 다른 말은 쓰지 마세요. 모든 문자열 값은 100% 한국어로 쓰세요.\n" +
    '{"verdicts": { "담당자키": {"approved": true 또는 false, "feedback": "반려 시 구체적 보완 지시, 통과면 빈 문자열"} },\n' +
    ' "storage": "파일 보관 / 노션 정리 / 디스코드 공유 중 하나와 이유 한 문장",\n' +
    ' "report": "모든 담당자가 통과했을 때만 작성. 아래 형식을 지킬 것. 통과 전이면 빈 문자열" }\n\n' +
    "report 작성 형식 (모두 통과했을 때만):\n" +
    "## 결론\n(대표가 어떻게 하면 좋은지 2~3문장으로 먼저 말한다)\n\n" +
    "## 담당자별 결과 요약\n(담당자마다 핵심만 3~4줄로. 어느 담당자가 조사·작성했는지 이름을 밝힌다)\n\n" +
    "## 대표님이 지금 결정하실 것\n(선택지를 2~3개 제시하고 각각의 장단점을 한 줄로)\n\n" +
    "## 이런 대안도 있어요\n(대표가 미처 생각 못 했을 다른 방향의 아이디어를 정확히 3가지, 각 한 줄로)\n\n" +
    "## 저장 추천\n(파일/노션/디스코드 중 무엇이 좋은지와 이유)\n\n" +
    "## 아직 확인 못 한 것\n(모르는 건 솔직히 적는다)\n\n" +
    "report 규칙: 전문용어·영어약어 금지, 쉬운 말로. 대표를 '대표님'으로 부른다. 100% 한국어로만 작성."
  );
}

// 쿠팡 상품 1개(북마클릿으로 가져온 정보)로 카드뉴스 문구를 N개 버전으로 다르게 짓는다.
// (실제 이미지는 이 문구를 social/cardnews.js의 generateCardNews()에 그대로 꽂아서 만든다)
function 카드뉴스카피생성지시(category, productName, price, quantity) {
  return (
    한국어전용 +
    "당신은 인스타그램 카드뉴스 카피라이터입니다. 아래 상품 하나로 서로 다른 버전의 카드뉴스 문구를 " +
    quantity + "개 지어주세요. 같은 상품이라도 후킹 문구·태그·특징 표현을 서로 겹치지 않게 다양하게 씁니다.\n\n" +
    "[카테고리] " + category + "\n" +
    "[상품명] " + productName + "\n" +
    "[가격] " + (price || "확인 안 됨") + "\n\n" +
    "작성 규칙:\n" +
    "- hook: 궁금증을 유발하는 짧은 후킹 문구 (예: '~~하는 법', '~~의 비밀')\n" +
    "- tag: 상단에 붙는 짧은 태그 (예: '오늘의 발견', '자취 필수템')\n" +
    "- bullets: 상품 특징 3개, 각 15자 이내\n" +
    "- cta: 마지막 장에 들어갈 짧은 구매 유도 문구\n" +
    "- 과장·허위 표현 금지, 확인 안 된 효능은 쓰지 않는다\n\n" +
    "JSON만 출력하세요. 다른 말은 쓰지 마세요. 모든 문자열은 100% 한국어로 쓰세요.\n" +
    '{"variants": [ {"hook":"", "tag":"", "bullets":["","",""], "cta":""}, ... 총 ' + quantity + '개 ] }'
  );
}

/* ────────────────────────── 전체 업무 진행 ────────────────────────── */

async function runPipeline(job) {
  const config = loadModelConfig();
  const question = job.question;
  const agentKeys = job.agentKeys;
  let ceoFeedback = "";

  try {
    for (let round = 1; round <= MAX_CEO_ROUNDS; round++) {
      emit(job, { type: "round", round, text: round === 1 ? "업무 시작" : "대표님 보완 요청 반영 (" + round + "차)" });

      // 담당자별 최신 결과물 (재작업 시 해당 담당자만 갱신됨)
      const results = {};
      for (const key of agentKeys) results[key] = null;
      let reworkFeedback = {}; // key -> 총괄AI 보완 지시

      async function runSpecialist(key, isRework) {
        const spec = SPECIALISTS[key];
        emit(job, { type: "status", agent: key, state: "working", text: isRework ? "보완 작업 중" : "작업 중" });
        const prompt = 전문가지시(
          spec, question, ceoFeedback, reworkFeedback[key] || "",
          getMemoryContext(job.userId, spec.roleKey), getKnowledgeContext(job.userId, key),
          getBrandContext(job.userId)
        );
        const result = await callWithFallback(config, spec.roleKey, prompt, spec.useSearch, 1800, { userId: job.userId, jobId: job.id });
        results[key] = { text: result.text, citations: result.citations, modelUsed: result.modelUsed };
        emit(job, { type: "status", agent: key, state: "submit", text: "결과 제출" });
        emit(job, {
          type: "step", agent: key,
          label: spec.label + (isRework ? " 결과 (보완본)" : " 결과"),
          model: result.modelUsed, text: result.text, citations: result.citations,
          kind: isRework ? "rework" : "result",
        });
        emit(job, { type: "status", agent: key, state: "done", text: "검수 대기" });
      }

      // 1) 고른 담당자들이 서로 대화 없이 동시에 작업
      await Promise.all(agentKeys.map((key) => runSpecialist(key, false)));

      // 2) 총괄AI 검수 (반려된 담당자만 재작업, 반복)
      let finalReport = "";
      let storageNote = "";
      let allCitations = agentKeys.reduce((acc, key) => acc.concat(results[key].citations || []), []);

      if (job.quick) {
        // 빠른 모드: 총괄AI 검수를 건너뛰고 담당자 결과를 그대로 모아 전달한다 (아이디어를 빨리 받을 때).
        emit(job, { type: "status", agent: "총괄AI", state: "working", text: "빠른 정리 중" });
        finalReport =
          "## 빠른 모드 결과 (검수 생략)\n" +
          "아이디어를 빠르게 받는 모드라, 총괄AI의 정식 신빙성 검수는 하지 않았습니다. 참고용으로만 봐 주세요.\n\n" +
          agentKeys.map((key) => "## " + SPECIALISTS[key].label + "\n" + results[key].text).join("\n\n");
        emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "대표님께 전달" });
        emit(job, {
          type: "step", agent: "총괄AI", label: "빠른 모드 결과 (검수 생략)",
          model: "빠른 모드", text: finalReport, citations: allCitations, isReport: true,
        });
      } else {
       for (let mAttempt = 1; mAttempt <= MAX_MANAGER_RETRY + 1; mAttempt++) {
        emit(job, { type: "status", agent: "총괄AI", state: "working", text: "전체 결과 검수 중" });

        const outputs = agentKeys.map((key) => ({ key, label: SPECIALISTS[key].label, text: results[key].text }));
        const reviewResult = await callWithFallback(config, "총괄AI_검수", 총괄검수지시(question, ceoFeedback, outputs), false, 2600, { userId: job.userId, jobId: job.id });
        const reviewJson = parseJSON(reviewResult.text);
        allCitations = agentKeys.reduce((acc, key) => acc.concat(results[key].citations || []), []);

        const verdicts = (reviewJson && reviewJson.verdicts) || {};
        const rejected = agentKeys.filter((key) => verdicts[key] && verdicts[key].approved === false);
        const canRetry = mAttempt <= MAX_MANAGER_RETRY && rejected.length > 0;

        if (canRetry) {
          emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "일부 보완 지시" });
          const 사유목록 = rejected.map((key) => SPECIALISTS[key].label + ": " + (verdicts[key].feedback || "근거 보강 필요")).join("\n");
          emit(job, {
            type: "step", agent: "총괄AI",
            label: "총괄 검수 결과 (" + mAttempt + "차) — 일부 보완 요청",
            model: reviewResult.modelUsed, text: 사유목록, kind: "review",
          });
          rejected.forEach((key) => {
            reworkFeedback[key] = verdicts[key].feedback || "근거를 더 확실히 밝혀서 다시 작성해 주세요.";
          });
          await Promise.all(rejected.map((key) => runSpecialist(key, true)));
          continue;
        }

        emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "대표님께 보고" });
        storageNote = (reviewJson && reviewJson.storage) || "";

        let 미흡 = false;
        if (reviewJson && reviewJson.report && String(reviewJson.report).trim()) {
          finalReport = String(reviewJson.report).trim();
        } else {
          미흡 = true;
          finalReport =
            "## 결론\n총괄AI가 정해진 재작업 횟수 안에 만족할 만한 수준까지 끌어올리지 못했습니다. " +
            "아래는 지금까지 나온 결과이며, 부족한 부분을 함께 적었습니다.\n\n" +
            agentKeys.map((key) => "## " + SPECIALISTS[key].label + "의 결과\n" + results[key].text).join("\n\n") +
            "\n\n## 대표님이 지금 결정하실 것\n" +
            "- 보완 요청: 부족한 점을 적어 다시 시키실 수 있습니다.\n" +
            "- 이대로 승인: 지금 내용만으로 판단하고 마무리합니다.";
        }
        if (storageNote) finalReport += "\n\n## 저장 추천\n" + storageNote;

        emit(job, {
          type: "step", agent: "총괄AI",
          label: 미흡 ? "총괄 검수 — 일부 부족한 상태로 올림" : "총괄 검수 완료 — 대표님께 올림",
          model: reviewResult.modelUsed, text: finalReport, citations: allCitations, isReport: true,
        });
        break;
       }
      }

      // 보고서가 실제로 나온 시점에 딱 한 번만 크레딧을 차감한다 (도중에 오류가 나면 차감 안 함).
      if (!job.charged && job.userId) {
        const remaining = chargeUser(job.userId, job.cost, {
          agents: agentKeys.length,
          question: String(question).slice(0, 60),
        });
        job.charged = true;
        if (remaining !== null) emit(job, { type: "credit", credits: remaining, cost: job.cost });
      }

      // 3) 대표(사용자) 최종 승인
      ["총괄AI"].concat(agentKeys).forEach((n) => emit(job, { type: "status", agent: n, state: "done", text: "승인 대기" }));
      emit(job, { type: "await-approval", round, lastRound: round >= MAX_CEO_ROUNDS, report: finalReport, citations: allCitations });
      safeUpdateJobLogStatus(job.id, "awaiting_approval", null, new Date().toISOString());

      const decision = await waitForCeo(job);

      if (decision.action === "approve") {
        // 승인된 내용을 각 담당자의 "기억"으로 남긴다 (다음에 이 담당자를 쓸 때 참고됨)
        agentKeys.forEach((key) => {
          const spec = SPECIALISTS[key];
          if (job.userId) addMemory(job.userId, spec.roleKey, question, results[key].text.slice(0, 300));
        });
        emit(job, { type: "approved", text: "대표님이 승인하셨습니다. 업무를 종료합니다." });
        safeUpdateJobLogStatus(job.id, "approved", null, new Date().toISOString());
        break;
      }
      if (round >= MAX_CEO_ROUNDS) {
        emit(job, { type: "approved", text: "보완 요청 횟수를 다 썼습니다. 새 업무로 다시 시켜 주세요." });
        safeUpdateJobLogStatus(job.id, "abandoned", "보완 요청 횟수 소진", new Date().toISOString());
        break;
      }
      ceoFeedback = decision.feedback || "대표가 보완을 요청했습니다. 더 구체적인 근거와 실행 방법을 채워 주세요.";
      emit(job, { type: "revising", text: "보완 요청을 팀에 전달했습니다." });
    }

    emit(job, { type: "done" });
  } catch (err) {
    const friendly =
      err.message === "API_KEY_MISSING"
        ? "AI 사용 열쇠(API 키)가 설정되지 않았습니다. backend 폴더의 .env 파일에 OPENROUTER_API_KEY를 넣어 주세요."
        : "업무 진행 중 문제가 생겼습니다: " + err.message;
    console.error("[파이프라인 오류]", err);
    emit(job, { type: "error", text: friendly });
    safeUpdateJobLogStatus(job.id, "error", String(err.message || err).slice(0, 300), new Date().toISOString());
  } finally {
    job.finished = true;
    for (const res of job.listeners) { try { res.end(); } catch (e) {} }
    job.listeners = [];
  }
}

/* ────────────────────────── 쿠팡 상품 1건 → 카드뉴스 N개 자동 생성 + 인스타 자동 업로드 ──────────────────────────
 * 북마클릿으로 상품명·가격·사진을 가져온 뒤, 문구만 AI가 여러 버전으로 짓고, 이미지 생성부터
 * 인스타그램 게시까지 사람 개입 없이 끝까지 진행한다. (댓글 자동답장은 기존 웹훅이 그대로 처리)
 */
function createSimpleJob(userId, cost) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = { id, userId, cost: cost || 0, charged: 0, events: [], listeners: [], finished: false, createdAt: Date.now() };
  jobs.set(id, job);
  return job;
}

async function runCoupangAutoJob(job, params) {
  const { category, productName, price, imageUrl, quantity, commentKeyword, baseUrl, social, promoOptout } = params;
  const config = loadModelConfig();
  let doneCount = 0;

  try {
    emit(job, { type: "status", agent: "카피라이터", state: "working", text: "카드뉴스 문구 " + quantity + "개 짓는 중" });
    const prompt = 카드뉴스카피생성지시(category, productName, price, quantity);
    const copyResult = await callWithFallback(config, "전문_카피라이터", prompt, false, 1800, { userId: job.userId, jobId: job.id });
    const parsed = parseJSON(copyResult.text);
    const variants = (parsed && Array.isArray(parsed.variants) ? parsed.variants : []).slice(0, quantity);
    if (!variants.length) throw new Error("카피 생성에 실패했습니다. 다시 시도해 주세요.");
    emit(job, { type: "status", agent: "카피라이터", state: "done", text: variants.length + "개 문구 완성" });

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i] || {};
      const seq = i + 1;
      emit(job, { type: "status", agent: "비서", state: "working", text: seq + "/" + variants.length + " 이미지 생성 중" });

      const slug = crypto.randomBytes(6).toString("hex");
      const outDir = path.join(__dirname, "public", "cardnews", slug);
      await generateCardNews(
        {
          name: productName,
          hook: v.hook || productName,
          tag: v.tag || "오늘의 발견",
          bullets: Array.isArray(v.bullets) ? v.bullets.slice(0, 3) : [],
          price: price || "",
          photoUrl: imageUrl,
          commentKeyword,
          cta: v.cta,
        },
        outDir
      );
      const urls = ["slide1.png", "slide2.png", "slide3.png"].map((f) => baseUrl + "/cardnews/" + slug + "/" + f);
      emit(job, {
        type: "step", agent: "비서", label: seq + "번째 카드뉴스 (" + (v.hook || "") + ")",
        text: (v.hook || "") + "\n" + (Array.isArray(v.bullets) ? v.bullets.join(" · ") : ""),
        kind: "result",
      });

      emit(job, { type: "status", agent: "총괄AI", state: "working", text: seq + "/" + variants.length + " 인스타그램 업로드 중" });
      // 바이럴 성장 전략 1번 — 자동 게시되는 캡션 끝에 짧은 출처를 남긴다(강제하면 반감이 생기므로 opt-out 가능).
      const promoLine = promoOptout ? "" : ("\n\n🤖 AI 직원팀이 이 콘텐츠를 만들었어요 · " + baseUrl.replace(/^https?:\/\//, ""));
      const caption = (v.hook || productName) + "\n\n" + (Array.isArray(v.bullets) ? v.bullets.map((b) => "· " + b).join("\n") : "") + "\n\n" + (v.cta || "") + promoLine;
      const publishResult = await publishCarouselPost(social.igUserId, decryptSecret(social.accessTokenEnc), urls, caption);

      db.addCardnewsHistory(job.userId, { jobId: slug, name: productName, hook: v.hook || "", imageUrls: urls, createdAt: nowKR() });
      doneCount++;
      const remaining = chargeUser(job.userId, COST_CARDNEWS, { kind: "쿠팡 자동 카드뉴스", label: productName + " (" + seq + "/" + variants.length + ")" });
      if (remaining !== null) emit(job, { type: "credit", credits: remaining, cost: COST_CARDNEWS });

      emit(job, {
        type: "step", agent: "총괄AI", label: seq + "번째 인스타그램 게시 완료",
        text: "게시물 ID: " + (publishResult && publishResult.id ? publishResult.id : "확인 필요"),
        kind: "review",
      });
    }

    emit(job, { type: "approved", text: doneCount + "개 카드뉴스를 생성해서 인스타그램에 전부 게시했습니다." });
    emit(job, { type: "done" });
    safeUpdateJobLogStatus(job.id, "approved", null, new Date().toISOString());
  } catch (err) {
    console.error("[쿠팡 자동 파이프라인 오류]", err);
    const friendly = doneCount > 0
      ? doneCount + "개까지는 성공했고, 그 다음에 문제가 생겼습니다: " + err.message
      : "시작하지 못했습니다: " + err.message;
    emit(job, { type: "error", text: friendly });
    safeUpdateJobLogStatus(job.id, "error", String(err.message || err).slice(0, 300), new Date().toISOString());
  } finally {
    job.finished = true;
    for (const res of job.listeners) { try { res.end(); } catch (e) {} }
    job.listeners = [];
  }
}

/* ────────────────────────── API ────────────────────────── */

app.get("/api/health", (req, res) => {
  const config = loadModelConfig();
  res.json({
    ok: true,
    apiKeySet: Boolean(OPENROUTER_API_KEY),
    modelsUpdatedAt: config.업데이트일,
  });
});

app.get("/api/rankings", (req, res) => {
  res.json(loadModelConfig());
});

app.get("/api/agents", (req, res) => {
  res.json(SPECIALIST_KEYS.map((key) => ({ key, label: SPECIALISTS[key].label, desc: SPECIALISTS[key].desc })));
});

/* ── 회원 · 로그인 ── */
// 같은 IP가 계정을 계속 새로 만들어서 가입 보너스(300 크레딧)만 반복해서 받아가는 것을 막는다.
const SIGNUP_LIMIT_PER_WINDOW = 5;
const SIGNUP_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24시간
const signupLog = new Map(); // ip -> timestamps[]
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of signupLog) {
    const kept = timestamps.filter((t) => now - t < SIGNUP_LIMIT_WINDOW_MS);
    if (kept.length) signupLog.set(ip, kept);
    else signupLog.delete(ip);
  }
}, 30 * 60 * 1000);

app.post("/api/signup", (req, res) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const timestamps = (signupLog.get(ip) || []).filter((t) => now - t < SIGNUP_LIMIT_WINDOW_MS);
  if (timestamps.length >= SIGNUP_LIMIT_PER_WINDOW) {
    return res.status(429).json({ error: "가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  }

  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." });
  if (password.length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상으로 정해 주세요." });

  if (db.emailExists(email)) return res.status(409).json({ error: "이미 가입된 이메일입니다." });
  timestamps.push(now);
  signupLog.set(ip, timestamps);

  const { salt, hash } = hashPassword(password);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const refCode = parseCookies(req).vo_ref;
  const referredBy = refCode && db.referralCodeExists(refCode) ? refCode : null;
  const u = db.createUser({ id, email, salt, hash, credits: SIGNUP_BONUS, ceiling: SIGNUP_BONUS, guest: false, createdAt: nowKR(), referredBy });
  setSession(res, id);
  res.json({ ok: true, user: publicUser(u) });
});

// 비밀번호 무차별 대입(brute force) 방지 — 같은 IP가 실패를 반복하면 잠깐 막는다.
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000; // 15분
const loginFailLog = new Map(); // ip -> timestamps[]
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of loginFailLog) {
    const kept = timestamps.filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
    if (kept.length) loginFailLog.set(ip, kept);
    else loginFailLog.delete(ip);
  }
}, 30 * 60 * 1000);

app.post("/api/login", (req, res) => {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const fails = (loginFailLog.get(ip) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  if (fails.length >= LOGIN_FAIL_LIMIT) {
    return res.status(429).json({ error: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요." });
  }

  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  const u = db.getUserByEmail(email);
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    fails.push(now);
    loginFailLog.set(ip, fails);
    return res.status(401).json({ error: "이메일 또는 비밀번호가 맞지 않습니다." });
  }
  loginFailLog.delete(ip);
  setSession(res, u.id);
  res.json({ ok: true, user: publicUser(u) });
});

app.post("/api/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// 로그인 없이 둘러보기 — 임시 체험 계정을 즉시 만들고 로그인 상태로 만든다.
// (비밀번호가 없어 /api/login으로는 못 들어가고, 쿠키로만 유지된다)
// 이중으로 막는다:
//  1) 기기(브라우저) 기준 — 쿠키로 식별한 이 브라우저가 예전에 체험한 적 있으면 평생 재입장 불가.
//     같은 집 다른 컴퓨터·같은 통신사 다른 사람처럼 IP만 같고 실제로는 다른 사람인 경우를
//     오탐하지 않기 위한 1차 기준.
//  2) IP 기준 — 기기 쿠키를 지우고 계속 새로 만드는 것까지 막는 상한선(하루 3개).
const GUEST_LIMIT_PER_WINDOW = 3;
const GUEST_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24시간
const guestCreationLog = new Map(); // ip -> timestamps[]
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of guestCreationLog) {
    const kept = timestamps.filter((t) => now - t < GUEST_LIMIT_WINDOW_MS);
    if (kept.length) guestCreationLog.set(ip, kept);
    else guestCreationLog.delete(ip);
  }
}, 30 * 60 * 1000);

app.post("/api/guest", (req, res) => {
  const deviceId = getOrCreateDeviceId(req, res);
  if (db.hasGuestDevice(deviceId)) {
    return res.status(429).json({ error: "이 브라우저에서는 이미 체험해 보셨습니다. 회원가입 후 계속 이용해 주세요." });
  }

  const ip = req.ip || "unknown";
  const now = Date.now();
  const timestamps = (guestCreationLog.get(ip) || []).filter((t) => now - t < GUEST_LIMIT_WINDOW_MS);
  if (timestamps.length >= GUEST_LIMIT_PER_WINDOW) {
    return res.status(429).json({ error: "체험 입장은 하루에 정해진 횟수만 가능합니다. 회원가입 후 이용해 주세요." });
  }
  timestamps.push(now);
  guestCreationLog.set(ip, timestamps);

  const id = "guest_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const u = db.createUser({ id, email: "체험 사용자", credits: SIGNUP_BONUS, ceiling: SIGNUP_BONUS, guest: true, createdAt: nowKR() });
  db.recordGuestDevice(deviceId, id, ip, nowKR());
  setSession(res, id);
  res.json({ ok: true, user: publicUser(u) });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({ user: publicUser(u), costPerAgent: COST_PER_AGENT, costManager: COST_MANAGER });
});

// 테스트 충전. ⚠️ 실제 결제 아님 — 나중에 이 안에서 결제대행사(PG) 결제 성공을 확인한 뒤 크레딧을 올리도록 바꾼다.
app.post("/api/topup", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const credits = (u.credits || 0) + TEST_TOPUP;
  db.updateCredits(u.id, credits, credits); // 게이지 기준선을 새로 채운 만큼으로 초기화
  res.json({ ok: true, user: publicUser(db.getUserById(u.id)) });
});

/* ══════════════════════════════════════════════════════════════
   실제 결제 (토스페이먼츠 결제위젯)
   .env에 TOSS_CLIENT_KEY / TOSS_SECRET_KEY가 없으면 "준비 중"으로 안내하고,
   있으면 실제 결제창이 뜬다. 라이브 키로만 교체하면 그대로 실서비스에 쓸 수 있다.
   ══════════════════════════════════════════════════════════════ */

// 결제 설정 + 상품 목록 (클라이언트 키는 공개해도 되는 키라 그대로 내려줌)
app.get("/api/payment/config", (req, res) => {
  res.json({ enabled: !!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY), clientKey: TOSS_CLIENT_KEY, packages: CREDIT_PACKAGES });
});

// 결제 시작 전, 서버가 먼저 "얼마짜리를 사려는지"를 저장해둔다 (결제창에서 금액을 조작해도 나중에 대조해서 막기 위함)
app.post("/api/payment/create-order", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  if (!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY)) return res.status(400).json({ error: "결제 기능이 아직 준비 중입니다." });

  const pkgKey = String((req.body && req.body.package) || "");
  const pkg = CREDIT_PACKAGES[pkgKey];
  if (!pkg) return res.status(400).json({ error: "존재하지 않는 상품입니다." });

  const orderId = "nexta_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.createOrder(orderId, { userId: u.id, credits: pkg.credits, amount: pkg.amount, label: pkg.label, status: "pending", createdAt: nowKR() });

  res.json({ ok: true, orderId, amount: pkg.amount, orderName: pkg.label, clientKey: TOSS_CLIENT_KEY });
});

// 결제 성공 콜백 — 토스가 돌려준 paymentKey로 "진짜 결제됐는지" 서버 대 서버로 다시 확인(승인)한 뒤에만 크레딧을 준다
app.get("/payment/success", async (req, res) => {
  const { paymentKey, orderId, amount } = req.query;
  const order = db.getOrder(orderId);

  if (!order || order.status !== "pending" || String(order.amount) !== String(amount)) {
    return res.status(400).send("<h1>결제 확인 실패</h1><p>주문 정보가 일치하지 않습니다.</p><a href='/'>돌아가기</a>");
  }

  try {
    const resp = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(TOSS_SECRET_KEY + ":").toString("base64"),
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || "결제 승인 실패");

    db.markOrderPaid(orderId);

    const rec = db.getUserById(order.user_id);
    if (rec) {
      const credits = (rec.credits || 0) + order.credits;
      db.updateCredits(rec.id, credits, credits);
    }
    res.redirect("/?payment=success");
  } catch (e) {
    res.status(500).send("<h1>결제 승인 중 오류</h1><p>" + e.message + "</p><a href='/'>돌아가기</a>");
  }
});

app.get("/payment/fail", (req, res) => {
  res.redirect("/?payment=fail");
});

// 회사(브랜드) 정보 저장 — 로고·회사명은 사이드바와 보고서 표지에 함께 표시된다.
app.post("/api/company", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });

  const name = String((req.body && req.body.name) || "").trim().slice(0, 40);
  let logo = String((req.body && req.body.logo) || "");
  if (logo && !/^data:image\/(png|jpe?g|webp);base64,/.test(logo)) logo = "";
  if (logo.length > 900000) return res.status(400).json({ error: "로고 이미지 용량이 너무 큽니다." });

  db.updateCompany(u.id, name, logo);
  res.json({ ok: true, user: publicUser(db.getUserById(u.id)) });
});

// 자동 게시 캡션에 "Made with 넥스타" 홍보 문구를 넣을지 여부 — 기본은 포함, 원치 않으면 끌 수 있다.
app.post("/api/settings/promo", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  db.setPromoOptout(u.id, !!(req.body && req.body.optout));
  res.json({ ok: true, user: publicUser(db.getUserById(u.id)) });
});

/* ══════════════════════════════════════════════════════════════
   인스타그램 카드뉴스 자동화 (Zapier·매니챗 없이 메타 공식 API 직접 연동)
   ══════════════════════════════════════════════════════════════ */

// 1) 인스타그램 계정 연결정보 저장 (액세스 토큰·계정ID·댓글 자동응답 규칙)
app.post("/api/social/connect", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { igUserId, accessToken, commentKeyword, dmMessage } = req.body || {};
  if (!igUserId || !accessToken) return res.status(400).json({ error: "igUserId와 accessToken이 필요합니다." });

  try {
    db.setSocialInstagram(u.id, {
      igUserId: String(igUserId),
      accessTokenEnc: encryptSecret(String(accessToken)), // 평문 저장 금지 — 파일 유출 시 계정 탈취 방지
      commentKeyword: String(commentKeyword || "정보"),
      dmMessage: String(dmMessage || "안녕하세요! 요청하신 링크 보내드려요 🙌"),
    });
    res.json({ ok: true, connected: true });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "이 인스타그램 계정은 이미 다른 계정에 연결되어 있습니다." });
    }
    res.status(500).json({ error: "연결 저장에 실패했습니다: " + e.message });
  }
});

// 2) 상품 정보로 카드뉴스 3장 생성 → 공개 URL 반환 (여기까진 대표님 승인 없이 바로 확인 가능)
app.post("/api/social/cardnews", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const p = req.body || {};
  if (!p.name || !p.hook) return res.status(400).json({ error: "name, hook은 필수입니다." });

  if ((u.credits || 0) < COST_CARDNEWS) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 충전 후 다시 시도해 주세요." });
  }

  try {
    const jobId = crypto.randomBytes(6).toString("hex");
    const outDir = path.join(__dirname, "public", "cardnews", jobId);
    const social = (u.social && u.social.instagram) || {};

    await generateCardNews(
      {
        name: p.name,
        hook: p.hook,
        tag: p.tag || "오늘의 발견",
        bullets: Array.isArray(p.bullets) ? p.bullets : [],
        price: p.price || "",
        photoUrl: p.photoUrl,
        commentKeyword: p.commentKeyword || social.commentKeyword || "정보",
        cta: p.cta,
        color1: p.color1,
        color2: p.color2,
      },
      outDir
    );

    const base = `${req.protocol}://${req.get("host")}`;
    const urls = ["slide1.png", "slide2.png", "slide3.png"].map((f) => `${base}/cardnews/${jobId}/${f}`);

    const credits = Math.max(0, (u.credits || 0) - COST_CARDNEWS);
    db.updateCredits(u.id, credits, u.ceiling);
    db.addUsage(u.id, { at: nowKR(), amount: COST_CARDNEWS, kind: "카드뉴스 생성", label: p.name });
    db.addCardnewsHistory(u.id, { jobId, name: p.name, hook: p.hook, imageUrls: urls, createdAt: nowKR() });

    res.json({ ok: true, jobId, imageUrls: urls, user: publicUser(db.getUserById(u.id)) });
  } catch (e) {
    res.status(500).json({ error: "카드뉴스 생성 실패: " + e.message });
  }
});

// 3) 생성된 카드뉴스를 실제로 인스타그램에 게시 (완전 자동 업로드)
app.post("/api/social/publish", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { imageUrls, caption } = req.body || {};
  if (!Array.isArray(imageUrls) || !imageUrls.length) return res.status(400).json({ error: "imageUrls가 필요합니다." });

  const social = u.social && u.social.instagram;
  if (!social) return res.status(400).json({ error: "먼저 /api/social/connect로 인스타그램 계정을 연결해 주세요." });

  try {
    const accessToken = decryptSecret(social.accessTokenEnc);
    const result = await publishCarouselPost(social.igUserId, accessToken, imageUrls, caption || "");
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: "게시 실패: " + e.message });
  }
});

// 3-1) 쿠팡 상품 1건(북마클릿으로 가져온 이름/가격/사진) → 카드뉴스 N개 자동 생성 + 인스타 자동 업로드
const COUPANG_AUTO_MAX_QTY = 5; // 인스타그램 콘텐츠 게시 API 자체 한도(24시간 25건)와 비용을 함께 고려한 상한
app.post("/api/social/coupang-auto", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });

  const social = user.social && user.social.instagram;
  if (!social) return res.status(400).json({ error: "먼저 인스타그램 계정을 연결해 주세요 (충전·설정 메뉴)." });

  const b = req.body || {};
  const productName = String(b.name || "").trim();
  const category = String(b.category || "").trim();
  const price = String(b.price || "").trim();
  const imageUrl = String(b.imageUrl || "").trim();
  const quantity = Math.min(COUPANG_AUTO_MAX_QTY, Math.max(1, parseInt(b.quantity, 10) || 1));
  const commentKeyword = String(b.commentKeyword || "정보").trim();

  if (!productName) return res.status(400).json({ error: "상품명이 필요합니다. 북마클릿으로 다시 가져와 주세요." });
  if (!category) return res.status(400).json({ error: "카테고리를 선택해 주세요." });

  const cost = COST_CARDNEWS * quantity;
  if ((user.credits || 0) < cost) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 충전 후 다시 시도해 주세요.", need: cost, have: user.credits || 0 });
  }

  const job = createSimpleJob(user.id, cost);
  safeCreateJobLog(job.id, user.id, "coupang_auto", productName + " (" + category + ")", [], new Date().toISOString());
  res.json({ jobId: job.id, cost });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  runCoupangAutoJob(job, { category, productName, price, imageUrl, quantity, commentKeyword, baseUrl, social, promoOptout: !!user.promoOptout });
});

// 4) 메타 웹훅 — 댓글에 키워드 남기면 자동으로 비공개 답장(DM) 발송 (매니챗 대체, 무료·무제한)
const IG_WEBHOOK_VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN || "nexta-verify";
// META_APP_SECRET(메타 개발자 앱의 "앱 시크릿") — 이 웹훅이 정말 메타에서 온 요청인지 서명을
// 검증하는 데 쓴다. 이게 없으면 남이 igUserId만 알아내서 가짜 웹훅을 보내 실제 계정으로
// 원치 않는 DM을 보내게 만들 수 있어서, 설정 안 돼 있으면 아예 처리를 거부한다(안전 우선).
const META_APP_SECRET = process.env.META_APP_SECRET || "";
function verifyMetaSignature(req) {
  if (!META_APP_SECRET) return false;
  const header = req.headers["x-hub-signature-256"];
  if (!header || !req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  try {
    return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch (e) {
    return false;
  }
}
app.get("/webhooks/instagram", (req, res) => {
  const challenge = verifyWebhook(req.query, IG_WEBHOOK_VERIFY_TOKEN);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post("/webhooks/instagram", async (req, res) => {
  res.sendStatus(200); // 메타는 빠른 200 응답을 기대하므로 먼저 응답하고 뒤에서 처리
  try {
    if (!verifyMetaSignature(req)) {
      console.warn("[웹훅 거부] 서명이 없거나 META_APP_SECRET 미설정 — 처리하지 않음");
      return;
    }
    const igUserId = req.body?.entry?.[0]?.id;
    const social = db.getSocialInstagramByIgUserId(igUserId);
    if (!social) return;
    await handleCommentWebhook(req.body, {
      keyword: social.commentKeyword,
      replyMessage: social.dmMessage,
      accessToken: decryptSecret(social.accessTokenEnc),
    });
  } catch (e) {
    console.error("웹훅 처리 오류:", e.message);
  }
});

// 업무 시작 → 작업번호만 즉시 돌려주고, 실제 일은 뒤에서 진행
app.post("/api/start", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });

  const question = String((req.body && req.body.question) || "").trim();
  if (!question) return res.status(400).json({ error: "무엇을 알아봐 드릴지 적어 주세요." });
  if (question.length > 2000) return res.status(400).json({ error: "질문이 너무 깁니다. 2000자 이내로 적어 주세요." });

  let agentKeys = Array.isArray(req.body && req.body.agents) ? req.body.agents.filter((k) => SPECIALISTS[k]) : [];
  if (!agentKeys.length) agentKeys = SPECIALIST_KEYS.slice();

  const quick = !!(req.body && req.body.quick);
  // 빠른 모드는 총괄AI 검수를 건너뛰므로 검수 크레딧(20)을 받지 않는다.
  const cost = agentKeys.length * COST_PER_AGENT + (quick ? 0 : COST_MANAGER);
  if ((user.credits || 0) < cost) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 충전 후 다시 시도해 주세요.", need: cost, have: user.credits || 0 });
  }

  const job = createJob(question, agentKeys, user.id, cost, quick);
  safeCreateJobLog(job.id, user.id, "pipeline", question, agentKeys, new Date().toISOString());
  res.json({ jobId: job.id, cost });
  runPipeline(job);
});

// 진행 상황 실시간 받기
app.get("/api/stream/:jobId", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).end();
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  if (job.userId !== user.id) return res.status(403).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  for (const event of job.events) {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  }
  if (job.finished) return res.end();

  job.listeners.push(res);
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    job.listeners = job.listeners.filter((r) => r !== res);
  });
});

// 결과물에 대한 대표님의 만족도(👍/👎) — 품질 저하를 조기에 감지하려는 용도
app.post("/api/feedback", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const rating = String((req.body && req.body.rating) || "");
  if (rating !== "up" && rating !== "down") return res.status(400).json({ error: "잘못된 값입니다." });
  db.addFeedback({ userId: u.id, jobId: String((req.body && req.body.jobId) || ""), rating, at: nowKR() });
  res.json({ ok: true });
});

// 대표의 결정 (승인 / 보완 요청)
app.post("/api/decide", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { jobId, action, feedback } = req.body || {};
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "작업을 찾을 수 없습니다." });
  if (job.userId !== user.id) return res.status(403).json({ error: "본인의 작업만 결재할 수 있습니다." });
  if (!job.ceoResolve) return res.status(409).json({ error: "아직 승인받을 단계가 아닙니다." });
  if (action !== "approve" && action !== "revise") {
    return res.status(400).json({ error: "승인 또는 보완요청만 가능합니다." });
  }

  const resolve = job.ceoResolve;
  job.ceoResolve = null;
  resolve({ action, feedback: String(feedback || "").slice(0, 2000) });
  res.json({ ok: true });
});

/* ── 담당자별 전문지식 자료 관리 (RAG: 파일을 통째로 학습시키는 대신, 참고자료로 매번 끼워 넣는다) ── */

app.get("/api/knowledge/:role", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  if (!SPECIALISTS[req.params.role] && req.params.role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  res.json({ items: db.getKnowledge(u.id, req.params.role) });
});

app.post("/api/knowledge/:role", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const role = req.params.role;
  if (!SPECIALISTS[role] && role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  const title = String((req.body && req.body.title) || "").trim().slice(0, 80) || "제목 없음";
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "내용을 입력해 주세요." });
  if (text.length > 20000) return res.status(400).json({ error: "자료가 너무 깁니다. 20000자 이내로 줄여 주세요." });

  db.addKnowledge(u.id, role, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, text, addedAt: nowKR(),
  });
  res.json({ ok: true, items: db.getKnowledge(u.id, role) });
});

app.delete("/api/knowledge/:role/:id", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const role = req.params.role;
  if (!SPECIALISTS[role] && role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  db.deleteKnowledge(u.id, role, req.params.id);
  res.json({ ok: true, items: db.getKnowledge(u.id, role) });
});

/* ══════════════════════════════════════════════════════════════
   인플루언서/제휴 추천 코드 관리 (대표님 전용 — 로그인 계정과 무관하게 별도 비밀키로 보호)
   .env에 ADMIN_KEY를 반드시 정해두세요. 안 정하면 누구나 코드 목록을 볼 수 있게 되어 위험합니다.
   사용법: /api/admin/referrals?key=여기에_ADMIN_KEY
   ══════════════════════════════════════════════════════════════ */
const ADMIN_KEY = process.env.ADMIN_KEY || "";
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function requireAdminKey(req, res, next) {
  const key = (req.query && req.query.key) || (req.body && req.body.key) || "";
  if (!ADMIN_KEY || !key || !timingSafeStringEqual(key, ADMIN_KEY)) {
    return res.status(403).json({ error: "권한이 없습니다. (.env에 ADMIN_KEY를 설정했는지, key 값이 맞는지 확인)" });
  }
  next();
}
app.get("/api/admin/referrals", requireAdminKey, (req, res) => {
  res.json({ codes: db.listReferralCodes(), stats: db.getReferralStats() });
});
// 관리자 대시보드 한 화면에 필요한 데이터를 전부 모아서 한 번에 내려준다.
app.get("/api/admin/dashboard", requireAdminKey, (req, res) => {
  res.json({
    users: db.getUserStats(),
    recentSignups: db.getRecentSignups(20),
    jobStats: db.getJobStats(),
    agentPopularity: db.getAgentPopularity(),
    recentQuestions: db.getRecentQuestions(30),
    feedback: db.getFeedbackStats(),
    costByRole: db.getCostSummaryByRole(),
    referrals: db.getReferralStats(),
  });
});
app.post("/api/admin/referrals", requireAdminKey, (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  const label = String((req.body && req.body.label) || "").trim().slice(0, 60);
  if (!/^[a-zA-Z0-9_-]{2,40}$/.test(code)) {
    return res.status(400).json({ error: "코드는 영문/숫자/-/_ 2~40자로 만들어 주세요 (한글·공백 불가, 링크에 들어가는 값이라서요)." });
  }
  if (db.referralCodeExists(code)) return res.status(409).json({ error: "이미 있는 코드입니다." });
  db.createReferralCode(code, label, nowKR());
  res.json({ ok: true, codes: db.listReferralCodes() });
});

// 전역 에러 처리 — Express 기본 에러 페이지는 서버 내부 파일 경로와 스택 트레이스를
// 그대로 응답에 실어 보낸다(예: 잘못된 JSON을 보내기만 해도 노출됨). 그 대신 항상 짧은
// JSON 에러만 돌려주고, 실제 원인은 서버 로그에만 남긴다.
app.use((err, req, res, next) => {
  console.error("[처리 안 된 오류]", err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 400;
  res.status(status).json({ error: "요청을 처리하지 못했습니다." });
});
// 정의된 라우트가 하나도 안 걸린 요청(존재하지 않는 API 경로 등)도 정보 노출 없이 404만 돌려준다.
app.use((req, res) => {
  res.status(404).json({ error: "찾을 수 없습니다." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("가상오피스 서버 실행 중 → http://localhost:" + PORT);
  if (!OPENROUTER_API_KEY) {
    console.warn("주의: OPENROUTER_API_KEY가 없습니다. .env 파일에 키를 넣어야 실제로 동작합니다.");
  }
  if (SESSION_SECRET === "virtual-office-dev-secret-change-me") {
    console.warn("보안 주의: SESSION_SECRET을 .env에 무작위 문자열로 정해 주세요 (로그인 서명 + 인스타 토큰 암호화에 쓰입니다).");
  }
  if (!ADMIN_KEY) {
    console.warn("보안 주의: ADMIN_KEY가 없습니다. 관리자 페이지(/api/admin/*)를 쓰려면 .env에 정해 주세요.");
  }
  if (!META_APP_SECRET) {
    console.warn("보안 주의: META_APP_SECRET이 없어서 인스타그램 웹훅(댓글 자동답장)을 처리하지 않습니다. 메타 개발자 앱의 '앱 시크릿'을 .env에 넣어 주세요.");
  }
});
