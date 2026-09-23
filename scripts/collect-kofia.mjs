// KOFIA 채권정보센터의 '최종호가수익률(국고채권)' 데이터를 받아 Supabase에 저장한다.
// 실행: node --env-file=.env scripts/collect-kofia.mjs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const TENOR_MAP = {
  "국고채권(3년)": "국고채 3년",
  "국고채권(5년)": "국고채 5년",
  "국고채권(10년)": "국고채 10년",
  "국고채권(30년)": "국고채 30년",
};

function todayYyyymmdd() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function toIsoDate(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function fetchKofiaRates() {
  const trDate = todayYyyymmdd();

  const body = `<?xml version="1.0" encoding="UTF-8"?><root><message><proframeHeader>
<pfmAppName>BIS-KOFIABOND</pfmAppName>
<pfmSvcName>BISLastAskPrcROPSrchSO</pfmSvcName>
<pfmFnName>listDay</pfmFnName>
<pfmGlobalNo>cd23283c0afe009c0c7ca90b4fb7db38</pfmGlobalNo>
<pfmTrDate>${trDate}</pfmTrDate>
<pfmTrTime>${trDate}000000000</pfmTrTime>
<pfmClntIp>127.0.0.1</pfmClntIp>
<pfmResponseDtal></pfmResponseDtal>
</proframeHeader>
<systemHeader>
</systemHeader>
<BISComDspDatDTO>
<val1>${trDate}</val1>
</BISComDspDatDTO></message></root>`;

  const res = await fetch("https://www.kofiabond.or.kr/proframeWeb/XMLSERVICES/", {
    method: "POST",
    headers: { "Content-Type": "application/xml; charset=UTF-8" },
    body,
  });

  if (!res.ok) {
    throw new Error(`KOFIA 요청 실패: ${res.status}`);
  }

  const xml = await res.text();

  // 간단한 정규식 파싱: <BISComDspDatDTO>...</BISComDspDatDTO> 블록마다 val1(종목명), val3(당일수익률), val5(전일대비), val11(최종호가일자) 추출
  const blocks = xml.match(/<BISComDspDatDTO>[\s\S]*?<\/BISComDspDatDTO>/g) || [];

  const rows = [];
  for (const block of blocks) {
    const getVal = (n) => {
      const m = block.match(new RegExp(`<val${n}>([\\s\\S]*?)<\\/val${n}>`));
      return m ? m[1].trim() : "";
    };

    const name = getVal(1);
    if (!TENOR_MAP[name]) continue;

    const rate = parseFloat(getVal(3));
    const changeBp = parseFloat(getVal(5)) * 100; // KOFIA 전일대비는 %p 단위 → bp로 환산
    const asOfDate = toIsoDate(getVal(11));

    if (Number.isNaN(rate)) continue;

    rows.push({
      tenor: TENOR_MAP[name],
      rate,
      change_bp: Number.isNaN(changeBp) ? 0 : changeBp,
      as_of_date: asOfDate,
    });
  }

  return rows;
}

async function upsertToSupabase(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kofia_rates`, {
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

const rows = await fetchKofiaRates();

if (rows.length === 0) {
  console.error("KOFIA에서 국고채 3/5/10/30년 데이터를 찾지 못했습니다.");
  process.exit(1);
}

await upsertToSupabase(rows);

console.log(`저장 완료: ${rows.length}건`);
console.table(rows);
