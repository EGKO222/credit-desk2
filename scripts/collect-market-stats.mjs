// KOFIA '유통시장 > 실시간 체결정보 > 일자별 거래현황'(Top5 매매와 동일한 데이터 소스)에서
// 1) 섹터별(채권종류별) 전영업일 유통 물량 (sector_volume, 국채 포함 8개 원분류 그대로)
// 2) 유형(공사채/은행채/여전채/회사채) x 등급 x 만기구간 조합별 국고채 대비 스프레드 (spread_cells, 최근 7영업일)
// 3) 국고 + 유형 x 등급 x 잔존 1년 단위(0~20년)별 평균 수익률 (curve_cells, 수익률 커브용)
// 를 계산해 Supabase에 저장한다.
// 실행: node --env-file=.env scripts/collect-market-stats.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

// GitHub Actions 러너는 UTC라서, 한국 날짜(KST) 기준으로 계산한다.
function todayYyyymmdd() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10).replace(/-/g, "");
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

// 스프레드/유통물량에 쓰는 만기 구간 (화면 버튼과 동일)
const MATURITY_BUCKETS = ["1년 이내", "1~2년", "2~3년", "3~5년", "5~7년", "7~10년", "10년 이상"];

// 잔존기간 코드(예: "010422" = 1년 4개월 22일)를 만기 구간으로 변환
function maturityBucket(code) {
  if (!code || code.length < 2) return null;
  const years = parseInt(code.slice(0, 2), 10);
  if (Number.isNaN(years)) return null;

  if (years === 0) return "1년 이내";
  if (years === 1) return "1~2년";
  if (years === 2) return "2~3년";
  if (years <= 4) return "3~5년";
  if (years <= 6) return "5~7년";
  if (years <= 9) return "7~10년";
  return "10년 이상";
}

// 잔존기간 코드를 연 단위 소수(예: "010422" -> 약 1.39년)로 변환
function maturityYears(code) {
  if (!code || code.length < 6) return null;
  const y = parseInt(code.slice(0, 2), 10);
  const m = parseInt(code.slice(2, 4), 10);
  const d = parseInt(code.slice(4, 6), 10);
  if ([y, m, d].some(Number.isNaN)) return null;
  return y + m / 12 + d / 365;
}

// KOFIA 원분류 -> 화면에 쓰는 4개 크레딧 유형 표기로 변환 (국채/지방채/통안증권/ABS는 이 필터에서 제외)
function creditSectorLabel(rawSector) {
  if (rawSector === "특수채") return "공사채";
  if (rawSector === "은행채") return "은행채";
  if (rawSector === "기타금융채") return "여전채";
  if (rawSector === "회사채") return "회사채";
  return null;
}

