/**
 * parse-ingredients.mjs
 *
 * YouTube の日本語概要欄から【材料】セクションを抽出し、
 * 食材名・分量に分解するパーサー。
 *
 * 概要欄の書式は動画ごとにバラつくため、複数のヒューリスティックを
 * 順に適用する。取りこぼしがあった場合は README の「パースがうまくいかない時」
 * を参照して正規表現を調整すること。
 */

// ---------------------------------------------------------------------------
// 正規化ユーティリティ
// ---------------------------------------------------------------------------

/** 全角英数字・記号を半角へ、カタカナはそのまま */
export function toHalfWidth(s) {
  return s
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[！-／：-＠［-｀｛-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 行頭の箇条書き記号・番号・装飾を取り除く */
function stripBullet(line) {
  return line.replace(
    /^\s*(?:[・･•●○◎■□◆◇▪▫▶▷►‣※*＊★☆♦♢☆✳✴✦✧＄\-–—ー~〜=＝+＋>＞]+|\(?\d{1,2}[.)、]|[①-⑳]|[❶-❿])\s*/,
    ''
  ).trim();
}

/** 日本語（ひらがな・カタカナ・漢字）を含むか */
function hasJapanese(s) {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(s);
}

/** 検索用に食材名を正規化する（表記ゆれ吸収） */
export function normalizeIngredientName(name) {
  let s = toHalfWidth(name).trim();

  // 異体字（旧字体）を新字体へ。「醬油」「豆豉醬」のような表記を吸収する
  s = s.replace(/醬/g, '醤');

  // 括弧内の注釈を除去: 豚バラ肉(薄切り) → 豚バラ肉
  s = s.replace(/[（(][^）)]*[）)]/g, '');
  s = s.replace(/[「『【〈《\[][^」』】〉》\]]*[」』】〉》\]]/g, '');

  // 先頭・末尾の装飾記号（★合わせ調味料マーク、▼リンク見出しなど）
  s = s.replace(/^[\s・･•●○◎■□◆◇▪▫▶▷►‣※*＊★☆♦♢✳✴✦✧＄=＝+＋>＞\-–—~〜]+/g, '');
  s = s.replace(/[\s・･•●○◎■□◆◇▪▫▶▷►‣※*＊★☆♦♢✳✴✦✧＄=＝+＋>＞]+$/g, '');

  // 末尾の装飾・補足
  s = s.replace(/(?:はお?好みで|お好みで|好みで|など|等|orお?好みのもの)$/i, '');
  s = s.replace(/^(?:お好みで|好みの|お好きな)\s*/i, '');

  // 記号・空白の掃除
  s = s.replace(/[…・:：\-–—~〜、,/／]+$/g, '');
  s = s.replace(/^[…・:：\-–—~〜、,/／]+/g, '');
  s = s.replace(/\s+/g, '');

  return s.trim();
}

// ---------------------------------------------------------------------------
// 表記ゆれの統合
// ---------------------------------------------------------------------------

/**
 * 連体修飾（動詞＋名詞）から中心の名詞だけを取り出す。
 * 「茹でる水」→「水」 「混ぜる水」→「水」 「炒める油」→「油」
 *
 * 誤爆を防ぐため、次の2つを両方満たす場合だけ適用する。
 *
 *  1. 動詞の語尾（る・う・く・す・つ・ぶ・む・ぐ・ぬ）の直後が漢字かカタカナ
 *  2. その語尾より前に漢字が1文字以上ある（＝動詞の語幹らしさ）
 *
 * 2 が無いと「にんにく微塵」を「にんに|く|微塵」と切って「微塵」にしてしまう。
 * 1 が無いと「きくらげ」「くるみ」のような普通の食材名まで削ってしまう。
 */
const RE_ATTRIBUTIVE =
  /^[ぁ-んァ-ヶ]*[一-鿿][ぁ-ん一-鿿ァ-ヶ]*?[るうくすつぶむぐぬ]([一-鿿ァ-ヶ][ぁ-ん一-鿿ァ-ヶ]{0,5})$/;

/** 「スープまたは水」のような選択表現。先に挙がっている方を採用する */
const RE_ALTERNATIVE = /(?:、|,)?(?:または|もしくは|or)[\s\S]*$/i;

