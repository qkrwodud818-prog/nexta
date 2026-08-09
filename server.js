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
 * 크레딧 단품 충전은 없다 — SUBSCRIPTION_PLANS(월 구독)로만 크레딧을 받는다.
 */
const SESSION_SECRET = process.env.SESSION_SECRET || "virtual-office-dev-secret-change-me";
const SIGNUP_BONUS = 300;   // 가입 시 무료로 주는 체험 크레딧 (구독 없이도 한 번 써볼 수 있게)
const COST_PER_AGENT = 10;  // 담당자 1명당 차감 크레딧
const COST_MANAGER = 20;    // 총괄AI 검수 차감 크레딧
const COST_CARDNEWS = 30;   // 카드뉴스 1건 생성 시 차감 크레딧

// 결제(토스페이먼츠) — 사업자가 실제 가맹 승인을 받으면 .env의 TOSS_CLIENT_KEY / TOSS_SECRET_KEY를
// 라이브 키(live_ck_..., live_sk_...)로 교체하기만 하면 된다. 지금은 테스트 키가 없으면 결제 버튼이
// "준비 중" 안내로 대체되어, 실서비스처럼 보이되 잘못된 키로 결제 시도가 되는 일은 없다.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || "";
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || "";

// 무통장입금 — PG 심사 없이 지금 바로 쓸 수 있는 결제 수단. 자동이 아니라 대표님이 실제
// 입금을 확인하고 관리자 페이지에서 승인해야 크레딧이 들어간다. .env에 은행 정보를 넣어야
// 화면에 노출된다.
// 예약 발행은 사용자 요청 없이 서버 타이머로 돌기 때문에 req에서 호스트를 알아낼 수 없다.
// 카드뉴스 이미지 URL을 인스타그램에 넘기려면 외부에서 접근 가능한 절대주소가 필요하므로
// .env의 SITE_URL을 쓴다(도메인이 바뀌면 이 값만 바꾸면 된다).
const PUBLIC_BASE_URL = (() => {
  const raw = process.env.SITE_URL || "nexta-yhy8.onrender.com";
  return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, "") : "https://" + raw.replace(/\/+$/, "");
})();

const BANK_NAME = process.env.BANK_NAME || "";
const BANK_ACCOUNT_NUMBER = process.env.BANK_ACCOUNT_NUMBER || "";
const BANK_ACCOUNT_HOLDER = process.env.BANK_ACCOUNT_HOLDER || "";

/* 정기결제(월 구독) — 유일한 크레딧 획득 경로. 두 요금제 모두 원가(총괄AI 검수에 쓰는
 * 고급 모델 호출) 대비 순이익률 70% 이상을 남기도록 크레딧량을 계산했다.
 * 가정: 담당자 호출은 경제형(무료) 모델이라 원가 0원, 총괄AI 검수만 고급 모델(오퍼스급,
 * 입력 $15/1M·출력 $75/1M 가정)을 쓴다. 평균 업무 1건(담당자 3명+검수, 재작업 확률 포함)의
 * 검수 원가 ≈ $0.18(약 250원), credits 50 소모 → 크레딧당 원가 ≈ 6원(여유 있게 잡은 값).
 * 스탠다드 19,900원 → AI 원가 예산 20%(3,980원) ÷ 6원 ≈ 660 → 600크레딧
 *   (원가 3,600원 18%+ 결제수수료 3.5% + 운영비 5% ≈ 총원가 26.6% → 순이익률 ≈ 73%)
 * 프로 29,900원 → AI 원가 예산 20%(5,980원) ÷ 6원 ≈ 997 → 1,000크레딧
 *   (원가 6,000원 20.1% + 결제수수료 3.5% + 운영비 5% ≈ 총원가 28.6% → 순이익률 ≈ 71%)
 * 실제 사용량은 db.getAiCostStats 등으로 주기적으로 검증해서 필요하면 조정할 것.
 */
