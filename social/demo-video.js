/**
 * 제품 데모 영상 — 넥스타가 넥스타를 홍보하는 세로 영상(1080×1920).
 *
 * 실제 브라우저를 띄워 녹화하지 않는다. Playwright로 진짜 화면을 찍으려면 서버에
 * 브라우저 바이너리와 가상 디스플레이가 필요한데, 지금 인프라로는 감당이 안 된다.
 * 대신 제품 화면의 구조를 그림으로 다시 그려 이어붙인다 — 스크린샷이 아니라
 * 도해(圖解)다. 그래서 이 파일은 "실제 화면"이라고 주장하지 않는다.
 *
 * 이 방식의 부수적인 이점 하나: 그림은 대본에서만 나오므로 고객 데이터가 화면에
 * 찍힐 경로 자체가 없다. 지시서가 요구한 "데모 전용 데이터만" 조건이 구조적으로 지켜진다.
 *
 * 인코딩은 새로 만들지 않고 social/shorts.js의 generateShort를 그대로 쓴다.
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { generateShort } = require("./shorts");

const W = 1080, H = 1920;
const FONT = "Pretendard, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif";

const INK = "#0b0e14";
const BRAND = "#5b4bf5";
const PAPER = "#f5f7fa";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 긴 문장을 폭에 맞춰 끊는다. 한글은 글자 폭이 고르므로 글자 수로 세도 충분하다. */
function wrap(text, perLine) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > perLine && cur) { lines.push(cur); cur = w; }
    else cur = (cur ? cur + " " : "") + w;
  }
  if (cur) lines.push(cur);
  return lines;
}
function tspans(text, x, startY, lineH, perLine) {
  return wrap(text, perLine)
    .map((l, i) => `<tspan x="${x}" y="${startY + i * lineH}">${esc(l)}</tspan>`)
    .join("");
}

/* 화면 도해 — 제품의 구조만 옮긴다. 픽셀을 흉내 내려 하면 어설퍼지고,
   무엇보다 실제 화면인 척하게 된다. */
function uiMock(kind, lines) {
  // 높이는 내용에 맞춘다 — 남는 여백이 크면 "덜 만든 화면"처럼 보인다
  const x = 90, y = 640, w = W - 180, h = 520, r = 28;
  const card = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#fff"/>
    <rect x="${x}" y="${y}" width="${w}" height="88" rx="${r}" fill="${PAPER}"/>
    <rect x="${x}" y="${y + 60}" width="${w}" height="28" fill="${PAPER}"/>
    <circle cx="${x + 44}" cy="${y + 44}" r="11" fill="#d6dbe4"/>
    <circle cx="${x + 78}" cy="${y + 44}" r="11" fill="#d6dbe4"/>
    <circle cx="${x + 112}" cy="${y + 44}" r="11" fill="#d6dbe4"/>`;

  const body = [];
  if (kind === "input") {
    body.push(`<rect x="${x + 44}" y="${y + 150}" width="${w - 88}" height="120" rx="18" fill="${PAPER}" stroke="${BRAND}" stroke-width="3"/>`);
    body.push(`<text font-size="34" fill="${INK}">${tspans(lines[0] || "", x + 76, y + 212, 44, 26)}</text>`);
    body.push(`<rect x="${x + w - 200}" y="${y + 320}" width="156" height="66" rx="14" fill="${BRAND}"/>`);
    body.push(`<text x="${x + w - 122}" y="${y + 363}" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">시키기</text>`);
  } else if (kind === "agents") {
    // 비비 카드 3장 — 총괄이 부른 사람만 켜진다
    for (let i = 0; i < 3; i++) {
      const cx = x + 60 + i * ((w - 120) / 3);
      const cw = (w - 120) / 3 - 24;
      body.push(`<rect x="${cx}" y="${y + 150}" width="${cw}" height="200" rx="20" fill="${PAPER}" stroke="${BRAND}" stroke-width="3"/>`);
      body.push(`<circle cx="${cx + cw / 2}" cy="${y + 220}" r="34" fill="${BRAND}" opacity="0.18"/>`);
      body.push(`<text x="${cx + cw / 2}" y="${y + 310}" font-size="28" fill="${INK}" text-anchor="middle">${esc(lines[i] || "비비")}</text>`);
    }
    body.push(`<rect x="${x + 44}" y="${y + 400}" width="${w - 88}" height="10" rx="5" fill="${PAPER}"/>`);
    body.push(`<rect x="${x + 44}" y="${y + 400}" width="${(w - 88) * 0.62}" height="10" rx="5" fill="${BRAND}"/>`);
  } else {
    // result — 결과물 줄글
    for (let i = 0; i < 4; i++) {
      const wid = [0.92, 0.86, 0.94, 0.55][i] * (w - 88);
      body.push(`<rect x="${x + 44}" y="${y + 160 + i * 52}" width="${wid}" height="22" rx="11" fill="${PAPER}"/>`);
    }
    body.push(`<rect x="${x + 44}" y="${y + 400}" width="200" height="60" rx="14" fill="#10b981" opacity="0.14"/>`);
    body.push(`<text x="${x + 144}" y="${y + 440}" font-size="28" font-weight="700" fill="#0f766e" text-anchor="middle">${esc(lines[0] || "발행 완료")}</text>`);
  }
  return card + body.join("");
}