/** 「おろしにんにく」「にんにく微塵」→「にんにく」のように調理法の修飾を剥がす */
const RE_PREP_PREFIX =
  /^(?:おろし|すりおろし|刻み|きざみ|みじん切りの?|千切りの?|薄切りの?|細切りの?|むき|茹で|ゆで|乾燥)/;
const RE_PREP_SUFFIX =
  /(?:微塵切り|みじん切り|微塵|みじん|千切り|薄切り|細切り|角切り|乱切り|ぶつ切り|すりおろし|おろし|の青み|の白い部分|スライス)$/;

/**
 * 表記ゆれ辞書: 正規名 → その表記の一覧
 *
 * ここに入れてよいのは「同じ物を別の書き方をしているだけ」のものに限る。
 * 似ているが別物のものを混ぜると、検索結果が静かに間違う。
 *
 * 意図的に統合していないもの（別物なので分けたまま）:
 *   中華の素 / 鶏ガラスープの素   … 中華の素は醤油・香辛料を含む別の調味料
 *   揚げ油・炒め油 / サラダ油     … 用途名であって油の種類ではない
 *   若鶏肉 / 鶏もも肉             … 若鶏肉は部位が不明
 *   グラニュー糖 / 砂糖           … 製菓では区別する
 *   コリアンダー / 香菜           … コリアンダーは種（スパイス）を指すことがある
 *   ねぎ / 長ねぎ                 … 「ねぎ」は総称。小ねぎを指すこともある
 *   紹興酒 / 酒                   … 別物
 *   白胡椒 / 黒胡椒 / 胡椒         … 使い分けるので分ける
 *
 * 「ねぎ」はこのチャンネルでは長ねぎを指す運用のため、あえて「長ねぎ」に統合している
 * （一般的には総称なので他チャンネルに流用する場合は見直すこと）。
 */
const SYNONYM_GROUPS = {
  // --- 同一物の書き方違い ---
  にんにく: ['ニンニク', '大蒜', 'ガーリック', 'にんいく', 'にんにく'],
  生姜: ['しょうが', 'ショウガ', '生姜'],
  長ねぎ: ['長ネギ', '白ねぎ', '白ネギ', '長葱', 'ネギ', '葱', 'ねぎ', '長ねぎ'],
  小ねぎ: ['小ネギ', '万能ねぎ', '万能ネギ', '青ねぎ', '青ネギ', '小葱', '小ねぎ'],
  玉ねぎ: ['玉ネギ', 'たまねぎ', 'タマネギ', '玉葱', '玉ねぎ'],
  醤油: ['しょうゆ', 'ショウユ', 'お醤油', '正油', '醤油'],
  胡椒: ['こしょう', 'コショウ', 'コショー', '胡椒'],
  白胡椒: ['白こしょう', '白コショウ', '白胡椒'],
  黒胡椒: ['黒こしょう', '黒コショウ', '黒胡椒'],
  卵: ['たまご', 'タマゴ', '玉子', '鶏卵', '卵'],
  砂糖: ['お砂糖', '上白糖', '砂糖'],
  酒: ['料理酒', '日本酒', '清酒', '酒'],
  紹興酒: ['老酒', '紹興酒'],

  // オイスターソース＝牡蠣油。同一物の訳語違い
  オイスターソース: ['牡蠣油', 'かき油', 'オイスター', 'オイスターソース'],
  // 味の素は商品名、うま味調味料は一般名
  味の素: ['うま味調味料', 'うまみ調味料', 'グルタミン酸ソーダ', '味の素'],

  // 液体スープと顆粒の素は本来別物だが、統合する方針を選択（README 参照）
  鶏ガラスープの素: [
    '鶏がらスープの素', '鶏ガラの素', '鶏がらの素', '鶏ガラスープ素',
    'ガラスープの素', '鶏ガラスープ', '鶏がらスープ', '鶏スープ',
    '鶏ガラスープの素',
  ],

  水溶き片栗粉: ['水溶き片栗', '水とき片栗粉', '水溶片栗粉', '水溶き片栗粉'],
  片栗粉: ['馬鈴薯澱粉', '馬鈴薯でん粉', '片栗', '片栗粉'],
  豆板醤: ['トウバンジャン', '豆板醤'],
  甜麺醤: ['テンメンジャン', '甜麺醤'],
  豆豉: ['豆豉醤', '豆豉'],
  ごま油: ['胡麻油', 'ゴマ油', 'ごま油'],
  ラー油: ['辣油', 'ラー油'],
  サラダ油: ['サラダオイル', 'サラダ油'],
  豚ひき肉: ['豚挽き肉', '豚ミンチ', '豚ひき肉'],
  鶏もも肉: ['鶏もも', '鶏モモ肉', '鶏モモ', 'とりもも肉', '鶏もも肉'],
  豚バラ肉: ['豚バラ', '豚ばら肉', '豚ばら', '豚バラ肉'],
  八角: ['スターアニス', 'スターアニース', '八角'],
  花椒: ['ホアジャオ', '花椒'],
  にんじん: ['ニンジン', '人参', 'にんじん'],
  じゃがいも: ['ジャガイモ', '馬鈴薯', 'じゃが芋', 'じゃがいも'],
  きくらげ: ['キクラゲ', '木耳', 'きくらげ'],
  香菜: ['パクチー', '香菜'],
  えび: ['海老', 'エビ', 'えび'],
};

