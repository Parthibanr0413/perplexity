import type { ResearchSource } from "@/lib/types";

function decodeHtmlEntities(input: string) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(input: string) {
  return decodeHtmlEntities(input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function getTagValue(block: string, tagName: string) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match?.[1]?.trim() ?? "";
}

function safeDomain(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeUrl(rawUrl: string) {
  try {
    return new URL(rawUrl.trim()).toString();
  } catch {
    return rawUrl.trim();
  }
}

async function fetchText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, text/plain",
        "User-Agent": "ScoutQuery/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchWeb(query: string, limit: number) {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return [];
  }

  const endpoint = `https://www.bing.com/search?format=rss&setlang=en&q=${encodeURIComponent(trimmedQuery)}`;
  const xml = await fetchText(endpoint);
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

  return items.slice(0, limit).map((match, index) => {
    const block = match[1];
    const title = stripHtml(getTagValue(block, "title")) || `Result ${index + 1}`;
    const url = normalizeUrl(stripHtml(getTagValue(block, "link")));
    const snippet = stripHtml(getTagValue(block, "description"));

    return {
      id: index + 1,
      title,
      url,
      domain: safeDomain(url),
      snippet,
    } satisfies ResearchSource;
  });
}
