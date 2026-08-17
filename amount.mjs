/**
 * amount.mjs
 *
 * 「1/2個」「大さじ1」「150g」といった分量表記を解析し、合算する。
 *
 * ブラウザからも Node からも使えるようにしてある（index.html 側にも同じ実装を埋め込む）。
 * テストは test-amount.mjs。
 *
 * 設計方針:
 *  - 足せるものだけ足す。足せないものを無理に換算しない
 *  - 「玉ねぎ 1/2個 + 100g」は換算表がないので併記する。推定しない
 *  - 「適量」「少々」は数量ではないので加算せず、そのまま残す
 */

// ---------------------------------------------------------------------------
// 単位の定義
// ---------------------------------------------------------------------------

/** 体積。すべて ml に換算して合算する */
const VOLUME = {
  ml: 1, cc: 1, 'cc.': 1, ミリリットル: 1,
  l: 1000, L: 1000, リットル: 1000,
  大さじ: 15, おおさじ: 15, 大匙: 15,
  小さじ: 5, こさじ: 5, 小匙: 5,
  カップ: 200, cup: 200,
  合: 180,
};

/** 重量。すべて g に換算して合算する */
const WEIGHT = {
  g: 1, グラム: 1,
  kg: 1000, キロ: 1000, キログラム: 1000,
  mg: 0.001,
};

/**
 * 個数系。互いに換算できないので、単位ごとに別々に合算する。
 * 「1本」と「1個」は足さない。
 */
const COUNT_UNITS = [
  '個', 'こ', 'ヶ', 'ケ', '本', '枚', '片', '束', '袋', '缶', '尾', '丁',
  '株', '玉', '房', '匹', '節', '枝', '粒', 'かけ', 'パック', 'つ', '杯',
  '切れ', 'かたまり', '羽', '膳', '人前', '人分',
];

/** 数量として扱えない表現 */
const VAGUE = [
  '適量', '適宜', '少々', '少量', '少し', 'ひとつまみ', '一つまみ', 'ふたつまみ',
  'お好みで', 'お好み', '好みで', '好きなだけ', 'たっぷり', '同量', '各適量', '大量',
];

// ---------------------------------------------------------------------------
// 数値の解析
// ---------------------------------------------------------------------------

/**
 * 全角の英数と記号を半角へ。
 * 数字だけでなく記号も含めること。「１／２」のスラッシュが全角のままだと
 * 分数として解析できず、1 と誤読する。
 */
