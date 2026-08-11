// ══════════════════════════════════════════════════════════════
// 인스타그램 Graph API 직접 연동 (Zapier·매니챗 같은 중개 도구 없이, 메타 공식 API를 서버가 직접 호출)
// 비용: 게시·DM 전부 무료(메타가 과금하지 않음). 단 이미지·SEO 조사 등에 쓰는 OpenRouter 호출 비용은 별개.
// ══════════════════════════════════════════════════════════════
const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * 카드뉴스(여러 장) 캐러셀 게시 — 완전 자동 업로드
 * @param {string} igUserId       인스타그램 비즈니스 계정 ID (Graph API 탐색기 /me/accounts 로 확인)
 * @param {string} accessToken    장기 액세스 토큰
 * @param {string[]} imageUrls    공개적으로 접근 가능한 이미지 URL 배열 (Nexta 서버의 /public 경로 등)
 * @param {string} caption        게시글 본문
 */
async function publishCarouselPost(igUserId, accessToken, imageUrls, caption) {
  // 1) 이미지마다 "캐러셀 아이템" 컨테이너 생성
  const childIds = [];
  for (const url of imageUrls) {
    const res = await fetch(`${GRAPH}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: url, is_carousel_item: true, access_token: accessToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error("이미지 컨테이너 생성 실패: " + JSON.stringify(data));
    childIds.push(data.id);
  }

  // 2) 캐러셀 컨테이너 생성 (여러 아이템을 하나로 묶기)
  const carouselRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "CAROUSEL",
      children: childIds,
      caption,
      access_token: accessToken,
    }),
  });
  const carouselData = await carouselRes.json();
  if (!carouselRes.ok) throw new Error("캐러셀 컨테이너 생성 실패: " + JSON.stringify(carouselData));

  // 3) 게시 (실제로 인스타그램에 올라가는 시점)
  const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: carouselData.id, access_token: accessToken }),
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok) throw new Error("게시 실패: " + JSON.stringify(publishData));

  return publishData; // { id: "게시된_미디어_ID" }
}

/**
 * 웹훅 검증 (메타가 서버에 처음 연결할 때 GET으로 확인 요청을 보냄)
 */
function verifyWebhook(query, verifyToken) {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === verifyToken) {
    return query["hub.challenge"];
  }
  return null;
}

/**
 * 댓글에 키워드가 있으면 "비공개 답장(Private Reply)"으로 DM 발송 — 매니챗 대체 기능, 무료·무제한
 * @param {string} commentId
 * @param {string} accessToken
 * @param {string} message
 */
async function sendPrivateReply(commentId, accessToken, message) {
  const res = await fetch(`${GRAPH}/${commentId}/private_replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: accessToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("비공개 답장 실패: " + JSON.stringify(data));
  return data;
}

/**
 * 웹훅으로 들어온 댓글 이벤트를 처리 — 키워드 매칭되면 자동으로 sendPrivateReply 호출
 * @param {object} body            메타가 보낸 웹훅 payload
 * @param {object} rule            { keyword, replyMessage, accessToken }
 */
async function handleCommentWebhook(body, rule) {
  const results = [];
  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== "comments") continue;
      const value = change.value || {};
      const text = String(value.text || "");
      const commentId = value.id;
      if (commentId && text.includes(rule.keyword)) {
        try {
          const r = await sendPrivateReply(commentId, rule.accessToken, rule.replyMessage);
          results.push({ commentId, ok: true, r });
        } catch (e) {
          results.push({ commentId, ok: false, error: e.message });
        }
      }
    }
  }
  return results;
}

/**
 * 릴스 게시.
 * 사진과 달리 영상은 컨테이너를 만든 즉시 발행할 수 없다 — 메타가 먼저 트랜스코딩을 하고,
 * 끝나기 전에 media_publish를 부르면 실패한다. 그래서 status_code가 FINISHED가 될 때까지
 * 기다린 뒤에 발행한다.
 * @param {string} igUserId    인스타그램 비즈니스/크리에이터 계정 ID
 * @param {string} accessToken 장기 액세스 토큰
 * @param {string} videoUrl    공개 접근 가능한 mp4 주소
 * @param {string} caption     본문
 * @param {string} [coverUrl]  커버 이미지(생략 시 메타가 첫 프레임을 쓴다)
 */
async function publishReel(igUserId, accessToken, videoUrl, caption, coverUrl) {
  const createRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "REELS",
      video_url: videoUrl,
      caption: caption || "",
      ...(coverUrl ? { cover_url: coverUrl } : {}),
      access_token: accessToken,
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) throw new Error("릴스 컨테이너 생성 실패: " + JSON.stringify(created));

  // 트랜스코딩 대기 — 5초 간격으로 최대 5분. 짧은 영상은 보통 20~40초면 끝난다.
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const stRes = await fetch(
      `${GRAPH}/${created.id}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`
    );
    const st = await stRes.json();
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") throw new Error("릴스 인코딩 실패: " + (st.status || ""));
    if (Date.now() > deadline) throw new Error("릴스 인코딩이 5분 안에 끝나지 않았습니다.");
  }

  const pubRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: created.id, access_token: accessToken }),
  });
  const published = await pubRes.json();
  if (!pubRes.ok) throw new Error("릴스 게시 실패: " + JSON.stringify(published));
  return published;
}

/** 계정 현황 — 팔로워 수와 게시물 수. 성장 그래프의 원천이다. */
async function fetchProfileStats(igUserId, accessToken) {
  const res = await fetch(
    `${GRAPH}/${igUserId}?fields=username,followers_count,media_count&access_token=${encodeURIComponent(accessToken)}`
  );
  const data = await res.json();
  if (!res.ok) throw new Error("계정 조회 실패: " + JSON.stringify(data));
  return {
    username: data.username || "",
    followers: Number(data.followers_count || 0),
    posts: Number(data.media_count || 0),
  };
}

module.exports = {
  publishCarouselPost, publishReel, fetchProfileStats,
  verifyWebhook, sendPrivateReply, handleCommentWebhook,
};
