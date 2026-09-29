// KOFIA '유통시장 > 실시간 체결정보 > 일자별 거래현황'(Top5 매매와 동일한 데이터 소스)에서
// 1) 섹터별(채권종류별) 전영업일 유통 물량
// 2) 섹터별 / 등급별 / 잔존기간별 국고채 대비 스프레드(최근 7영업일 추이)
// 를 계산해 Supabase에 저장한다.
// 실행: node --env-file=.env scripts/collect-market-stats.mjs

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

function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function callKofia(pfmSvcName, pfmFnName, dtoName, fields) {
  const fieldXml = Object.entries(fields)
    .map(([k, v]) => `    <${k}>${v ?? ""}</${k}>`)
    .join("\n");

  const body = `<?xml version="1.0" encoding="utf-8"?>
<message>
  <proframeHeader>
    <pfmAppName>BIS-KOFIABOND</pfmAppName>
    <pfmSvcName>${pfmSvcName}</pfmSvcName>
    <pfmFnName>${pfmFnName}</pfmFnName>
  </proframeHeader>
  <systemHeader></systemHeader>
    <${dtoName}>
${fieldXml}
</${dtoName}>
</message>
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
  const xml = await callKofia("BISBefBizYMDSrchSO", "searchBefDay", "BISBefBizYMDDTO", {
    standardDt: fromDate,
  });
  const m = xml.match(/<standardDt>([\s\S]*?)<\/standardDt>/);
  if (!m) throw new Error("전영업일 조회 실패");
  return m[1].trim();
}

async function fetchDayTrades(day) {
  const xml = await callKofia("BISCurTrdDescSrchSO", "listDay", "BISComDspDatDTO", {
    val1: day,
    val2: "",
    val3: "",
    val4: "",
    val5: "",
    val6: "",
    val8: "",
    val9: "",
    val10: "B",
  });

  const blocks = xml.match(/<BISComDspDatDTO>[\s\S]*?<\/BISComDspDatDTO>/g) || [];
  const rows = [];

  for (const block of blocks) {
    const getVal = (n) => {
      const m = block.match(new RegExp(`<val${n}>([\\s\\S]*?)<\\/val${n}>`));
      return m ? m[1].trim() : "";
    };

    const sector = getVal(2);
    const grade = getVal(5);
    const maturityCode = getVal(4);
    const avgYield = parseFloat(getVal(6));
    const amountManwon = parseFloat(getVal(12).replace(/,/g, ""));

    if (!sector || Number.isNaN(avgYield)) continue;

    rows.push({ sector, grade, maturityCode, avgYield, amountManwon: Number.isNaN(amountManwon) ? 0 : amountManwon });
  }

  return rows;
}

// 잔존기간 코드(예: "010422" = 1년 4개월 22일)를 대략적인 연 단위 버킷으로 변환
function maturityBucket(code) {
  if (!code || code.length < 2) return null;
  const years = parseInt(code.slice(0, 2), 10);
  if (Number.isNaN(years)) return null;
  if (years < 2) return "1년";
  if (years < 4) return "3년";
  if (years < 7) return "5년";
  return "10년";
}

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function computeSpreadsForDay(day) {
  const rows = await fetchDayTrades(day);

  const govtYield = average(rows.filter((r) => r.sector === "국채").map((r) => r.avgYield));
  if (govtYield === null) return { volume: [], spreads: [] };

  // 섹터별 유통 물량 (만원 -> 조원)
  const volumeBySector = new Map();
  for (const r of rows) {
    const cur = volumeBySector.get(r.sector) || 0;
    volumeBySector.set(r.sector, cur + r.amountManwon);
  }
  const volume = Array.from(volumeBySector.entries()).map(([sector, manwon]) => ({
    sector,
    volumeJo: manwon / 1e8,
  }));

  // 섹터별 스프레드 (국채 제외)
  const yieldBySector = new Map();
  for (const r of rows) {
    if (r.sector === "국채") continue;
    if (!yieldBySector.has(r.sector)) yieldBySector.set(r.sector, []);
    yieldBySector.get(r.sector).push(r.avgYield);
  }
  const sectorSpreads = Array.from(yieldBySector.entries()).map(([sector, yields]) => ({
    type: "sector",
    name: sector,
    spreadBp: (average(yields) - govtYield) * 100,
  }));

  // 등급별 스프레드 (신용등급이 있는 채권만)
  const yieldByGrade = new Map();
  for (const r of rows) {
    if (!r.grade) continue;
    if (!yieldByGrade.has(r.grade)) yieldByGrade.set(r.grade, []);
    yieldByGrade.get(r.grade).push(r.avgYield);
  }
  const gradeSpreads = Array.from(yieldByGrade.entries()).map(([grade, yields]) => ({
    type: "grade",
    name: grade,
    spreadBp: (average(yields) - govtYield) * 100,
  }));

  // 투자기간별 스프레드 (국채/통안증권 제외한 크레딧 채권)
  const yieldByPeriod = new Map();
  for (const r of rows) {
    if (r.sector === "국채" || r.sector === "통안증권") continue;
    const bucket = maturityBucket(r.maturityCode);
    if (!bucket) continue;
    if (!yieldByPeriod.has(bucket)) yieldByPeriod.set(bucket, []);
    yieldByPeriod.get(bucket).push(r.avgYield);
  }
  const periodSpreads = Array.from(yieldByPeriod.entries()).map(([period, yields]) => ({
    type: "period",
    name: period,
    spreadBp: (average(yields) - govtYield) * 100,
  }));

  return { volume, spreads: [...sectorSpreads, ...gradeSpreads, ...periodSpreads] };
}

async function upsertToSupabase(table, rows) {
  if (rows.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
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

// 최근 7영업일 날짜를 구한다 (오늘 포함, 과거로 걸어가며)
async function getRecentBusinessDays(count) {
  const days = [];
  let cursor = todayYyyymmdd();
  for (let i = 0; i < count; i++) {
    cursor = await getPreviousBusinessDay(cursor);
    days.push(cursor);
  }
  return days;
}

const days = await getRecentBusinessDays(7);
console.log("대상 영업일:", days.join(", "));

const volumeRows = [];
const spreadRows = [];

for (const day of days) {
  const { volume, spreads } = await computeSpreadsForDay(day);
  const isoDate = toIsoDate(day);

  for (const v of volume) {
    volumeRows.push({ trade_date: isoDate, sector: v.sector, volume_jo: Math.round(v.volumeJo * 1000) / 1000 });
  }
  for (const s of spreads) {
    spreadRows.push({
      trade_date: isoDate,
      category_type: s.type,
      category_name: s.name,
      spread_bp: Math.round(s.spreadBp * 10) / 10,
    });
  }
}

await upsertToSupabase("sector_volume", volumeRows);
await upsertToSupabase("spreads", spreadRows);

console.log(`섹터별 유통물량 저장: ${volumeRows.length}건`);
console.log(`스프레드 저장: ${spreadRows.length}건`);
