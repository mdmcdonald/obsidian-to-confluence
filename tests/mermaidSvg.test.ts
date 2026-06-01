import { test } from "node:test";
import assert from "node:assert/strict";

import {
	decodeHtmlEntities,
	extractLabelLines,
	replaceForeignObjects,
	escapeXmlText,
} from "../src/mermaidSvg";

test("decodeHtmlEntities decodes &amp; last (so &amp;lt; → &lt;)", () => {
	assert.equal(decodeHtmlEntities("R &amp; D"), "R & D");
	assert.equal(decodeHtmlEntities("&amp;lt;"), "&lt;");
	assert.equal(decodeHtmlEntities("a &lt;b&gt; c"), "a <b> c");
	assert.equal(decodeHtmlEntities("&#39;q&#39; &#x27;r&#x27;"), "'q' 'r'");
});

test("extractLabelLines splits on <br> and block boundaries, decodes entities", () => {
	assert.deepEqual(extractLabelLines("High-Fidelity Pulse<br/>Captures"), [
		"High-Fidelity Pulse",
		"Captures",
	]);
	assert.deepEqual(extractLabelLines("R &amp; D"), ["R & D"]);
	assert.deepEqual(extractLabelLines("<div>Line1</div><div>Line2</div>"), [
		"Line1",
		"Line2",
	]);
	// <br> variants
	assert.deepEqual(extractLabelLines("a<br>b<br />c<BR/>d"), ["a", "b", "c", "d"]);
	// empty → one empty line (so a <text> is still emitted)
	assert.deepEqual(extractLabelLines("<div></div>"), [""]);
});

test("replaceForeignObjects: <br/> becomes multiple tspans (line breaks render)", () => {
	const svg = `<svg><foreignObject x="0" y="0" width="100" height="40"><div xmlns="http://www.w3.org/1999/xhtml"><span>Top<br/>Bottom</span></div></foreignObject></svg>`;
	const out = replaceForeignObjects(svg);
	assert.ok(!out.includes("foreignObject"), out);
	assert.ok(out.includes("<tspan"), "multi-line label should use tspans");
	assert.ok(out.includes(">Top</tspan>"), out);
	assert.ok(out.includes(">Bottom</tspan>"), out);
});

test("replaceForeignObjects: &amp; renders as a real ampersand, not literal &amp;", () => {
	const svg = `<svg><foreignObject x="0" y="0" width="80" height="20"><div xmlns="http://www.w3.org/1999/xhtml"><span>R &amp; D</span></div></foreignObject></svg>`;
	const out = replaceForeignObjects(svg);
	// the text node carries a single XML-escaped ampersand (renders as "&"),
	// NOT the double-escaped "&amp;amp;" that produced literal "&amp;" before.
	assert.ok(out.includes("R &amp; D"), out);
	assert.ok(!out.includes("&amp;amp;"), out);
});

test("replaceForeignObjects: single line uses <text> with a centre", () => {
	const svg = `<svg><foreignObject x="10" y="10" width="20" height="20"><div>Solo</div></foreignObject></svg>`;
	const out = replaceForeignObjects(svg);
	assert.ok(out.includes(`<text x="20" y="20"`), out); // centre of the box
	assert.ok(out.includes(">Solo</text>"), out);
});

test("SVGs without foreignObject are returned unchanged", () => {
	const svg = `<svg><text>hi</text></svg>`;
	assert.equal(replaceForeignObjects(svg), svg);
});

test("escapeXmlText escapes &/</> for the SVG text node", () => {
	assert.equal(escapeXmlText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});
