// IndexNow への URL 送信（研究ナビ research.dror.co.jp 用）。
// 本番反映（main への push → Cloudflare Pages のデプロイ完了）の後に、変えたページの URL を
// Bing などの IndexNow 対応検索エンジンへ知らせる。
//
//   node scripts/indexnow.mjs https://research.dror.co.jp/burnout/ ...   指定した URL を送る
//   node scripts/indexnow.mjs --all                                      本番 robots.txt に列挙された全サイトマップの URL を送る
//   node scripts/indexnow.mjs --dry-run --all                            送らずに内容だけ表示
//
// キーは site/<key>.txt（本文＝キーのみ・改行なし）。IndexNow のキーは公開前提の値で、認証情報ではない。
// 送る前に keyLocation（本番の /<key>.txt）を取得し、本文がキーと一致しなければ止める
// （デプロイ前に送ってしまう事故を防ぐ）。依存パッケージは使わない（Node 18 以降の標準 fetch）。
// このファイルは site/ の外にあるため配信されない。
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "research.dror.co.jp";
const SITE = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/indexnow";
const ROBOTS = `${SITE}/robots.txt`;
const MAX_URLS = 10000; // IndexNow の1リクエストあたりの上限。超えたら分けて送る

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = path.join(root, "site");

// Windows の Node では fetch の後に process.exit() を呼ぶと libuv のアサーションで落ちることがあるため、
// 終了は exitCode で行う（fail は例外を投げ、末尾の catch で exitCode=1 にする）。
class Stop extends Error {}
function fail(message) {
  throw new Stop(message);
}

function readKey() {
  const candidates = readdirSync(siteDir).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name));
  if (candidates.length !== 1) fail(`site/ にキーのファイル（32桁の16進数.txt）が1つだけ必要です（見つかった数: ${candidates.length}）`);
  const file = candidates[0];
  const key = readFileSync(path.join(siteDir, file), "utf8");
  if (`${key}.txt` !== file) fail(`site/${file} の本文がファイル名のキーと一致しません（改行なしでキーだけを書く）`);
  return key;
}

const unescapeXml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function getText(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) fail(`${url} を取得できませんでした（HTTP ${res.status}）`);
  return res.text();
}

// 本番 robots.txt の Sitemap: 行 → 各サイトマップの <loc>
async function allSitemapUrls() {
  const robots = await getText(ROBOTS);
  const sitemaps = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)].map((m) => m[1]);
  if (sitemaps.length === 0) fail(`${ROBOTS} に Sitemap: 行がありません`);
  const urls = [];
  for (const sm of sitemaps) {
    let u;
    try {
      u = new URL(sm);
    } catch {
      fail(`robots.txt のサイトマップ URL が不正です: ${sm}`);
    }
    if (u.protocol !== "https:" || u.hostname !== HOST) {
      console.log(`除外（${HOST} 以外のサイトマップ）: ${sm}`);
      continue;
    }
    const xml = await getText(sm);
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => unescapeXml(m[1]));
    console.log(`サイトマップ ${sm}: ${locs.length}件`);
    urls.push(...locs);
  }
  return { sitemaps, urls };
}

function filterHost(urls) {
  const kept = [];
  const dropped = [];
  for (const raw of urls) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      dropped.push(raw);
      continue;
    }
    if (url.protocol === "https:" && url.hostname === HOST) kept.push(url.href);
    else dropped.push(raw);
  }
  return { kept: [...new Set(kept)], dropped };
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const unknown = args.filter((a) => a.startsWith("--") && !["--dry-run", "--all"].includes(a));
  if (unknown.length) fail(`不明なオプション: ${unknown.join(" ")}`);
  const given = args.filter((a) => !a.startsWith("--"));
  if (!all && given.length === 0) fail("送る URL を指定するか、--all を付けてください（--dry-run で送らずに表示）");

  const key = readKey();
  const keyLocation = `${SITE}/${key}.txt`;

  const fromSitemaps = all ? (await allSitemapUrls()).urls : [];
  const { kept: urlList, dropped } = filterHost([...fromSitemaps, ...given]);
  if (dropped.length) console.log(`除外（${HOST} 以外・不正な URL）: ${dropped.length}件\n  ${dropped.join("\n  ")}`);
  if (urlList.length === 0) fail("送る URL がありません");
  const batches = chunks(urlList, MAX_URLS);

  if (dryRun) {
    console.log(`[dry-run] 送信しません。POST ${ENDPOINT}`);
    console.log(`[dry-run] keyLocation: ${keyLocation}（送信時はここを取得して本文がキーと一致するか確かめる）`);
    console.log(`[dry-run] URL ${urlList.length}件（重複除去後）、${batches.length}回に分けて送る予定`);
    batches.forEach((b, i) => {
      console.log(`[dry-run] 第${i + 1}回: ${b.length}件（先頭 ${b[0]} … 末尾 ${b[b.length - 1]}）`);
    });
    console.log(JSON.stringify({ host: HOST, key, keyLocation, urlList: urlList.slice(0, 5), urlListCount: urlList.length }, null, 2));
    return;
  }

  // 本番にキーのファイルが出ているか（＝デプロイ済みか）を確かめてから送る
  const keyRes = await fetch(`${keyLocation}?v=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  const keyBody = keyRes.ok ? (await keyRes.text()).trim() : "";
  if (!keyRes.ok || keyBody !== key) {
    fail(`${keyLocation} の本文がキーと一致しません（HTTP ${keyRes.status}）。デプロイ後に実行してください。送信は行っていません。`);
  }

  for (const [i, batch] of batches.entries()) {
    console.log(`POST ${ENDPOINT}（第${i + 1}/${batches.length}回、URL ${batch.length}件）`);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: HOST, key, keyLocation, urlList: batch }),
    });
    const text = await res.text().catch(() => "");
    console.log(`応答: HTTP ${res.status}${text ? ` ${text.slice(0, 500)}` : ""}`);
    if (res.status !== 200 && res.status !== 202) {
      // 400 不正な形式 / 403 キー不一致 / 422 host とキーが合わない / 429 送りすぎ
      fail(`第${i + 1}回の送信が失敗しました（HTTP ${res.status}）。残り ${batches.length - i - 1}回は送っていません。`);
    }
  }
  console.log("成功（すべて 200/202）");
}

main().catch((error) => {
  console.error(`indexnow: ${error instanceof Stop ? error.message : error?.stack || error}`);
  process.exitCode = 1;
});