/** 表記 → 正規名 の逆引きマップ */
const SYNONYM_MAP = new Map();
for (const [canonical, variants] of Object.entries(SYNONYM_GROUPS)) {
  for (const v of variants) SYNONYM_MAP.set(v, canonical);
  SYNONYM_MAP.set(canonical, canonical);
}

/**
 * 食材名を検索用の正規名に寄せる。
 * 調理法の修飾を剥がしたうえで、表記ゆれ辞書に当てる。
 */
export function canonicalIngredientName(name) {
  let s = normalizeIngredientName(name);
  if (!s) return s;

  if (SYNONYM_MAP.has(s)) return SYNONYM_MAP.get(s);

  // 「スープまたは水」→「スープ」
  const alt = s.replace(RE_ALTERNATIVE, '').trim();
  if (alt && alt !== s && alt.length >= 2) {
    s = alt;
    if (SYNONYM_MAP.has(s)) return SYNONYM_MAP.get(s);
  }

  // 「茹でる水」→「水」（連体修飾を落として中心の名詞にする）
  const am = s.match(RE_ATTRIBUTIVE);
  if (am && am[1] && am[1] !== s) {
    s = am[1];
    if (SYNONYM_MAP.has(s)) return SYNONYM_MAP.get(s);
  }

  // 「おろしにんにく」「にんにく微塵」など修飾を剥がして再挑戦。
  //
  // 剥がした結果が送り仮名だけ残る（「茹でる水」→「る水」）のを防ぐ。
  // ただし条件は「送り仮名で始まる かつ 2文字以下」に限る。
  // 単に送り仮名で始まるだけで弾くと「しょうが微塵」→「しょうが」まで
  // 巻き添えで弾いてしまうため。
  let stripped = s.replace(RE_PREP_PREFIX, '').replace(RE_PREP_SUFFIX, '').trim();
  const looksLikeLeftover = stripped.length <= 2 && /^[るたてでりしきいえっ]/.test(stripped);
  if (stripped && stripped !== s && !looksLikeLeftover) {
    if (SYNONYM_MAP.has(stripped)) return SYNONYM_MAP.get(stripped);
    return stripped;
  }

  return s;
}

// ---------------------------------------------------------------------------
// セクション検出
// ---------------------------------------------------------------------------

/**
 * 「材料」セクションの開始行かどうか。
 *
 * 「〜材料〜」「~材料~」という書式を使うチャンネルがあるため、
 * 行頭・行末に許す記号へ波ダッシュ（〜 ～ ~）を必ず含めること。
 * ここが抜けていると、その書式の動画を丸ごと取りこぼす。
 */