const SUBSCRIPTION_PLANS = {
  standard: { key: "standard", label: "스탠다드", amount: 19900, credits: 600 },
  pro: { key: "pro", label: "프로", amount: 29900, credits: 1000 },
};
const SUBSCRIPTION_PERIOD_MS = 30 * 24 * 60 * 60 * 1000; // 30일

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
    accessUntil: u.accessUntil || null,
  };
}
// 정기결제가 아니라 "결제 1회 = 결제일로부터 30일" 방식이라, 한 번도 결제한 적 없는
// 사용자(accessUntil 없음)는 예전처럼 크레딧 잔액만으로 이용 가능 여부를 판단하고,
// 결제 이력이 있는 사용자는 그 30일이 지나면 크레딧이 남아 있어도 더 이상 쓸 수 없다.
function hasValidAccess(user) {
  if (!user.accessUntil) return true;
  return new Date(user.accessUntil).getTime() > Date.now();
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

// 기본지식(운영자가 미리 심어둔 전문가 자료) + 유저 개인지식을 둘 다 프롬프트에 넣는다.
// 예산을 나눠서 유저 자료가 많다고 기본지식이 밀려서 잘리는 일이 없게 한다.
function getKnowledgeContext(userId, role) {
  let out = "";

  const defaults = db.getDefaultKnowledge(role);
  if (defaults.length) {
    let joined = defaults.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
    if (joined.length > 5000) joined = joined.slice(0, 5000) + "\n...(자료가 길어 일부만 표시됨)";
    out += "[넥스타 전문가 기본지식 — 이 역할의 핵심 원칙. 검증된 실제 이론/기준이니 최우선으로 따른다]\n" + joined + "\n\n";
  }

  const userList = db.getKnowledge(userId, role);
  if (userList.length) {
    let joined = userList.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
    if (joined.length > 4000) joined = joined.slice(0, 4000) + "\n...(자료가 길어 일부만 표시됨)";
    out += "[대표님이 개인적으로 등록한 추가 자료 — 기본지식과 함께 참고한다]\n" + joined + "\n\n";
  }

  return out;
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
    cancelled: false,
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
// 품질(헛소리 방지) 측정 로그도 통계용일 뿐이라 실패해도 실제 업무 흐름을 막으면 안 된다.
function safeLogManagerVerdict(jobId, userId, roleKey, approved, attempt, at) {
  try { db.logManagerVerdict(jobId, userId, roleKey, approved, attempt, at); }
  catch (e) { console.warn("[품질 로그(검수 판정) 기록 실패 — 무시하고 계속]", e.message); }
}
function safeLogCeoDecision(jobId, userId, action, round, at) {
  try { db.logCeoDecision(jobId, userId, action, round, at); }
  catch (e) { console.warn("[품질 로그(대표 결정) 기록 실패 — 무시하고 계속]", e.message); }
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

/* ────────────────────────── 역할별 전문화 페르소나 ──────────────────────────
 * 실제로 존재하는 검증 가능한 이론/원칙만 담는다(지어낸 "전문성"은 헛소리 방지 취지에
 * 반한다). 근거: AIDA(Elias St. Elmo Lewis 판매원칙에서 유래), PAS(카피라이팅 고전
 * 구조), 네이버 C-Rank·D.I.A(네이버 공식 블로그가 설명한 자사 검색 랭킹 로직),
 * BEP(회계학 기본 개념), AARRR·Sean Ellis Test(그로스해킹 업계 표준),
 * SPIN Selling(Neil Rackham 영업 방법론), STAR 기법(구조화 면접 표준),
 * Lean Startup(Eric Ries). roleKey(SPECIALISTS[].roleKey) 기준으로 매핑한다.
 */
const SPECIALIST_PERSONAS = {
  전문_카피라이터: {
    systemNote: "당신은 AIDA(주목-관심-욕구-행동), PAS(문제-확대-해결) 같은 실전 카피 프레임워크를 상황에 맞게 골라 쓰는 카피라이터입니다.",
    outputHint: "후킹 문구는 15자 이내로 짧게, 본문은 상품의 실제 특징에서 나온 구체적 이유로 씁니다. 과장된 최상급 표현·검증 안 된 효능은 쓰지 않습니다.",
  },
  전문_이커머스: {
    systemNote: "당신은 상세페이지 구성 원칙과 가격심리(단수가격 vs 프리미엄 프라이싱), 오픈마켓 랭킹 요소(리뷰·응답속도)를 아는 이커머스 운영 담당입니다.",
    outputHint: "가격 전략을 제안할 때는 상품이 저가·실용재인지 고관여·선물용인지부터 구분해서 답하세요.",
  },
  전문_재무분석: {
    systemNote: "당신은 손익분기점(BEP), 원가율/마진율, 현금흐름 같은 실제 재무 개념을 정확한 계산식과 함께 설명하는 소상공인 전문 재무분석가입니다.",
    outputHint: "숫자를 다룰 때는 반드시 계산 과정을 보여주고, 입력된 정보로 계산 가능한 범위까지만 답하며 부족한 정보는 명시적으로 요청하세요. 추측성 숫자를 지어내지 마세요.",
  },
  전문_SEO: {
    systemNote: "당신은 네이버 검색엔진 최적화 전문가입니다. C-Rank(블로그 단위 신뢰도·주제 집중도)와 D.I.A(개별 문서의 검색의도 적합도) 같은 네이버가 공식적으로 설명한 랭킹 로직의 핵심 원칙을 반영해 조언합니다.",
    outputHint: "키워드를 인위적으로 반복 삽입하라고 조언하지 말고, 실제 검색 의도에 맞는 정보성 콘텐츠 구조 중심으로 답하세요.",
  },
  전문_성장코치: {
    systemNote: "당신은 PMF 판단 기준(Sean Ellis Test: '매우 실망할 것 같다' 응답 40% 이상)과 AARRR(획득-활성화-유지-추천-매출) 퍼널 같은 그로스해킹 표준 프레임을 아는 성장 코치입니다.",
    outputHint: "지금 어느 단계(획득/활성화/유지/추천/매출)가 가장 새는 구멍인지부터 짚고 우선순위를 제안하세요.",
  },
  전문_영업관리: {
    systemNote: "당신은 SPIN Selling(상황-문제-시사-해결 질문 구조) 같은 검증된 영업 방법론과 영업 퍼널(리드-상담-제안-협상-계약) 단계별 관리 원칙을 아는 영업관리 담당입니다.",
    outputHint: "일방적인 제품 설명보다, 고객이 스스로 필요성을 말하게 만드는 질문 구조를 제안하세요.",
  },
  전문_고객문의: {
    systemNote: "당신은 CS 응대 원칙(공감 → 사실확인 → 해결책 → 후속조치 순서)을 따르는 고객문의 응대 담당입니다.",
    outputHint: "회사가 지킬 수 없는 약속(정확한 배송일 단정 등)을 하지 말고, 사과와 공감을 원인 설명보다 먼저 배치하세요.",
  },
  전문_이메일: {
    systemNote: "당신은 이메일 마케팅 기본 구조(제목이 오픈률을 좌우, 본문 첫 줄에 핵심, CTA는 하나만)를 아는 이메일 담당입니다.",
    outputHint: "이메일 하나에 행동 유도(CTA)는 하나만 넣으세요.",
  },
  전문_채용: {
    systemNote: "당신은 채용 공고문 작성 원칙과 STAR 기법(상황-과제-행동-결과)으로 지원자 경험을 구조화해서 검토하는 채용 담당입니다.",
    outputHint: "자격요건에서 '우대'와 '필수'를 명확히 구분하세요 — 우대를 필수처럼 적으면 적합한 지원자도 지레 포기합니다.",
  },
  전문_전략기획: {
    systemNote: "당신은 린 스타트업(MVP로 빠르게 검증 후 반영) 방법론과 PMF 판단 기준을 아는 전략기획 담당입니다.",
    outputHint: "전면 투자를 제안하기 전에, 적은 비용으로 실제 수요를 먼저 확인할 방법(사전예약, 소량 테스트 등)부터 제시하세요.",
  },
  전문_SNS콘텐츠: {
    systemNote: "당신은 저장·공유·댓글 같은 적극적 반응이 도달에 유리하다는 인스타그램 공식 언급 원칙과 카드뉴스 완독률 원칙(장당 메시지 하나, 다음 장 유도)을 아는 SNS·블로그 콘텐츠 담당입니다.",
    outputHint: "단순 홍보 문구보다 저장하고 싶은 정보성 구성이나 댓글을 유도하는 질문형 마무리를 우선하세요.",
  },
  전문_비서: {
    systemNote: "당신은 시선 흐름(삼분할 구도), 명도 대비, 여백 활용 같은 기본 이미지 구성 원칙을 아는 이미지 기획 담당입니다.",
    outputHint: "요소를 욱여넣지 말고, 핵심 메시지 하나에 집중한 구도를 제안하세요.",
  },
};

/* ────────────────────────── 프롬프트 ────────────────────────── */

const 한국어전용 =
  "매우 중요한 규칙: 반드시 100% 한국어로만 답하세요. 영어 단어, 중국어, 일본어, 그 밖의 " +
  "다른 언어를 단 한 글자도 섞지 마세요. 사람·회사·제품의 고유명사도 가능하면 한글로 표기하세요 " +
  "(예: OpenAI → 오픈AI). 이 규칙을 어기면 안 됩니다.\n\n";

function 전문가지시(spec, question, ceoFeedback, reworkFeedback, memoryCtx, knowledgeCtx, brandCtx) {
  const persona = SPECIALIST_PERSONAS[spec.roleKey];
  // Lost-in-the-Middle 대응: 프롬프트가 길어질수록(지식/기억/이전 피드백이 쌓일수록) 모델이
  // 중간에 낀 지시를 놓치기 쉽다. 그래서 "이번에 가장 중요한 지시"를 맨 끝(질문 바로 다음,
  // 실제로 답을 쓰기 직전)에 짧게 한 번 더 반복한다.
  const 이번라운드핵심 = reworkFeedback
    ? "이번 라운드에서 가장 먼저 고쳐야 할 것: " + reworkFeedback
    : (ceoFeedback ? "대표님이 이번에 가장 원하는 것: " + ceoFeedback : "");

  return (
    한국어전용 +
    "당신은 1인 사업가(대표)를 돕는 AI 직원이며, 담당 역할은 [" + spec.label + "]입니다.\n" +
    "담당 설명: " + spec.desc + "\n" +
    (persona ? persona.systemNote + "\n" : "") +
    "중요: 다른 담당자와 이야기를 나누지 않습니다. 오직 당신의 담당 범위 안에서만, 아는 만큼 정확하게 답하세요.\n\n" +
    (brandCtx || "") +
    knowledgeCtx +
    memoryCtx +
    "[대표의 이번 지시]\n" + question + "\n\n" +
    (ceoFeedback ? "[대표님이 직접 보완 요청한 내용 — 반드시 반영]\n" + ceoFeedback + "\n\n" : "") +
    (reworkFeedback ? "[총괄AI의 보완 지시 — 반드시 반영해서 다시 작성]\n" + reworkFeedback + "\n\n" : "") +
    "작성 규칙:\n" +
    "- 담당 역할 범위 안에서만 답한다. 다른 담당자 몫의 일은 하지 않는다.\n" +
    "- 제공된 지식·검색결과·자료에 없는 사실은 지어내지 않는다. 없으면 없다고 표시한다.\n" +
    "- 확실하지 않은 내용은 추측해서 단정짓지 말고, '확인이 필요합니다' 또는 '추가 정보가 없어 " +
    "판단이 어렵습니다'라고 솔직히 답해도 된다. 근거 없이 확신하는 것보다 훨씬 낫다.\n" +
    "- 숫자나 시점이 있으면 반드시 함께 적는다.\n" +
    "- 전문용어 없이, 처음 듣는 사람도 이해할 쉬운 말로 쓴다.\n" +
    "- 실제로 메일을 보내거나 SNS에 게시하거나 결제·구독을 하지 않는다. 초안/제안만 작성한다.\n" +
    (persona ? "- " + persona.outputHint + "\n" : "") +
    "\n" +
    (이번라운드핵심 ? "[다시 한번, 이번에 꼭 반영할 것]\n" + 이번라운드핵심 + "\n\n" : "") +
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
    "1) 신빙성 검사 — 결과물에 있는 핵심 주장(수치, 사실, 추천)을 하나씩 짚어서, 각각 제공된 " +
    "지식/자료/검색결과로 뒷받침되는지 확인한다. 뒷받침 안 되는 주장이 있으면 feedback에 " +
    "'어떤 문장의 어떤 주장이 근거 없는지' 구체적으로 지적한다(예: '월 매출 500만원이라는 " +
    "숫자의 근거가 없음' 처럼 문장을 콕 집어서).\n" +
    "2) 대표님(전문 지식이 없는 1인 사업가) 눈높이에 맞게 정리해서 설명한다.\n" +
    "3) 결과물을 어디에 보관하면 좋을지 추천한다 (파일 보관 / 노션 정리 / 디스코드 공유 중 성격에 맞는 것 하나).\n" +
    "4) 담당자별로 통과(approved:true)/반려(approved:false) 판정을 내린다. 대표님을 오래 기다리게 하면 " +
    "안 되므로, 완벽하지 않아도 대표가 판단하기에 충분하면 통과시킨다. 핵심 질문을 아예 다루지 않았거나, " +
    "뒷받침 안 되는 핵심 주장을 확인 안 됨 표시 없이 단정했거나, 완전히 지어낸 것으로 보일 때만 반려한다. " +
    "'확인 안 됨'이라고 솔직히 인정한 부분은 반려 사유가 아니다 — 오히려 바람직하다.\n\n" +
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

// 대표가 담당자를 1명만 골랐을 때, 질문이 실제로는 다른 담당자 영역이면 자동으로 인계한다.
function 라우팅분류지시(question, selectedKey) {
  const list = SPECIALIST_KEYS.map((k) => "- " + k + ": " + SPECIALISTS[k].desc).join("\n");
  return (
    한국어전용 +
    "아래 [담당자 목록] 중에서 [질문]에 가장 적합한 담당자를 정확히 1명 고르세요.\n" +
    "확신이 없거나 여러 담당자에 걸쳐 있어 애매하면, 무리해서 바꾸지 말고 원래 선택된 담당자를 " +
    "그대로 유지하세요(matchesSelection: true). 명백히 다른 담당자 영역일 때만 바꾸세요.\n\n" +
    "[담당자 목록]\n" + list + "\n\n" +
    "[대표가 원래 선택한 담당자] " + selectedKey + "\n" +
    "[질문] " + question + "\n\n" +
    "JSON만 출력하세요. 다른 말은 쓰지 마세요. reason은 matchesSelection이 false일 때만 " +
    "한국어 한 문장으로 채우세요.\n" +
    '{"bestRoleKey": "담당자키", "matchesSelection": true 또는 false, "reason": ""}'
  );
}
async function classifyBestRole(config, question, selectedKey, job) {
  try {
    const result = await callWithFallback(
      config, "라우팅_분류", 라우팅분류지시(question, selectedKey), false, 200,
      { userId: job.userId, jobId: job.id }
    );
    const parsed = parseJSON(result.text);
    if (!parsed || !SPECIALISTS[parsed.bestRoleKey]) return null;
    return parsed;
  } catch (e) {
    console.warn("[라우팅 분류 실패 — 원래 선택 유지]", e.message);
    return null;
  }
}

/* ────────────────────────── 전체 업무 진행 ────────────────────────── */

async function runPipeline(job) {
  const config = loadModelConfig();
  const question = job.question;
  const agentKeys = job.agentKeys;
  let ceoFeedback = "";

  try {
    // 자동 역할 라우팅 — 대표가 담당자를 정확히 1명만 골랐을 때만 검토한다.
    // 복수 선택은 이미 의도적인 선택이므로 라우팅을 건너뛴다(오탐 방지).
    if (job.routeCheck && agentKeys.length === 1) {
      const routing = await classifyBestRole(config, question, agentKeys[0], job);
      if (routing && routing.matchesSelection === false && routing.bestRoleKey !== agentKeys[0]) {
        const from = agentKeys[0];
        emit(job, {
          type: "handoff",
          from, to: routing.bestRoleKey,
          fromLabel: SPECIALISTS[from].label, toLabel: SPECIALISTS[routing.bestRoleKey].label,
          text: "이 질문은 " + SPECIALISTS[routing.bestRoleKey].label + "이에요. 제가 대신 답변할게요" +
            (routing.reason ? " — " + routing.reason : ""),
        });
        agentKeys[0] = routing.bestRoleKey; // job.agentKeys와 같은 배열이라 그대로 반영됨
      }
    }

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

      if (job.cancelled) { emit(job, { type: "cancelled", text: "대표님이 업무를 취소했습니다." }); return; }

      // 2) 총괄AI 검수 (반려된 담당자만 재작업, 반복)
      let finalReport = "";
      let storageNote = "";
      let finalVerdicts = {}; // 마지막 검수 판정 — 끝까지 반려된(질문과 안 맞는) 담당자는 크레딧을 안 받는다
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
        finalVerdicts = verdicts;
        agentKeys.forEach((key) => {
          const v = verdicts[key];
          if (v && typeof v.approved === "boolean") {
            safeLogManagerVerdict(job.id, job.userId, SPECIALISTS[key].roleKey, v.approved, mAttempt, new Date().toISOString());
          }
        });
        const rejected = agentKeys.filter((key) => verdicts[key] && verdicts[key].approved === false);
        const canRetry = mAttempt <= MAX_MANAGER_RETRY && rejected.length > 0;

        if (job.cancelled) { emit(job, { type: "cancelled", text: "대표님이 업무를 취소했습니다." }); return; }

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
        // 끝까지 반려된(=이 질문을 처리 못한) 담당자는 크레딧 대상에서 빠진다는 걸 알려준다.
        const stillRejected = agentKeys.filter((key) => finalVerdicts[key] && finalVerdicts[key].approved === false);
        if (stillRejected.length) {
          finalReport += "\n\n## 참고\n" +
            stillRejected.map((key) => SPECIALISTS[key].label).join(", ") +
            "은(는) 이 질문을 제대로 처리하지 못해 해당 담당자의 크레딧은 차감하지 않았습니다.";
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
      // 빠른 모드가 아니면, 총괄AI가 끝까지 반려한(질문과 안 맞아 처리 못한) 담당자는 빼고 차감한다.
      if (!job.charged && job.userId) {
        const chargeableAgents = job.quick
          ? agentKeys.length
          : agentKeys.filter((key) => !(finalVerdicts[key] && finalVerdicts[key].approved === false)).length;
        const actualCost = chargeableAgents * COST_PER_AGENT + (job.quick ? 0 : COST_MANAGER);
        const remaining = chargeUser(job.userId, actualCost, {
          agents: chargeableAgents,
          question: String(question).slice(0, 60),
        });
        job.charged = true;
        if (remaining !== null) emit(job, { type: "credit", credits: remaining, cost: actualCost });
      }

      // 3) 대표(사용자) 최종 승인
      ["총괄AI"].concat(agentKeys).forEach((n) => emit(job, { type: "status", agent: n, state: "done", text: "승인 대기" }));
      emit(job, { type: "await-approval", round, lastRound: round >= MAX_CEO_ROUNDS, report: finalReport, citations: allCitations });
      safeUpdateJobLogStatus(job.id, "awaiting_approval", null, new Date().toISOString());

      const decision = await waitForCeo(job);
      safeLogCeoDecision(job.id, job.userId, decision.action, round, new Date().toISOString());

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

/* ══════════════════════════════════════════════════════════════
   무통장입금 — 사업자 심사 없이 지금 바로 켤 수 있는 결제 수단.
   크레딧 단품 충전이 아니라 월 구독(SUBSCRIPTION_PLANS) 결제 수단 중 하나다 — 자동 재청구는
   안 되니, 신청 → 대표님이 실제 입금을 눈으로 확인 → /admin.html에서 승인 → 그때 크레딧 지급 +
   30일 이용 기간 부여. 다음 달에는 사용자가 다시 신청해야 한다(정기결제는 위 토스 빌링 참고).
   ══════════════════════════════════════════════════════════════ */
app.get("/api/payment/bank-transfer/config", (req, res) => {
  res.json({
    enabled: !!BANK_ACCOUNT_NUMBER,
    bank: BANK_NAME, accountNumber: BANK_ACCOUNT_NUMBER, accountHolder: BANK_ACCOUNT_HOLDER,
    plans: SUBSCRIPTION_PLANS,
  });
});
app.post("/api/payment/bank-transfer/request", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  if (!BANK_ACCOUNT_NUMBER) return res.status(400).json({ error: "무통장입금이 아직 준비되지 않았습니다." });

  const planKey = String((req.body && req.body.plan) || "");
  const plan = SUBSCRIPTION_PLANS[planKey];
  if (!plan) return res.status(400).json({ error: "존재하지 않는 요금제입니다." });
  const depositorName = String((req.body && req.body.depositorName) || "").trim().slice(0, 40);
  if (!depositorName) return res.status(400).json({ error: "입금하실 분 성함을 입력해 주세요." });

  const orderId = "bank_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  db.createOrder(orderId, {
    userId: u.id, credits: plan.credits, amount: plan.amount, label: plan.label,
    status: "pending", createdAt: nowKR(), method: "bank_transfer", depositorName,
  });
  res.json({
    ok: true, orderId,
    bank: BANK_NAME, accountNumber: BANK_ACCOUNT_NUMBER, accountHolder: BANK_ACCOUNT_HOLDER,
    amount: plan.amount, credits: plan.credits,
  });
});

/* ══════════════════════════════════════════════════════════════
   정기결제(구독) — 토스페이먼츠 빌링(자동결제) API. SUBSCRIPTION_PLANS(스탠다드/프로) 중
   하나를 고르면 그 플랜의 금액으로 매달 자동 청구된다. TOSS_CLIENT_KEY/TOSS_SECRET_KEY가
   없으면 "준비 중"으로 안내되어 잘못된 키로 구독이 시도되는 일은 없다. 사업자등록증으로
   빌링 심사를 통과해서 실제 키를 .env에 넣으면 그대로 작동한다.
   흐름: ① 프런트가 tossPayments.requestBillingAuth()로 카드 등록 → 토스가 브라우저를
   /api/subscription/billing-success로 돌려보냄 → ② 서버가 빌링키 발급 + 첫 결제 즉시 청구 →
   ③ 이후 매 30일마다 서버의 스케줄러(chargeRenewal)가 그 빌링키로 자동 재청구.
   구독을 취소해도 즉시 끊지 않는다 — current_period_end(이미 낸 기간)까지는 그대로 쓸 수
   있고, 다음 자동 재청구만 안 하는 방식이다.
   ══════════════════════════════════════════════════════════════ */

async function chargeTossBilling(billingKey, { customerKey, amount, orderId, orderName }) {
  const resp = await fetch(`https://api.tosspayments.com/v1/billing/${billingKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(TOSS_SECRET_KEY + ":").toString("base64"),
    },
    body: JSON.stringify({ customerKey, amount, orderId, orderName }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || "정기결제 청구 실패");
  return data;
}

app.get("/api/subscription/config", (req, res) => {
  res.json({ enabled: !!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY), clientKey: TOSS_CLIENT_KEY, plans: SUBSCRIPTION_PLANS });
});

app.get("/api/subscription/status", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const sub = db.getSubscription(u.id);
  if (!sub) return res.json({ subscribed: false });
  res.json({
    subscribed: true,
    status: sub.status,
    plan: sub.plan,
    currentPeriodEnd: sub.currentPeriodEnd,
    canceledAt: sub.canceledAt,
    lastFailureReason: sub.status === "past_due" ? sub.lastFailureReason : null,
  });
});

// 카드 등록(빌링키 발급) 완료 후 토스가 브라우저를 이 주소로 돌려보낸다 (authKey, customerKey, plan 쿼리).
// customerKey는 프런트가 requestBillingAuth()에 넘긴 값을 토스가 그대로 돌려준 것일 뿐이라
// (지금은 me.email을 쓴다 — 내부 사용자 id는 클라이언트에 노출하지 않으므로) 우리 쪽 사용자
// 식별은 이 값이 아니라 항상 로그인 세션(currentUser)으로만 한다. plan도 프런트가 successUrl에
// 실어 보낸 값이라 서버는 SUBSCRIPTION_PLANS에 실제로 존재하는 키인지만 검증한다.
app.get("/api/subscription/billing-success", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.redirect("/?subscription=fail");
  const { authKey, customerKey } = req.query;
  const plan = SUBSCRIPTION_PLANS[String(req.query.plan || "")];
  if (!authKey || !customerKey || !plan || !(TOSS_CLIENT_KEY && TOSS_SECRET_KEY)) {
    return res.redirect("/?subscription=fail");
  }

  try {
    const issueResp = await fetch("https://api.tosspayments.com/v1/billing/authorizations/issue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(TOSS_SECRET_KEY + ":").toString("base64"),
      },
      body: JSON.stringify({ authKey, customerKey }),
    });
    const issueData = await issueResp.json();
    if (!issueResp.ok) throw new Error(issueData.message || "빌링키 발급 실패");
    const billingKey = issueData.billingKey;

    const orderId = "sub_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await chargeTossBilling(billingKey, {
      customerKey, amount: plan.amount, orderId, orderName: "넥스타 " + plan.label + " 구독",
    });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + SUBSCRIPTION_PERIOD_MS).toISOString();
    db.upsertSubscription(u.id, {
      billingKeyEnc: encryptSecret(billingKey), // 빌링키도 카드 자체나 다름없어 평문 저장 금지
      customerKey, // 재청구할 때도 발급 당시와 같은 값을 써야 하므로 같이 저장해둔다
      status: "active",
      plan: plan.key,
      currentPeriodEnd: periodEnd,
      canceledAt: null,
      lastPaymentAt: now.toISOString(),
      lastFailureReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const credits = (u.credits || 0) + plan.credits;
    db.updateCredits(u.id, credits, credits);
    db.setAccessUntil(u.id, periodEnd);

    res.redirect("/?subscription=success");
  } catch (e) {
    console.error("[구독 등록 실패]", e.message);
    res.redirect("/?subscription=fail");
  }
});

// 구독 취소 — 즉시 끊지 않는다. 이미 낸 기간(current_period_end)까지는 그대로 쓰고,
// 다음 자동 재청구만 걸리지 않게 한다.
app.post("/api/subscription/cancel", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const sub = db.getSubscription(u.id);
  if (!sub || sub.status !== "active") {
    return res.status(400).json({ error: "활성 구독이 없습니다." });
  }
  db.updateSubscriptionFields(u.id, { status: "canceled", canceledAt: new Date().toISOString() });
  res.json({ ok: true, currentPeriodEnd: sub.currentPeriodEnd });
});

// 30일마다 자동 재청구 — Toss는 매 주기마다 알아서 청구해주지 않으므로 우리 서버가
// 직접 "이번 기간이 끝난 활성 구독"을 찾아서 그 빌링키로 청구를 건다.
async function chargeRenewal(sub) {
  try {
    const plan = SUBSCRIPTION_PLANS[sub.plan] || SUBSCRIPTION_PLANS.standard;
    const billingKey = decryptSecret(sub.billingKeyEnc);
    const orderId = "subrenew_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    await chargeTossBilling(billingKey, {
      customerKey: sub.customerKey, amount: plan.amount, orderId, orderName: "넥스타 " + plan.label + " 구독",
    });

    const newPeriodEnd = new Date(new Date(sub.currentPeriodEnd).getTime() + SUBSCRIPTION_PERIOD_MS).toISOString();
    db.updateSubscriptionFields(sub.userId, {
      status: "active", currentPeriodEnd: newPeriodEnd,
      lastPaymentAt: new Date().toISOString(), lastFailureReason: null,
    });
    const user = db.getUserById(sub.userId);
    if (user) {
      const credits = (user.credits || 0) + plan.credits;
      db.updateCredits(sub.userId, credits, credits);
      db.setAccessUntil(sub.userId, newPeriodEnd);
    }
    console.log("[정기결제 갱신 성공]", sub.userId);
  } catch (e) {
    // 실패(카드 만기 등) — 즉시 이용 중단: access_until을 연장하지 않고 그대로 두면
    // 이미 지난 시각이라 hasValidAccess()가 자동으로 막아준다. 대표님이 확인할 수 있도록
    // last_failure_reason에 사유를 남기고, 사용자는 다음에 서비스를 쓰려 할 때 안내 문구를 본다
    // (이메일·SMS 알림 채널은 없음 — 필요하면 나중에 별도로 연결).
    console.error("[정기결제 갱신 실패]", sub.userId, e.message);
    db.updateSubscriptionFields(sub.userId, { status: "past_due", lastFailureReason: String(e.message).slice(0, 300) });
  }
}
const SUBSCRIPTION_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 확인
setInterval(() => {
  if (!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY)) return;
  db.getDueSubscriptions(new Date().toISOString()).forEach((sub) => { chargeRenewal(sub); });
}, SUBSCRIPTION_CHECK_INTERVAL_MS);

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
  if (!hasValidAccess(u)) {
    return res.status(402).json({ error: "결제 후 30일 이용 기간이 지났습니다. 다시 결제해 주세요.", accessUntil: u.accessUntil });
  }
  const p = req.body || {};
  if (!p.name || !p.hook) return res.status(400).json({ error: "name, hook은 필수입니다." });

  if ((u.credits || 0) < COST_CARDNEWS) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 구독하시면 매달 크레딧이 채워집니다." });
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
  if (!hasValidAccess(user)) {
    return res.status(402).json({ error: "결제 후 30일 이용 기간이 지났습니다. 다시 결제해 주세요.", accessUntil: user.accessUntil });
  }

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
    return res.status(402).json({ error: "크레딧이 부족합니다. 구독하시면 매달 크레딧이 채워집니다.", need: cost, have: user.credits || 0 });
  }

  const job = createSimpleJob(user.id, cost);
  safeCreateJobLog(job.id, user.id, "coupang_auto", productName + " (" + category + ")", [], new Date().toISOString());
  res.json({ jobId: job.id, cost });

  const baseUrl = `${req.protocol}://${req.get("host")}`;
  runCoupangAutoJob(job, { category, productName, price, imageUrl, quantity, commentKeyword, baseUrl, social, promoOptout: !!user.promoOptout });
});

/* ══════════════════════════════════════════════════════════════
   3-2) 자동 발행 — 보관함 + 예약
   쿠팡은 서버에서 상품을 긁어올 수 없어(차단됨) 북마클릿으로만 가져온다. 그래서
   "한가할 때 상품을 보관함에 담아두면, 예약 시각마다 하나씩 꺼내 알아서 발행"하는 구조다.
   대표가 자는 동안에도 계정이 계속 돌아가게 만드는 것이 이 기능의 목적이다.
   ══════════════════════════════════════════════════════════════ */
const AUTO_QUEUE_MAX = 60; // 보관함 상한 — 무한정 쌓아 크레딧이 예고 없이 소진되는 것을 막는다

// KST 기준 날짜/시각 (서버 타임존과 무관하게 한국 시간으로 예약을 판단한다)
function kstNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: parseInt(get("hour"), 10) || 0 };
}

app.get("/api/social/queue", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({ items: db.listQueue(u.id, 50), pending: db.countPendingQueue(u.id), max: AUTO_QUEUE_MAX });
});

app.post("/api/social/queue", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });

  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 200);
  const category = String(b.category || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "상품명이 필요합니다. 북마클릿으로 다시 가져와 주세요." });
  if (!category) return res.status(400).json({ error: "카테고리를 선택해 주세요." });
  if (db.countPendingQueue(u.id) >= AUTO_QUEUE_MAX) {
    return res.status(400).json({ error: `보관함이 가득 찼습니다(최대 ${AUTO_QUEUE_MAX}개). 발행되면 자리가 생겨요.` });
  }

  db.addQueueItem(u.id, {
    id: "q_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    name, category,
    price: String(b.price || "").trim().slice(0, 40),
    imageUrl: String(b.imageUrl || "").trim().slice(0, 1000),
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true, pending: db.countPendingQueue(u.id) });
});

