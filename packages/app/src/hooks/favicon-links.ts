/**
 * Points every `rel="icon"` link at `href`, creating one when the document has
 * none. Branded shells can carry several icon links (an `.ico` fallback and
 * scheme-scoped PNGs), and a single-link update leaves the others to shadow it
 * — Firefox, for one, uses the last appropriate icon. Update them all, and
 * compare the raw attribute so a repeated update stays a no-op.
 */
export function setFaviconHref(doc: Document, href: string): void {
  let links = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  if (links.length === 0) {
    const link = doc.createElement("link");
    link.rel = "icon";
    link.type = "image/png";
    doc.head.appendChild(link);
    links = [link];
  }
  for (const link of links) {
    if (link.getAttribute("href") !== href) {
      link.setAttribute("href", href);
    }
  }
}
