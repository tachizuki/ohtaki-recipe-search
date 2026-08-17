#!/usr/bin/env node
/**
 * audit-data.mjs
 *
 * 生成済みの recipes.json を実データとして検査し、怪しい食材名を洗い出す。
 *
 * test-parser.mjs が「想定したケースが直っているか」を見るのに対して、
 * こちらは「実データに何が残っているか」を見る。想定漏れはこちらでしか気づけない。
 *
 *   node audit-data.mjs [recipes.json]
 *
 * 終了コードは、要確認の項目が1件でもあれば 1。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'recipes.json');

/**
 * 確認済みのペア。「片方がもう片方を含む」だけでは別物かどうか判断できないため、
 * 一度目で見て「別物のままでよい」と決めたものはここに記録して再表示しない。
 *
 * 新しいペアだけが出るようにしておかないと、毎回同じ10件を読み飛ばすことになり
 * 監査そのものが形骸化する。
 */
const REVIEWED_PAIRS = new Map([
  ['ねぎ|玉ねぎ', '別物'],
  ['ねぎ|小ねぎ', '別物。「ねぎ」は総称'],
  ['ねぎ|長ねぎ', '別物。「ねぎ」は総称'],
  ['生姜|紅生姜', '別物'],
  ['豆腐|絹豆腐', '絹豆腐は豆腐の一種。検索は部分一致で拾えるので分けたまま'],
  ['花椒|花椒粉', '粒と粉で別物'],
  ['ソース|中濃ソース', '別物'],
  ['ソース|オイスターソース', '別物'],
  ['バター|無塩バター', '有塩／無塩は使い分けるので別物'],
  ['スープ|鶏ガラスープの素', '部分文字列がたまたま一致しただけ'],
  ['片栗粉|水溶き片栗粉', 'そのまま使う場合と水で溶く場合で別物'],
  ['酒|紹興酒', '別物'],
  ['胡椒|白胡椒', '使い分けるので別物'],
  ['胡椒|黒胡椒', '使い分けるので別物'],
  ['砂糖|グラニュー糖', '製菓では区別する'],
  ['油|ごま油', '別物'],
  ['油|ラー油', '別物'],
  ['油|サラダ油', '別物'],
  ['油|揚げ油', '別物'],
]);

const RE_HAS_DIGIT = /[0-9０-９]/;
const RE_HAS_SYMBOL = /[★☆▼▽▶▷◆■※*＊@#＃]/;
const RE_SENTENCE = /を|たら|たり|ながら|ように|ときは|場合は|ければ|てから|ておく/;
const RE_VERB_TAIL =
  /(?:せる|させる|られる|れる|える|ける|げる|める|ねる|べる|てる|でる|なる|する|くる|いく|おく|しまう|ます|たい|ない|よう|そう|こと|ため)$/;
const RE_ASCII_ONLY = /^[\x20-\x7E]+$/;

function group(title, items, render = (x) => x) {
  if (!items.length) return 0;
  console.log('');
  console.log(`■ ${title} (${items.length}件)`);
  for (const it of items.slice(0, 40)) console.log(`    ${render(it)}`);
  if (items.length > 40) console.log(`    ... 他 ${items.length - 40} 件`);
  return items.length;
}

const data = JSON.parse(await fs.readFile(file, 'utf8'));
const recipes = Array.isArray(data) ? data : data.recipes ?? [];

// 食材の出現頻度を数え直す（ingredientIndex を信用せず実データから作る）
const freq = new Map();
const sample = new Map(); // name -> raw の例
for (const r of recipes) {
  for (const ing of r.ingredients ?? []) {
    freq.set(ing.name, (freq.get(ing.name) ?? 0) + 1);
    if (!sample.has(ing.name)) sample.set(ing.name, ing.raw ?? ing.displayName ?? '');
  }
}
const names = [...freq.keys()];

console.log(`検査対象: ${file}`);
console.log(`  レシピ ${recipes.length} 件 / ユニーク食材 ${names.length} 種`);

let flagged = 0;

flagged += group('数字が残っている', names.filter((n) => RE_HAS_DIGIT.test(n)),
  (n) => `${n}   ← ${JSON.stringify(sample.get(n))}`);

flagged += group('記号が残っている', names.filter((n) => RE_HAS_SYMBOL.test(n)),
  (n) => `${n}   ← ${JSON.stringify(sample.get(n))}`);

flagged += group('文に見える（調理の指示が混入した可能性）',
  names.filter((n) => RE_SENTENCE.test(n) || (n.length >= 6 && RE_VERB_TAIL.test(n))),
  (n) => `${n}   ← ${JSON.stringify(sample.get(n))}`);

flagged += group('英数字のみ（英語併記の行）', names.filter((n) => RE_ASCII_ONLY.test(n)),
  (n) => `${n}   ← ${JSON.stringify(sample.get(n))}`);

flagged += group('長すぎる（12文字超）', names.filter((n) => n.length > 12),
  (n) => `${n}   ← ${JSON.stringify(sample.get(n))}`);

// 片方がもう片方を含むペア＝表記ゆれの統合漏れ候補。
// 「鶏ガラスープ」と「鶏ガラスープの素」のような取りこぼしはここで出る。
const pairs = [];
const reviewed = [];
const sorted = [...names].sort((a, b) => a.length - b.length);
for (let i = 0; i < sorted.length; i++) {
  for (let j = i + 1; j < sorted.length; j++) {
    if (sorted[i].length >= 2 && sorted[j].includes(sorted[i])) {
      const key = `${sorted[i]}|${sorted[j]}`;
      if (REVIEWED_PAIRS.has(key)) reviewed.push([key, REVIEWED_PAIRS.get(key)]);
      else pairs.push([sorted[i], sorted[j]]);
    }
  }
}
flagged += group('統合漏れの候補（未確認のペアのみ）', pairs,
  ([a, b]) => `${a} (${freq.get(a)}件)  ⊂  ${b} (${freq.get(b)}件)`);

if (reviewed.length) {
  console.log('');
  console.log(`（確認済みとして除外したペア: ${reviewed.length}件）`);
}

// 1回しか出てこない食材はパース失敗の残骸であることが多い
const once = names.filter((n) => freq.get(n) === 1);
group('1件しか出てこない食材（参考・要確認ではない）', once);

console.log('');
console.log('----------------------------------------');
if (flagged > 0) {
  console.log(`要確認: ${flagged} 件`);
  console.log('別物なら SYNONYM_GROUPS の判断ミス、ゴミなら isNoiseLine / RE_NOISE_WORD を調整してください。');
  process.exit(1);
} else {
  console.log('明らかな異常は見つかりませんでした。');
}
