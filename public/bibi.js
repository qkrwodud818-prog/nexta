/* ══════════════════════════════════════════════════════════════
   비비 캐릭터 — 코드로 그리는 13명

   설정: 2087년의 로봇 직원. 모두 같은 몸체로 만들어졌고, 태어날 때 임무 하나를 받는다.
   그래서 몸은 13명이 완전히 같고 세 가지만 다르다 — 색, 표정, 손에 든 도구.
   같은 몸을 공유해야 "같은 공장에서 나온 동료"로 읽히고, 셋이 달라야 구별된다.

   그림은 전부 SVG다. 이미지 파일이 아니라 코드라서 어느 크기로 키워도 안 뭉개지고,
   색·표정을 데이터로 바꿀 수 있다.
   ══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* 흰 획 공통 속성 — 표정은 전부 이 굵기로 그린다. 얼굴 안에서 굵기가 흔들리면
     같은 개체로 안 보인다. */
  var W = 'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';

  /* 눈 — 얼굴판 안 (26,25)·(38,25) 두 자리 */
  var EYES = {
    round:  '<circle cx="26" cy="25" r="3.6" fill="#fff"/><circle cx="38" cy="25" r="3.6" fill="#fff"/>',
    wide:   '<circle cx="26" cy="25" r="4.4" fill="#fff"/><circle cx="38" cy="25" r="4.4" fill="#fff"/>'
          + '<circle cx="27.3" cy="23.7" r="1.5" fill="rgba(11,14,20,.55)"/>'
          + '<circle cx="39.3" cy="23.7" r="1.5" fill="rgba(11,14,20,.55)"/>',
    happy:  '<path d="M22.6 27 26 23.3 29.4 27" ' + W + '/><path d="M34.6 27 38 23.3 41.4 27" ' + W + '/>',
    squint: '<path d="M23 21.7 27.2 25.2 23 28.7" ' + W + '/><path d="M41 21.7 36.8 25.2 41 28.7" ' + W + '/>',
    line:   '<path d="M22.7 25.4h6.6" ' + W + '/><path d="M34.7 25.4h6.6" ' + W + '/>',
    /* 팀장만 바이저다. 눈이 하나로 이어지면 "지켜보고 있다"로 읽혀서, 검수하는 역할과 맞다. */
    visor:  '<rect x="21.4" y="21.5" width="21.2" height="7.2" rx="3.6" fill="#fff" opacity=".93"/>'
          + '<rect x="24" y="23.6" width="6" height="3" rx="1.5" fill="rgba(11,14,20,.35)"/>',
    wink:   '<path d="M22.6 26.6 26 23 29.4 26.6" ' + W + '/><circle cx="38" cy="25" r="3.7" fill="#fff"/>',
    star:   '<path d="M26 20.6 27.2 23.8 30.4 25 27.2 26.2 26 29.4 24.8 26.2 21.6 25 24.8 23.8Z" fill="#fff"/>'
          + '<path d="M38 20.6 39.2 23.8 42.4 25 39.2 26.2 38 29.4 36.8 26.2 33.6 25 36.8 23.8Z" fill="#fff"/>'
  };

  /* 입 — (32, 31.5) 언저리 */
  var MOUTH = {
    smile: '<path d="M28.6 31.1Q32 34.4 35.4 31.1" ' + W + '/>',
    grin:  '<path d="M27.4 30.4Q32 35.6 36.6 30.4" ' + W + '/>',
    flat:  '<path d="M29.4 32h5.2" ' + W + '/>',
    open:  '<ellipse cx="32" cy="32" rx="2.7" ry="3" fill="#fff"/>',
    wave:  '<path d="M28 32.2q2-2.2 4 0t4 0" ' + W + '/>',
    dot:   '<circle cx="32" cy="32" r="1.6" fill="#fff"/>'
  };

  /* 13명의 차별점 — 표정 조합.
     같은 눈을 써도 입이 다르면 다른 성격으로 읽힌다. 색·도구까지 셋이 겹치는 조합은 없다. */
  var EXPR = {
    strategy:   { e: "wide",   m: "smile" },  // 멀리 보는 눈
    finance:    { e: "line",   m: "dot"   },  // 계산 중, 표정 없음
    seo:        { e: "wide",   m: "dot"   },  // 뭔가 찾는 중
    cs:         { e: "happy",  m: "smile" },  // 친절
    sales:      { e: "squint", m: "grin"  },  // 열정 >_<
    hiring:     { e: "round",  m: "open"  },  // 반가움
    manager:    { e: "visor",  m: "flat"  },  // 팀장 — 검수하는 눈
    sns:        { e: "star",   m: "grin"  },  // 신남
    copywriter: { e: "happy",  m: "wave"  },  // 흥얼거리며 쓰는 중
    email:      { e: "round",  m: "smile" },
    coach:      { e: "happy",  m: "grin"  },  // 응원
    ecommerce:  { e: "round",  m: "flat"  },
    assistant:  { e: "wink",   m: "smile" }   // 눈치 빠른 비서
  };

  /* 도구 — 24칸 격자에 획 1.75로 그린 픽토그램. 규격을 공유해야 세트로 읽힌다. */
  var TOOL = {
    strategy:   '<circle cx="12" cy="12" r="8"/><path d="M15.2 8.8l-1.7 4.7-4.7 1.7 1.7-4.7z"/>',
    finance:    '<path d="M3.5 19.5h17"/><path d="M8 16.5V12"/><path d="M12 16.5V8.5"/><path d="M16 16.5V5.5"/>',
    seo:        '<circle cx="10.5" cy="10.5" r="6"/><path d="M14.9 14.9l4.6 4.6"/><path d="M7.8 11.6l2-2.3 1.7 1.4 2.2-2.7"/>',
    cs:         '<rect x="3.5" y="5" width="17" height="11" rx="2.5"/><path d="M8 16v3.2l3.6-3.2"/><path d="M8.6 10.5h.01M12 10.5h.01M15.4 10.5h.01"/>',
    sales:      '<path d="M3.6 5.2h16.8l-6.6 7.7v6.1l-3.6-2.2v-3.9z"/>',
    hiring:     '<circle cx="9.5" cy="8.5" r="3.4"/><path d="M3.5 19.2c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6"/><path d="M18.8 6.2v5M16.3 8.7h5"/>',
    manager:    '<path d="M12 3.2l7.2 3v5.6c0 4.2-3 6.9-7.2 8-4.2-1.1-7.2-3.8-7.2-8V6.2z"/><path d="M8.9 12.1l2.2 2.2 4.2-4.5"/>',
    sns:        '<circle cx="17.6" cy="6.6" r="2.6"/><circle cx="17.6" cy="17.4" r="2.6"/><circle cx="6.4" cy="12" r="2.6"/><path d="M8.8 10.9l6.4-3.2M8.8 13.1l6.4 3.2"/>',
    copywriter: '<path d="M4.4 5.6h5.6v6.4c0 3.6-2.1 5.9-5.6 6.6"/><path d="M13.4 5.6H19v6.4c0 3.6-2.1 5.9-5.6 6.6"/>',
    email:      '<rect x="3.2" y="5.6" width="17.6" height="12.8" rx="2.2"/><path d="M4.2 7.4l7.8 5.7 7.8-5.7"/>',
    coach:      '<path d="M3.5 19.5h4.4v-4.2h4.4v-4.2h4.4V7.2"/><circle cx="16.7" cy="4.8" r="2.4"/>',
    ecommerce:  '<path d="M12 3.6l8 3.9v8.9L12 20.4 4 16.4V7.5z"/><path d="M4 7.5l8 4 8-4M12 11.5v8.9"/>',
    assistant:  '<rect x="3.4" y="5" width="17.2" height="14" rx="2.4"/><path d="M4.2 16.4l4.2-4.2 3.2 3.2 3.4-3.9 5 5.3"/><circle cx="8.6" cy="9.6" r="1.4"/>'
  };

  function rgba(hex, a) {
    var h = String(hex).replace("#", "");
    return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")";
  }
  function escAttr(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* 몸체 — 13명이 완전히 동일한 부분. 색만 갈아끼운다. */
  function body(c) {
    return ''
      /* 안테나 — 로봇이라는 신호. 끝의 불빛이 "켜져 있다"를 말한다. */
      + '<path d="M32 14V10" stroke="' + c + '" stroke-width="2.8" stroke-linecap="round"/>'
      + '<circle cx="32" cy="7.2" r="3.1" fill="' + c + '"/>'
      + '<circle cx="32" cy="7.2" r="1.3" fill="#fff" opacity=".9"/>'
      /* 옆 통신부 */
      + '<rect x="7.2" y="24" width="5.2" height="10.4" rx="2.6" fill="' + c + '"/>'
      + '<rect x="51.6" y="24" width="5.2" height="10.4" rx="2.6" fill="' + c + '"/>'
      /* 목 — 머리와 몸 사이를 잇는다(둘 뒤에 깔린다) */
      + '<rect x="28.4" y="40" width="7.2" height="8" rx="2.4" fill="' + c + '"/>'
      /* 머리 */
      + '<rect x="12" y="14" width="40" height="30" rx="13" fill="' + c + '"/>'
      /* 머리 위 광택 한 줄 — 금속 느낌은 이 한 줄이면 충분하다 */
      + '<path d="M19 21.5q6-5.4 13-5.4" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".3"/>'
      /* 얼굴판 */
      + '<rect x="17" y="18" width="30" height="21" rx="8.6" fill="#0b0e14" opacity=".9"/>'
      /* 팔 */
      + '<path d="M20.4 50.5 13.4 55.4" stroke="' + c + '" stroke-width="4.6" stroke-linecap="round"/>'
      + '<path d="M43.6 50.5 52.2 46.2" stroke="' + c + '" stroke-width="4.6" stroke-linecap="round"/>'
      /* 몸통 + 가슴 표시등 */
      + '<rect x="20" y="46" width="24" height="15.4" rx="6" fill="' + c + '"/>'
      + '<circle cx="32" cy="53.6" r="3.1" fill="#fff" opacity=".85"/>'
      /* 다리 */
      + '<path d="M25.4 61.4V68" stroke="' + c + '" stroke-width="5.4" stroke-linecap="round"/>'
      + '<path d="M38.6 61.4V68" stroke="' + c + '" stroke-width="5.4" stroke-linecap="round"/>';
  }

  function face(key) {
    var x = EXPR[key] || EXPR.email;
    return (EYES[x.e] || EYES.round) + (MOUTH[x.m] || MOUTH.smile);
  }

  /* opts.compact — 도구와 배경 원을 뺀 몸체만. 60px 이하에서는 도구가 얼룩으로만 남는다.
     opts.cls    — 붙일 CSS 클래스
     opts.label  — 스크린리더용 설명 (없으면 역할로 만든다) */
  function character(p, opts) {
    opts = opts || {};
    var c = p.color || "#5b4bf5";
    var key = p.img || "email";
    var label = opts.label || ("비비-" + (p.serial || "") + " " + (p.role || ""));
    var cls = opts.cls || "bibi";
    var head = '<svg class="' + cls + '" viewBox="' + (opts.compact ? "2 0 60 72" : "0 0 80 72")
      + '" role="img" aria-label="' + escAttr(label) + '">';

    if (opts.compact) {
      return head + body(c) + face(key) + "</svg>";
    }
    return head
      /* 뒤에 깔리는 옅은 원 — 캐릭터가 흰 바탕에 뜨지 않게 잡아준다 */
      + '<circle cx="36" cy="35" r="34.5" fill="' + rgba(c, 0.1) + '"/>'
      + body(c) + face(key)
      /* 손에 든 도구 */
      + '<g transform="translate(54 36) scale(0.78)" fill="none" stroke="' + c
      + '" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">'
      + (TOOL[key] || TOOL.email) + "</g>"
      + "</svg>";
  }

  global.BIBI = { character: character, TOOL: TOOL, EXPR: EXPR };
})(window);