app.delete("/api/social/queue/:id", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  db.deleteQueueItem(u.id, req.params.id);
  res.json({ ok: true, pending: db.countPendingQueue(u.id) });
});

app.get("/api/social/schedule", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({
    schedule: db.getSchedule(u.id) || { enabled: false, hour: 8, quantity: 2, commentKeyword: "정보" },
    pending: db.countPendingQueue(u.id),
    instagramConnected: !!(u.social && u.social.instagram),
  });
});

app.post("/api/social/schedule", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const b = req.body || {};
  const enabled = !!b.enabled;
  if (enabled && !(u.social && u.social.instagram)) {
    return res.status(400).json({ error: "먼저 인스타그램 계정을 연결해 주세요." });
  }
  db.upsertSchedule(u.id, {
    enabled,
    hour: Math.max(0, Math.min(23, parseInt(b.hour, 10) || 8)),
    quantity: Math.min(COUPANG_AUTO_MAX_QTY, Math.max(1, parseInt(b.quantity, 10) || 2)),
    commentKeyword: String(b.commentKeyword || "정보").trim().slice(0, 20) || "정보",
  });
  res.json({ ok: true, schedule: db.getSchedule(u.id) });
});

/* 예약 실행기 — 10분마다 "오늘 아직 안 돈, 시각이 된" 예약을 찾아 보관함에서 1건씩 발행한다.
   실패해도(크레딧 부족, 보관함 비어 있음 등) 사유만 남기고 그날은 넘어간다 — 재시도로
   크레딧이 예고 없이 빠져나가지 않게 하기 위함이다. */
