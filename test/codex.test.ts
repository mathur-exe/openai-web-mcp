import { describe, expect, it } from "vitest";
import { cleanInline, isChallenge, parsePage, parseSearch, searchBudget } from "../src/codex";
import { assertPublicUrl } from "../src/url";

// Markup shapes copied from live alpha/search responses (2026-11-10); text is synthetic.
const CITE = (ref: string) => `\uE200cite\uE202${ref}\uE201`;

function openOutput(lines: [number, string][], total = 849) {
  return [
    "Example Changelog - Example (https://example.com/changelog/)",
    `${CITE("turn0view0")} [wordlim: 200] Crawled: today; Content type: text/html; Source: open({"ref_id":"https://example.com/changelog/","lineno":null}); Total lines: ${total}`,
    ...lines.map(([n, t]) => `L${n}: ${t}`),
  ].join("\n");
}

describe("parsePage", () => {
  it("parses title, header fields, lines and strips link and cite markup", () => {
    const page = parsePage(
      openOutput([
        [0, "  * 【0†Download】"],
        [1, "  * 【1†Pricing†example.com】"],
        [2, `Version 1.2 ships faster sync ${CITE("turn0view0")}.`],
      ], 3),
      "https://example.com/changelog/",
      { maxOutputTokens: 6000 },
    );
    expect(page).toMatchObject({
      url: "https://example.com/changelog/",
      title: "Example Changelog - Example",
      crawled: "today",
      content_type: "text/html",
      total_lines: 3,
      first_line: 0,
      last_line: 2,
      next_line: null,
      truncated: false,
    });
    expect(page.text).toBe("* Download\n* Pricing\nVersion 1.2 ships faster sync .");
  });

  it("drops lines before the requested start (upstream windows begin on chunk boundaries)", () => {
    const page = parsePage(openOutput([[120, "a"], [150, "b"], [205, "c"]]), "https://example.com/", {
      startLine: 200,
      maxOutputTokens: 6000,
    });
    expect([page.first_line, page.last_line, page.next_line, page.text]).toEqual([205, 205, 206, "c"]);
  });

  it("treats a budget-filling body as truncated and resumes at the partial last line", () => {
    const body = openOutput([[0, "x".repeat(3000)], [1, "y".repeat(3000)], [2, "partial..."]]);
    const page = parsePage(body, "https://example.com/", { maxOutputTokens: Math.floor(body.length / 4) });
    expect([page.last_line, page.next_line, page.truncated]).toEqual([1, 2, true]);
    expect(page.text).not.toContain("partial");
  });

  it("keeps continuation lines that lack an Lnn prefix", () => {
    const page = parsePage(openOutput([[0, "first"]], 1) + "\nwrapped tail", "https://e.com/", { maxOutputTokens: 6000 });
    expect(page.text).toBe("first\nwrapped tail");
  });
});

describe("parseSearch", () => {
  it("maps results, dedupes URLs, cleans markup and honours the limit", () => {
    const hits = parseSearch(
      {
        results: [
          { type: "text_result", ref_id: "turn0search0", title: "A", url: "https://a.example/x", snippet: `one ${CITE("turn0search0")}`, domain: "a.example" },
          { type: "text_result", ref_id: "turn0search1", title: "A again", url: "https://a.example/x", snippet: "dup" },
          { type: "text_result", ref_id: "turn0search2", title: "", url: "https://b.example/", snippet: "two" },
          { type: "image_result", url: "javascript:alert(1)" },
          { type: "text_result", url: "https://c.example/", title: "C" },
        ],
      },
      2,
    );
    expect(hits).toEqual([
      { title: "A", url: "https://a.example/x", snippet: "one", domain: "a.example" },
      { title: "https://b.example/", url: "https://b.example/", snippet: "two", domain: "b.example" },
    ]);
  });

  it("tolerates a missing results array (older endpoint shape)", () => {
    expect(parseSearch({ output: "text only" }, 5)).toEqual([]);
  });
});

it("searchBudget scales with limit inside [1500, 8000]", () => {
  expect([searchBudget(1), searchBudget(10), searchBudget(100)]).toEqual([1500, 2500, 8000]);
});

it("cleanInline removes every private-use marker", () => {
  expect(cleanInline(`x ${CITE("turn0news3")} y \uE203`)).toBe("x  y");
});

it("isChallenge detects Cloudflare challenge pages, not API errors", () => {
  const html = new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } });
  const mitigated = new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } });
  const api = new Response('{"detail":"Unauthorized"}', { status: 401, headers: { "content-type": "application/json" } });
  expect(isChallenge(html, "<title>Just a moment...</title>")).toBe(true);
  expect(isChallenge(mitigated, "")).toBe(true);
  expect(isChallenge(api, '{"detail":"Unauthorized"}')).toBe(false);
});

describe("assertPublicUrl", () => {
  it.each([
    "http://localhost:8080/",
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.20.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://printer.local/",
    "http://user:pw@example.com/",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => assertPublicUrl(url)).toThrow();
  });
  it("accepts public URLs", () => {
    expect(assertPublicUrl("https://obsidian.md/changelog/").hostname).toBe("obsidian.md");
    expect(assertPublicUrl("http://172.32.0.1/").hostname).toBe("172.32.0.1");
  });
});

describe("refresh failure classification (Codex rules)", async () => {
  const { isPermanentRefreshFailure, oauthErrorCode } = await import("../src/oauth");
  it.each([
    [400, '{"error":{"code":"refresh_token_expired"}}', true],
    [400, '{"error":"refresh_token_reused"}', true],
    [400, '{"code":"refresh_token_invalidated"}', true],
    [400, '{"error":"invalid_grant"}', true],
    [401, "unauthorized", true],
    [400, '{"error":"invalid_request"}', false],
    [500, "upstream down", false],
    [503, '{"error":"temporarily_unavailable"}', false],
  ])("HTTP %i %s → permanent=%s", (status, body, permanent) => {
    expect(isPermanentRefreshFailure(status as number, oauthErrorCode(body as string))).toBe(permanent);
  });
});
