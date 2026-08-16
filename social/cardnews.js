// ══════════════════════════════════════════════════════════════
// 카드뉴스 자동 생성 (Node/sharp 버전 — Nexta 서버에 그대로 얹을 수 있게 Python 의존성 없이 작성)
// 템플릿에 상품 정보(이름/특징/가격/사진)만 채워 넣는 방식. 매번 새로 "그리는" 게 아니라
// SVG 틀에 값을 꽂아 렌더링하는 거라 빠르고(장당 수백ms) 결과가 항상 일관됨.
// ══════════════════════════════════════════════════════════════
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const W = 1080, H = 1350;
const FONT = "Noto Sans CJK KR"; // 서버에 이 폰트가 설치돼 있어야 함 (아래 README 참고)
// 결과물 자체가 광고가 되게(바이럴 성장 전략 1번) — 카드뉴스마다 작게 출처를 남긴다.
// 도메인이 바뀌면 .env의 SITE_URL만 바꾸면 된다(코드 수정 불필요).
const SITE_URL = process.env.SITE_URL || "nexta-yhy8.onrender.com";

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── 스타일 프리셋 ────────────────────────────────────────────
// 매번 색을 새로 고르게 두면 같은 계정인데 카드마다 딴 사람이 만든 것처럼 보인다.
// 계정당 하나를 골라 고정하고, 그다음부터는 내용만 갈아끼운다.
// 값이 코드에 박혀 있어야 하는 이유: 사용자가 색을 자유롭게 넣으면 결국 안 어울리는 조합이
// 나오고, 피드 전체가 무너진다. 고를 수 있는 건 "어느 프리셋이냐"까지다.
const STYLES = {
  minimal: {
    label: "미니멀",
    color1: "#5b4bf5", color2: "#8b7cff",
    infoBg: "#f5f6fa", infoInk: "#1a1a2e", bodyInk: "#323240",
  },
  dark: {
    label: "딥다크",
    color1: "#c0392b", color2: "#2c2c34",
    infoBg: "#1a1a1f", infoInk: "#ffffff", bodyInk: "#d8d8e0",
  },
  editorial: {
    label: "에디토리얼",
    color1: "#1f6f5c", color2: "#3fa88c",
    infoBg: "#faf7f0", infoInk: "#22221f", bodyInk: "#4a4a44",
  },
};
const DEFAULT_STYLE = "minimal";

/** 프리셋 이름을 실제 색값으로. 모르는 이름이면 기본값 — 화면이 깨지느니 기본이 낫다. */
function resolveStyle(name) {
  return STYLES[String(name || "")] || STYLES[DEFAULT_STYLE];
}

// color1/color2는 요청 본문에서 그대로 들어오는 값이라, 검증 없이 SVG 속성에 넣으면
// 따옴표를 깨고 임의의 SVG 태그를 주입할 수 있다(XML 인젝션). #rgb/#rrggbb 형식만 허용한다.
function safeHexColor(v, fallback) {
  return /^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(String(v || "")) ? v : fallback;
}

// 요청에 딸려온 임의의 URL을 서버가 그대로 fetch하면, 공격자가 내부망이나 클라우드
// 메타데이터 주소(예: 169.254.169.254)를 넣어 서버가 대신 접근하게 만들 수 있다(SSRF).
// http(s)만 허용하고, 사설/루프백/링크로컬 주소로 보이는 호스트는 걸러낸다.
function isSafeImageUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch (e) { return false; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return false;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^::1$|^\[::1\]$/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
  return true;
}

// 긴 줄을 여러 줄로 감싸기 (한글 기준 대략 글자수로 계산)
function wrap(text, maxChars) {
  const out = [];
  for (const rawLine of String(text).split("\n")) {
    let line = "";
    for (const ch of rawLine) {
      line += ch;
      if (line.length >= maxChars) { out.push(line); line = ""; }
    }
    if (line) out.push(line);
  }
  return out;
}

function multilineTspans(text, x, startY, lineHeight, maxChars) {
  return wrap(text, maxChars)
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");
}