const AUTO_SCHEDULE_CHECK_MS = 10 * 60 * 1000;
async function runScheduledPost(schedule) {
  const { date } = kstNow();
  const user = db.getUserById(schedule.userId);
  if (!user) return;

  const finish = (msg) => db.markScheduleRun(schedule.userId, date, msg);

  const social = user.social && user.social.instagram;
  if (!social) return finish("인스타그램 연결이 해제되어 건너뜀");
  if (!hasValidAccess(user)) return finish("이용 기간이 끝나 건너뜀");

  const item = db.nextPendingQueueItem(schedule.userId);
  if (!item) return finish("보관함이 비어 있어 건너뜀");

  const cost = COST_CARDNEWS * schedule.quantity;
  if ((user.credits || 0) < cost) return finish("크레딧이 부족해 건너뜀");

  // 하루 1회 보장을 위해 실행 "시작" 시점에 오늘 날짜를 먼저 찍는다.
  // (발행이 오래 걸려도 다음 10분 주기에서 중복 실행되지 않게)
  finish("발행 중…");

  const job = createSimpleJob(user.id, cost);
  safeCreateJobLog(job.id, user.id, "auto_scheduled", item.name + " (" + item.category + ")", [], new Date().toISOString());

  try {
    await runCoupangAutoJob(job, {
      category: item.category, productName: item.name, price: item.price, imageUrl: item.imageUrl,
      quantity: schedule.quantity, commentKeyword: schedule.commentKeyword,
      baseUrl: PUBLIC_BASE_URL, social, promoOptout: !!user.promoOptout,
    });
    db.markQueueItem(item.id, "done", null, new Date().toISOString());
    db.markScheduleRun(schedule.userId, date, `발행 완료 — ${item.name}`);
  } catch (e) {
    db.markQueueItem(item.id, "failed", String(e.message || e).slice(0, 300), null);
    db.markScheduleRun(schedule.userId, date, "발행 실패 — " + String(e.message || e).slice(0, 120));
    console.error("[예약 발행 실패]", schedule.userId, e.message);
  }
}
setInterval(() => {
  const { date, hour } = kstNow();
  let due = [];
  try { due = db.getDueSchedules(date, hour); }
  catch (e) { console.warn("[예약 조회 실패 — 무시]", e.message); return; }
  // 한 주기에 여러 사용자가 걸려도 순차 실행한다 (동시에 여러 건이 돌면 API 한도에 걸린다)
  due.reduce((chain, s) => chain.then(() => runScheduledPost(s).catch(() => {})), Promise.resolve());
}, AUTO_SCHEDULE_CHECK_MS);