const RE_MATERIAL_HEADER =
  /^[\s・･•●○◎■□◆◇▪▶※*＊★☆~〜～\-–—=＝【〈《＜<「『\[]*\s*(?:材\s*料|ざいりょう|材料表|使用食材|用意するもの|Ingredients?)\s*(?:[】〉》＞>」』\]~〜～]|[:：]|$|[（(\s])/i;

/** 材料セクションを終了させる行 */
const RE_SECTION_END = new RegExp(
  [
    // 「〜手順〜」のように波ダッシュで囲む書式があるので ~〜～ を含める
    '^[\\s・･•●○◎■□◆◇▪▶※*＊★☆~〜～\\-–—=＝【〈《＜<「『\\[]*\\s*(?:',
    [
      '作\\s*り\\s*方', 'つくりかた', '手\\s*順', '調理手順', '工程', '下ごしらえ手順',
      '目\\s*次', 'チャプター', 'ポイント', 'コツ', '解\\s*説',
      'レシピ動画', '関連動画', 'おすすめ動画', '前回の動画', '再生リスト',
      // 器具・アフィリエイト・物販
      '使用(?:した)?(?:道具|器具|調理器具|商品|アイテム)',
      '今回使(?:った|用した)', 'おすすめ(?:の)?(?:中華)?(?:アイテム|商品|道具|器具)',
      '愛用(?:品|の)?', '撮影(?:機材|環境)', '使用機材', '購入(?:先|はこちら)',
      '商品リンク', 'リンクはこちら', 'Amazon', '楽\\s*天',
      // 店舗・連絡先
      'お\\s*店', '店\\s*舗', '所在地', '住\\s*所', '営業時間', '定休日',
      'お問\\s*い?\\s*合\\s*わ?せ', 'お仕事', 'ご連絡', '企業様', 'ご依頼',
      '引用元', '出\\s*演', 'コラボ', '提\\s*供',
      // SNS・チャンネル
      'SNS', 'Twitter', 'X\\s*\\(旧', 'Instagram', 'インスタ', 'TikTok', 'Threads',
      'メンバーシップ', 'チャンネル登録', 'サブチャンネル',
      '書\\s*籍', '著\\s*書', '通\\s*販', 'オンラインショップ', 'BGM', '音\\s*源',
      '使用楽曲', '楽\\s*曲', 'Music', '免責', '注意事項', 'プロフィール', '自己紹介',
      'Recipe', 'Instructions?', 'Directions?', 'Steps?', 'How to',
    ].join('|'),
    ')',
  ].join(''),
  'i'
);

/** グループ見出し（【タレ】【合わせ調味料】など、閉じ括弧あり）*/
const RE_GROUP_HEADER =
  /^[\s・･•●○◎■□◆◇▪▶※*＊\-–—=＝]*\s*[【〈《＜<「『\[]\s*([^】〉》＞>」』\]\n]{1,20}?)\s*[】〉》＞>」』\]]\s*(?:[:：])?\s*$/;

/**
 * グループ見出し（閉じ括弧なし）
 * ・▼ ▽ ▶ ▷ は箇条書きに使われることがまず無いので見出しとみなす
 * ・それ以外の記号は行末が「：」の場合のみ見出し扱い（例: ◆合わせ調味料：）
 */
const RE_GROUP_HEADER_LOOSE =
  /^\s*(?:[▼▽▶▷]+\s*([^\s:：][^\n:：]{0,14}?)\s*[:：]?|[◆◇■□●○※=＝\-]+\s*([^\s:：][^\n:：]{0,14}?)\s*[:：])\s*$/;

/**
 * 記号なしで単独行に置かれるグループ見出し語。
 * 「スープ」「ソース」は中華では食材そのものとしても出てくるため、あえて含めない。
 */
const RE_GROUP_WORD =
  /^(?:合わせ調味料|調味料|合わせ調味|タレ|たれ|つけダレ|付けダレ|あん|餡|下味|下ごしらえ|衣|具材|香味油|付け合わせ|トッピング|仕上げ|材料|Ingredients?|Combinedseasoning)$/i;

/** タイムスタンプ行 (0:00 オープニング) */
const RE_TIMESTAMP = /^\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?\s*[〜~\-–—]?\s*/;

/** 行のどこかにタイムスタンプ・比率がある（「プロ麻婆茄子 2:22」「砂糖、醤油 1:1.5」） */
const RE_TIMESTAMP_ANY = /[0-9０-９]\s*[:：]\s*[0-9０-９]/;

