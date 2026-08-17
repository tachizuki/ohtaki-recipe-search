#!/usr/bin/env node
/**
 * fetch-recipes.mjs
 *
 * YouTube Data API v3 を使って「とにかく売れたい中華料理屋」チャンネルの
 * 全動画の概要欄を取得し、材料をパースして recipes.json を生成する。
 *
 * 使い方:
 *   YOUTUBE_API_KEY=xxxxx node fetch-recipes.mjs
 *
 * オプション:
 *   --channel <channelId>  対象チャンネルID (既定: とにかく売れたい中華料理屋)
 *   --out <path>           出力先 (既定: ./recipes.json)
 *   --all                  材料が取れなかった動画も出力に含める
 *   --raw <path>           APIの生レスポンス(動画一覧)も保存する
 *   --from-raw <path>      APIを呼ばず、保存済みの生レスポンスから再パースする
 *                          (APIキー不要・クォータ消費なし。パーサー調整時に使う)
 *   --diagnose             材料が取れなかった動画の内訳を表示する
 *
 * 推奨の使い方:
 *   1回目  YOUTUBE_API_KEY=xxx node fetch-recipes.mjs --raw raw.json
 *   2回目〜 node fetch-recipes.mjs --from-raw raw.json --diagnose
 *
 * Node 18 以上（グローバル fetch 使用）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDescription } from './parse-ingredients.mjs';

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const DEFAULT_CHANNEL_ID = 'UCYkW8AbG82KUsh8zGWARriA'; // とにかく売れたい中華料理屋
const API_BASE = 'https://www.googleapis.com/youtube/v3';

function parseArgs(argv) {
  const args = {
    channel: DEFAULT_CHANNEL_ID,
    out: 'recipes.json',
    all: false,
    raw: null,
    fromRaw: null,
    diagnose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') args.channel = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--raw') args.raw = argv[++i];
    else if (a === '--from-raw') args.fromRaw = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--diagnose') args.diagnose = true;
    else if (a === '--help' || a === '-h') {
      console.log([
        '使い方:',
        '  YOUTUBE_API_KEY=xxx node fetch-recipes.mjs [--channel ID] [--out recipes.json] [--all] [--raw raw.json]',
        '  node fetch-recipes.mjs --from-raw raw.json [--diagnose]   (API を呼ばずに再パース)',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// API ヘルパー
// ---------------------------------------------------------------------------

async function api(endpoint, params, apiKey) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  url.searchParams.set('key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message ?? '';
    } catch { /* ignore */ }
    throw new Error(`YouTube API エラー ${res.status} (${endpoint}): ${detail}`);
  }
  return res.json();
}

/** チャンネルの「アップロード動画」プレイリストIDを取得 */
async function getUploadsPlaylistId(channelId, apiKey) {
  const data = await api('channels', { part: 'contentDetails,snippet', id: channelId }, apiKey);
  const item = data.items?.[0];
  if (!item) throw new Error(`チャンネルが見つかりません: ${channelId}`);
  return {
    playlistId: item.contentDetails.relatedPlaylists.uploads,
    channelTitle: item.snippet.title,
  };
}

/** プレイリスト内の全 videoId を取得（1リクエスト=1クォータ, 50件ずつ） */
async function listAllVideoIds(playlistId, apiKey) {
  const ids = [];
  let pageToken;
  let page = 0;
  do {
    const data = await api('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: 50,
      pageToken,
    }, apiKey);
    for (const it of data.items ?? []) {
      if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    }
    pageToken = data.nextPageToken;
    page++;
    process.stdout.write(`\r  動画ID取得中... ${ids.length} 件 (page ${page})`);
  } while (pageToken);
  process.stdout.write('\n');
  return ids;
}

/** videoId の配列から詳細情報（概要欄・再生時間など）を取得 */
async function fetchVideoDetails(videoIds, apiKey) {
  const out = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await api('videos', {
      part: 'snippet,contentDetails,statistics',
      id: chunk.join(','),
      maxResults: 50,
    }, apiKey);
    out.push(...(data.items ?? []));
    process.stdout.write(`\r  動画詳細取得中... ${out.length}/${videoIds.length} 件`);
  }
  process.stdout.write('\n');
  return out;
}

// ---------------------------------------------------------------------------
// 変換
// ---------------------------------------------------------------------------

/** ISO 8601 duration (PT1H2M3S) を秒に変換 */
function isoDurationToSeconds(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, mi, s] = m.map((x) => (x ? Number(x) : 0));
  return d * 86400 + h * 3600 + mi * 60 + s;
}

function pickThumbnail(thumbs) {
  return (
    thumbs?.medium?.url ??
    thumbs?.high?.url ??
    thumbs?.default?.url ??
    null
  );
}

