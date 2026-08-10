/**
 * 콘텐츠 성격 분류기 — 상품 정보를 보고 5개 카테고리 중 하나를 고른다.
 * 이 결과가 라우팅 표를 타고 어느 영상 서비스로 갈지 결정한다.
 *
 * LLM은 형식을 어길 수 있으므로, 지시서의 우선순위 규칙(2-3)을 코드로도 한 번 더 적용한다.
 * has_existing_footage 같은 규칙은 판단이 아니라 사실이라 LLM에 맡길 이유가 없다 —
 * 원본 영상이 없는데 REPURPOSE로 가면 그 뒤 단계가 통째로 실패하기 때문이다.
 */

const CATEGORIES = ["PRESENTER", "MOOD", "TRUST_EXPLAINER", "REPURPOSE", "LAUNCH_IMPACT"];

// 우선순위 규칙에 쓰는 키워드 (지시서 2-3)
const LAUNCH_WORDS = ["런칭", "론칭", "출시", "이벤트", "오픈", "신상", "신제품", "새로", "첫"];
const TRUST_CATEGORIES = ["재무", "법률", "세무", "노무", "교육", "학원", "병원", "의료", "보험", "회계", "금융"];
const MOOD_CATEGORIES = ["뷰티", "화장품", "인테리어", "카페", "패션", "의류", "향수", "홈데코", "리빙", "주얼리"];

const 분류지시 = (input) => `
당신은 상품 정보를 보고 어떤 형식의 숏폼 영상이 가장 효과적일지 판단하는 콘텐츠 기획자입니다.

## 카테고리 5종
- PRESENTER: 사람(아바타)이 상품을 직접 설명하는 게 효과적인 경우. 일반적인 상품 설명의 기본값.
- MOOD: 브랜드 감성·분위기 중심의 무드샷이 어울리는 경우 (뷰티, 인테리어, 카페 등 감성 소비재).
- TRUST_EXPLAINER: 전문성과 신뢰가 중요한 정보성 콘텐츠 (재무·법률·세무·노무·교육 등).
- REPURPOSE: 고객이 이미 가진 원본 영상(라이브방송, 유튜브 등)을 잘라 재활용하는 경우.
- LAUNCH_IMPACT: 신상품 출시·이벤트처럼 임팩트 있는 런칭 영상이 필요한 경우.

## 판단 우선순위
1. 이미 보유한 영상이 있으면 → REPURPOSE
2. 의도에 "런칭/출시/이벤트/오픈"이 있으면 → LAUNCH_IMPACT
3. 업종이 재무·법률·세무·노무·교육 등 전문 분야면 → TRUST_EXPLAINER
4. 감성 소비재(뷰티·인테리어·카페 등)면 → MOOD
5. 그 외 일반 상품 설명이면 → PRESENTER

## 입력
상품명: ${input.product_name || "(없음)"}
상품 특징: ${input.product_features || "(없음)"}
가격: ${input.price != null ? input.price + "원" : "(없음)"}
사용자 의도: ${input.user_intent || "(없음)"}
보유 영상: ${input.has_existing_footage ? "있음" : "없음"}
업종: ${input.business_category || "(없음)"}

아래 JSON으로만 답하세요. 다른 텍스트는 절대 쓰지 마세요.
{
  "category": "PRESENTER | MOOD | TRUST_EXPLAINER | REPURPOSE | LAUNCH_IMPACT 중 하나",
  "confidence": 0.0~1.0 사이 숫자,
  "reasoning": "판단 근거 1~2문장",
  "fallback_category": "확신이 낮을 때 대안이 될 카테고리"
}`;

/** 지시서 2-3의 우선순위를 코드로 적용한다. 확정적인 규칙은 LLM 판단보다 우선한다. */
function ruleBasedCategory(input) {
  if (input.has_existing_footage && input.source_video_url) {
    return { category: "REPURPOSE", reason: "보유한 원본 영상이 있어 재활용이 우선입니다." };
  }
  const intent = String(input.user_intent || "");
  if (LAUNCH_WORDS.some((w) => intent.includes(w))) {
    return { category: "LAUNCH_IMPACT", reason: "런칭·출시 의도가 명시돼 있습니다." };
  }
  const biz = String(input.business_category || "");
  if (TRUST_CATEGORIES.some((w) => biz.includes(w))) {
    return { category: "TRUST_EXPLAINER", reason: "전문성이 중요한 업종입니다." };
  }
  return null; // 나머지는 LLM 판단에 맡긴다
}

/** 규칙에도 LLM에도 못 기댈 때 쓰는 최후 기본값 (지시서 2-3의 4·5번). */
function heuristicFallback(input) {
  const biz = String(input.business_category || "") + " " + String(input.product_name || "");
  if (MOOD_CATEGORIES.some((w) => biz.includes(w))) return "MOOD";
  return "PRESENTER";
}

/**
 * @param {object} deps { callWithFallback, parseJSON, loadModelConfig } — server.js의 것을 주입받는다
 *        (여기서 server를 require하면 순환 참조가 된다)
 */
function createClassifier({ callWithFallback, parseJSON, loadModelConfig }) {
  return async function classify(input, logCtx) {
    // ① 확정 규칙 먼저 — 사실 관계라 LLM에 물을 이유가 없다.
    const rule = ruleBasedCategory(input);
    if (rule) {
      return {
        category: rule.category,
        confidence: 1,
        reasoning: rule.reason,
        fallback_category: heuristicFallback(input),
        decidedBy: "rule",
      };
    }

    // ② 나머지는 LLM 판단.
    try {
      const config = loadModelConfig();
      const result = await callWithFallback(config, "라우팅_분류", 분류지시(input), false, 700, logCtx);
      const parsed = parseJSON(result.text);
      const category = parsed && CATEGORIES.includes(parsed.category) ? parsed.category : null;
      if (category) {
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
        const fb = CATEGORIES.includes(parsed.fallback_category)
          ? parsed.fallback_category
          : heuristicFallback(input);
        return {
          category,
          confidence,
          reasoning: String(parsed.reasoning || "").slice(0, 300),
          // 같은 값이면 대안 역할을 못 하므로 다른 값으로 바꾼다.
          fallback_category: fb === category ? heuristicFallback(input) : fb,
          decidedBy: "llm",
        };
      }
    } catch (e) {
      // 분류 실패가 기능 전체를 막으면 안 된다 — 기본값으로 계속 진행한다.
      console.warn("[영상 분류 실패 — 기본값으로 진행]", e.message);
    }

    const category = heuristicFallback(input);
    return {
      category,
      confidence: 0.4,
      reasoning: "분류기가 판단하지 못해 기본 규칙을 적용했습니다.",
      fallback_category: category === "PRESENTER" ? "MOOD" : "PRESENTER",
      decidedBy: "heuristic",
    };
  };
}

module.exports = { createClassifier, CATEGORIES, ruleBasedCategory, heuristicFallback };
