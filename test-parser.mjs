#!/usr/bin/env node
/**
 * test-parser.mjs
 *
 * 概要欄パーサーの動作確認。実際の YouTube 概要欄によくある書式パターンを
 * 手書きのサンプルで再現し、期待どおり材料が取れるかを確認する。
 *
 *   node test-parser.mjs
 *
 * ※ ここのサンプルは書式の検証用に作った架空のテキストであり、
 *    実在のチャンネルの概要欄そのものではない。
 */

import {
  parseDescription,
  normalizeIngredientName,
  canonicalIngredientName,
} from './parse-ingredients.mjs';

let pass = 0, fail = 0;

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  NG   ${label}${detail ? ' -> ' + detail : ''}`); }
}

function show(title, result) {
  console.log(`\n=== ${title} ===`);
  console.log(`  信頼度: ${result.confidence} / 人数: ${result.servings ?? '-'} / 材料 ${result.ingredients.length} 点`);
  result.ingredients.forEach((i) => {
    console.log(`    ${i.group ? `[${i.group}] ` : ''}${i.name}  ${i.amount || '(分量なし)'}`);
  });
}

// ---------------------------------------------------------------------------
// パターン1: 【材料】＋全角スペース区切り＋グループ見出し
// ---------------------------------------------------------------------------
const CASE1 = `
今回はご家庭で作れる本格麻婆豆腐です！

【材料】2人前
・木綿豆腐　300g
・豚ひき肉　100g
・長ねぎ　1/2本
・にんにく　2片
・生姜　1片

【合わせ調味料】
・豆板醤　大さじ1
・甜麺醤　小さじ2
・醤油　大さじ1
・鶏ガラスープ　200ml
・水溶き片栗粉　適量

【作り方】
1. 豆腐を2cm角に切り、塩を入れた湯で3分茹でる
2. フライパンに油を熱し、ひき肉を炒める

チャンネル登録よろしくお願いします！
https://www.youtube.com/@example
`;

const r1 = parseDescription(CASE1);
show('パターン1: 【材料】＋グループ見出し', r1);
check('材料が10点取れる', r1.ingredients.length === 10, `実際 ${r1.ingredients.length}`);
check('人数が「2人前」', r1.servings === '2人前', String(r1.servings));
check('木綿豆腐 300g', r1.ingredients[0]?.name === '木綿豆腐' && r1.ingredients[0]?.amount === '300g');
check('グループが付く', r1.ingredients.some((i) => i.group === '合わせ調味料'));
check('作り方が取れる', !!r1.steps);
check('URL行が混ざらない', !r1.ingredients.some((i) => /http/.test(i.name)));
check('信頼度 high', r1.confidence === 'high', r1.confidence);

// ---------------------------------------------------------------------------
// パターン2: 見出しに括弧、区切りが「…」、▼グループ
// ---------------------------------------------------------------------------
const CASE2 = `
■材料 (4人分)
鶏もも肉…2枚(600g)
片栗粉…大さじ4
サラダ油…適量

▼下味
醤油…大さじ2
酒…大さじ1
おろしにんにく…小さじ1
おろし生姜…小さじ1
塩…少々
こしょう…少々

■作り方
鶏肉を一口大に切る
`;

const r2 = parseDescription(CASE2);
show('パターン2: 「…」区切り＋▼グループ', r2);
check('材料が9点取れる', r2.ingredients.length === 9, `実際 ${r2.ingredients.length}`);
check('人数が「4人分」', r2.servings === '4人分', String(r2.servings));
check('鶏もも肉の分量が取れる', /2枚/.test(r2.ingredients[0]?.amount || ''), r2.ingredients[0]?.amount);
check('▼下味がグループになる', r2.ingredients.some((i) => i.group === '下味'));
check('「少々」も分量として認識', r2.ingredients.some((i) => i.amount === '少々'));

// ---------------------------------------------------------------------------
// パターン3: タイムスタンプ・SNS・ハッシュタグが混在
// ---------------------------------------------------------------------------
const CASE3 = `
プロが教える本格もやし炒め！シャキシャキに仕上げるコツを解説します。

材料
・もやし 250g
・豚バラ肉 100g
・にんにく 1片
・ごま油 大さじ1
・鶏ガラスープの素 小さじ1
・塩 ひとつまみ
・こしょう 少々

目次
0:00 オープニング
1:20 下ごしらえ
3:45 炒める
7:10 完成

▼SNS
Twitter https://x.com/example
Instagram https://instagram.com/example

