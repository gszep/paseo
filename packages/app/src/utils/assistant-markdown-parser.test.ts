import { describe, expect, it } from "vitest";
import { createAssistantMarkdownParser } from "./assistant-markdown-parser";

describe("createAssistantMarkdownParser", () => {
  it("keeps bold text bold through every partial closing marker", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });

    for (const source of ["**bold", "**bold*", "**bold**"]) {
      expect(parser.renderInline(source)).toBe("<strong>bold</strong>");
    }
  });

  it("shows the growing link label and only links a complete destination", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    const source = "[docs](https://example.com/path)";
    for (let length = 1; length < source.length; length++) {
      expect(parser.renderInline(source.slice(0, length))).toBe(
        "docs".slice(0, Math.max(0, length - 1)),
      );
    }
    expect(parser.renderInline(source)).toBe('<a href="https://example.com/path">docs</a>');
  });

  it.each([
    ["**", "strong"],
    ["__", "strong"],
    ["*", "em"],
    ["_", "em"],
    ["~~", "s"],
    ["`", "code"],
    ["``", "code"],
  ])("keeps %s formatting stable as text and closing markers arrive", (marker, tag) => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    for (let length = 1; length <= 4; length++) {
      expect(parser.renderInline(marker + "text".slice(0, length))).toBe(
        `<${tag}>${"text".slice(0, length)}</${tag}>`,
      );
    }
    for (let length = 0; length <= marker.length; length++) {
      expect(parser.renderInline(marker + "text" + marker.slice(0, length))).toBe(
        `<${tag}>text</${tag}>`,
      );
    }
  });

  it("keeps combined and nested emphasis stable through closing markers", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    for (const closing of ["", "*", "**", "***"]) {
      expect(parser.renderInline("***both" + closing)).toBe("<em><strong>both</strong></em>");
    }
    expect(parser.renderInline("**bold and *italic")).toBe(
      "<strong>bold and <em>italic</em></strong>",
    );
    expect(parser.renderInline("*italic and **bold")).toBe(
      "<em>italic and <strong>bold</strong></em>",
    );
  });

  it.each(["*", "**", "***", "_", "__", "~~", "`", "``"])(
    "hides an opening %s while waiting for its text",
    (marker) => {
      expect(
        createAssistantMarkdownParser({ streaming: true }).renderInline("hello " + marker),
      ).toBe("hello ");
    },
  );

  it.each([
    "[docs](https://example.com/a(b)c)",
    '[docs](https://example.com "a title)")',
    "[docs](<https://example.com/a(b)>)",
    "[docs](file:///tmp/example.ts)",
  ])("waits for the entire destination of %s", (source) => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    for (let length = 6; length < source.length; length++) {
      expect(parser.renderInline(source.slice(0, length))).toBe("docs");
    }
    expect(parser.renderInline(source)).toBe(createAssistantMarkdownParser().renderInline(source));
  });

  it("preserves formatting in incomplete labels and around incomplete links", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    expect(parser.renderInline("[**bold")).toBe("<strong>bold</strong>");
    expect(parser.renderInline("[**bold**](https://exam")).toBe("<strong>bold</strong>");
    expect(parser.renderInline("**see [docs](https://exam")).toBe("<strong>see docs</strong>");
  });

  it("does not auto-link a URL label before the destination is complete", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    expect(parser.renderInline("Read [example.com](https://exam")).toBe("Read example.com");
    expect(parser.renderInline("Read [example.com](https://example.org)")).toBe(
      'Read <a href="https://example.org">example.com</a>',
    );
  });

  it.each([
    "\\*literal",
    "\\[literal",
    "some_identifier",
    "some__identifier",
    "`**literal [link](url`",
    "``a ` b``",
    "**already closed** after",
    "[bad](javascript:alert(1))",
    "<component",
    "$$price",
    "20~25",
  ])("preserves literal and complete inline text: %s", (source) => {
    expect(createAssistantMarkdownParser({ streaming: true }).renderInline(source)).toBe(
      createAssistantMarkdownParser().renderInline(source),
    );
  });

  it.each([
    "```md\n**literal [link](url",
    "~~~md\n**literal [link](url",
    "    **literal [link](url",
    "**earlier\n\nplain tail",
    "- **earlier\n- plain tail",
  ])("leaves literal code and earlier blocks alone: %s", (source) => {
    expect(createAssistantMarkdownParser({ streaming: true }).render(source)).toBe(
      createAssistantMarkdownParser().render(source),
    );
  });

  it("completes inline formatting inside the final list item", () => {
    expect(createAssistantMarkdownParser({ streaming: true }).render("- first\n- **bold")).toBe(
      "<ul>\n<li>first</li>\n<li><strong>bold</strong></li>\n</ul>\n",
    );
  });

  it("hides incomplete images until their source is complete", () => {
    const parser = createAssistantMarkdownParser({ streaming: true });
    expect(parser.renderInline("before ![alt](https://exam")).toBe("before ");
    expect(parser.renderInline("before ![alt](https://example.com/image.png)")).toBe(
      'before <img src="https://example.com/image.png" alt="alt">',
    );
  });

  it("keeps ordinary parsing for completed messages", () => {
    const parser = createAssistantMarkdownParser();
    expect(parser.renderInline("**unfinished")).toBe("**unfinished");
    expect(parser.renderInline("[unfinished")).toBe("[unfinished");
  });

  it("renders agent text verbatim", () => {
    const parser = createAssistantMarkdownParser();

    // The reported bug, plus the substitutions that share its cause.
    expect(parser.renderInline("(c) (C) (r) (tm) (p)")).toBe("(c) (C) (r) (tm) (p)");
    expect(parser.renderInline("wait for it...")).toBe("wait for it...");
    expect(parser.renderInline("a -- b")).toBe("a -- b");
    // Smart quotes are off too: a curled quote is not pasteable into a shell.
    expect(parser.renderInline(`run --name="my repo"`)).toBe("run --name=&quot;my repo&quot;");
    expect(parser.renderInline("it's fine")).toBe("it's fine");
  });

  it("allows file:// links, unlike every other parser", () => {
    const parser = createAssistantMarkdownParser();

    expect(parser.render("[open](file:///tmp/a.ts)")).toContain('href="file:///tmp/a.ts"');
  });

  it("still rejects javascript: links", () => {
    const parser = createAssistantMarkdownParser();

    expect(parser.render("[x](javascript:alert(1))")).not.toContain("href");
  });

  describe("math", () => {
    const parser = createAssistantMarkdownParser();

    function inlineMath(source: string): [string, string][] {
      return (parser.parseInline(source, {})[0]?.children ?? [])
        .filter((token) => token.type === "math_inline")
        .map((token) => [token.markup, token.content]);
    }

    function blockMath(source: string): [string, string][] {
      return parser
        .parse(source, {})
        .filter((token) => token.type === "math_block")
        .map((token) => [token.markup, token.content]);
    }

    it("parses inline $…$, $$…$$ and \\(…\\)", () => {
      expect(inlineMath("so $E = mc^2$ and \\(\\tau\\) and $$x^2$$.")).toEqual([
        ["$", "E = mc^2"],
        ["\\(", "\\tau"],
        ["$$", "x^2"],
      ]);
      expect(inlineMath("the $n$th term")).toEqual([["$", "n"]]);
    });

    it.each([
      "costs $5 and $10",
      "between $5-$10",
      "a $ sign",
      "$ x$",
      "$x $",
      "escaped \\$x\\$",
      "`$x$` in code",
      "costs $5 and $10. Code: `$HOME` stays code.",
      "$$",
    ])("leaves %j as text", (source) => {
      expect(inlineMath(source)).toEqual([]);
      expect(parser.renderInline(source)).not.toContain("math");
    });

    it("keeps \\[ for literal brackets inside a paragraph", () => {
      expect(inlineMath("see \\[1\\]")).toEqual([]);
      expect(parser.renderInline("see \\[1\\]")).toBe("see [1]");
    });

    it("parses $$ and \\[ display blocks, including one that interrupts a paragraph", () => {
      expect(
        blockMath(
          "$$\n\\langle \\sigma \\rangle = D_{KL}(P_F \\| P_R) \\ge 0\n$$\n\n\\[ \\tau \\]\n\nText\n$$a$$",
        ),
      ).toEqual([
        ["$$", "\\langle \\sigma \\rangle = D_{KL}(P_F \\| P_R) \\ge 0"],
        ["\\[", "\\tau"],
        ["$$", "a"],
      ]);
    });

    it("leaves unclosed and fenced display math alone", () => {
      expect(blockMath("$$\nx + y")).toEqual([]);
      expect(blockMath("```\n$$\nx\n$$\n```")).toEqual([]);
      expect(blockMath("    $$x$$")).toEqual([]);
    });

    it("copies math as its source", () => {
      expect(parser.render("$a<b$\n\n$$\nx\n$$")).toBe("<p>$a&lt;b$</p>\n<p>$$x$$</p>\n");
    });
  });
});