/** URL 行 */
const RE_URL = /https?:\/\/|www\.|\.com\b|\.jp\b|\.to\b|\.co\b|amzn|楽天|rakuten|@[A-Za-z0-9_]{3,}/i;

/** 住所らしい行 */
const RE_ADDRESS = /[都道府県]\s*\S*[市区町村]|〒\s*\d/;

/** 材料行ではありえない語（機材・店舗・宣伝・文章） */
const RE_NOISE_WORD = new RegExp(
  [
    // 文末表現（説明文）
    'ください', '下さい', 'します', 'ました', 'ですね?', 'でしょう', '思います',
    'おります', 'ございます', 'いたします', 'ありがとう', 'お願い', 'できます',
    'なります', 'いきます', 'ごめん', 'すみません', 'よろしく',
    // 調理の指示文
    '調\\s*節', '調\\s*整', '味\\s*見', 'タイミング', 'ようなら', '足して',
    '同じくらい', '好きなだけ食べ', 'お好みの量で調',
    // 店舗・宣伝・人物
    'お店', '店舗', '所在地', '営業時間', '定休日', '予約', '電話',
    'インスタ', 'ツイッター', 'チャンネル', '登録', 'メンバー', '問合', '問い合わせ',
    '引用元', 'コラボ', 'さん$', '様$',
    // 機材・器具・物販
    'おすすめ', 'アイテム', '機\\s*材', 'カメラ', 'マイク', 'レンズ', '三脚',
    'せいろ', 'せいろプレート', '中華鍋', 'おたま', '包丁', 'まな板', 'フライパン',
    '和平フレイズ', '山田工業所', 'SONY', 'Amazon', '購入', '商品',
  ].join('|'),
  'i'
);

/**
 * 文（調理の指示・説明）を検出する。
 *
 * 材料行は本来「名詞句＋分量」なので、格助詞や活用語尾が出てきたら文とみなす。
 * 例: 「卵を炒める油はしっかり鍋に馴染ませる」「芋が柔らかくなったら味を見る」
 *
 * ・「を」は食材名にまず現れないので単独で判定材料にできる
 * ・「は」「が」は「はちみつ」「鶏がらスープ」などに含まれるため単独では使わない
 */
const RE_SENTENCE_PARTICLE =
  /を|たら|たり|ながら|ように|ときは|場合は|ければ|てから|ておく|ておき|ていく|てくる/;

/** 活用語尾で終わる（動詞・形容詞で終わる行は文） */
const RE_VERB_TAIL =
  /(?:せる|させる|られる|れる|える|ける|げる|める|ねる|べる|てる|でる|なる|する|くる|いく|おく|しまう|ちゃう|ます|ません|たい|ない|よう|そう|こと|ため)$/;

/** 人数・分量の表記 */
const RE_SERVINGS = /([0-9０-９]+\s*(?:〜|~|-|ー)?\s*[0-9０-９]*)\s*(人前|人分|皿分|個分|本分)/;

// ---------------------------------------------------------------------------
// 分量検出
// ---------------------------------------------------------------------------

const UNIT_WORDS = [
  'g', 'kg', 'mg', 'ml', 'cc', 'l', 'L', 'リットル', 'グラム', 'キロ',
  'cm', '㎝', 'センチ', 'mm',
  '個', '本', '枚', '片', '束', '袋', '缶', '尾', '丁', '株', '玉', '房',
  '匹', '節', '枝', '粒', '房', 'こ', 'ヶ', 'ケ', 'つ', '杯', '膳',
  '合', '切れ', 'かけ', 'つまみ', 'かたまり', 'パック', 'カップ',
  '人前', '人分', '皿', '匙', 'さじ', '振り', 'ふり', 'まわし', '摘み', '握り',
];