/** 장면 하나를 1080×1920 PNG로. */
async function renderScene(scene, index, total, outPath) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${INK}"/>
    <g font-family="${FONT}">
      <text x="90" y="200" font-size="30" fill="#8791a6" letter-spacing="6">${esc(String(index + 1).padStart(2, "0"))} / ${esc(String(total).padStart(2, "0"))}</text>
      <text x="90" y="330" font-size="72" font-weight="800" fill="#fff">${tspans(scene.title, 90, 330, 92, 15)}</text>
      ${uiMock(scene.ui || "result", scene.uiLines || [])}
      <text x="90" y="1470" font-size="38" fill="rgba(255,255,255,.82)">${tspans(scene.narration, 90, 1470, 54, 24)}</text>
      <rect x="90" y="1760" width="${W - 180}" height="8" rx="4" fill="rgba(255,255,255,.12)"/>
      <rect x="90" y="1760" width="${(W - 180) * ((index + 1) / total)}" height="8" rx="4" fill="${BRAND}"/>
      <text x="90" y="1850" font-size="30" fill="rgba(255,255,255,.45)" letter-spacing="8">NEXTA</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/**
 * 장면들 → mp4.
 * @param {{title:string,narration:string,ui?:string,uiLines?:string[]}[]} scenes
 * @returns {Promise<string>} 만들어진 mp4 경로
 */
async function generateDemoVideo(scenes, outDir) {
  if (!Array.isArray(scenes) || !scenes.length) throw new Error("장면이 없습니다.");
  fs.mkdirSync(outDir, { recursive: true });

  const framePaths = [];
  for (let i = 0; i < scenes.length; i++) {
    const p = path.join(outDir, `scene${i + 1}.png`);
    await renderScene(scenes[i], i, scenes.length, p);
    framePaths.push(p);
  }
  const outPath = path.join(outDir, "demo.mp4");
  await generateShort(framePaths, outPath);
  return outPath;
}

/**
 * 캡션 — 고정 틀이다.
 * "AI가 알아서 했다"와 "사장님은 쉬고 있었다" 두 가지가 항상 들어가야 하므로 모델에게
 * 맡기지 않고 여기서 조립한다. 올리는 시각이 새벽이면 그 사실을 그대로 쓴다.
 */
function buildCaption(featureLine, hourKst) {
  const h = Number.isFinite(hourKst) ? hourKst : new Date().getHours();
  const asleep =
    h >= 0 && h < 6 ? "사장님은 지금 자고 있어요. 🌙"
      : h >= 6 && h < 9 ? "사장님은 아직 안 일어났어요. 🌅"
        : h >= 22 ? "사장님은 이미 퇴근했어요. 🌙"
          : "사장님은 지금 딴 일 하고 있어요. ☕";
  return [
    "이 영상도 홍보 문구도 전부 넥스타가 알아서 만들고 올린 거예요.",
    asleep,
    String(featureLine || "").trim(),
  ].filter(Boolean).join("\n");
}

module.exports = { generateDemoVideo, buildCaption, renderScene };
