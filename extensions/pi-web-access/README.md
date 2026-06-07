# Pi Web Access Pruned

Minimal web access for Pi agent: basic web search plus basic URL content extraction.

This is a pruned derivative of [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access), originally by Nico Bailon and licensed under MIT.

## Install

```bash
pi install npm:@stevelikesrhino/pi-web-access-pruned
```

## Tools

### web_search

Search the web and return a concise answer with source URLs.

```typescript
web_search({ query: "TypeScript 5.8 release notes" })
web_search({ query: "Mozilla Readability examples", numResults: 10 })
```

Parameters:

| Parameter | Description |
|-----------|-------------|
| `query` | Search query |
| `numResults` | Number of results to return, default 5, max 20 |

### fetch_content

Fetch one HTTP(S) URL and extract readable page content as markdown.

```typescript
fetch_content({ url: "https://example.com/article" })
```

Parameters:

| Parameter | Description |
|-----------|-------------|
| `url` | HTTP or HTTPS URL to fetch |

## Scope

This extension intentionally does not include code search, result curation, video analysis, YouTube extraction, local video frames, GitHub cloning, PDF extraction, cookie-based Gemini access, or stored content retrieval.

## Attribution

- Original project: [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access)
- Original author: Nico Bailon
- Original license: MIT
- This package keeps the original MIT license notice in `LICENSE` and adds publication attribution in `NOTICE.md`.
