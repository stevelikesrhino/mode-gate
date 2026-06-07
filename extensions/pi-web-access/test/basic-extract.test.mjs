import assert from "node:assert/strict";
import { test } from "node:test";

const { extractContent } = await import(new URL("../extract.ts", import.meta.url).href);

test("extractContent extracts readable HTML from an HTTP URL", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(`<!doctype html>
		<html>
			<head><title>Example Page</title></head>
			<body>
				<main>
					<article>
						<h1>Example Page</h1>
						<p>This is readable page content for the simplified extension.</p>
						<p>It should be returned as markdown text.</p>
					</article>
				</main>
			</body>
		</html>`, {
		status: 200,
		headers: { "Content-Type": "text/html" },
	});

	try {
		const result = await extractContent("https://example.test/article");
		assert.equal(result.error, null);
		assert.equal(result.title, "Example Page");
		assert.match(result.content, /readable page content/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