/* ══════════════════════════════════════════════════════════════
   3-3) 수익 대시보드 — "비비들이 얼마나 벌어줬나"
   쿠팡 파트너스는 공식 Open API로 자동 수집하고, API가 없는 채널(애드센스·틱톡 등)은
   직접 입력을 받는다. 파트너스 키는 사용자마다 자기 계정 것을 쓰므로 사용자별로 저장하며,
   인스타 토큰과 같은 방식으로 암호화해 둔다.
   ══════════════════════════════════════════════════════════════ */
const REVENUE_CHANNELS = {
  coupang: "쿠팡 파트너스",
  adsense: "애드센스",
  tiktok: "틱톡",
  smartstore: "스마트스토어",
  youtube: "유튜브",
  etc: "기타",
};

/** 쿠팡 Open API 서명 — CEA HmacSHA256. 서명 시각은 반드시 UTC(yyMMddTHHmmssZ). */
function coupangAuthHeader(accessKey, secretKey, method, pathOnly, query) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const datetime =
    String(d.getUTCFullYear()).slice(-2) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) +
    "T" + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + "Z";
  const message = datetime + method.toUpperCase() + pathOnly + (query || "");
  const signature = crypto.createHmac("sha256", secretKey).update(message).digest("hex");
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`;
}

const COUPANG_API_HOST = "https://api-gateway.coupang.com";
const COUPANG_COMMISSION_PATH = "/v2/providers/affiliate_open_api/apis/openapi/reports/commission";

/** 쿠팡 파트너스 커미션 리포트 조회 (한 번에 최대 30일). yyyyMMdd 형식. */
async function fetchCoupangCommission(accessKey, secretKey, startDate, endDate) {
  const query = `startDate=${startDate}&endDate=${endDate}`;
  const auth = coupangAuthHeader(accessKey, secretKey, "GET", COUPANG_COMMISSION_PATH, query);
  const resp = await fetch(`${COUPANG_API_HOST}${COUPANG_COMMISSION_PATH}?${query}`, {
    method: "GET",
    headers: { Authorization: auth, "Content-Type": "application/json;charset=UTF-8" },
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("쿠팡 응답을 해석하지 못했습니다."); }
  if (!resp.ok) throw new Error(data.message || data.rMessage || `쿠팡 API 오류 (${resp.status})`);
  return Array.isArray(data.data) ? data.data : [];
}

/** 리포트를 하루 단위로 합쳐 저장한다 (같은 날짜에 trackingCode별로 여러 행이 온다). */
async function syncCoupangRevenue(userId) {
  const key = db.getRevenueKey(userId, "coupang");
  if (!key || !key.accessKeyEnc || !key.secretKeyEnc) return { ok: false, error: "키가 등록되지 않았습니다." };

  try {
    const accessKey = decryptSecret(key.accessKeyEnc);
    const secretKey = decryptSecret(key.secretKeyEnc);
    const end = new Date();
    const start = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000); // API 상한이 30일
    const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
    const rows = await fetchCoupangCommission(accessKey, secretKey, ymd(start), ymd(end));

    const byDate = new Map();
    for (const r of rows) {
      const raw = String(r.date || "");
      const date = raw.includes("-") ? raw : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      const cur = byDate.get(date) || { amount: 0, clicks: 0, orders: 0 };
      cur.amount += Number(r.commission) || 0;
      cur.clicks += Number(r.click) || 0;
      cur.orders += Number(r.order) || 0;
      byDate.set(date, cur);
    }
    db.upsertRevenueMany(
      userId,
      [...byDate.entries()].map(([date, v]) => ({
        date, channel: "coupang", amount: v.amount, clicks: v.clicks, orders: v.orders, source: "api",
      })),
    );
    db.markRevenueSync(userId, "coupang", null);
    return { ok: true, days: byDate.size };
  } catch (e) {
    db.markRevenueSync(userId, "coupang", e.message);
    return { ok: false, error: e.message };
  }
}

app.get("/api/revenue/summary", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });

  const { date: today } = kstNow();
  const d = new Date(today + "T00:00:00Z");
  const iso = (x) => x.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + "01";
  const prevMonthEnd = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)));
  const prevMonthStart = prevMonthEnd.slice(0, 8) + "01";
  const from = iso(new Date(d.getTime() - 89 * 24 * 60 * 60 * 1000));

  const entries = db.listRevenue(u.id, from);
  const byChannel = {};
  const byDate = {};
  for (const e of entries) {
    // 상한(today)을 함께 걸어야 채널별 합계와 thisMonth 총액이 어긋나지 않는다.
    if (e.date >= monthStart && e.date <= today) {
      byChannel[e.channel] = (byChannel[e.channel] || 0) + e.amount;
    }
    byDate[e.date] = (byDate[e.date] || 0) + e.amount;
  }

  const key = db.getRevenueKey(u.id, "coupang");
  res.json({
    channels: REVENUE_CHANNELS,
    thisMonth: db.getRevenueTotal(u.id, monthStart, today),
    lastMonth: db.getRevenueTotal(u.id, prevMonthStart, prevMonthEnd),
    allTime: db.getRevenueTotal(u.id, "0000-00-00", "9999-99-99"),
    byChannel,
    // 최근 30일 추이 (빈 날짜는 0으로 채워 그래프가 끊기지 않게)
    trend: Array.from({ length: 30 }, (_, i) => {
      const day = iso(new Date(d.getTime() - (29 - i) * 24 * 60 * 60 * 1000));
      return { date: day, amount: byDate[day] || 0 };
    }),
    recent: entries.slice(0, 30),
    coupang: {
      connected: !!(key && key.accessKeyEnc),
      lastSyncedAt: key?.lastSyncedAt || null,
      lastError: key?.lastError || null,
    },
  });
});

// 직접 입력 — API가 없는 채널(애드센스·틱톡 등)이나 수동 보정용
app.post("/api/revenue/entry", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const b = req.body || {};
  const channel = String(b.channel || "");
  const date = String(b.date || "");
  if (!REVENUE_CHANNELS[channel]) return res.status(400).json({ error: "알 수 없는 채널입니다." });
  // 형태만 맞는 "2026-13-99" 같은 값이 통과하면 집계마다 다르게 잡혀(문자열 비교라) 합계가 어긋난다.
  // 실제 달력 날짜인지 왕복 변환으로 확인하고, 미래 날짜도 막는다.
  const parsed = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== date) {
    return res.status(400).json({ error: "날짜 형식이 올바르지 않습니다." });
  }
  if (date > kstNow().date) return res.status(400).json({ error: "미래 날짜는 입력할 수 없습니다." });
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < 0 || amount > 1000000000) {
    return res.status(400).json({ error: "금액을 다시 확인해 주세요." });
  }
  // 쿠팡은 API가 값을 덮어쓰므로 수동 입력이 무의미하다 — 헷갈리지 않게 막는다.
  if (channel === "coupang" && db.getRevenueKey(u.id, "coupang")?.accessKeyEnc) {
    return res.status(400).json({ error: "쿠팡은 API로 자동 수집 중이라 직접 입력할 수 없습니다." });
  }
  db.upsertRevenue(u.id, { date, channel, amount, source: "manual" });
  res.json({ ok: true });
});

app.delete("/api/revenue/entry", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const b = req.body || {};
  db.deleteRevenue(u.id, String(b.date || ""), String(b.channel || ""));
  res.json({ ok: true });
});

// 쿠팡 파트너스 키 등록 — 저장 즉시 한 번 당겨보고, 실패하면 키를 지워 잘못된 키가 남지 않게 한다
app.post("/api/revenue/coupang/connect", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const accessKey = String((req.body && req.body.accessKey) || "").trim();
  const secretKey = String((req.body && req.body.secretKey) || "").trim();
  if (!accessKey || !secretKey) return res.status(400).json({ error: "액세스 키와 시크릿 키를 모두 입력해 주세요." });

  db.setRevenueKey(u.id, "coupang", encryptSecret(accessKey), encryptSecret(secretKey));
  const result = await syncCoupangRevenue(u.id);
  if (!result.ok) {
    db.deleteRevenueKey(u.id, "coupang");
    return res.status(400).json({ error: "키 확인에 실패했습니다: " + result.error });
  }
  res.json({ ok: true, days: result.days });
});

app.post("/api/revenue/coupang/disconnect", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  db.deleteRevenueKey(u.id, "coupang");
  res.json({ ok: true });
});

app.post("/api/revenue/coupang/sync", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const result = await syncCoupangRevenue(u.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, days: result.days });
});

/* 수익 자동 수집 — 6시간마다 키가 등록된 사용자들의 쿠팡 실적을 당겨온다.
   실패해도 다음 주기에 다시 시도하면 되므로 사유만 남기고 넘어간다. */
const REVENUE_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  let users = [];
  try { users = db.listRevenueKeyUsers("coupang"); }
  catch (e) { console.warn("[수익 수집 대상 조회 실패 — 무시]", e.message); return; }
  users.reduce((chain, uid) => chain.then(() => syncCoupangRevenue(uid).catch(() => {})), Promise.resolve());
}, REVENUE_SYNC_INTERVAL_MS);

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
  if (!hasValidAccess(user)) {
    return res.status(402).json({ error: "결제 후 30일 이용 기간이 지났습니다. 다시 결제해 주세요.", accessUntil: user.accessUntil });
  }

  const question = String((req.body && req.body.question) || "").trim();
  if (!question) return res.status(400).json({ error: "무엇을 알아봐 드릴지 적어 주세요." });
  if (question.length > 2000) return res.status(400).json({ error: "질문이 너무 깁니다. 2000자 이내로 적어 주세요." });

  let agentKeys = Array.isArray(req.body && req.body.agents) ? req.body.agents.filter((k) => SPECIALISTS[k]) : [];
  // 담당자를 정확히 1명만 골랐을 때만 자동 라우팅 검토 대상 — 복수 선택·미선택(전체)은 건드리지 않는다.
  const routeCheck = agentKeys.length === 1;
  if (!agentKeys.length) agentKeys = SPECIALIST_KEYS.slice();

  const quick = !!(req.body && req.body.quick);
  // 빠른 모드는 총괄AI 검수를 건너뛰므로 검수 크레딧(20)을 받지 않는다.
  const cost = agentKeys.length * COST_PER_AGENT + (quick ? 0 : COST_MANAGER);
  if ((user.credits || 0) < cost) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 구독하시면 매달 크레딧이 채워집니다.", need: cost, have: user.credits || 0 });
  }

  const job = createJob(question, agentKeys, user.id, cost, quick);
  job.routeCheck = routeCheck;
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

// 업무 중간 취소 — 총괄AI 검수가 끝나 크레딧이 차감되기 전(작업 중/검수 중)에만 취소할 수 있다.
// 이미 대표님 승인 대기 단계(await-approval)까지 갔다면 이미 차감이 끝난 뒤라 취소가 아니라
// 그 화면에서 승인/보완요청으로 마무리해야 한다.
app.post("/api/cancel/:jobId", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "업무를 찾을 수 없습니다." });
  if (job.userId !== user.id) return res.status(403).json({ error: "권한이 없습니다." });
  if (job.finished || job.charged) {
    return res.status(409).json({ error: "이미 진행이 많이 되어 취소할 수 없습니다." });
  }
  job.cancelled = true;
  res.json({ ok: true });
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
    subscriptions: db.getSubscriptionStats(),
    pendingBankOrders: db.listPendingBankTransferOrders(),
  });
});
// AI 품질(헛소리 방지) 측정 — 총괄AI 반려율(방법 A) + 대표 첫승인율(방법 B, 가장 중요한 지표).
app.get("/api/admin/quality-stats", requireAdminKey, (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const stats = db.getQualityStats(since);
  res.json({ period_days: days, ...stats });
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

/* ── 무통장입금 승인 (운영자 전용) ──
   사용법: curl "https://.../api/admin/bank-orders?key=ADMIN_KEY"
           curl -X POST ".../api/admin/bank-orders/주문번호/confirm?key=ADMIN_KEY"
           curl -X POST ".../api/admin/bank-orders/주문번호/reject?key=ADMIN_KEY" */
app.get("/api/admin/bank-orders", requireAdminKey, (req, res) => {
  res.json({ orders: db.listPendingBankTransferOrders() });
});
app.post("/api/admin/bank-orders/:orderId/confirm", requireAdminKey, (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  if (order.status !== "pending") return res.status(409).json({ error: "이미 처리된 주문입니다." });

  db.markOrderPaid(order.order_id);
  const rec = db.getUserById(order.user_id);
  if (rec) {
    const credits = (rec.credits || 0) + order.credits;
    db.updateCredits(rec.id, credits, credits);
    // 무통장입금도 구독 결제 수단 중 하나라 승인 시 30일 이용 기간을 함께 부여한다.
    // (자동 재청구는 안 되므로 다음 달엔 사용자가 다시 신청해야 한다.)
    db.setAccessUntil(rec.id, new Date(Date.now() + SUBSCRIPTION_PERIOD_MS).toISOString());
  }
  res.json({ ok: true, orders: db.listPendingBankTransferOrders() });
});
app.post("/api/admin/bank-orders/:orderId/reject", requireAdminKey, (req, res) => {
  const order = db.getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
  if (order.status !== "pending") return res.status(409).json({ error: "이미 처리된 주문입니다." });
  db.rejectOrder(order.order_id);
  res.json({ ok: true, orders: db.listPendingBankTransferOrders() });
});

/* ── 역할별 시스템 기본지식 관리 (운영자 전용 — ADMIN_KEY로 보호, 일반 유저 접근 불가) ──
   사용법: curl "https://.../api/admin/default-knowledge/카피라이터?key=ADMIN_KEY"
           curl -X POST ".../api/admin/default-knowledge/카피라이터?key=ADMIN_KEY" -d '{"title":"...","text":"..."}'
           curl -X DELETE ".../api/admin/default-knowledge/카피라이터/아이디?key=ADMIN_KEY" */
function isValidKnowledgeRole(role) {
  return !!SPECIALISTS[role] || role === BRAND_KEY;
}
app.get("/api/admin/default-knowledge/:role", requireAdminKey, (req, res) => {
  if (!isValidKnowledgeRole(req.params.role)) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  res.json({ items: db.getDefaultKnowledge(req.params.role) });
});
app.post("/api/admin/default-knowledge/:role", requireAdminKey, (req, res) => {
  const role = req.params.role;
  if (!isValidKnowledgeRole(role)) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  const title = String((req.body && req.body.title) || "").trim().slice(0, 80) || "제목 없음";
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "내용을 입력해 주세요." });
  if (text.length > 20000) return res.status(400).json({ error: "자료가 너무 깁니다. 20000자 이내로 줄여 주세요." });
  db.addDefaultKnowledge(role, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, text, addedAt: nowKR(),
  });
  res.json({ ok: true, items: db.getDefaultKnowledge(role) });
});
app.delete("/api/admin/default-knowledge/:role/:id", requireAdminKey, (req, res) => {
  const role = req.params.role;
  if (!isValidKnowledgeRole(role)) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  db.deleteDefaultKnowledge(role, req.params.id);
  res.json({ ok: true, items: db.getDefaultKnowledge(role) });
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
