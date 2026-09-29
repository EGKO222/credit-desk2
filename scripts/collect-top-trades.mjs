// KOFIA 채권정보센터의 '유통시장 > 실시간 체결정보 > 일자별 거래현황'에서
// 전영업일 회사채(크레딧) 거래를 발행자 기준으로 집계해 Top 5를 Supabase에 저장한다.
// 실행: node --env-file=.env scripts/collect-top-trades.mjs

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

async function getPreviousBusinessDay() {
  const xml = await callKofia("BISBefBizYMDSrchSO", "searchBefDay", "BISBefBizYMDDTO", {
    standardDt: todayYyyymmdd(),
  });
  const m = xml.match(/<standardDt>([\s\S]*?)<\/standardDt>/);
  if (!m) throw new Error("전영업일 조회 실패");
  return m[1].trim();
}

// 종목명에서 뒤에 붙는 회차/번호(예: "에스케이하이닉스224-2" -> "에스케이하이닉스")를 제거해 발행자명을 추정한다.
// 완벽하지 않은 휴리스틱이며, 숫자로 끝나는 일부 회사명은 잘못 잘릴 수 있다.
function guessIssuer(bondName) {
  return bondName.replace(/[0-9]+(-[0-9]+)?\s*$/, "").trim();
}

async function fetchTopTrades(prevBizDay) {
  const xml = await callKofia("BISCurTrdDescSrchSO", "listDay", "BISComDspDatDTO", {
    val1: prevBizDay,
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

  const byIssuer = new Map();

  for (const block of blocks) {
    const getVal = (n) => {
      const m = block.match(new RegExp(`<val${n}>([\\s\\S]*?)<\\/val${n}>`));
      return m ? m[1].trim() : "";
    };

    if (getVal(2) !== "회사채") continue;

    const bondName = getVal(3);
    const rating = getVal(5);
    const amountManwon = parseFloat(getVal(12).replace(/,/g, ""));
    const count = parseInt(getVal(13), 10);
    if (!bondName || Number.isNaN(amountManwon) || Number.isNaN(count)) continue;

    const issuer = guessIssuer(bondName);
    if (!issuer) continue;

    const prev = byIssuer.get(issuer) || { issuer, rating: rating || null, amountEok: 0, count: 0 };
    prev.amountEok += amountManwon / 10000; // 만원 -> 억원
    prev.count += count;
    if (!prev.rating && rating) prev.rating = rating;
    byIssuer.set(issuer, prev);
  }

  return Array.from(byIssuer.values())
    .sort((a, b) => b.amountEok - a.amountEok)
    .slice(0, 5);
}

async function upsertToSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/top_trades`, {
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

const prevBizDay = await getPreviousBusinessDay();
const top5 = await fetchTopTrades(prevBizDay);

if (top5.length === 0) {
  console.log("전영업일 회사채 거래 데이터가 없습니다.");
  process.exit(0);
}

const tradeDate = toIsoDate(prevBizDay);
const rows = top5.map((t) => ({
  trade_date: tradeDate,
  issuer: t.issuer,
  rating: t.rating,
  amount_eok: Math.round(t.amountEok * 100) / 100,
  trade_count: t.count,
}));

await upsertToSupabase(rows);

console.log(`저장 완료 (${tradeDate}): ${rows.length}건`);
console.table(rows);
