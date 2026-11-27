# Pi Web Access Pruned

Minimal web access for Pi agent: basic web search plus basic URL content extraction.

This is a pruned derivative of [`nicobailon/pi-web-access`](https://github.com/nicobailon/pi-web-access), originally by Nico Bailon and licensed under MIT.

## Install

```bash
pi install npm:@stevelikesrhino/pi-web-access-pruned
```

## Web search configuration

- **Exa (default):** Leave `PI_WEB_SEARCH_PROVIDER` unset or set it to `exa`. `EXA_API_KEY` is optional.
- **OpenAI:** Set `PI_WEB_SEARCH_PROVIDER=openai`. The extension reads `OAI_PLATFORM_KEY` first, then `OPENAI_API_KEY`. It does not fall back to Exa if the request fails.

`PI_WEB_SEARCH_MODEL` selects the OpenAI model. It defaults to `gpt-6-luna` when unset or blank. The model must support `web_search` in the Responses API.

`PI_WEB_SEARCH_MAX_TOOL_CALLS` limits hosted web search calls per OpenAI response. It defaults to **3** when unset or blank and accepts a positive whole number. Invalid values fail before a request is sent. It limits web actions such as searching or opening a page, not the number of sources shown. It has no effect on Exa.

```bash
PI_WEB_SEARCH_PROVIDER=openai PI_WEB_SEARCH_MODEL=gpt-5.4-mini PI_WEB_SEARCH_MAX_TOOL_CALLS=5 pi
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
| `numResults` | Maximum number of sources to list, default 5, range 1–20 |

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
