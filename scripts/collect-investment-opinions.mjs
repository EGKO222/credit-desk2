// 네이버 증권 '리서치 > 채권분석'의 최근 2일 리포트 원문을 모아
// Google Gemini API(직접 연결)로 3꼭지 시황 요약·의견을 생성해 Supabase에 저장한다.
// 리포트 목록 자체(제목/증권사/날짜/링크)도 함께 저장한다 (investment_opinions 테이블).
// 실행: node --env-file=.env scripts/collect-investment-opinions.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

function kstTodayIsoDate() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function isoDaysAgo(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAVER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

async function fetchOpinionsList() {
  const res = await fetch("https://m.stock.naver.com/api/research/debenture?page=1&pageSize=20", {
    headers: NAVER_HEADERS,
  });
  if (!res.ok) throw new Error(`네이버 리서치 목록 요청 실패: ${res.status}`);
  return res.json();
}

async function fetchOpinionDetail(researchId) {
  const res = await fetch(`https://m.stock.naver.com/api/research/debenture/${researchId}`, {
    headers: NAVER_HEADERS,
  });
  if (!res.ok) throw new Error(`네이버 리서치 상세 요청 실패 (${researchId}): ${res.status}`);
  const data = await res.json();
  return data.researchContent;
}

async function upsertToSupabase(table, rows, onConflict) {
  if (rows.length === 0) return;
  const url = onConflict
    ? `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase 저장 실패 (${table}): ${res.status} ${text}`);
  }
}

async function summarizeWithGemini(reports) {
  const reportText = reports
    .map((r, i) => `[리포트 ${i + 1}] ${r.brokerName} - ${r.title} (${r.writeDate})\n${r.content}`)
    .join("\n\n---\n\n");

  const systemPrompt = `당신은 채권/크레딧 데스크의 애널리스트입니다. 여러 증권사의 채권 리포트 원문이 주어집니다.
이 내용을 종합해서 금리 방향, 일드커브, 수급, 섹터별 크레딧 이슈 중 중요한 것 위주로 정확히 3개의 핵심 포인트로 요약하세요.
규칙:
- 리포트에 실제로 나온 내용만 사용하고, 없는 내용을 추측해서 지어내지 마세요.
- 각 포인트는 6~12자 내외의 짧은 소제목(heading)과, 2~4문장의 설명(body)으로 구성하세요.
- 반드시 아래 JSON 배열 형식으로만 응답하고, 다른 텍스트는 출력하지 마세요.
[{"heading": "...", "body": "..."}, {"heading": "...", "body": "..."}, {"heading": "...", "body": "..."}]`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: reportText }] }],
        generationConfig: { temperature: 0.2 },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API 요청 실패: ${res.status} ${text}`);
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error(`AI 응답에서 JSON을 찾지 못했습니다: ${raw.slice(0, 300)}`);

  const points = JSON.parse(match[0]);
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error("AI가 유효한 요약 포인트를 반환하지 않았습니다.");
  }
  return points;
}

const today = kstTodayIsoDate();
const cutoff = isoDaysAgo(today, 1); // 최근 2일(오늘 포함)

const list = await fetchOpinionsList();
const recentItems = list.filter((item) => item.writeDate >= cutoff);

// 리포트 목록 저장 (제목/증권사/날짜/링크)
const listRows = recentItems.map((item) => ({
  research_id: item.researchId,
  title: item.title,
  broker_name: item.brokerName,
  write_date: item.writeDate,
  url: item.endUrl,
}));
await upsertToSupabase("investment_opinions", listRows);
console.log(`리포트 목록 저장: ${listRows.length}건`);

if (recentItems.length === 0) {
  console.log("최근 2일 내 채권분석 리포트가 없어 AI 요약을 건너뜁니다.");
  process.exit(0);
}

// 본문까지 필요하므로 최대 8건만 사용 (토큰/시간 절약)
const targets = recentItems.slice(0, 8);
const reports = [];
for (const item of targets) {
  const detail = await fetchOpinionDetail(item.researchId);
  reports.push({
    brokerName: item.brokerName,
    title: item.title,
    writeDate: item.writeDate,
    content: stripHtml(detail.content || "").slice(0, 1500),
  });
}

const points = await summarizeWithGemini(reports);

const sourcesText = reports.map((r) => `${r.brokerName} - ${r.title}`).join(", ");
const summaryRows = points.slice(0, 3).map((p, i) => ({
  summary_date: today,
  point_order: i + 1,
  heading: p.heading,
  body: p.body,
  sources: sourcesText,
}));

await upsertToSupabase("market_opinion_summary", summaryRows);
console.log(`AI 요약 저장 완료 (${today}): ${summaryRows.length}건`);
console.table(summaryRows.map(({ point_order, heading, body }) => ({ point_order, heading, body })));
