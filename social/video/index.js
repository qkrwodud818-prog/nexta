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

// 기본은 저장소의 설정 파일. VIDEO_ROUTING_CONFIG로 바꿔 끼울 수 있게 해 두면
// 테스트에서 "계약 단가가 채워진 상태"를 실제 설정을 건드리지 않고 재현할 수 있다.
const CONFIG_PATH = process.env.VIDEO_ROUTING_CONFIG
  || path.join(__dirname, "..", "..", "config", "video-routing.json");

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

/* ────────────────────────── 영상 요금 계산 ──────────────────────────
 * 영상은 외부 API가 초당 과금이라 구독 크레딧에 그냥 태우면 사용량이 늘수록 적자가 된다.
 * 그래서 편당 크레딧을 "실제 원가 ÷ (1−목표마진)"에서 역산해 매긴다. 단가가 바뀌면
 * config/video-routing.json만 고치면 요금이 따라오므로, 코드를 다시 만질 일이 없다.
 */

/** 크레딧 1개의 매출 가치(원). 요금제에서 역산하므로 요금제가 바뀌면 같이 따라간다. */
function creditValueKrw(plan) {
  if (!plan || !plan.credits) return 33;
  return plan.amount / plan.credits;
}

/**
 * 영상 1편에 매길 크레딧.
 * 단가를 모르는 서비스는 값을 매길 수 없으므로 null을 돌려주고, 호출부가 생성을 막는다
 * — 원가를 모른 채 파는 것이 가장 위험하다.
 */
function quoteVideo(config, serviceName, durationSec, { plan, usdToKrw, targetMargin }) {
  const svc = config.services[serviceName];
  if (!svc) return null;
  if (svc.costPerSecUsd == null) {
    return { service: serviceName, label: svc.label, credits: null, costKrw: null, reason: svc.costNote };
  }
  const costKrw = svc.costPerSecUsd * durationSec * usdToKrw;
  const needRevenue = costKrw / (1 - targetMargin);
  return {
    service: serviceName,
    label: svc.label,
    costKrw: Math.round(costKrw),
    credits: Math.max(1, Math.ceil(needRevenue / creditValueKrw(plan))),
  };
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
  // 단가를 모르는 서비스는 요금을 매길 수 없어 후보에서 뺀다. 원가를 모른 채 파는 것이
  // 가장 위험하므로, 계약 후 config에 단가를 채워야 비로소 켜진다.
  const priceable = (name) => config.services[name]?.costPerSecUsd != null;
  const primaryChain = resolveRoute(config, decision.category).filter(priceable);

  // 시도는 최대 2회다(지시서 5). 그래서 2번째 자리를 무엇으로 채울지가 관건인데,
  // 확신이 낮다는 건 "카테고리 판단 자체가 미덥다"는 뜻이므로 같은 카테고리의 예비
  // 서비스로 다시 가봐야 불확실성이 그대로다. 이럴 땐 2번째를 대안 카테고리로 보낸다
  // (지시서 2-4). 확신이 높으면 원래대로 같은 카테고리의 fallback을 쓴다.
  const lowConfidence = decision.confidence < (config.confidenceFloor ?? 0.6);
  let chain = primaryChain;
  if (lowConfidence && decision.fallback_category) {
    const alt = resolveRoute(config, decision.fallback_category)
      .filter(priceable)
      .filter((n) => n !== primaryChain[0]);
    if (alt.length) chain = [primaryChain[0], alt[0]].filter(Boolean);
  }

  if (!chain.length) {
    const ready = readyServices(config);
    const readyButUnpriced = ready.filter((n) => !priceable(n));
    return {
      ok: false,
      decision,
      error: readyButUnpriced.length
        ? `연결된 서비스(${readyButUnpriced.map((n) => config.services[n].label).join(", ")})의 단가가 설정되지 않아 요금을 매길 수 없습니다. 계약 단가를 config에 넣어 주세요.`
        : ready.length
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

module.exports = {
  generateVideo, loadRoutingConfig, resolveRoute, readyServices, validateResult,
  quoteVideo, creditValueKrw,
};
