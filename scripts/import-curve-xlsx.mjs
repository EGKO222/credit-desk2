// KOFIA '시가평가 가중평균수익률' 엑셀 표를 읽어 curve_yields 테이블에 저장한다 (수익률 커브용).
// 표 형식: 1행 = 헤더(대분류,중분류,소분류,구분,3M,6M,...), 3행부터 데이터. 병합 셀이라 대/중분류는 위 행 값을 이어받는다.
// 실행: node --env-file=.env scripts/import-curve-xlsx.mjs "<엑셀 경로>" <기준일 YYYY-MM-DD>
import fs from "node:fs";
import zlib from "node:zlib";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const [filePath, tradeDate] = process.argv.slice(2);
if (!filePath || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || "")) {
  console.error('사용법: node --env-file=.env scripts/import-curve-xlsx.mjs "<엑셀 경로>" <YYYY-MM-DD>');
  process.exit(1);
}

// 헤더의 만기 표기 -> 연 단위
function tenorToYears(label) {
  const m = /^(\d+(?:\.\d+)?)(M|Y)$/.exec(label);
  if (!m) return null;
  return m[2] === "M" ? Number(m[1]) / 12 : Number(m[1]);
}

// 엑셀의 (대분류/중분류/소분류) -> 화면의 (유형, 등급). 여기에 없는 행은 저장하지 않는다.
function mapRow(major, middle, minor) {
  if (major === "국채" && middle === "국고채") return { sector: "국고", grade: "무등급" };
  if (major === "공사/공단채" && /^(AAA|AA\+|AA0|AA-)$/.test(minor)) return { sector: "공사채", grade: minor };
  if (major === "금융채" && middle === "은행채" && /^(AAA|AA\+|AA0|AA-|A\+|A0|A-)$/.test(minor)) return { sector: "은행채", grade: minor };
  if (major === "금융채" && middle === "기타금융채") return { sector: "여전채", grade: minor };
  if (major === "회사채" && middle === "공모/무보증") return { sector: "회사채", grade: minor };
  return null;
}

// --- 내장 모듈만으로 xlsx(zip) 읽기 ---
function unzip(b) {
  let eocd = b.length - 22;
  while (b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.slice(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = b.readUInt16LE(off + 26);
    const lelen = b.readUInt16LE(off + 28);
    const data = b.slice(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    files[name] = method === 0 ? data : zlib.inflateRawSync(data);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function readSheet1(path) {
  const files = unzip(fs.readFileSync(path));

  const shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const x = files["xl/sharedStrings.xml"].toString("utf8");
    for (const m of x.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    }
  }

  const x = files["xl/worksheets/sheet1.xml"].toString("utf8");
  const rows = new Map();
  for (const row of x.matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const c of row[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const inner = c[3] || "";
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const t = (c[2].match(/t="(\w+)"/) || [])[1];
      let val = v;
      if (t === "s" && v !== undefined) val = shared[Number(v)];
      if (t === "inlineStr") val = decodeXml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
      if (val !== undefined && val !== "") cells[c[1]] = val;
    }
    rows.set(Number(row[1]), cells);
  }
  return rows;
}

const sheet = readSheet1(filePath);
const header = sheet.get(1);
const tenorCols = Object.entries(header)
  .map(([col, label]) => ({ col, years: tenorToYears(label) }))
  .filter((t) => t.years !== null);

const out = [];
let major = "";
let middle = "";
for (const rowNo of Array.from(sheet.keys()).filter((n) => n >= 3).sort((a, b) => a - b)) {
  const cells = sheet.get(rowNo);
  if (cells.A) major = cells.A;
  if (cells.B) middle = cells.B;
  const mapped = mapRow(major, middle, cells.C || "");
  if (!mapped) continue;

  for (const t of tenorCols) {
    const y = Number(cells[t.col]);
    if (cells[t.col] === undefined || Number.isNaN(y)) continue;
    out.push({
      trade_date: tradeDate,
      sector: mapped.sector,
      grade: mapped.grade,
      tenor_years: Math.round(t.years * 1000) / 1000,
      yield_pct: Math.round(y * 1000) / 1000,
    });
  }
}

if (out.length === 0) {
  console.error("저장할 행이 없습니다. 엑셀 형식을 확인하세요.");
  process.exit(1);
}

const res = await fetch(`${SUPABASE_URL}/rest/v1/curve_yields`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Prefer: "resolution=merge-duplicates",
  },
  body: JSON.stringify(out),
});

if (!res.ok) {
  throw new Error(`Supabase 저장 실패: ${res.status} ${await res.text()}`);
}

const bySector = {};
for (const r of out) bySector[r.sector] = (bySector[r.sector] || 0) + 1;
console.log(`저장 완료 (${tradeDate}): ${out.length}건`, bySector);
