// KOFIA 채권정보센터의 '신용평가정보 > 신용등급 속보' 중 '변동사항만' 데이터를 받아 Supabase에 저장한다.
// KOFIA가 신용평가 3사(한국신용평가/NICE신용평가/한국기업평가)로부터 받아 공개 게시하는 속보이며,
// 각 신용평가사 자체 사이트를 직접 수집하지 않는다 (저작권 리스크 회피).
// 실행: node --env-file=.env scripts/collect-credit-events.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

function todayYyyymmdd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function daysAgoYyyymmdd(days) {
  const now = new Date();
  now.setDate(now.getDate() - days);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toIsoDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function fetchCreditEvents() {
  const startDt = daysAgoYyyymmdd(30);
  const endDt = todayYyyymmdd();

  const body = `<?xml version="1.0" encoding="utf-8"?>
<message>
  <proframeHeader>
    <pfmAppName>BIS-KOFIABOND</pfmAppName>
    <pfmSvcName>BISCdtRnkHotSrchSO</pfmSvcName>
    <pfmFnName>select</pfmFnName>
  </proframeHeader>
  <systemHeader></systemHeader>
    <BISCdtRnkHotDTO>
    <schField>1</schField>
    <creditEstCd></creditEstCd>
    <companyNm></companyNm>
    <schData>2</schData>
    <standardDt1>${startDt}</standardDt1>
    <standardDt2>${endDt}</standardDt2>
</BISCdtRnkHotDTO>
</message>
`;

  const res = await fetch("https://www.kofiabond.or.kr/proframeWeb/XMLSERVICES/", {
    method: "POST",
    headers: { "Content-Type": "application/xml; charset=UTF-8" },
    body,
  });

  if (!res.ok) {
    throw new Error(`KOFIA 요청 실패: ${res.status}`);
  }

  const xml = await res.text();
  const blocks = xml.match(/<BISCdtRnkHotDTO>[\s\S]*?<\/BISCdtRnkHotDTO>/g) || [];

  const rows = [];
  for (const block of blocks) {
    const getVal = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
      return m ? m[1].trim() : "";
    };

    const companyNm = getVal("companyNm");
    const agency = getVal("koreanShotNm");
    const estimateDay = toIsoDate(getVal("estimateDay"));
    if (!companyNm || !agency || !estimateDay) continue;

    const bondSeries = getVal("issueTimeDiff");
    const fileNm = getVal("fileNm");

    rows.push({
      event_key: `${companyNm}|${agency}|${bondSeries}|${estimateDay}`,
      company_nm: companyNm,
      agency,
      rating: getVal("creditEstRnkNm") || null,
      outlook: getVal("outlook") || null,
      bond_series: bondSeries || null,
      estimate_day: estimateDay,
      report_url: fileNm ? `https://www.kofiabond.or.kr${fileNm}` : null,
    });
  }

  return rows;
}

async function upsertToSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/credit_events`, {
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

const rows = await fetchCreditEvents();

if (rows.length === 0) {
  console.log("최근 30일간 등급/전망 변동 건이 없습니다.");
} else {
  await upsertToSupabase(rows);
  console.log(`저장 완료: ${rows.length}건`);
  console.table(rows.map(({ company_nm, agency, rating, outlook, estimate_day }) => ({ company_nm, agency, rating, outlook, estimate_day })));
}
