#!/usr/bin/env node
/**
 * build-draft.mjs
 *
 * videos.json の概要欄をパースして、食材データの「下書き」を作る。
 * 買い物リストの合算に使うため、食材名だけでなく分量も拾う。
 *
 *   node build-draft.mjs [videos.json] [--out ingredients.json]
 *
 * これはあくまで下書き。パーサーは概要欄の書式のばらつきに弱く、
 * ゴミが混ざったり取りこぼしたりする。アプリ側で目視して直す前提。
 *
 * 既に ingredients.json がある場合、手で直した内容を壊さないよう
 * 「まだ登録されていない動画」にだけ下書きを足す。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDescription } from './parse-ingredients.mjs';

function parseArgs(argv) {
  const args = { src: 'videos.json', out: 'ingredients.json', force: false, fill: true };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--no-fill') args.fill = false;
    else if (a === '--help' || a === '-h') {
      console.log([
        '使い方:',
        '  node build-draft.mjs [videos.json] [--out ingredients.json]',
        '',
        '既定の動作:',
        '  ・食材が未登録の動画  → 概要欄から下書きを作る',
        '  ・登録済みの動画      → 名前はそのまま、空の分量だけを補う',
        '',
        '  --no-fill  分量の補完をしない（登録済みの動画は完全に触らない）',
        '  --force    登録済みの動画も下書きで上書きする（手で直した内容が消えます）',
      ].join('\n'));
      process.exit(0);
    } else rest.push(a);
  }
  if (rest[0]) args.src = rest[0];
  return args;
}

/**
 * 換算の対象外にする食材（肉・魚介）。
 *
 * 肉や魚は買うときにパッケージにグラム数が書いてあるので、
 * 「300g」を「1枚」に直すと逆に使いにくい。野菜だけを換算対象にする。
 *
 * 手で換算表に足したものは対象外にしない（manual フラグで守る）。
 */
const MEAT_FISH_RE = new RegExp([
  '肉', '鶏', '豚', '牛', 'ひき', '挽', 'ミンチ',
  'バラ', 'もも', 'むね', 'ムネ', 'ささみ', 'ササミ', '手羽', 'ロース', 'ヒレ',
  'レバー', '砂肝', 'ハム', 'ベーコン', 'ソーセージ', '親鶏',
  '魚', '鮭', '鯖', '鯛', '鰤', '鰺', '切り身',
  'えび', 'エビ', '海老', 'いか', 'イカ', 'たこ', 'タコ',
  '貝', 'あさり', 'アサリ', 'しじみ', 'ホタテ', 'かに', 'カニ', '明太子', 'たらこ',
].join('|'));

/**
 * 「玉ねぎ 1個（200g）」のような記載から「1個あたり200g」を割り出す。
 *
 * パーサーは括弧内の注釈を note に退避しているので、そこに重さが書かれていれば
 * 分量（個数）と組み合わせて1単位あたりの重さが求まる。
 * これを買い物リストで「重さ→個数」の換算に使う。
 *
 * @param samples Map: 'name|unit' -> number[]（1単位あたりのgの候補）
 */
/** 全角英数記号を半角へ */
function half(s) {
  return String(s || '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 「1/4こ」「半分」「2個」から { count, unit } を取り出す */
function parseCountText(text) {
  const s = half(text).replace(/\s+/g, '');
  if (!s) return null;

  let count = null;
  let rest = s;

  if (/^半分?/.test(s)) {
    count = 0.5;
    rest = s.replace(/^半分?/, '');
  } else {
    const frac = s.match(/^([0-9]+)\/([0-9]+)/);
    if (frac) {
      count = Number(frac[1]) / Number(frac[2]);
      rest = s.slice(frac[0].length);
    } else {
      const num = s.match(/^([0-9]+(?:\.[0-9]+)?)/);
      if (!num) return null;
      count = Number(num[1]);
      rest = s.slice(num[0].length);
    }
  }
  if (!count || !isFinite(count)) return null;

  rest = rest.replace(/(?:ほど|くらい|ぐらい|程度|分)$/, '');
  if (/^(?:g|kg|ml|cc|l)$/i.test(rest)) return null;   // 重量・体積は個数ではない

  // 「こ」「ヶ」「ケ」は「個」に寄せる。表記ゆれで別項目にしないため
  let unit = rest || '個';
  if (/^(?:こ|ヶ|ケ)$/.test(unit)) unit = '個';

  return { count, unit };
}

/** 「200g」「1.5kg」からグラム数を取り出す */
function parseGrams(text) {
  const m = half(text).match(/([0-9]+(?:\.[0-9]+)?)\s*(kg|g)\b/i);
  if (!m) return null;
  let g = Number(m[1]);
  if (/kg/i.test(m[2])) g *= 1000;
  return isFinite(g) && g > 0 ? g : null;
}

function pushSample(samples, name, unit, per) {
  if (per < 3 || per > 5000) return;             // 明らかに変な値は捨てる
  const key = `${name}|${unit}`;
  if (!samples.has(key)) samples.set(key, []);
  samples.get(key).push(per);
}

function collectUnitWeight(samples, ing) {
  if (!ing.name || !ing.amount || !ing.note) return;
  if (MEAT_FISH_RE.test(ing.name)) return;       // 肉・魚介は換算しない

  // パターンA: 分量が個数、注釈に重さ  「玉ねぎ 1個（200g）」
  const cnt = parseCountText(ing.amount);
  const gramsInNote = parseGrams(ing.note);
  if (cnt && gramsInNote) {
    pushSample(samples, ing.name, cnt.unit, gramsInNote / cnt.count);
    return;
  }

  // パターンB: 分量が重さ、注釈に個数  「玉ねぎ 100g(半分)」「玉ねぎ 50g(1/4こ)」
  const gramsInAmount = parseGrams(ing.amount);
  const cntInNote = parseCountText(ing.note);
  if (gramsInAmount && cntInNote) {
    pushSample(samples, ing.name, cntInNote.unit, gramsInAmount / cntInNote.count);
  }
}

/** 候補の中央値を取る。外れ値に引きずられないように */
function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** 食材名の照合用。カタカナ→ひらがな、記号と空白を除去 */
function keyOf(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s　・･、,．.\-–—ー〜~()（）]/g, '')
    .toLowerCase();
}