function toHalfWidth(s) {
  return String(s || '').replace(/[！-～]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

const VULGAR = { '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75, '⅛': 0.125 };

/** 漢数字。「親鶏 一羽」のような表記が実データにあるため対応する */
const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** 数値の先頭に現れる文字（分量の解析で単位を切り出すときに使う） */
const NUM_CHARS = '0-9./,と〜~\\-–—ー½⅓⅔¼¾⅛半一二三四五六七八九十';

/**
 * 「1と1/2」「1/2」「1.5」「1,5」「½」を数値にする。
 * 解析できなければ null。
 */
export function parseNumber(text) {
  let s = toHalfWidth(text).replace(/\s+/g, '');
  if (!s) return null;

  let total = 0;
  let matched = false;

  // 「半分」「半玉」の「半」= 0.5
  if (s[0] === '半') return 0.5;

  // 漢数字（「一羽」「二本」）
  if (KANJI_NUM[s[0]] != null) return KANJI_NUM[s[0]];

  // 「1と1/2」の整数部
  const wa = s.match(/^(\d+(?:[.,]\d+)?)と/);
  if (wa) {
    total += Number(wa[1].replace(',', '.'));
    matched = true;
    s = s.slice(wa[0].length);
  }

  // 分数
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;
    total += Number(frac[1]) / den;
    return total;
  }

  // 単位分数記号
  if (s && VULGAR[s[0]] != null) {
    total += VULGAR[s[0]];
    return total;
  }

  // 「1〜2」のような範囲は少ない方を採る（買いすぎないため）
  const range = s.match(/^(\d+(?:[.,]\d+)?)\s*[〜~\-–—ー]\s*(\d+(?:[.,]\d+)?)/);
  if (range) return total + Number(range[1].replace(',', '.'));

  const num = s.match(/^(\d+(?:[.,]\d+)?)/);
  if (num) {
    // 「1,5」は 1.5 の誤記とみなす（1,500 のような桁区切りは料理では稀）
    return total + Number(num[1].replace(',', '.'));
  }

  return matched ? total : null;
}

/** 数値を読みやすい文字列にする。1/2 や 1と1/2 に戻す */
export function formatNumber(n) {
  if (n == null || !isFinite(n)) return '';
  const rounded = Math.round(n * 1000) / 1000;
  if (Number.isInteger(rounded)) return String(rounded);

  const whole = Math.floor(rounded);
  const frac = rounded - whole;
  const table = [[0.5, '1/2'], [1 / 3, '1/3'], [2 / 3, '2/3'], [0.25, '1/4'], [0.75, '3/4'],
                 [0.125, '1/8'], [0.375, '3/8'], [0.625, '5/8'], [0.875, '7/8']];
  for (const [val, label] of table) {
    if (Math.abs(frac - val) < 0.02) {
      return whole > 0 ? `${whole}と${label}` : label;
    }
  }
  return String(Math.round(rounded * 10) / 10);
}

// ---------------------------------------------------------------------------
// 分量の解析
// ---------------------------------------------------------------------------

const VOLUME_KEYS = Object.keys(VOLUME).sort((a, b) => b.length - a.length);
const WEIGHT_KEYS = Object.keys(WEIGHT).sort((a, b) => b.length - a.length);
const COUNT_KEYS = COUNT_UNITS.slice().sort((a, b) => b.length - a.length);

/**
 * 分量表記を { kind, value, unit, text } に分解する。
 *
 *   kind: 'volume' | 'weight' | 'count' | 'vague' | 'unknown'
 *   value: 数値（vague/unknown では null）
 *   unit:  合算のキー。volume は 'ml'、weight は 'g'、count は個数単位そのもの
 */
export function parseAmount(text) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'unknown', value: null, unit: '', text: '' };

  const s = toHalfWidth(raw).replace(/\s+/g, '');

  for (const v of VAGUE) {
    if (s.indexOf(v) !== -1) return { kind: 'vague', value: null, unit: '', text: raw };
  }

  // 「半分」は数量だが単位が書かれていない。unit を空にして、
  // 同じ食材の他の分量が持つ単位に後から合わせる（sumAmounts 側で処理）
  if (/^半分$/.test(s)) return { kind: 'count', value: 0.5, unit: '', text: raw };

  // 大さじ・小さじ・カップは数値が後ろに来る（大さじ1）
  for (const key of ['大さじ', 'おおさじ', '大匙', '小さじ', 'こさじ', '小匙', 'カップ']) {
    if (s.startsWith(key)) {
      const n = parseNumber(s.slice(key.length));
      if (n == null) return { kind: 'unknown', value: null, unit: '', text: raw };
      return { kind: 'volume', value: n * VOLUME[key], unit: 'ml', text: raw };
    }
  }

  // それ以外は「数値 + 単位」
  const n = parseNumber(s);
  if (n == null) return { kind: 'unknown', value: null, unit: '', text: raw };

  const rest = s.replace(new RegExp('^[' + NUM_CHARS + ']+'), '');

  for (const key of VOLUME_KEYS) {
    if (rest === key || rest.startsWith(key)) {
      return { kind: 'volume', value: n * VOLUME[key], unit: 'ml', text: raw };
    }
  }
  for (const key of WEIGHT_KEYS) {
    if (rest === key || rest.startsWith(key)) {
      return { kind: 'weight', value: n * WEIGHT[key], unit: 'g', text: raw };
    }
  }
  for (const key of COUNT_KEYS) {
    if (rest === key || rest.startsWith(key)) {
      return { kind: 'count', value: n, unit: key, text: raw };
    }
  }

  // 単位が無い（「玉ねぎ 1」など）。unit は空のままにして、
  // 同じ食材の他の分量が持つ単位に後から合わせる
  if (!rest) return { kind: 'count', value: n, unit: '', text: raw };

  return { kind: 'unknown', value: null, unit: '', text: raw };
}