const RE_AMOUNT = new RegExp(
  [
    '(?:',
    [
      // 大さじ1と1/2 / 小さじ1/2 / 大さじ1（「1,5」のような誤記も許容）
      '(?:大さじ|小さじ|おおさじ|こさじ|カップ)\\s*[0-9０-９½¼¾/／.,．，\\s と]*[0-9０-９½¼¾]',
      '(?:大さじ|小さじ|おおさじ|こさじ|カップ)\\s*[0-9０-９]*',
      // 「半分」「半丁」「半玉」
      `半\\s*(?:分|身|${UNIT_WORDS.join('|')})`,
      // 分数（1/2本, 1/4玉 など）— 数値+単位より先に試す必要がある
      `[0-9０-９]+\\s*[/／]\\s*[0-9０-９]+\\s*(?:${UNIT_WORDS.join('|')})?`,
      // 数値+単位（小数点にカンマ誤用も許容）
      `[0-9０-９]+(?:[.．,，][0-9０-９]+)?\\s*(?:[〜~\\-–—ー]\\s*[0-9０-９]+(?:[.．,，][0-9０-９]+)?)?\\s*(?:${UNIT_WORDS.join('|')})`,
      // 定型表現
      '適\\s*量', '適\\s*宜', '少\\s*々', '少\\s*量', '少\\s*し', 'ひとつまみ', '一つまみ', '一摘み',
      'ふたつまみ', 'お好みで?', '好みで?', '好きなだけ', 'たっぷり', '同\\s*量', '各適量',
      '大量', 'ひと(?:かけ|片|握り|回し|振り)', '一(?:かけ|片|握り|回し|振り)',
    ].join('|'),
    ')',
  ].join(''),
  'i'
);

/** 分量の後ろに付きうる曖昧表現（「1個ほど」「100gくらい」） */
const RE_AMOUNT_TAIL = '(?:\\s*(?:ほど|くらい|ぐらい|程度|位|前後|弱|強|ずつ|づつ|分))*';

/** 行末が分量で終わっている（「豚バラ肉　100g」） */
const RE_AMOUNT_AT_END = new RegExp(`(${RE_AMOUNT.source})${RE_AMOUNT_TAIL}\\s*$`, 'i');

/** その断片が丸ごと分量である（「大さじ2」= true / 「足すときは少しづつ」= false） */
const RE_AMOUNT_FULL = new RegExp(`^(?:${RE_AMOUNT.source})${RE_AMOUNT_TAIL}$`, 'i');

/**
 * 検索対象にしない食材。
 * ほぼ全レシピに出てきて絞り込みの役に立たないものをここに入れる。
 */
const EXCLUDED_NAMES = new Set(['水', 'お湯', '湯', '熱湯', '氷水', '水適量']);

/** 「食材名 分量」を分割する区切り文字 */
const RE_SEPARATOR = /\s*(?:[…‥]{1,3}|\.{2,}|[:：]|[〜～]{2,}|[ 　]{1,}|[=＝]|[▶►→]|[、,](?=\s*[0-9０-９大小適少]))\s*/;

/**
 * 行末の括弧注釈を切り離す。
 * 「トマト 1個 （250g）ほど」「バター15g（無塩）」のように
 * 分量の後ろに注釈が来る書式で、分量検出が失敗するのを防ぐ。
 */
function stripTrailingNote(s) {
  let out = s.trim();
  let note = '';
  // 末尾の「（...）+ 曖昧表現」を最大3回まで剥がす
  for (let i = 0; i < 3; i++) {
    const m = out.match(/[（(]([^）)]*)[）)]\s*(?:ほど|くらい|ぐらい|程度|位|前後)?\s*$/);
    if (!m) break;
    note = note ? `${m[1]} ${note}` : m[1];
    out = out.slice(0, m.index).trim();
  }
  return { text: out, note };
}

/**
 * 1行を { name, amount } に分解する
 */