#中華料理 #もやし炒め #レシピ
`;

const r3 = parseDescription(CASE3);
show('パターン3: タイムスタンプ・SNS混在', r3);
check('材料が7点取れる', r3.ingredients.length === 7, `実際 ${r3.ingredients.length}`);
check('タイムスタンプが混ざらない', !r3.ingredients.some((i) => /オープニング|下ごしらえ|完成/.test(i.name)));
check('SNS行が混ざらない', !r3.ingredients.some((i) => /Twitter|Instagram/i.test(i.name)));
check('ハッシュタグが混ざらない', !r3.ingredients.some((i) => /^#/.test(i.name)));
check('もやし 250g', r3.ingredients[0]?.name === 'もやし' && r3.ingredients[0]?.amount === '250g');

// ---------------------------------------------------------------------------
// パターン4: 材料セクションが無い（雑談動画など）
// ---------------------------------------------------------------------------
const CASE4 = `
今日はお店の裏側をお見せします！
いつも応援ありがとうございます。

チャンネル登録はこちら
https://www.youtube.com/@example
`;

const r4 = parseDescription(CASE4);
show('パターン4: 材料セクション無し', r4);
check('材料0点', r4.ingredients.length === 0);
check('信頼度 none', r4.confidence === 'none');

// ---------------------------------------------------------------------------
// パターン5: 括弧付き注釈・お好みで
// ---------------------------------------------------------------------------
const CASE5 = `
【材料】(2人前)
・豚バラ肉(薄切り)　150g
・キャベツ　1/4玉
・ピーマン　2個
・味噌　大さじ1と1/2
・砂糖　小さじ1
・ラー油　お好みで
・白ごま　適量
`;

const r5 = parseDescription(CASE5);
show('パターン5: 括弧注釈・お好みで', r5);
check('材料が7点取れる', r5.ingredients.length === 7, `実際 ${r5.ingredients.length}`);
check('括弧注釈が除去される', r5.ingredients[0]?.name === '豚バラ肉', r5.ingredients[0]?.name);
check('「大さじ1と1/2」が取れる', /大さじ1/.test(r5.ingredients[3]?.amount || ''), r5.ingredients[3]?.amount);
check('分数+単位が正しく分離される', r5.ingredients[1]?.name === 'キャベツ', r5.ingredients[1]?.name);
check('「お好みで」が分量扱い', r5.ingredients[5]?.name === 'ラー油', r5.ingredients[5]?.name);

// ---------------------------------------------------------------------------
// パターン6: 実データで混入していたノイズ（機材・店舗・チャプター・英語併記）
// ---------------------------------------------------------------------------
const CASE6 = `
材料
・豚バラ肉　100g
・キャベツ　1/4玉
★砂糖 小さじ1
★醤油 大さじ1

一般麻婆茄子 0:53
プロ麻婆茄子 2:22

▼せいろ（中華鍋の大きさに合うものを選ぶ）
▼中華鍋30-33cmがおすすめ　山田工業所
▼SONY ILCE-7M3 万能カメラ

お店所在地
山形県酒田市　中華料理龍鳳
父のお店で頑張って働いております