/** 文字列配列でも {name, amount} 配列でも受け取れるようにする */
function toEntries(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    if (typeof x === 'string') return { name: x, amount: '' };
    if (x && typeof x === 'object' && x.name) return { name: String(x.name), amount: String(x.amount || '') };
    return null;
  }).filter(Boolean);
}

/**
 * 既存の食材リストに、概要欄から取れた分量を流し込む。
 *
 * 名前は追加も削除もしない。既に入っている分量も上書きしない。
 * 手で直した内容を壊さないことを優先する。
 *
 * @returns {{ filled: number, missed: string[] }}
 */
function fillAmounts(entries, parsedIngredients) {
  const byKey = new Map();
  for (const ing of parsedIngredients) {
    if (!ing.name || !ing.amount) continue;
    const k = keyOf(ing.name);
    if (!byKey.has(k)) byKey.set(k, ing.amount);
  }

  let filled = 0;
  const missed = [];

  for (const e of entries) {
    if (e.amount) continue;               // 既に分量がある
    const k = keyOf(e.name);

    let amount = byKey.get(k);

    // 完全一致しない場合、片方が片方を含む候補が1つだけなら採用する。
    // 複数該当する場合は誤って別物の分量を入れる恐れがあるので諦める。
    if (!amount) {
      const cands = [];
      for (const [pk, pa] of byKey) {
        if (pk.includes(k) || k.includes(pk)) cands.push(pa);
      }
      if (cands.length === 1) amount = cands[0];
    }

    if (amount) { e.amount = amount; filled++; }
    else missed.push(e.name);
  }

  return { filled, missed };
}

const args = parseArgs(process.argv);
const srcPath = path.resolve(args.src);
const outPath = path.resolve(args.out);

const src = JSON.parse(await fs.readFile(srcPath, 'utf8'));
const videos = Array.isArray(src) ? src : (src.videos || []);
if (!videos.length) {
  console.error(`動画が読み込めませんでした: ${srcPath}`);
  process.exit(1);
}

// 既存の ingredients.json があれば読む（手で直した内容を守るため）
let existing = { items: {} };
try {
  existing = JSON.parse(await fs.readFile(outPath, 'utf8'));
  if (!existing.items) existing.items = {};
  console.log(`既存のデータを読み込みました: ${outPath}`);
} catch {
  console.log('既存のデータはありません。新規に作成します。');
}

const items = Object.assign({}, existing.items);
let added = 0;
let empty = 0;
let touched = 0;      // 分量を補った動画数
let filledTotal = 0;  // 補った分量の件数
let missedTotal = 0;  // 補えなかった件数
const missedSamples = [];

// 換算表は全動画の概要欄から集める（登録済みかどうかに関わらず）
const weightSamples = new Map();

for (const v of videos) {
  const existingEntries = toEntries(items[v.videoId]);
  const already = existingEntries.length > 0;

  // --- 登録済み: 名前はそのまま、空の分量だけを補う ---
  if (already && !args.force) {
    const parsedForWeight = parseDescription(v.description || '', v.title || '');
    for (const ing of parsedForWeight.ingredients) collectUnitWeight(weightSamples, ing);

    if (!args.fill) continue;
    const blanks = existingEntries.filter((e) => !e.amount).length;
    if (!blanks) { items[v.videoId] = existingEntries; continue; }

    const parsed = parsedForWeight;
    const res = fillAmounts(existingEntries, parsed.ingredients);
    items[v.videoId] = existingEntries;

    if (res.filled) { touched++; filledTotal += res.filled; }
    missedTotal += res.missed.length;
    for (const name of res.missed) {
      if (missedSamples.length < 20 && missedSamples.indexOf(name) === -1) missedSamples.push(name);
    }
    continue;
  }

  // --- 未登録: 概要欄から下書きを作る ---
  const parsed = parseDescription(v.description || '', v.title || '');
  const list = [];
  const seen = new Set();
  for (const ing of parsed.ingredients) {
    collectUnitWeight(weightSamples, ing);
    if (!ing.name || seen.has(ing.name)) continue;
    seen.add(ing.name);
    list.push({ name: ing.name, amount: ing.amount || '' });
  }

  if (!list.length) { empty++; continue; }
  items[v.videoId] = list;
  added++;
}