// ---------------------------------------------------------------------------
// 合算
// ---------------------------------------------------------------------------

/** ml を読みやすい表記にする。大さじ・小さじに寄せる */
function formatVolume(ml) {
  if (ml >= 200 && ml % 200 === 0) return `${formatNumber(ml / 200)}カップ`;
  if (ml >= 100) return `${formatNumber(ml)}ml`;
  if (ml % 15 === 0) return `大さじ${formatNumber(ml / 15)}`;
  if (ml % 5 === 0) return `小さじ${formatNumber(ml / 5)}`;
  return `${formatNumber(ml)}ml`;
}

function formatWeight(g) {
  if (g >= 1000) return `${formatNumber(g / 1000)}kg`;
  return `${formatNumber(g)}g`;
}

/**
 * 同じ食材の分量リストを合算して、表示用の文字列にする。
 *
 * @param amountTexts 分量の文字列の配列
 * @param conv 重さと個数の換算 { unit: '個', per: 200 }。省略可。
 *             与えられた場合、重量を個数に換算して1つにまとめる。
 *             無い場合は「1/2個 ＋ 100g」のように併記する（推定しない）。
 *
 * 戻り値は文字列。換算が行われたかを知りたい場合は sumAmountsDetail を使う。
 */
export function sumAmounts(amountTexts, conv) {
  return sumAmountsDetail(amountTexts, conv).text;
}

export function sumAmountsDetail(amountTexts, conv) {
  const parsed = (amountTexts || []).map(parseAmount);

  let ml = 0, hasVolume = false;
  let g = 0, hasWeight = false;
  const counts = new Map();
  const vague = [];
  const unknown = [];

  for (const a of parsed) {
    if (a.kind === 'volume') { ml += a.value; hasVolume = true; }
    else if (a.kind === 'weight') { g += a.value; hasWeight = true; }
    else if (a.kind === 'count') counts.set(a.unit, (counts.get(a.unit) || 0) + a.value);
    else if (a.kind === 'vague') { if (a.text && vague.indexOf(a.text) === -1) vague.push(a.text); }
    else if (a.text && unknown.indexOf(a.text) === -1) unknown.push(a.text);
  }

  // 重さ→個数の換算。「玉ねぎ 1個 = 200g」が分かっていれば
  // 「1/2個 + 100g」を「1個」にまとめられる。
  let converted = false;
  if (conv && conv.unit && conv.per > 0 && hasWeight) {
    counts.set(conv.unit, (counts.get(conv.unit) || 0) + g / conv.per);
    g = 0;
    hasWeight = false;
    converted = true;
  }

  // 単位なしの数量（「半分」「1」）を、同じ食材の他の単位に寄せる。
  // 候補が1つだけのときに限る。複数あるとどれに寄せるべきか決まらないため。
  if (counts.has('')) {
    const others = Array.from(counts.keys()).filter((u) => u !== '');
    if (others.length === 1) {
      counts.set(others[0], counts.get(others[0]) + counts.get(''));
      counts.delete('');
    } else if (others.length === 0) {
      // 他に手がかりが無ければ「個」とみなす
      counts.set('個', counts.get(''));
      counts.delete('');
    }
  }

  const parts = [];
  counts.forEach((val, unit) => parts.push(`${formatNumber(val)}${unit || '個'}`));
  if (hasWeight) parts.push(formatWeight(g));
  if (hasVolume) parts.push(formatVolume(ml));
  unknown.forEach((u) => parts.push(u));

  // 数量が1つも取れなければ「適量」等をそのまま出す
  if (!parts.length) {
    return { text: vague.length ? vague.join('／') : '', converted: false };
  }

  // 数量が取れている場合、「適量」は情報量が無いので落とす
  return { text: parts.join(' ＋ '), converted: converted };
}

export default { parseNumber, formatNumber, parseAmount, sumAmounts, sumAmountsDetail };