cabbage
Soysauce
`;

const r6 = parseDescription(CASE6);
show('パターン6: 実データのノイズ', r6);
check('機材・アフィリ行が混ざらない',
  !r6.ingredients.some((i) => /せいろ|中華鍋|SONY|カメラ/i.test(i.name)),
  r6.ingredients.map((i) => i.name).join(','));
check('店舗・宣伝行が混ざらない',
  !r6.ingredients.some((i) => /お店|山形|働いて|所在地/.test(i.name)));
check('行末チャプターが混ざらない',
  !r6.ingredients.some((i) => /麻婆茄子/.test(i.name)));
check('英語併記行が混ざらない',
  !r6.ingredients.some((i) => /cabbage|Soysauce/i.test(i.name)));
check('★が名前に残らない',
  !r6.ingredients.some((i) => /★/.test(i.name)),
  r6.ingredients.map((i) => i.name).join(','));
check('★砂糖が「砂糖」として取れる', r6.ingredients.some((i) => i.name === '砂糖'));

// ---------------------------------------------------------------------------
// パターン7: 分量が名前に食い込む書式
// ---------------------------------------------------------------------------
const CASE7 = `
【材料】
トマト　1個　（250g）ほど
バター１５g（無塩）
ひき肉 50g （豚、牛どちらでも可）
海老　15匹
烏龍茶パック　２つ
トマト　半分
豆腐　半丁
玉ねぎ　好きなだけ
中濃ソース　少し
豆板醤　小さじ1,5
ニンニク　1こ
`;

const r7 = parseDescription(CASE7);
show('パターン7: 分量の食い込み', r7);
const names7 = r7.ingredients.map((i) => i.name);
check('名前に数字が残らない',
  !names7.some((n) => /[0-9０-９]/.test(n)), names7.join(','));
check('「トマト」が分量と分離される', names7.includes('トマト'), names7.join(','));
check('「（250g）ほど」の書式に対応',
  r7.ingredients.find((i) => i.name === 'トマト')?.amount === '1個',
  r7.ingredients.find((i) => i.name === 'トマト')?.amount);
check('括弧注釈付きの分量に対応',
  /15g/.test(r7.ingredients.find((i) => /バター/.test(i.name))?.amount || ''),
  r7.ingredients.find((i) => /バター/.test(i.name))?.amount);
check('「半丁」が分量扱い',
  r7.ingredients.some((i) => i.name === '豆腐' && /半丁/.test(i.amount)));
check('「好きなだけ」が分量扱い',
  r7.ingredients.some((i) => i.name === '玉ねぎ' && /好きなだけ/.test(i.amount)));
check('「少し」が分量扱い',
  r7.ingredients.some((i) => i.name === '中濃ソース' && /少し/.test(i.amount)));
check('「1こ」「15匹」「２つ」が分量扱い',
  ['にんにく', 'えび', '烏龍茶パック'].every((n) =>
    r7.ingredients.some((i) => i.name === n && i.amount)),
  names7.join(','));

// ---------------------------------------------------------------------------
// パターン8: 表記ゆれの統合
// ---------------------------------------------------------------------------
const CASE8 = `
材料
ニンニク　1片
おろしにんにく　小さじ1
にんにく微塵　少々
長ネギ　1本
ネギ微塵　大さじ1
こしょう　少々
牡蠣油　大さじ1
鶏がらスープの素　小さじ1
水溶き片栗　適量
`;

const r8 = parseDescription(CASE8);
show('パターン8: 表記ゆれの統合', r8);
const names8 = r8.ingredients.map((i) => i.name);
check('にんにく系が1つの名前に統合される',
  names8.filter((n) => n === 'にんにく').length === 3, names8.join(','));
check('長ネギ → 長ねぎ', names8.includes('長ねぎ'), names8.join(','));
check('ネギ微塵 → 長ねぎ（このチャンネルではねぎ=長ねぎとして統合する運用）',
  names8.filter((n) => n === '長ねぎ').length === 2, names8.join(','));
check('こしょう → 胡椒', names8.includes('胡椒'), names8.join(','));
check('牡蠣油 → オイスターソース', names8.includes('オイスターソース'));
check('鶏がらスープの素 → 鶏ガラスープの素', names8.includes('鶏ガラスープの素'));

// ---------------------------------------------------------------------------
// パターン8b: 追加の表記ゆれ（誤字・異体字）
// ---------------------------------------------------------------------------
const CASE8B = `
材料
にんいく　1片
片栗　大さじ1
豆豉醬　小さじ1
醬油　大さじ1
`;
const r8b = parseDescription(CASE8B);
show('パターン8b: 追加の表記ゆれ', r8b);
const names8b = r8b.ingredients.map((i) => i.name);
check('にんいく（誤字） → にんにく', names8b.includes('にんにく'), names8b.join(','));
check('片栗 → 片栗粉', names8b.includes('片栗粉'), names8b.join(','));
check('豆豉醬（異体字） → 豆豉', names8b.includes('豆豉'), names8b.join(','));
check('醬油（異体字） → 醤油', names8b.includes('醤油'), names8b.join(','));
check('水溶き片栗 → 水溶き片栗粉', names8.includes('水溶き片栗粉'));
check('displayName に元の表記が残る',
  r8.ingredients.some((i) => /おろしにんにく/.test(i.displayName)),
  r8.ingredients.map((i) => i.displayName).join(','));

// ---------------------------------------------------------------------------
// パターン9: 記号なしのグループ見出し
// ---------------------------------------------------------------------------
const CASE9 = `
材料
豚バラ肉　100g

