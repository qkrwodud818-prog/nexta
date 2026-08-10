/**
 * 숏폼 영상 생성 오케스트레이터.
 *   분류 → 라우팅 → 어댑터 호출 → 폴링 → 결과 검증 → (실패 시) 폴백 1회
 *
 * 폴백은 딱 한 번만 시도한다(지시서 5). 무한 재시도는 외부 API 비용이 그대로 쌓이는
 * 구조라, 두 번 실패하면 사람이 봐야 하는 상황으로 보고 파이프라인을 멈춘다.
 */
const fs = require("fs");
const path = require("path");
const { ADAPTERS } = require("./adapters");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "video-routing.json");

function loadRoutingConfig() {
  // 운영 중 설정만 바꿔 반영할 수 있도록 매번 읽는다 (파일이 작아 부담이 없다).
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

/** 키가 등록돼 실제로 호출 가능한 서비스만 남긴다. */
function readyServices(config) {
  return Object.keys(config.services).filter((name) => ADAPTERS[name]?.isReady());
}

/**
 * 카테고리 → 실제로 쓸 서비스 목록(primary, fallback 순).
 * 키가 없는 서비스는 후보에서 빠지므로, 키를 하나만 넣어도 그 서비스로 몰리지 않고
 * "해당 카테고리에 쓸 서비스가 없음"으로 정직하게 실패한다.
 */
function resolveRoute(config, category) {
  const route = config.routes[category];
  if (!route) return [];
  return [route.primary, route.fallback]
    .filter(Boolean)
    .filter((name) => ADAPTERS[name]?.isReady());
}

async function pollUntilDone(adapter, jobId, config) {
  const timeoutMs = (config.pollTimeoutSec || 300) * 1000;
  const intervalMs = (config.pollIntervalSec || 5) * 1000;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const status = await adapter.checkStatus(jobId);
    if (status.state === "done") return status;
    if (status.state === "failed") throw new Error(status.error || "영상 생성 실패");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`영상 생성이 ${config.pollTimeoutSec}초 안에 끝나지 않았습니다.`);
}

/** 결과물이 인스타 릴스 규격을 만족하는지 (지시서 5·8). */
function validateResult(result, config, aspectRatio) {
  const rules = config.validation.reels;
  const problems = [];

  if (!result.videoUrl) problems.push("영상 주소가 없습니다.");
  if (result.durationSec != null) {
    if (result.durationSec < rules.minSeconds) problems.push(`영상이 너무 짧습니다 (${result.durationSec}초).`);
    if (result.durationSec > rules.maxSeconds) problems.push(`영상이 너무 깁니다 (${result.durationSec}초).`);
  }
  if (aspectRatio && aspectRatio !== rules.aspectRatio) {
    problems.push(`릴스는 ${rules.aspectRatio} 비율이어야 합니다 (요청: ${aspectRatio}).`);
  }
  return problems;
}

/**
 * 한 서비스로 끝까지 시도한다.
 * @returns {{ok:true, ...}|{ok:false, error:string}}
 */
async function attempt(serviceName, input, config) {
  const adapter = ADAPTERS[serviceName];
  const svc = config.services[serviceName];
  const startedAt = Date.now();

  // REPURPOSE 전용 서비스에 원본이 없으면 호출 자체를 막는다 (지시서 4-4 가드).
  if (svc.requiresSourceVideo && !input.sourceVideoUrl) {
    return { ok: false, service: serviceName, error: "원본 영상이 필요한 서비스인데 주소가 없습니다.", elapsedMs: 0 };
  }

  try {
    const { jobId } = await adapter.generateVideo(input);
    const done = await pollUntilDone(adapter, jobId, config);
    const elapsedMs = Date.now() - startedAt;

    const problems = validateResult(done, config, input.aspectRatio);
    if (problems.length) {
      return { ok: false, service: serviceName, error: "결과 검증 실패: " + problems.join(" "), elapsedMs };
    }

    const durationSec = done.durationSec || input.durationSec || 15;
    return {
      ok: true,
      service: serviceName,
      jobId,
      videoUrl: done.videoUrl,
      durationSec,
      costUsd: svc.costPerSecUsd != null ? +(svc.costPerSecUsd * durationSec).toFixed(4) : null,
      elapsedMs,
    };
  } catch (e) {
    return { ok: false, service: serviceName, error: e.message, elapsedMs: Date.now() - startedAt };
  }
}

/**
 * 영상 1편 생성 — 분류부터 결과까지.
 * @param {object} input VideoGenerationInput + 분류기 입력
 * @param {function} classify createClassifier()로 만든 함수
 * @param {function} onLog 시도마다 호출 (성공/실패 모두 기록 — 지시서 5)
 */
async function generateVideo(input, classify, onLog) {
  const config = loadRoutingConfig();

  const decision = await classify(input, input.logCtx);
  const primaryChain = resolveRoute(config, decision.category);

  // 시도는 최대 2회다(지시서 5). 그래서 2번째 자리를 무엇으로 채울지가 관건인데,
  // 확신이 낮다는 건 "카테고리 판단 자체가 미덥다"는 뜻이므로 같은 카테고리의 예비
  // 서비스로 다시 가봐야 불확실성이 그대로다. 이럴 땐 2번째를 대안 카테고리로 보낸다
  // (지시서 2-4). 확신이 높으면 원래대로 같은 카테고리의 fallback을 쓴다.
  const lowConfidence = decision.confidence < (config.confidenceFloor ?? 0.6);
  let chain = primaryChain;
  if (lowConfidence && decision.fallback_category) {
    const alt = resolveRoute(config, decision.fallback_category).filter((n) => n !== primaryChain[0]);
    if (alt.length) chain = [primaryChain[0], alt[0]].filter(Boolean);
  }

  if (!chain.length) {
    const ready = readyServices(config);
    return {
      ok: false,
      decision,
      error: ready.length
        ? `'${decision.category}'에 쓸 수 있는 영상 서비스가 연결돼 있지 않습니다.`
        : "영상 생성 서비스가 아직 하나도 연결되지 않았습니다.",
      attempts: [],
    };
  }

  // primary → fallback 순으로 최대 2회. 그 뒤엔 멈춘다.
  const attempts = [];
  for (const serviceName of chain.slice(0, 2)) {
    const res = await attempt(serviceName, input, config);
    attempts.push(res);
    if (onLog) {
      try { await onLog({ ...res, category: decision.category }); }
      catch (e) { console.warn("[영상 로그 기록 실패 — 무시]", e.message); }
    }
    if (res.ok) return { ok: true, decision, result: res, attempts };
  }

  return {
    ok: false,
    decision,
    error: attempts[attempts.length - 1]?.error || "영상 생성에 실패했습니다.",
    attempts,
  };
}

module.exports = { generateVideo, loadRoutingConfig, resolveRoute, readyServices, validateResult };