// ── 슬라이드 1: 후킹형 (제품사진 원형 + "~~의 비밀" 카피) ──
async function renderHookSlide({ hook, tag, photoBuffer, color1, color2 }, outPath) {
  let photoDataUri = null;
  if (photoBuffer) {
    const side = 620;
    const circleMask = Buffer.from(
      `<svg width="${side}" height="${side}"><circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}" fill="#fff"/></svg>`
    );
    const cropped = await sharp(photoBuffer)
      .resize(side, side, { fit: "cover" })
      .modulate({ brightness: 0.55 })
      .composite([{ input: circleMask, blend: "dest-in" }])
      .png()
      .toBuffer();
    photoDataUri = `data:image/png;base64,${cropped.toString("base64")}`;
  }

  /* 훅의 세로 위치는 사진 유무로 갈린다. 사진이 있으면 그 아래에 놓아야 하지만,
     없는데도 같은 자리에 두면 위쪽이 통째로 빈 화면이 된다. 정보성 카드는 사진이 없는 쪽이
     기본이라, 없을 때는 가운데로 올린다. */
  const hookLines = wrap(hook, 13).length;
  const hookY = photoDataUri ? 800 : Math.round(H / 2 - ((hookLines - 1) * 82) / 2);

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color1}"/>
        <stop offset="100%" stop-color="${color2}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <g font-family="${FONT}">
      <rect x="${W / 2 - 140}" y="40" width="280" height="72" rx="36" fill="#fff"/>
      <text x="${W / 2}" y="86" font-size="34" font-weight="900" fill="${color1}" text-anchor="middle">${esc(tag)}</text>
      ${photoDataUri ? `
        <circle cx="${W / 2}" cy="400" r="316" fill="none" stroke="#fff" stroke-width="8"/>
        <image href="${photoDataUri}" x="${W / 2 - 310}" y="90" width="620" height="620"/>
      ` : ""}
      <text x="${W / 2}" y="${hookY}" font-size="66" font-weight="900" fill="#fff" text-anchor="middle">
        ${multilineTspans(hook, W / 2, hookY, 82, 13)}
      </text>
      <text x="${W / 2}" y="${H - 90}" font-size="32" fill="#fff" text-anchor="middle">다음 장에서 바로 확인 →</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ── 슬라이드 2: 상품 정보 (특징 불릿 + 가격) ──