合わせ調味料
醤油　大さじ1
砂糖　小さじ1
`;

const r9 = parseDescription(CASE9);
show('パターン9: 記号なしグループ見出し', r9);
check('「合わせ調味料」が食材にならない',
  !r9.ingredients.some((i) => i.name === '合わせ調味料'),
  r9.ingredients.map((i) => i.name).join(','));
check('「合わせ調味料」がグループになる',
  r9.ingredients.some((i) => i.group === '合わせ調味料'));

// ---------------------------------------------------------------------------
// パターン10: 材料セクションに紛れ込んだ調理の指示文
// ---------------------------------------------------------------------------
const CASE10 = `
材料
卵　3個
塩
卵を炒める油はしっかり鍋に馴染ませる
油を大さじ1入れる
芋が柔らかくなったタイミングで味見をして調節
生地がまとまらないようなら、少しずつ粉を足す
水が詰まりすぎたら足して調節
ごま油　大さじ1
`;

const r10 = parseDescription(CASE10);
show('パターン10: 指示文の混入', r10);
const names10 = r10.ingredients.map((i) => i.name);
check('「卵を炒める油は…馴染ませる」が除外される',
  !names10.some((n) => /馴染|炒める/.test(n)), names10.join(','));
check('「油を大さじ1入れる」が除外される',
  !names10.some((n) => /入れる/.test(n)), names10.join(','));
check('「…味見をして調節」が除外される',
  !names10.some((n) => /味見|調節/.test(n)), names10.join(','));
check('「…ようなら、少しずつ粉を足す」が除外される',
  !names10.some((n) => /ようなら|足す/.test(n)), names10.join(','));
check('分量なしの食材「塩」は残る', names10.includes('塩'), names10.join(','));
check('通常の材料は残る',
  names10.includes('卵') && names10.includes('ごま油'), names10.join(','));
check('材料は3点だけ', r10.ingredients.length === 3, `実際 ${r10.ingredients.length}`);

// ---------------------------------------------------------------------------
// パターン11: 分量の後ろに補足が続く書式 / 除外食材
// ---------------------------------------------------------------------------
const CASE11 = `
材料
油　大さじ２　足すときは少しづつ
水　200cc
辣油　少々
水溶き片栗粉　適量
`;

const r11 = parseDescription(CASE11);
show('パターン11: 分量の後ろに補足 / 除外食材', r11);
const names11 = r11.ingredients.map((i) => i.name);
check('「油 大さじ２ 足すときは…」から油が取れる',
  names11.includes('油'), names11.join(','));
check('分量が「大さじ2」になる',
  r11.ingredients.find((i) => i.name === '油')?.amount === '大さじ2',
  r11.ingredients.find((i) => i.name === '油')?.amount);
check('補足は note に逃がす',
  /少しづつ/.test(r11.ingredients.find((i) => i.name === '油')?.note || ''),
  r11.ingredients.find((i) => i.name === '油')?.note);
check('「水」は除外される', !names11.includes('水'), names11.join(','));
check('「水溶き片栗粉」は除外されない', names11.includes('水溶き片栗粉'));
check('辣油 → ラー油', names11.includes('ラー油'), names11.join(','));

// ---------------------------------------------------------------------------
// パターン12: 連体修飾・選択表現
// ---------------------------------------------------------------------------
const CASE12 = `
材料
茹でる水　1500cc
混ぜる水　1200cc
スープまたは水　200mlくらい
炒める油　大さじ1
にんにく　1片
きくらげ　5g
くるみ　20g
むき海老　100g
`;

const r12 = parseDescription(CASE12);
show('パターン12: 連体修飾・選択表現', r12);
const names12 = r12.ingredients.map((i) => i.name);
check('「茹でる水」が「る水」にならない',
  !names12.some((n) => /^る/.test(n)), names12.join(','));
check('「茹でる水」「混ぜる水」は水として除外される',
  !names12.some((n) => /水$/.test(n)), names12.join(','));
check('「スープまたは水」→ スープ',
  names12.includes('スープ'), names12.join(','));
check('「炒める油」→ 油', names12.includes('油'), names12.join(','));
check('普通の食材が削られない（にんにく・きくらげ・くるみ）',
  ['にんにく', 'きくらげ', 'くるみ'].every((n) => names12.includes(n)),
  names12.join(','));
check('「にんにく微塵」が「微塵」にならない',
  canonicalIngredientName('にんにく微塵') === 'にんにく',
  canonicalIngredientName('にんにく微塵'));
check('「にんにくチップ」が「チップ」にならない',
  canonicalIngredientName('にんにくチップ') === 'にんにくチップ',
  canonicalIngredientName('にんにくチップ'));
check('「しょうが微塵」→ 生姜（送り仮名よけに巻き込まれない）',
  canonicalIngredientName('しょうが微塵') === '生姜',
  canonicalIngredientName('しょうが微塵'));
check('「刻みノリ」→ ノリ',
  canonicalIngredientName('刻みノリ') === 'ノリ',
  canonicalIngredientName('刻みノリ'));
check('「むき海老」→ えび', names12.includes('えび'), names12.join(','));

// ---------------------------------------------------------------------------
// パターン13: 別物を勝手に統合していないか
// ---------------------------------------------------------------------------
const CASE13 = `
材料
中華の素　小さじ1
鶏がらスープ　小さじ1/4
揚げ油　適量
サラダ油　大さじ1
若鶏肉　300g
鶏もも肉　2枚
グラニュー糖　20g
砂糖　小さじ1
紹興酒　大さじ1
酒　大さじ1
`;

const r13 = parseDescription(CASE13);
show('パターン13: 統合すべきでないもの', r13);
const names13 = r13.ingredients.map((i) => i.name);
check('中華の素は鶏ガラスープの素と別扱い',
  names13.includes('中華の素'), names13.join(','));
check('鶏がらスープ → 鶏ガラスープの素（方針どおり統合）',
  names13.includes('鶏ガラスープの素'), names13.join(','));
check('揚げ油はサラダ油と別扱い',
  names13.includes('揚げ油') && names13.includes('サラダ油'), names13.join(','));
check('若鶏肉は鶏もも肉と別扱い',
  names13.includes('若鶏肉') && names13.includes('鶏もも肉'), names13.join(','));
check('グラニュー糖は砂糖と別扱い',
  names13.includes('グラニュー糖') && names13.includes('砂糖'), names13.join(','));
check('紹興酒は酒と別扱い',
  names13.includes('紹興酒') && names13.includes('酒'), names13.join(','));

// ---------------------------------------------------------------------------
// パターン14: 波ダッシュで囲む見出し（このチャンネルの実際の書式）
// ---------------------------------------------------------------------------
const CASE14 = `
たまらなくビールを誘います。お試しあれ！