function average(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

async function computeStatsForDay(day) {
  const rows = await fetchDayTrades(day);

  const govtYield = average(rows.filter((r) => r.sector === "국채").map((r) => r.avgYield));
  if (govtYield === null) return { volume: [], cells: [], curve: [] };

  // 섹터별 유통 물량 (만원 -> 조원, KOFIA 원분류 8개 그대로)
  const volumeBySector = new Map();
  for (const r of rows) {
    const cur = volumeBySector.get(r.sector) || 0;
    volumeBySector.set(r.sector, cur + r.amountManwon);
  }
  const volume = Array.from(volumeBySector.entries()).map(([sector, manwon]) => ({
    sector,
    volumeJo: manwon / 1e8,
  }));

  // 유형(공사채/은행채/여전채/회사채) x 등급 x 만기구간 셀별 스프레드 + 유통물량
  const cellMap = new Map();
  for (const r of rows) {
    const sector = creditSectorLabel(r.sector);
    if (!sector) continue;
    const grade = r.grade || "무등급";
    const bucket = maturityBucket(r.maturityCode);
    if (!bucket) continue;

    const key = `${sector}|${grade}|${bucket}`;
    const cur = cellMap.get(key) || { sector, grade, bucket, yieldSum: 0, count: 0, amountManwon: 0 };
    cur.yieldSum += r.avgYield;
    cur.count += 1;
    cur.amountManwon += r.amountManwon;
    cellMap.set(key, cur);
  }

  const cells = Array.from(cellMap.values()).map((c) => ({
    sector: c.sector,
    grade: c.grade,
    bucket: c.bucket,
    spreadBp: (c.yieldSum / c.count - govtYield) * 100,
    tradeCount: c.count,
    volumeJo: c.amountManwon / 1e8,
  }));

  // 수익률 커브: 국고 + 4개 유형 x 등급 x 잔존 1년 단위(0~20년) 구간별 평균 수익률/평균 잔존기간
  const curveMap = new Map();
  for (const r of rows) {
    const sector = r.sector === "국채" ? "국고" : creditSectorLabel(r.sector);
    if (!sector) continue;
    const years = maturityYears(r.maturityCode);
    if (years === null || years >= 20) continue;
    const grade = r.grade || "무등급";
    const bin = Math.floor(years);

    const key = `${sector}|${grade}|${bin}`;
    const cur = curveMap.get(key) || { sector, grade, bin, yieldSum: 0, yearsSum: 0, count: 0 };
    cur.yieldSum += r.avgYield;
    cur.yearsSum += years;
    cur.count += 1;
    curveMap.set(key, cur);
  }
  const curve = Array.from(curveMap.values()).map((c) => ({
    sector: c.sector,
    grade: c.grade,
    bin: c.bin,
    avgYears: c.yearsSum / c.count,
    avgYield: c.yieldSum / c.count,
    tradeCount: c.count,
  }));

  return { volume, cells, curve };
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
const spreadCellRows = [];
const volumeCellRows = [];
const curveRows = [];

for (const day of days) {
  const { volume, cells, curve } = await computeStatsForDay(day);
  const isoDate = toIsoDate(day);

  for (const c of curve) {
    curveRows.push({
      trade_date: isoDate,
      sector: c.sector,
      grade: c.grade,
      maturity_year: c.bin,
      avg_years: Math.round(c.avgYears * 1000) / 1000,
      avg_yield: Math.round(c.avgYield * 1000) / 1000,
      trade_count: c.tradeCount,
    });
  }

  for (const v of volume) {
    volumeRows.push({ trade_date: isoDate, sector: v.sector, volume_jo: Math.round(v.volumeJo * 1000) / 1000 });
  }
  for (const c of cells) {
    spreadCellRows.push({
      trade_date: isoDate,
      sector: c.sector,
      grade: c.grade,
      maturity_bucket: c.bucket,
      spread_bp: Math.round(c.spreadBp * 10) / 10,
      trade_count: c.tradeCount,
    });
    volumeCellRows.push({
      trade_date: isoDate,
      sector: c.sector,
      grade: c.grade,
      maturity_bucket: c.bucket,
      volume_jo: Math.round(c.volumeJo * 1000) / 1000,
    });
  }
}

await upsertToSupabase("sector_volume", volumeRows);
await upsertToSupabase("spread_cells", spreadCellRows);
await upsertToSupabase("volume_cells", volumeCellRows);

// 만기 구간을 바꾸면서 남은 예전 구간(3개월, 3년~5년 등) 행 정리 (사용자 허락 받음)
const keepList = `(${MATURITY_BUCKETS.map((b) => `"${b}"`).join(",")})`;
for (const table of ["spread_cells", "volume_cells"]) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?maturity_bucket=not.in.${encodeURIComponent(keepList)}`,
    {
      method: "DELETE",
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    }
  );
  if (!res.ok) throw new Error(`예전 만기 구간 정리 실패 (${table}): ${res.status} ${await res.text()}`);
}

// curve_cells 테이블은 supabase_setup.sql 실행 후에만 존재한다.
await upsertToSupabase("curve_cells", curveRows);

console.log(`수익률 커브 저장: ${curveRows.length}건`);
console.log(`섹터별 유통물량 저장: ${volumeRows.length}건`);
console.log(`스프레드 셀 저장: ${spreadCellRows.length}건`);
console.log(`유통물량 셀 저장: ${volumeCellRows.length}건`);
