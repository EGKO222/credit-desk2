// 네이버 증권 '리서치 > 채권분석'에서 최근 2일 내 발행된 자료 목록(제목/증권사/날짜/링크)을 가져온다.
// 저작권 보호를 위해 리서치 본문/요약 문단은 저장하지 않고, 제목·증권사·날짜·원문 링크만 저장한다.
// 실행: node --env-file=.env scripts/collect-investment-opinions.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
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

async function fetchOpinions() {
  const res = await fetch("https://m.stock.naver.com/api/research/debenture?page=1&pageSize=20", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!res.ok) {
    throw new Error(`네이버 리서치 요청 실패: ${res.status}`);
  }

  return res.json();
}

async function upsertToSupabase(rows) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/investment_opinions`, {
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
    throw new Error(`Supabase 저장 실패: ${res.status} ${text}`);
  }
}

const today = kstTodayIsoDate();
const cutoff = isoDaysAgo(today, 1); // 최근 2일(오늘 포함) = 오늘, 어제

const items = await fetchOpinions();

const rows = items
  .filter((item) => item.writeDate >= cutoff)
  .map((item) => ({
    research_id: item.researchId,
    title: item.title,
    broker_name: item.brokerName,
    write_date: item.writeDate,
    url: item.endUrl,
  }));

if (rows.length === 0) {
  console.log("최근 2일 내 채권분석 리서치가 없습니다.");
} else {
  await upsertToSupabase(rows);
  console.log(`저장 완료: ${rows.length}건`);
  console.table(rows);
}