〜材料〜
・鶏もも肉　300gほど
・長ネギ　半分
・ピーマン　1個

〜手順〜
①鶏もも肉を一口大に切る
②強火で炒める
`;

const r14 = parseDescription(CASE14);
show('パターン14: 〜材料〜 書式', r14);
check('〜材料〜 が見出しとして認識される',
  r14.ingredients.length === 3, `実際 ${r14.ingredients.length}`);
check('鶏もも肉 300g', r14.ingredients[0]?.name === '鶏もも肉', r14.ingredients[0]?.name);
check('「300gほど」の分量が取れる',
  /300g/.test(r14.ingredients[0]?.amount || ''), r14.ingredients[0]?.amount);
check('〜手順〜 でセクションが終わる',
  !r14.ingredients.some((i) => /切る|炒める/.test(i.name)),
  r14.ingredients.map((i) => i.name).join(','));

const CASE14b = parseDescription(`
~材料~
あさり　１パック（200g ~250g）
春雨　50g
`);
show('パターン14b: 半角チルダ書式', CASE14b);
check('~材料~ も認識される', CASE14b.ingredients.length === 2, `実際 ${CASE14b.ingredients.length}`);

const CASE14c = parseDescription(`
〜材料〜（動画で作った材料、半分の場合は半量で）6~8人前
・親鶏　一羽
・ネギ　1本
`);
show('パターン14c: 見出しに注釈と人数', CASE14c);
check('見出しに注釈が付いていても認識される',
  CASE14c.ingredients.length === 2, `実際 ${CASE14c.ingredients.length}`);

// ---------------------------------------------------------------------------
// 正規化のテスト
// ---------------------------------------------------------------------------
console.log('\n=== 食材名の正規化 ===');
const normCases = [
  ['豚バラ肉（薄切り）', '豚バラ肉'],
  ['にんにく ', 'にんにく'],
  ['・長ねぎ', '長ねぎ'],
  ['ラー油（お好みで）', 'ラー油'],
  ['　ごま油　', 'ごま油'],
];
normCases.forEach(([input, expected]) => {
  const got = normalizeIngredientName(input);
  check(`"${input}" -> "${expected}"`, got === expected, `実際 "${got}"`);
});

// ---------------------------------------------------------------------------
console.log(`\n----------------------------------------`);
console.log(`結果: ${pass} 件成功 / ${fail} 件失敗`);
if (fail > 0) {
  console.log('失敗したケースは parse-ingredients.mjs の正規表現を調整してください。');
  process.exit(1);
}
