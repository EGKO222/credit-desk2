// KOFIA 채권정보센터의 '채권금리 > 가중평균수익률 > 시가평가 가중평균수익률'(그날 실제 거래된 칸만 값이 있는 표)을
// 받아 국고 + 유형(공사채/은행채/여전채/회사채) x 등급 x 만기별 수익률을 curve_yields에 저장한다 (수익률 커브용).
// 최근 7영업일을 매번 다시 받아 덮어쓴다.
// 실행: node --env-file=.env scripts/collect-curve.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

// 응답의 val1~val16 = 만기 3개월~50년 (화면 표의 열 순서와 같음)
const TENOR_YEARS = [0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50];

// GitHub Actions 러너는 UTC라서, 한국 날짜(KST) 기준으로 계산한다.
function todayYyyymmdd() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
}

function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function callKofia(pfmSvcName, pfmFnName, dtoName, innerXml) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<message>
  <proframeHeader>
    <pfmAppName>BIS-KOFIABOND</pfmAppName>
    <pfmSvcName>${pfmSvcName}</pfmSvcName>
    <pfmFnName>${pfmFnName}</pfmFnName>
  </proframeHeader>
  <systemHeader></systemHeader>
<${dtoName}>${innerXml}</${dtoName}></message>
`;

  const res = await fetch("https://www.kofiabond.or.kr/proframeWeb/XMLSERVICES/", {
    method: "POST",
    headers: { "Content-Type": "application/xml; charset=UTF-8" },
    body,
  });

  if (!res.ok) {
    throw new Error(`KOFIA 요청 실패 (${pfmSvcName}.${pfmFnName}): ${res.status}`);
  }

  return res.text();
}

async function getPreviousBusinessDay(fromDate) {
  const xml = await callKofia("BISBefBizYMDSrchSO", "searchBefDay", "BISBefBizYMDDTO", `<standardDt>${fromDate}</standardDt>`);
  const m = xml.match(/<standardDt>([\s\S]*?)<\/standardDt>/);
  if (!m) throw new Error("전영업일 조회 실패");
  return m[1].trim();
}

// 최근 7영업일 날짜 (오늘 제외, 과거로 걸어가며)
async function getRecentBusinessDays(count) {
  const days = [];
  let cursor = todayYyyymmdd();
  for (let i = 0; i < count; i++) {
    cursor = await getPreviousBusinessDay(cursor);
    days.push(cursor);
  }
  return days;
}

// KOFIA 표의 (대분류, 종류, 신용등급) -> 화면의 (유형, 등급). 여기에 없는 행은 저장하지 않는다.
function mapRow(large, type, rank) {
  if (large === "국채" && type === "국고채권") return { sector: "국고", grade: "무등급" };
  if (large === "특수채" && type === "공사채 및 공단채" && /^(AAA|AA\+|AA)$/.test(rank)) return { sector: "공사채", grade: rank };
  // 은행채: AAA(산금채)/AAA(중금채)/AAA는 모두 AAA 한 줄로 합친다.
  if (large.startsWith("금융채 I(") && type === "무보증") return { sector: "은행채", grade: rank.startsWith("AAA") ? "AAA" : rank };
  if (large.includes("금융채 II(") && type === "무보증") return { sector: "여전채", grade: rank };
  if (large.startsWith("회사채 I(") && type === "무보증") return { sector: "회사채", grade: rank };
  return null;
}

async function fetchDay(day) {
  const xml = await callKofia(
    "BISSrtPrcEstMtrxWhtAvgSrchSO",
    "selectList",
    "BISSrtPrcEstMtrxWhtAvgDTO",
    `<standardDt>${day}</standardDt><applyGbCd>C00</applyGbCd><val20>1</val20>`
  );

  const blocks = xml.match(/<BISSrtPrcEstMtrxWhtAvgDTO>[\s\S]*?<\/BISSrtPrcEstMtrxWhtAvgDTO>/g) || [];

  // 같은 (유형, 등급, 만기)로 모이는 행은 거래가 있는 값만 단순평균한다.
  const acc = new Map();
  for (const block of blocks) {
    const f = {};
    for (const m of block.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) f[m[1]] = m[2].trim();

    const mapped = mapRow(f.largeCategoryMrk || "", f.typeNmMrk || "", f.creditRnkMrk || "");
    if (!mapped) continue;

    TENOR_YEARS.forEach((years, i) => {
      const y = parseFloat(f[`val${i + 1}`]);
      if (Number.isNaN(y) || y === 0) return; // 0 = 그날 거래 없음
      const key = `${mapped.sector}|${mapped.grade}|${years}`;
      const cur = acc.get(key) || { ...mapped, years, sum: 0, n: 0 };
      cur.sum += y;
      cur.n += 1;
      acc.set(key, cur);
    });
  }

  const isoDate = toIsoDate(day);
  return Array.from(acc.values()).map((c) => ({
    trade_date: isoDate,
    sector: c.sector,
    grade: c.grade,
    tenor_years: c.years,
    yield_pct: Math.round((c.sum / c.n) * 1000) / 1000,
  }));
}

async function upsertToSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/curve_yields`, {
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

const days = await getRecentBusinessDays(7);
console.log("대상 영업일:", days.join(", "));

const rows = [];
for (const day of days) {
  rows.push(...(await fetchDay(day)));
}

if (rows.length === 0) {
  console.error("수익률 커브 데이터를 찾지 못했습니다.");
  process.exit(1);
}

await upsertToSupabase(rows);

const bySector = {};
for (const r of rows) bySector[r.sector] = (bySector[r.sector] || 0) + 1;
console.log(`수익률 커브 저장: ${rows.length}건`, bySector);