async function renderInfoSlide({ title, bullets, price, color1, style }, outPath) {
  /* 항목 수는 3개일 때도 7개일 때도 있다. 시작 위치를 고정하면 3개일 때 아래가 텅 비고
     7개일 때는 가격 막대를 덮는다. 블록 전체를 남는 공간 가운데에 놓는다. */
  const LINE = 110;
  const topEdge = 260;                          // 제목 아래
  const bottomEdge = price ? H - 300 : H - 120; // 가격 막대가 있으면 그 위까지만
  const blockH = Math.max(0, (bullets.length - 1) * LINE);
  const startY = Math.round(topEdge + (bottomEdge - topEdge - blockH) / 2);

  const bulletSvg = bullets
    .map((b, i) => {
      const y = startY + i * LINE;
      return `<circle cx="115" cy="${y - 12}" r="14" fill="${color1}"/>
              <text x="160" y="${y}" font-size="40" font-weight="700" fill="${style.bodyInk}">${esc(b)}</text>`;
    })
    .join("\n");

  // 가격이 없는 계정이 훨씬 많다(제휴·정보 계정). 빈 막대를 그리면 그냥 색깔 덩어리가 남는다.
  const priceBar = price
    ? `<rect x="100" y="${H - 260}" width="${W - 200}" height="120" rx="24" fill="${color1}"/>
       <text x="${W / 2}" y="${H - 185}" font-size="52" font-weight="900" fill="#fff" text-anchor="middle">${esc(price)}</text>`
    : "";

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${style.infoBg}"/>
    <rect width="${W}" height="16" fill="${color1}"/>
    <g font-family="${FONT}">
      <text x="${W / 2}" y="150" font-size="56" font-weight="900" fill="${style.infoInk}" text-anchor="middle">
        ${multilineTspans(title, W / 2, 150, 70, 14)}
      </text>
      ${bulletSvg}
      ${priceBar}
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ── 슬라이드 3: CTA (댓글 유도 + 쿠팡파트너스 고지문구) ──
async function renderCtaSlide({ ctaText, commentKeyword, color1, color2, disclosure, badge: customBadge, hideMark }, outPath) {
  /* 기본 문구는 링크를 미끼로 댓글을 받는 방식이다. 계정을 막 시작해 아직 링크가 없을 때
     이걸 그대로 쓰면 줄 것도 없으면서 약속만 하는 글이 되고, 알고리즘도 홍보 계정으로 분류한다.
     그래서 호출부가 문구를 정할 수 있어야 한다. */
  const badge = customBadge || `댓글에 '${commentKeyword}' 남기면 DM으로 링크 드려요`;
  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color2}"/>
        <stop offset="100%" stop-color="${color1}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg2)"/>
    <g font-family="${FONT}">
      <text x="${W / 2}" y="500" font-size="60" font-weight="900" fill="#fff" text-anchor="middle">
        ${multilineTspans(ctaText, W / 2, 500, 78, 14)}
      </text>
      <rect x="${W / 2 - 420}" y="780" width="840" height="90" rx="45" fill="#fff"/>
      <text x="${W / 2}" y="836" font-size="32" font-weight="700" fill="${color1}" text-anchor="middle">${esc(badge)}</text>
      ${disclosure ? `<text x="${W / 2}" y="${H - 150}" font-size="24" fill="#ffffffcc" text-anchor="middle">
        ${multilineTspans(disclosure, W / 2, H - 150, 34, 34)}
      </text>` : ""}
      ${hideMark ? "" : `<text x="${W / 2}" y="${H - 30}" font-size="20" fill="#ffffff99" text-anchor="middle">Made with 넥스타 · ${esc(SITE_URL)}</text>`}
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/**
 * 카드뉴스 3장 생성 (핵심 함수 — server.js 라우트에서 이거 하나만 호출하면 됨)
 * @param {object} product { name, hook, tag, bullets:[], price, photoUrl 또는 photoBuffer, commentKeyword }
 * @param {string} outDir  이미지를 저장할 폴더 (public 하위, 밖에서 URL로 접근 가능해야 함)
 */
async function generateCardNews(product, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  let photoBuffer = null;
  if (product.photoBuffer) {
    photoBuffer = product.photoBuffer;
  } else if (product.photoUrl && isSafeImageUrl(product.photoUrl)) {
    try {
      // redirect를 자동으로 따라가면 "안전해 보이는 URL"이 내부 주소로 리다이렉트하는 방식으로
      // 위 검사를 우회할 수 있어서, 리다이렉트는 아예 따라가지 않는다(그 경우 실패 처리).
      const res = await fetch(product.photoUrl, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
    } catch (e) { /* 사진을 못 가져와도 카드뉴스 자체는 계속 만든다 */ }
  }

  /* 색은 프리셋에서 온다. 직접 넘긴 color1/color2는 프리셋을 덮어쓰는 예외 경로로만 남긴다
     — 상품 카드뉴스처럼 브랜드 색이 정해진 경우가 있어서다. */
  const style = resolveStyle(product.style);
  const color1 = safeHexColor(product.color1, style.color1);
  const color2 = safeHexColor(product.color2, style.color2);

  const p1 = path.join(outDir, "slide1.png");
  const p2 = path.join(outDir, "slide2.png");
  const p3 = path.join(outDir, "slide3.png");

  await renderHookSlide(
    { hook: product.hook, tag: product.tag, photoBuffer, color1, color2 },
    p1
  );
  await renderInfoSlide(
    { title: product.name, bullets: product.bullets, price: product.price, color1, style },
    p2
  );
  await renderCtaSlide(
    {
      ctaText: product.cta || `이거 하나면\n고민 끝`,
      commentKeyword: product.commentKeyword || "정보",
      badge: product.badge,
      /* 콘텐츠 계정에 매 장 도구 이름이 박히면 아마추어로 보인다.
         넥스타 홍보는 기본값으로 두되, 끌 수 있어야 한다. */
      hideMark: !!product.hideMark,
      color1, color2,
      /* 고지문구는 실제로 제휴 수수료를 받을 때만 찍는다. 안 받는데 찍으면 거짓말이고,
         받는데 안 찍으면 표시광고법 위반이다. 둘 다 호출부가 알려줘야 정해진다. */
      disclosure: product.disclosure || "",
    },
    p3
  );

  return [p1, p2, p3];
}

/* ══════════════════════════════════════════════════════════════
   뉴스형 카드뉴스

   인스타에서 실제로 도는 정보성 카드뉴스를 여러 장 뜯어보니 형태가 둘로 갈렸다.
   하나는 AI 일러스트를 전면에 깐 캐릭터형, 다른 하나는 텍스트만으로 밀어붙이는 편집형이다.
   여기 구현한 건 후자다 — 만드는 데 이미지 생성비가 들지 않고, 스크롤 중에 0.5초 만에
   읽히는 쪽이라 짧은 호흡의 계정에 맞는다.

   공통적으로 반복되던 것들: 흰색이 아니라 살짝 노란 크림 배경, 화면 절반을 먹는 검은 헤드라인,
   핵심 어절에만 형광펜, 그리고 출처를 흰 카드로 따로 얹는 것.
   ══════════════════════════════════════════════════════════════ */
/* 레퍼런스를 넷 뜯어봤더니 반복되는 문법이 있었다 —
   좌상단 배지, 화면 3할을 먹는 헤드라인, 강조는 딱 한 요소만, 연한 서브, 회차 번호, 하단 CTA.
   문법은 가져오되 조합은 다르게 간다. 그대로 베끼면 아류로 읽히고, 그건 초기 신뢰에 제일 나쁘다.

   구체적으로 넷과 다르게 잡은 것:
   - 넷 다 밝은 배경이거나 사진 위였다 → 어두운 바탕으로 뒤집었다
   - 넷 다 헤드라인이 가운데였다 → 왼쪽으로 붙였다
   - 형광펜(사각 배경) 대신 글자색 + 굵은 밑줄로 강조한다
   - 왼쪽에 세로 액센트 바를 세웠다. 넷 중 아무도 안 쓴 요소다
   - 회차 숫자를 배경처럼 크게 깔았다 ("3초"라는 이름과 붙는 장치) */
const NEWS = {
  bg: "#15171e",
  ink: "#f4f1e8",       // 순백은 어두운 바탕에서 눈이 아프다. 살짝 크림 쪽으로.
  sub: "#8b909c",
  mark: "#4ade9b",      // 강조 — 돈 얘기에 초록 계열이 자연스럽다
  ghost: "#1e212a",     // 배경에 깔리는 회차 숫자
  pad: 92,
  barW: 10,
};

/* 형광펜 사각형을 그리려면 글자 폭을 알아야 하는데 SVG는 그걸 안 알려준다.
   한글은 글자당 폭이 글자크기와 거의 같고 영숫자는 그 절반쯤이라, 그걸로 어림한다.
   몇 픽셀 어긋나도 형광펜은 원래 삐뚤어서 오히려 자연스럽다. */
function textWidth(s, size) {
  let w = 0;
  // 한글 자체는 정사각에 가깝지만 실제 렌더 폭은 그보다 조금 좁다. 형광펜이 글자 밖으로
  // 삐져나오는 게 눈에 띄어서 0.96으로 눌렀다.
  for (const ch of String(s)) w += /[ㄱ-힝]/.test(ch) ? size * 0.96 : size * 0.52;
  return w;
}

/** 글자 수가 아니라 실제 폭으로 줄바꿈한다. 숫자·영문이 섞이면 글자 수 기준은 빗나간다. */
function wrapByWidth(text, size, maxW) {
  const out = [];
  let line = "";
  for (const ch of String(text)) {
    if (textWidth(line + ch, size) > maxW && line) { out.push(line); line = ""; }
    line += ch;
  }
  if (line) out.push(line);
  return out;
}

/** `*강조*` 로 감싼 부분은 색을 바꾸고 밑줄을 깐다. 왼쪽 정렬이라 시작 x가 고정이다. */
function headlineSvg(line, y, size, x0) {
  const parts = String(line).split(/(\*[^*]+\*)/).filter(Boolean);
  let x = x0;
  let out = "";
  for (const p of parts) {
    const t = p.replace(/\*/g, "");
    const w = textWidth(t, size);
    const on = p.startsWith("*");
    out += `<text x="${Math.round(x)}" y="${y}" font-size="${size}" font-weight="900" ` +
           `fill="${on ? NEWS.mark : NEWS.ink}" text-anchor="start">${esc(t)}</text>`;
    if (on) {
      // 밑줄은 글자 아래 살짝 띄운다. 붙이면 받침과 겹쳐 지저분해진다.
      out += `<rect x="${Math.round(x)}" y="${Math.round(y + size * 0.16)}" ` +
             `width="${Math.round(w)}" height="${Math.max(5, Math.round(size * 0.07))}" fill="${NEWS.mark}"/>`;
    }
    x += w;
  }
  return out;
}

/**
 * 뉴스형 카드 한 장.
 * @param {object} s { badge, no, headline(줄바꿈 \n, *강조*), sub, source:{title,press,date}, footer }
 */
async function renderNewsSlide(s, outPath) {
  const x0 = NEWS.pad + NEWS.barW + 30;      // 세로 바 오른쪽에서 글이 시작한다
  const size = s.headlineSize || 84;
  const lines = String(s.headline || "").split("\n");
  const lineH = Math.round(size * 1.3);
  const startY = Math.round(H * 0.42);

  const headline = lines
    .map((ln, i) => headlineSvg(ln, startY + i * lineH, size, x0))
    .join("\n");

  const subY = startY + lines.length * lineH + 34;
  const subSvg = s.sub
    ? `<text x="${x0}" y="${subY}" font-size="35" fill="${NEWS.sub}">
         ${wrapByWidth(s.sub.replace(/\n/g, " "), 35, W - x0 - NEWS.pad)
           .map((l, i) => `<tspan x="${x0}" y="${subY + i * 54}">${esc(l)}</tspan>`).join("")}
       </text>`
    : "";

  /* 출처. 기사 제목을 인용하고 매체·날짜를 밝히는 건 정당한 인용이다.
     기사 사진을 가져다 쓰는 건 저작권 침해라 여기서는 아예 다루지 않는다. */
  let sourceSvg = "";
  if (s.source && s.source.title) {
    const titleLines = wrapByWidth(s.source.title, 30, W - x0 - NEWS.pad - 30);
    const cardY = H - 240;
    sourceSvg = `
      <rect x="${x0}" y="${cardY}" width="4" height="${34 + titleLines.length * 44}" fill="${NEWS.sub}"/>
      <text x="${x0 + 24}" y="${cardY + 36}" font-size="30" font-weight="700" fill="${NEWS.ink}">
        ${titleLines.map((l, i) => `<tspan x="${x0 + 24}" y="${cardY + 36 + i * 44}">${esc(l)}</tspan>`).join("")}
      </text>
      <text x="${x0 + 24}" y="${cardY + 44 + titleLines.length * 44}" font-size="25" fill="${NEWS.sub}">
        ${esc(s.source.press || "")}${s.source.date ? "  ·  " + esc(s.source.date) : ""}
      </text>`;
  }

  const badgeW = Math.round(textWidth(s.badge || "", 29) + 44);
  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="${NEWS.bg}"/>
    <g font-family="${FONT}">
      <!-- 배경에 깔리는 큰 회차 숫자. 읽으라고 있는 게 아니라 장이 넘어가는 걸 느끼게 하는 장치다 -->
      ${s.no ? `<text x="${W - 40}" y="${H * 0.30}" font-size="300" font-weight="900" fill="${NEWS.ghost}" text-anchor="end">${esc(s.no)}</text>` : ""}
      <rect x="${NEWS.pad}" y="${H * 0.42 - 96}" width="${NEWS.barW}" height="${H * 0.42 + 40}" fill="${NEWS.mark}"/>
      ${s.badge ? `
        <rect x="${x0}" y="72" width="${badgeW}" height="50" rx="25" fill="none" stroke="${NEWS.mark}" stroke-width="2"/>
        <text x="${x0 + 22}" y="106" font-size="29" font-weight="700" fill="${NEWS.mark}">${esc(s.badge)}</text>` : ""}
      ${headline}
      ${subSvg}
      ${sourceSvg}
      <text x="${x0}" y="${H - 76}" font-size="27" font-weight="700" fill="${NEWS.sub}">${esc(s.handle || "@3sec.money")}</text>
      ${s.footer ? `<text x="${W - NEWS.pad}" y="${H - 76}" font-size="27" font-weight="700" fill="${NEWS.mark}" text-anchor="end">${esc(s.footer)}</text>` : ""}
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/**
 * 뉴스형 카드뉴스 여러 장.
 * @param {object[]} slides renderNewsSlide가 받는 형태
 * @param {string} outDir
 */
async function generateNewsCards(slides, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < slides.length; i++) {
    const p = path.join(outDir, "slide" + (i + 1) + ".png");
    await renderNewsSlide(slides[i], p);
    paths.push(p);
  }
  return paths;
}

module.exports = { generateCardNews, generateNewsCards, STYLES, DEFAULT_STYLE };
