/**
 * 영상 생성 서비스 어댑터 — 5개 서비스를 하나의 인터페이스로 감싼다.
 *
 * 공통 인터페이스 (지시서 4-0):
 *   serviceName
 *   generateVideo(input) -> { jobId }
 *   checkStatus(jobId)   -> { state: 'pending'|'done'|'failed', error? }
 *   getResult(jobId)     -> { videoUrl, durationSec, costCredits }
 *
 * 각 어댑터는 환경변수 키가 있을 때만 동작한다. 키가 없으면 isReady()가 false를
 * 돌려주고 오케스트레이터가 그 서비스를 아예 후보에서 뺀다 — 잘못된 키로 호출해
 * 실패 로그를 쌓지 않기 위함이다.
 */

const POLL_UA = "nexta-video/1.0";

class AdapterError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

async function jsonFetch(url, options = {}, timeoutMs = 30000) {
  const resp = await fetch(url, {
    ...options,
    headers: { "User-Agent": POLL_UA, ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new AdapterError(`응답을 해석하지 못했습니다 (${resp.status})`); }
  if (!resp.ok) {
    // 4xx는 요청 자체가 잘못된 것이라 재시도해도 같은 결과다 — 폴백으로 바로 넘긴다.
    const retryable = resp.status >= 500 || resp.status === 429;
    throw new AdapterError(data.message || data.error?.message || `요청 실패 (${resp.status})`, retryable);
  }
  return data;
}

/* ────────────────────────── HeyGen (PRESENTER) ──────────────────────────
 * 아바타가 상품을 직접 설명하는 영상. 아바타/음성은 .env에 프리셋 ID로 고정해 두고
 * 재사용한다 — 호출마다 새로 만들면 아바타 생성비($1/회)가 그대로 원가에 붙는다.
 */
const heygen = {
  serviceName: "heygen",
  isReady: () => !!process.env.HEYGEN_API_KEY,
  async generateVideo(input) {
    const body = {
      video_inputs: [
        {
          character: {
            type: "avatar",
            avatar_id: process.env.HEYGEN_AVATAR_ID || "Daisy-inskirt-20220818",
            avatar_style: "normal",
          },
          voice: {
            type: "text",
            input_text: input.script || `${input.productName}. ${input.productFeatures}`,
            voice_id: process.env.HEYGEN_VOICE_ID || "1bd001e7e50f421d891986aad5158bc8",
          },
        },
      ],
      dimension: dimensionFor(input.aspectRatio),
    };
    const data = await jsonFetch("https://api.heygen.com/v2/video/generate", {
      method: "POST",
      headers: { "X-Api-Key": process.env.HEYGEN_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const jobId = data?.data?.video_id;
    if (!jobId) throw new AdapterError("HeyGen이 작업 번호를 돌려주지 않았습니다.", false);
    return { jobId };
  },
  async checkStatus(jobId) {
    const data = await jsonFetch(
      `https://api.heygen.com/v1/video_status.get?video_id=${encodeURIComponent(jobId)}`,
      { headers: { "X-Api-Key": process.env.HEYGEN_API_KEY } },
    );
    const s = data?.data?.status;
    if (s === "completed") return { state: "done", videoUrl: data.data.video_url, durationSec: data.data.duration };
    if (s === "failed") return { state: "failed", error: data?.data?.error?.message || "HeyGen 생성 실패" };
    return { state: "pending" };
  },
};

/* ────────────────────────── Runway (MOOD) ──────────────────────────
 * 감성·분위기 중심 무드샷. task 기반 비동기라 생성 후 폴링이 필수다.
 */
const runway = {
  serviceName: "runway",
  isReady: () => !!process.env.RUNWAY_API_KEY,
  async generateVideo(input) {
    if (!input.photoUrls?.length) throw new AdapterError("Runway는 시작 이미지가 필요합니다.", false);
    const data = await jsonFetch("https://api.dev.runwayml.com/v1/image_to_video", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RUNWAY_API_KEY,
        "X-Runway-Version": "2024-11-06",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.RUNWAY_MODEL || "gen4_turbo",
        promptImage: input.photoUrls[0],
        promptText: input.script || `${input.productName} — ${input.productFeatures}`,
        ratio: input.aspectRatio === "9:16" ? "720:1280" : "1280:720",
        duration: Math.min(10, input.durationSec || 10),
      }),
    });
    if (!data.id) throw new AdapterError("Runway가 작업 번호를 돌려주지 않았습니다.", false);
    return { jobId: data.id };
  },
  async checkStatus(jobId) {
    const data = await jsonFetch(`https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Bearer " + process.env.RUNWAY_API_KEY, "X-Runway-Version": "2024-11-06" },
    });
    if (data.status === "SUCCEEDED") return { state: "done", videoUrl: data.output?.[0] };
    if (data.status === "FAILED") return { state: "failed", error: data.failure || "Runway 생성 실패" };
    return { state: "pending" };
  },
};

/* ────────────────────────── Synthesia (TRUST_EXPLAINER) ──────────────────────────
 * 신뢰감 있는 설명형. 재무·법률·세무 정보가 들어가는 카테고리라, 오케스트레이터에서
 * 총괄AI 대본 검수를 통과한 script만 넘어오게 되어 있다(지시서 4-3).
 */
const synthesia = {
  serviceName: "synthesia",
  isReady: () => !!process.env.SYNTHESIA_API_KEY,
  async generateVideo(input) {
    if (!input.script) throw new AdapterError("Synthesia는 검수된 대본이 필요합니다.", false);
    const data = await jsonFetch("https://api.synthesia.io/v2/videos", {
      method: "POST",
      headers: { Authorization: process.env.SYNTHESIA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.productName?.slice(0, 100) || "넥스타 영상",
        visibility: "private",
        aspectRatio: input.aspectRatio === "9:16" ? "9:16" : "16:9",
        input: [
          {
            scriptText: input.script,
            avatar: process.env.SYNTHESIA_AVATAR_ID || "anna_costume1_cameraA",
            background: process.env.SYNTHESIA_BACKGROUND || "off_white",
          },
        ],
      }),
    });
    if (!data.id) throw new AdapterError("Synthesia가 작업 번호를 돌려주지 않았습니다.", false);
    return { jobId: data.id };
  },
  async checkStatus(jobId) {
    const data = await jsonFetch(`https://api.synthesia.io/v2/videos/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: process.env.SYNTHESIA_API_KEY },
    });
    if (data.status === "complete") return { state: "done", videoUrl: data.download, durationSec: data.duration };
    if (data.status === "failed" || data.status === "rejected") {
      return { state: "failed", error: data.reason || "Synthesia 생성 실패" };
    }
    return { state: "pending" };
  },
};

/* ────────────────────────── Opus Clip (REPURPOSE) ──────────────────────────
 * 이미 있는 롱폼 영상을 숏폼으로 자른다. 원본이 없으면 이 서비스는 존재 이유가 없으므로
 * 호출 자체를 막는다(지시서 4-4 가드).
 */
const opusClip = {
  serviceName: "opus_clip",
  isReady: () => !!process.env.OPUS_CLIP_API_KEY,
  async generateVideo(input) {
    if (!input.sourceVideoUrl) {
      throw new AdapterError("원본 영상 주소가 없으면 재활용(REPURPOSE)을 할 수 없습니다.", false);
    }
    const data = await jsonFetch("https://api.opus.pro/api/v1/projects", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.OPUS_CLIP_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        videoUrl: input.sourceVideoUrl,
        aspectRatio: input.aspectRatio === "9:16" ? "9:16" : "16:9",
        subtitle: true,
      }),
    });
    const jobId = data.id || data.projectId;
    if (!jobId) throw new AdapterError("Opus Clip이 작업 번호를 돌려주지 않았습니다.", false);
    return { jobId };
  },
  async checkStatus(jobId) {
    const data = await jsonFetch(`https://api.opus.pro/api/v1/projects/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Bearer " + process.env.OPUS_CLIP_API_KEY },
    });
    const s = String(data.status || "").toLowerCase();
    if (s === "completed" || s === "done") {
      const clip = (data.clips || [])[0];
      return { state: "done", videoUrl: clip?.videoUrl || data.videoUrl, durationSec: clip?.duration };
    }
    if (s === "failed" || s === "error") return { state: "failed", error: data.error || "Opus Clip 생성 실패" };
    return { state: "pending" };
  },
};

/* ────────────────────────── Motion (LAUNCH_IMPACT) ──────────────────────────
 * 런칭·이벤트용 임팩트 영상. 배경음악이 자동으로 붙을 수 있어, 상업적 사용이 가능한
 * 음원만 쓰도록 프롬프트에 명시한다(지시서 4-5).
 */
const motion = {
  serviceName: "motion",
  isReady: () => !!process.env.MOTION_API_KEY,
  async generateVideo(input) {
    const prompt =
      (input.script || `${input.productName} — ${input.productFeatures}`) +
      "\n\n[필수] 배경음악은 상업적 사용이 허용된 저작권 프리 음원만 사용할 것.";
    const data = await jsonFetch("https://api.motion.so/v1/sessions", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.MOTION_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        aspect_ratio: input.aspectRatio || "9:16",
        duration_sec: input.durationSec || 15,
      }),
    });
    const jobId = data.job_id || data.id;
    if (!jobId) throw new AdapterError("Motion이 작업 번호를 돌려주지 않았습니다.", false);
    return { jobId };
  },
  async checkStatus(jobId) {
    const data = await jsonFetch(`https://api.motion.so/v1/sessions/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Bearer " + process.env.MOTION_API_KEY },
    });
    const s = String(data.status || "").toLowerCase();
    if (s === "completed" || s === "succeeded") {
      return { state: "done", videoUrl: data.video_url || data.output?.url, durationSec: data.duration_sec };
    }
    if (s === "failed") return { state: "failed", error: data.error || "Motion 생성 실패" };
    return { state: "pending" };
  },
};

function dimensionFor(aspectRatio) {
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  if (aspectRatio === "16:9") return { width: 1920, height: 1080 };
  return { width: 1080, height: 1920 }; // 9:16 기본
}

const ADAPTERS = { heygen, runway, synthesia, opus_clip: opusClip, motion };

module.exports = { ADAPTERS, AdapterError };