function splitNameAmount(line) {
  const raw = line;
  const { text: base, note } = stripTrailingNote(line);
  let s = (base || line).trim();

  // まず区切り文字で分割し、「丸ごと分量である断片」を左から探す。
  //
  // 行末から探すより先にこれをやる必要がある。
  // 「油　大さじ２　足すときは少しづつ」を行末から見ると「少しづつ」を分量と誤認し、
  // 残り全部（油 大さじ２ 足すときは）が名前になってしまうため。
  const parts = s.split(RE_SEPARATOR).filter(Boolean);
  if (parts.length >= 2) {
    const idx = parts.findIndex((p) => RE_AMOUNT_FULL.test(p.trim()));
    if (idx > 0) {
      const rest = parts.slice(idx + 1).join(' ').trim();
      return {
        name: parts.slice(0, idx).join(' ').trim(),
        amount: parts[idx].trim(),
        note: [note, rest].filter(Boolean).join(' ') || '',
        raw,
      };
    }
  }

  // 区切りが無い書式（「トマト1個」など）は行末から分量を探す
  const amountMatch = s.match(RE_AMOUNT_AT_END);
  if (amountMatch && amountMatch.index > 0) {
    // 分量の手前にある区切り記号を落とす
    const name = s
      .slice(0, amountMatch.index)
      .replace(/[…‥.\s　:：〜～=＝▶►→、,\-–—/／]+$/, '')
      .trim();
    const amount = amountMatch[0].trim();
    if (normalizeIngredientName(name).length >= 1) {
      return { name, amount, note, raw };
    }
  }

  // 分量が見つからない（「塩」だけ等）
  return { name: s.trim(), amount: '', note, raw };
}

// ---------------------------------------------------------------------------
// 行フィルタ
// ---------------------------------------------------------------------------

