// @vitest-environment jsdom
import { beforeEach, describe, expect, test } from "vitest";
import { setFaviconHref } from "./favicon-links";

describe("setFaviconHref", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
  });

  test("updates every rel=icon link so media-scoped variants cannot shadow it", () => {
    document.head.innerHTML = [
      '<link rel="icon" href="/brand/favicon.ico" sizes="any" />',
      '<link rel="icon" type="image/png" media="(prefers-color-scheme: light)" href="/brand/favicon-light.png" />',
      '<link rel="icon" type="image/png" media="(prefers-color-scheme: dark)" href="/brand/favicon-dark.png" />',
    ].join("");
    setFaviconHref(document, "/brand/favicon-dark-running.png");
    const hrefs = [...document.querySelectorAll('link[rel="icon"]')].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/brand/favicon-dark-running.png",
      "/brand/favicon-dark-running.png",
      "/brand/favicon-dark-running.png",
    ]);
  });

  test("creates a link when the document has none", () => {
    setFaviconHref(document, "/brand/favicon-light.png");
    const link = document.querySelector('link[rel="icon"]');
    expect(link?.getAttribute("href")).toBe("/brand/favicon-light.png");
  });

  test("is idempotent and ignores an absolute-href difference", () => {
    document.head.innerHTML = '<link rel="icon" href="/brand/favicon-light.png" />';
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement;
    setFaviconHref(document, "/brand/favicon-light.png");
    expect(link.getAttribute("href")).toBe("/brand/favicon-light.png");
    expect(document.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
  });
});
