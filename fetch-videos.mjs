#!/usr/bin/env node
/**
 * fetch-videos.mjs
 *
 * YouTube Data API v3 でチャンネルの全動画を取得し videos.json を生成する。
 *
 * 概要欄は加工せずそのまま保存する。materials の抽出はしない。
 * 書式が動画ごとにバラバラで、パースしようとすると必ず取りこぼしが出るため、
 * 「全部保存してアプリ側で全文検索する」方針に倒している。
 *
 * 使い方:
 *   PowerShell : $env:YOUTUBE_API_KEY="AIza..."; node fetch-videos.mjs --raw raw.json
 *   再生成のみ : node fetch-videos.mjs --from-raw raw.json   (APIキー不要)
 *
 * オプション:
 *   --channel <channelId>  対象チャンネルID
 *   --out <path>           出力先 (既定: ./videos.json)
 *   --raw <path>           APIの生レスポンスも保存する
 *   --from-raw <path>      APIを呼ばず保存済みレスポンスから生成する
 *
 * Node 18 以上（グローバル fetch 使用）
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CHANNEL_ID = 'UCYkW8AbG82KUsh8zGWARriA'; // とにかく売れたい中華料理屋
const API_BASE = 'https://www.googleapis.com/youtube/v3';

function parseArgs(argv) {
  const args = {
    channel: DEFAULT_CHANNEL_ID,
    out: 'videos.json',
    raw: null,
    fromRaw: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--channel') args.channel = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--raw') args.raw = argv[++i];
    else if (a === '--from-raw') args.fromRaw = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log([
        '使い方:',
        '  $env:YOUTUBE_API_KEY="AIza..."; node fetch-videos.mjs [--channel ID] [--out videos.json] [--raw raw.json]',
        '  node fetch-videos.mjs --from-raw raw.json    (APIを呼ばずに再生成)',
      ].join('\n'));
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// API
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

async function getUploadsPlaylistId(channelId, apiKey) {
  const data = await api('channels', { part: 'contentDetails,snippet', id: channelId }, apiKey);
  const item = data.items?.[0];
  if (!item) throw new Error(`チャンネルが見つかりません: ${channelId}`);
  return {
    playlistId: item.contentDetails.relatedPlaylists.uploads,
    channelTitle: item.snippet.title,
  };
}

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
  return thumbs?.medium?.url ?? thumbs?.high?.url ?? thumbs?.default?.url ?? null;
}

function toVideo(v) {
  const sn = v.snippet ?? {};
  return {
    videoId: v.id,
    title: sn.title ?? '',
    url: `https://www.youtube.com/watch?v=${v.id}`,
    thumbnail: pickThumbnail(sn.thumbnails),
    publishedAt: sn.publishedAt ?? null,
    durationSec: isoDurationToSeconds(v.contentDetails?.duration),
    viewCount: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
    description: sn.description ?? '',
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  let raw;
  let channelTitle = '';

  if (args.fromRaw) {
    const rawPath = path.resolve(args.fromRaw);
    console.log(`保存済みレスポンスから生成します: ${rawPath}`);
    raw = JSON.parse(await fs.readFile(rawPath, 'utf8'));
    if (!Array.isArray(raw)) {
      throw new Error('--from-raw のファイルは --raw で保存した配列である必要があります');
    }
    channelTitle = raw[0]?.snippet?.channelTitle ?? '';
    console.log(`  ${raw.length} 本を読み込みました`);
  } else {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      console.error('エラー: 環境変数 YOUTUBE_API_KEY が設定されていません。');
      console.error('  例) $env:YOUTUBE_API_KEY="AIza..."; node fetch-videos.mjs   (PowerShell)');
      process.exit(1);
    }

    console.log(`チャンネル情報を取得中... (${args.channel})`);
    const info = await getUploadsPlaylistId(args.channel, apiKey);
    channelTitle = info.channelTitle;
    console.log(`  チャンネル名: ${channelTitle}`);

    console.log('動画一覧を取得中...');
    const videoIds = await listAllVideoIds(info.playlistId, apiKey);
    console.log(`  合計 ${videoIds.length} 本`);

    console.log('概要欄を取得中...');
    raw = await fetchVideoDetails(videoIds, apiKey);

    if (args.raw) {
      await fs.writeFile(path.resolve(args.raw), JSON.stringify(raw, null, 2), 'utf8');
      console.log(`  生レスポンスを保存: ${args.raw}`);
    }
  }

  // 動画は一本も捨てない。ショートも雑談回もそのまま入れる。
  const videos = raw.map(toVideo);
  videos.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));

  const withDesc = videos.filter((v) => v.description.trim().length >= 40).length;
  const shorts = videos.filter((v) => (v.durationSec ?? 999) <= 60).length;

  const payload = {
    generatedAt: new Date().toISOString(),
    channelId: args.channel,
    channelTitle,
    videoCount: videos.length,
    videos,
  };

  const outPath = path.resolve(args.out);
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  console.log('');
  console.log('完了');
  console.log(`  動画総数            : ${videos.length}`);
  console.log(`  概要欄が40文字以上  : ${withDesc}`);
  console.log(`  ショート動画(60秒以下): ${shorts}`);
  console.log(`  出力先              : ${outPath}  (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error('\n失敗しました:', err.message);
  process.exit(1);
});
