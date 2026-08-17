#!/usr/bin/env node
/**
 * test-amount.mjs
 *
 * 分量の解析と合算の確認。
 *
 *   node test-amount.mjs
 */

import { parseNumber, formatNumber, parseAmount, sumAmounts, sumAmountsDetail } from './amount.mjs';

let pass = 0, fail = 0;

function check(label, got, expected) {
  const ok = got === expected;
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  NG   ${label}  期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(got)}`); }
}

console.log('\n=== 数値の解析 ===');
check('1/2', parseNumber('1/2'), 0.5);
check('１／２（全角）', parseNumber('１／２'), 0.5);
check('1と1/2', parseNumber('1と1/2'), 1.5);
check('2', parseNumber('2'), 2);
check('1.5', parseNumber('1.5'), 1.5);
check('1,5（小数点の誤記）', parseNumber('1,5'), 1.5);
check('½', parseNumber('½'), 0.5);
check('1〜2 は少ない方', parseNumber('1〜2'), 1);
check('数値なし', parseNumber('てきとう'), null);

console.log('\n=== 表示用の整形 ===');
check('1 → 1', formatNumber(1), '1');
check('0.5 → 1/2', formatNumber(0.5), '1/2');
check('1.5 → 1と1/2', formatNumber(1.5), '1と1/2');
check('2 → 2', formatNumber(2), '2');
check('0.25 → 1/4', formatNumber(0.25), '1/4');

console.log('\n=== 分量の分類 ===');
check('1/2個 は個数', parseAmount('1/2個').kind, 'count');
check('1/2個 の単位', parseAmount('1/2個').unit, '個');
check('150g は重量', parseAmount('150g').kind, 'weight');
check('150g の値', parseAmount('150g').value, 150);
check('大さじ1 は体積', parseAmount('大さじ1').kind, 'volume');
check('大さじ1 は15ml', parseAmount('大さじ1').value, 15);
check('小さじ2 は10ml', parseAmount('小さじ2').value, 10);
check('200ml は体積', parseAmount('200ml').value, 200);
check('1kg は1000g', parseAmount('1kg').value, 1000);
check('適量 は数量でない', parseAmount('適量').kind, 'vague');
check('少々 は数量でない', parseAmount('少々').kind, 'vague');
check('単位なしの2 は単位なし', parseAmount('2').unit, '');

console.log('\n=== 「半分」と漢数字 ===');
check('半分 は0.5', parseAmount('半分').value, 0.5);
check('半分 は単位なし', parseAmount('半分').unit, '');
check('半玉 は0.5玉', parseAmount('半玉').value, 0.5);
check('半玉 の単位', parseAmount('半玉').unit, '玉');
check('半丁 の単位', parseAmount('半丁').unit, '丁');
check('一羽 は1羽', parseAmount('一羽').value, 1);
check('一羽 の単位', parseAmount('一羽').unit, '羽');
check('二本 は2本', parseAmount('二本').value, 2);
check('三枚 は3枚', parseAmount('三枚').value, 3);

console.log('\n=== 単位なしの数量を他の単位に寄せる ===');
check('1/2個 + 半分 = 1個',
  sumAmounts(['1/2個', '半分']), '1個');
check('1/2本 + 半分 = 1本（本に寄せる）',
  sumAmounts(['1/2本', '半分']), '1本');
check('半分 だけなら個とみなす',
  sumAmounts(['半分']), '1/2個');
check('半分 + 半分 = 1個',
  sumAmounts(['半分', '半分']), '1個');
check('単位が2種類あると寄せずに分ける',
  sumAmounts(['1本', '1枚', '半分']), '1本 ＋ 1枚 ＋ 1/2個');
check('トマト 半分 + 1個 = 1と1/2個',
  sumAmounts(['半分', '1個']), '1と1/2個');
check('親鶏 一羽 + 一羽 = 2羽',
  sumAmounts(['一羽', '一羽']), '2羽');

console.log('\n=== 合算（提案された例） ===');
check('玉ねぎ 1/2個 + 1/2個 = 1個',
  sumAmounts(['1/2個', '1/2個']), '1個');
check('1/2個 + 1/4個 = 3/4個',
  sumAmounts(['1/2個', '1/4個']), '3/4個');
check('1個 + 1/2個 = 1と1/2個',
  sumAmounts(['1個', '1/2個']), '1と1/2個');

console.log('\n=== 合算（重量・体積） ===');
check('150g + 100g = 250g', sumAmounts(['150g', '100g']), '250g');
check('600g + 600g = 1.2kg', sumAmounts(['600g', '600g']), '1.2kg');
check('大さじ1 + 大さじ1 = 大さじ2', sumAmounts(['大さじ1', '大さじ1']), '大さじ2');
check('大さじ1 + 小さじ1 = 小さじ4', sumAmounts(['大さじ1', '小さじ1']), '小さじ4');
check('200ml + 200ml = 2カップ', sumAmounts(['200ml', '200ml']), '2カップ');

console.log('\n=== 合算（足せないもの） ===');
check('1/2個 + 100g は併記',
  sumAmounts(['1/2個', '100g']), '1/2個 ＋ 100g');
check('1本 + 1個 は単位ごとに分ける',
  sumAmounts(['1本', '1個']), '1本 ＋ 1個');
check('適量だけなら適量', sumAmounts(['適量']), '適量');
check('適量 + 適量 は適量のまま', sumAmounts(['適量', '適量']), '適量');
check('100g + 適量 は数量を優先', sumAmounts(['100g', '適量']), '100g');
check('空はから文字列', sumAmounts([]), '');
check('分量なしの混在', sumAmounts(['', '1個']), '1個');

console.log('\n=== 重さ→個数の換算（玉ねぎ 1個 = 200g） ===');
var ONION = { unit: '個', per: 200 };
check('200g → 1個', sumAmounts(['200g'], ONION), '1個');
check('300g → 1と1/2個', sumAmounts(['300g'], ONION), '1と1/2個');
check('1個 + 200g → 2個', sumAmounts(['1個', '200g'], ONION), '2個');
check('1/2個 + 100g → 1個', sumAmounts(['1/2個', '100g'], ONION), '1個');
check('換算表がなければ併記のまま',
  sumAmounts(['1/2個', '100g']), '1/2個 ＋ 100g');
check('換算表があっても重量が無ければ影響なし',
  sumAmounts(['1/2個'], ONION), '1/2個');
check('半分 + 100g → 1個（単位なしも寄せる）',
  sumAmounts(['半分', '100g'], ONION), '1個');
check('換算したことが分かる',
  sumAmountsDetail(['200g'], ONION).converted, true);
check('換算していなければ false',
  sumAmountsDetail(['1個'], ONION).converted, false);
check('体積は換算の対象外',
  sumAmounts(['大さじ1', '200g'], ONION), '1個 ＋ 大さじ1');

console.log('\n----------------------------------------');
console.log(`結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) process.exit(1);
