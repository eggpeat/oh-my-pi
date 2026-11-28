import { describe, expect, it } from "bun:test";
import { renderHtml } from "../native/index.js";

describe("renderHtml scripts after emphasis", () => {
	it("preserves scripts that follow emphasized punctuation", async () => {
		const cases = [
			["<em>word.</em><sup>1</sup>", "word.¹\n"],
			["<strong>foo.</strong><sup>123</sup>", "foo.¹²³\n"],
			["<del>gone.</del><sub>2</sub>", "gone.₂\n"],
			['<em><a href="https://example.com/">ref</a></em><sup>1</sup>', "[ref](https://example.com/)¹\n"],
			["<em><code>x</code></em><sup>1</sup>", "`x`¹\n"],
			["<b>a<i>b</i></b><sup>1</sup>", "a*b*¹\n"],
		];

		for (const [html, expected] of cases) {
			expect(await renderHtml(html, { format: "markdown", mode: "full" })).toBe(expected);
		}
	});

	it("keeps emphasis when script notation separates it from alphanumeric text", async () => {
		expect(await renderHtml("<em>foo.</em><sup>1é</sup>", { format: "markdown", mode: "full" })).toBe(
			"*foo.*^1é\n",
		);
		expect(await renderHtml("<em>foo.</em><sup>[1]</sup>", { format: "markdown", mode: "full" })).toBe(
			"*foo.*^\\[1\\]\n",
		);
	});

	it("keeps pending emphasis across an empty script", async () => {
		expect(await renderHtml("<em>foo.</em><sup></sup>bar", { format: "markdown", mode: "full" })).toBe(
			"foo.bar\n",
		);
	});
});