// --- 換算表をまとめる（既存の手直しを尊重して、無い項目だけ足す） ---
const unitWeights = {};
let weightAdded = 0;
let weightPruned = 0;

// 過去に自動生成した肉・魚介の項目は取り除く。
// アプリで手で入れたもの（manual: true）は残す。
for (const [key, w] of Object.entries(existing.unitWeights || {})) {
  const name = (w && w.name) || key.split('|')[0];
  if (!(w && w.manual) && MEAT_FISH_RE.test(name)) { weightPruned++; continue; }
  unitWeights[key] = w;
}

for (const [key, list] of weightSamples) {
  if (unitWeights[key] != null) continue;         // 既にある（手で直した可能性）
  const [name, unit] = key.split('|');
  unitWeights[key] = {
    name,
    unit,
    per: Math.round(median(list)),
    samples: list.length,
  };
  weightAdded++;
}

const payload = {
  generatedAt: new Date().toISOString(),
  note: '自動生成の下書きを含みます。アプリ上で確認・修正してください。',
  aliases: existing.aliases,
  pantry: existing.pantry,
  unitWeights,
  items,
};
if (!payload.aliases) delete payload.aliases;
if (!payload.pantry) delete payload.pantry;

await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

const allEntriesRaw = Object.keys(items).map((k) => toEntries(items[k]));
const allEntries = allEntriesRaw;
const registered = allEntries.filter((l) => l.length > 0).length;
const totalIng = allEntries.reduce((n, l) => n + l.length, 0);
const withAmount = allEntries.reduce((n, l) => n + l.filter((e) => e.amount).length, 0);
const complete = allEntries.filter((l) => l.length > 0 && l.every((e) => e.amount)).length;

console.log('');
console.log('完了');
console.log(`  動画総数                  : ${videos.length}`);
console.log(`  下書きを作成した動画      : ${added}`);
console.log(`  分量を補った動画          : ${touched}（${filledTotal} 件の分量）`);
console.log(`  材料が取れなかった動画    : ${empty}`);
console.log(`  登録済み合計              : ${registered} / ${videos.length}`);
console.log(`  分量が入っている食材      : ${withAmount} / ${totalIng}`);
console.log(`  分量が全部揃っている動画  : ${complete} / ${registered}`);
console.log(`  出力先                    : ${outPath}`);

const weightKeys = Object.keys(unitWeights);
if (weightKeys.length) {
  console.log('');
  console.log(`重さ→個数の換算表: ${weightKeys.length} 件（今回 ${weightAdded} 件追加` +
              (weightPruned ? ` / ${weightPruned} 件除去` : '') + '）');
  console.log('  概要欄の「1個（200g）」のような記載から割り出したものです。');
  console.log('  肉・魚介は対象外です（買うときにグラム数が分かるため）。');
  weightKeys.slice(0, 15).forEach((k) => {
    const w = unitWeights[k];
    console.log(`    ${w.name} 1${w.unit} = ${w.per}g　（${w.samples}件の記載から）`);
  });
  if (weightKeys.length > 15) console.log(`    ... 他 ${weightKeys.length - 15} 件`);
}

// --- 診断: グラム表記なのに換算表が無い食材 ---
// 「他にもありそう」を推測で潰さないための一覧。
const convNames = new Set(Object.keys(unitWeights).map((k) => (unitWeights[k] && unitWeights[k].name) || k.split('|')[0]));
const gramOnly = new Map();
for (const list of allEntriesRaw) {
  for (const e of list) {
    if (!e.amount || !parseGrams(e.amount)) continue;
    if (MEAT_FISH_RE.test(e.name)) continue;
    if (convNames.has(e.name)) continue;
    gramOnly.set(e.name, (gramOnly.get(e.name) || 0) + 1);
  }
}
if (gramOnly.size) {
  const sorted = [...gramOnly.entries()].sort((a, b) => b[1] - a[1]);
  console.log('');
  console.log(`グラム表記だが換算表に無い食材: ${sorted.length} 種`);
  console.log('  買い物リストではグラムのまま表示されます。');
  console.log('  個数で買いたいものがあれば、アプリの「重さの換算表」に手で足してください。');
  sorted.slice(0, 20).forEach(([name, n]) => console.log(`    ${name}（${n}件）`));
  if (sorted.length > 20) console.log(`    ... 他 ${sorted.length - 20} 種`);
}

if (missedTotal) {
  console.log('');
  console.log(`分量を補えなかった食材: ${missedTotal} 件`);
  console.log('  概要欄に分量が書かれていない、または名前が一致しなかったものです。');
  console.log('  アプリ上で手で入れてください。例:');
  for (const name of missedSamples) console.log(`    ${name}`);
}

console.log('');
console.log('アプリを開いて、内容を確認・修正してください。');
console.log('修正後はアプリの「食材データを書き出す」で ingredients.json を更新します。');