/** 材料行として不適切な行を弾く */
function isNoiseLine(line) {
  const s = line.trim();
  if (!s) return true;
  if (RE_URL.test(s)) return true;
  if (RE_TIMESTAMP.test(s)) return true;
  if (RE_TIMESTAMP_ANY.test(s)) return true;        // 行末チャプター・比率表記
  if (RE_ADDRESS.test(s)) return true;              // 住所
  if (s.length > 60) return true;                   // 説明文っぽい長文
  if (/[。！？]/.test(s)) return true;               // 句点を含む行は文章
  if (/^[#＃]/.test(s)) return true;                // ハッシュタグ
  if (/^[-=＝─━_]{3,}$/.test(s)) return true;       // 区切り線
  if (RE_NOISE_WORD.test(s)) return true;           // 機材・店舗・宣伝・説明文
  if (!hasJapanese(s)) return true;                 // 英語併記行（cabbage / Soysauce）
  // 「▼」始まりはアフィリエイトリンクの見出し（グループ見出しは先に処理済み）
  if (/^[\s]*[▼▽▶▷]/.test(s)) return true;
  return false;
}

/**
 * 正規化後の食材名として不適切なものを弾く。
 * グループ見出し語（「合わせ調味料」等）は行の段階で処理済みなのでここでは見ない。
 * 「スープ 200ml」のように分量付きで出てくる語を巻き添えにしないため。
 */
function isNoiseName(name, amount = '') {
  if (!name) return true;
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.length > 25) return true;
  if (/^[0-9０-９.．,，\/／\s]+$/.test(name)) return true;
  if (RE_NOISE_WORD.test(name)) return true;

  // 分量が取れなかった行は、調理の指示文である可能性を疑う。
  // 「卵を炒める油はしっかり鍋に馴染ませる」「油を大さじ1入れる」など。
  // 分量が取れている行は素直な材料行なので、この判定はかけない。
  if (!amount) {
    if (RE_SENTENCE_PARTICLE.test(name)) return true;
    if (name.length >= 6 && RE_VERB_TAIL.test(name)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

/**
 * 概要欄テキストをパースする
 * @param {string} description 概要欄の全文
 * @param {string} title 動画タイトル（フォールバック用）
 * @returns {{ ingredients: Array, servings: string|null, steps: string|null, confidence: string }}
 */
export function parseDescription(description, title = '') {
  const empty = { ingredients: [], servings: null, steps: null, confidence: 'none' };
  if (!description || typeof description !== 'string') return empty;

  const lines = description.split(/\r?\n/);

  // --- 材料セクションの範囲を特定 -----------------------------------------
  let start = -1;
  let servings = null;

  for (let i = 0; i < lines.length; i++) {
    if (RE_MATERIAL_HEADER.test(lines[i])) {
      start = i;
      const sm = lines[i].match(RE_SERVINGS);
      if (sm) servings = `${toHalfWidth(sm[1]).replace(/\s/g, '')}${sm[2]}`;
      break;
    }
  }

  if (start === -1) return empty;

  // 見出し行に人数が無ければ直後の数行を見る
  if (!servings) {
    for (let i = start; i < Math.min(start + 3, lines.length); i++) {
      const sm = lines[i].match(RE_SERVINGS);
      if (sm) {
        servings = `${toHalfWidth(sm[1]).replace(/\s/g, '')}${sm[2]}`;
        break;
      }
    }
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (RE_SECTION_END.test(lines[i])) { end = i; break; }
    // URL が3行続いたらセクション終了とみなす
    if (RE_URL.test(lines[i]) && RE_URL.test(lines[i + 1] ?? '') && RE_URL.test(lines[i + 2] ?? '')) {
      end = i;
      break;
    }
  }

  // --- 行をパース ---------------------------------------------------------
  const ingredients = [];
  let currentGroup = '';
  let blankRun = 0;

  for (let i = start + 1; i < end; i++) {
    const rawLine = lines[i];

    if (!rawLine.trim()) {
      blankRun++;
      // 空行が3つ以上続いたらセクションが終わったとみなす
      if (blankRun >= 3 && ingredients.length > 0) break;
      continue;
    }
    blankRun = 0;

    // 人数表記だけの行はスキップ
    if (RE_SERVINGS.test(rawLine) && rawLine.trim().length <= 12) continue;

    // グループ見出し（【タレ】など）
    const gm = rawLine.match(RE_GROUP_HEADER);
    if (gm && !RE_AMOUNT.test(gm[1])) {
      currentGroup = gm[1].trim();
      continue;
    }
    // グループ見出し（▼タレ のように閉じ括弧なし）
    const gm2 = rawLine.match(RE_GROUP_HEADER_LOOSE);
    const g2 = gm2 ? (gm2[1] ?? gm2[2]) : null;
    if (g2 && !RE_AMOUNT.test(g2) && !RE_NOISE_WORD.test(g2)) {
      currentGroup = g2.trim();
      continue;
    }
    // 記号なしのグループ見出し（「合わせ調味料」だけの行）
    const bare = normalizeIngredientName(stripBullet(rawLine));
    if (RE_GROUP_WORD.test(bare)) {
      currentGroup = bare;
      continue;
    }

    if (isNoiseLine(rawLine)) continue;

    const cleaned = stripBullet(rawLine);
    if (!cleaned) continue;

    const { name, amount, note, raw } = splitNameAmount(cleaned);
    const normalized = canonicalIngredientName(name);

    // 食材名として不自然なものを除外
    if (isNoiseName(normalized, amount)) continue;

    ingredients.push({
      name: normalized,
      displayName: name.trim(),
      amount: amount ? toHalfWidth(amount).replace(/\s+/g, '') : '',
      note: note || null,
      group: currentGroup || null,
      raw,
    });
  }

  // 重複除去（正規名+分量が同じもの）
  const seen = new Set();
  const deduped = ingredients.filter((ing) => {
    const key = `${ing.name} ${ing.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // --- 作り方セクション（あれば） -----------------------------------------
  let steps = null;
  for (let i = end; i < lines.length; i++) {
    if (/^[\s【〈《＜<■◆●※*＊~〜～\-]*\s*(?:作\s*り\s*方|手\s*順|つくりかた)/.test(lines[i])) {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (RE_SECTION_END.test(l) && !/作り方|手順/.test(l)) break;
        if (RE_URL.test(l)) break;
        buf.push(l);
        if (buf.length > 40) break;
      }
      const text = buf.join('\n').trim();
      if (text) steps = text;
      break;
    }
  }

  // --- 信頼度 -------------------------------------------------------------
  let confidence = 'none';
  if (deduped.length >= 3) {
    const withAmount = deduped.filter((d) => d.amount).length;
    confidence = withAmount / deduped.length >= 0.5 ? 'high' : 'low';
  } else if (deduped.length > 0) {
    confidence = 'low';
  }

  return { ingredients: deduped, servings, steps, confidence };
}

export default {
  parseDescription,
  normalizeIngredientName,
  canonicalIngredientName,
  toHalfWidth,
};