function toRecipe(video) {
  const sn = video.snippet ?? {};
  const description = sn.description ?? '';
  const parsed = parseDescription(description, sn.title ?? '');

  return {
    videoId: video.id,
    title: sn.title ?? '',
    url: `https://www.youtube.com/watch?v=${video.id}`,
    thumbnail: pickThumbnail(sn.thumbnails),
    publishedAt: sn.publishedAt ?? null,
    durationSec: isoDurationToSeconds(video.contentDetails?.duration),
    viewCount: video.statistics?.viewCount ? Number(video.statistics.viewCount) : null,
    tags: sn.tags ?? [],
    // パース結果
    ingredients: parsed.ingredients,   // [{ name, amount, group, raw }]
    servings: parsed.servings,         // "2人前" など / null
    steps: parsed.steps,               // 手順テキスト（取れた場合）
    parseConfidence: parsed.confidence, // 'high' | 'low' | 'none'
    description,                       // 元の概要欄（アプリ側で全文表示用）
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** 材料が取れなかった動画の内訳を表示する */
function diagnose(all) {
  const missed = all.filter((r) => r.ingredients.length === 0);
  const looksLikeRecipe = missed.filter((r) =>
    /材\s*料|ざいりょう|使用食材|用意するもの|ingredients/i.test(r.description)
  );
  const shorts = missed.filter((r) => (r.durationSec ?? 999) <= 60);
  const noDesc = missed.filter((r) => (r.description ?? '').trim().length < 40);

  console.log('');
  console.log('--- 診断: 材料が取れなかった動画 ---');
  console.log(`  合計                      : ${missed.length} 本`);
  console.log(`  うちショート動画(60秒以下): ${shorts.length} 本`);
  console.log(`  うち概要欄がほぼ空        : ${noDesc.length} 本`);
  console.log(`  うち「材料」の記載あり    : ${looksLikeRecipe.length} 本  ← パーサーの取りこぼし候補`);

  if (looksLikeRecipe.length) {
    console.log('');
    console.log('  取りこぼし候補（先頭20本）:');
    for (const r of looksLikeRecipe.slice(0, 20)) {
      console.log(`    ${r.videoId}  ${r.title.slice(0, 40)}`);
      const line = (r.description.split(/\r?\n/).find((l) => /材\s*料/.test(l)) ?? '').trim();
      if (line) console.log(`      見出し行: ${JSON.stringify(line.slice(0, 60))}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  let videos;
  let videoIds;
  let channelTitle = '';

  if (args.fromRaw) {
    // --- API を呼ばずに保存済みレスポンスから再パース -----------------------
    const rawPath = path.resolve(args.fromRaw);
    console.log(`保存済みレスポンスから再パースします: ${rawPath}`);
    videos = JSON.parse(await fs.readFile(rawPath, 'utf8'));
    if (!Array.isArray(videos)) {
      throw new Error('--from-raw のファイルは --raw で保存した配列である必要があります');
    }
    videoIds = videos.map((v) => v.id);
    channelTitle = videos[0]?.snippet?.channelTitle ?? '';
    console.log(`  ${videos.length} 本を読み込みました`);
  } else {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      console.error('エラー: 環境変数 YOUTUBE_API_KEY が設定されていません。');
      console.error('  例) $env:YOUTUBE_API_KEY="AIza..."; node fetch-recipes.mjs   (PowerShell)');
      console.error('  キーの取り方は README.md を参照してください。');
      process.exit(1);
    }

    console.log(`チャンネル情報を取得中... (${args.channel})`);
    const info = await getUploadsPlaylistId(args.channel, apiKey);
    channelTitle = info.channelTitle;
    console.log(`  チャンネル名: ${channelTitle}`);

    console.log('動画一覧を取得中...');
    videoIds = await listAllVideoIds(info.playlistId, apiKey);
    console.log(`  合計 ${videoIds.length} 本`);

    console.log('概要欄を取得中...');
    videos = await fetchVideoDetails(videoIds, apiKey);

    if (args.raw) {
      await fs.writeFile(path.resolve(args.raw), JSON.stringify(videos, null, 2), 'utf8');
      console.log(`  生レスポンスを保存: ${args.raw}`);
      console.log('  次回からは以下でAPIを使わずに再パースできます:');
      console.log(`    node fetch-recipes.mjs --from-raw ${args.raw} --diagnose`);
    }
  }

  console.log('材料をパース中...');
  const all = videos.map(toRecipe);
  const withIngredients = all.filter((r) => r.ingredients.length > 0);
  const recipes = args.all ? all : withIngredients;

  // 新しい順
  recipes.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  // 食材の出現頻度（アプリ側のサジェスト用）
  const freq = new Map();
  for (const r of recipes) {
    for (const ing of r.ingredients) {
      freq.set(ing.name, (freq.get(ing.name) ?? 0) + 1);
    }
  }
  const ingredientIndex = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([name, count]) => ({ name, count }));

  const payload = {
    generatedAt: new Date().toISOString(),
    channelId: args.channel,
    channelTitle,
    totalVideos: videoIds.length,
    recipeCount: recipes.length,
    ingredientIndex,
    recipes,
  };

  const outPath = path.resolve(args.out);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log('');
  console.log('完了');
  console.log(`  動画総数        : ${videoIds.length}`);
  console.log(`  材料が取れた動画: ${withIngredients.length}`);
  console.log(`  出力レシピ数    : ${recipes.length}`);
  console.log(`  ユニーク食材数  : ${ingredientIndex.length}`);
  console.log(`  出力先          : ${outPath}`);
  console.log('');
  console.log('上位の食材:');
  for (const { name, count } of ingredientIndex.slice(0, 15)) {
    console.log(`  ${String(count).padStart(3)} 件  ${name}`);
  }

  if (args.diagnose) diagnose(all);
}

main().catch((err) => {
  console.error('\n失敗しました:', err.message);
  process.exit(1);
});
