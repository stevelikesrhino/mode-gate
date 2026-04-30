## Example read output:
```
1#VR:import { capitalize } from "./text";
2#WS:
3#TX:export function formatGreeting(name: string, excited: boolean) {
4#PM:  const displayName = capitalize(name);
5#NQ:  const punctuation = excited ? "!" : ".";
6#JB:  return "hello " + displayName + punctuation;
7#HY:}
8#MK:
9#BY:console.log(formatGreeting("ada", true));
```

## Example single-line replace using line 6 from the snippet:
```
{"path":"src/app.ts","edits":[{"op":"replace","pos":"6#JB","end":"6#JB","content":"  return `hello ${displayName}${punctuation}`;"}]}
```

## Example multi-line replace using lines 4-6 from the snippet:
```
{"path":"src/app.ts","edits":[{"op":"replace","pos":"4#PM","end":"6#JB","content":"  const displayName = capitalize(name.trim());\n  const punctuation = excited ? \"!\" : \".\";\n  return `hello ${displayName}${punctuation}`;"}]}
```

## Example insert_after using line 4 from the snippet:
```
{"path":"src/app.ts","edits":[{"op":"insert_after","pos":"4#PM","end":"4#PM","content":"  if (!displayName) return \"hello.\";"}]}
```

## Example insert_before using line 1 from the snippet:
```
{"path":"src/app.ts","edits":[{"op":"insert_before","pos":"1#VR","end":"1#VR","content":"import { logger } from \"./logger\";"}]}
```

## Example delete using lines 4-5 from the snippet:
```
{"path":"src/app.ts","edits":[{"op":"replace","pos":"4#PM","end":"5#NQ","content":""}]}
```

## Very important usage rules:
- Do not recalculate the hash. Use the LINE#HASH anchor exactly as read returned it.
- Always read a file before editing it to get current LINE#HASH anchors.
- Tool arguments must be a top-level object with path and edits. Put path at the top level, never inside edits[].
- Reference lines by their anchor from read output (e.g. pos: "6#PM").
- Operations: replace (pos to end, both lines included), insert_after, insert_before.
- When using replace for single-line replacements, you MUST set pos to end to the same line anchor.
- Never include LINE#HASH: prefixes in content.
- Make the minimum exact edit. Do not rewrite, reformat, or clean up unrelated code.
- content must use matching indentation. If the file uses tabs, use real tabs.
- Before submitting an edit, check that the result will not duplicate adjacent lines or drop required lines such as braces, return statements, or closing delimiters.
- When replacement content ends with a closing delimiter like }, */, ), or ], verify end includes the original line carrying that delimiter.
- When adding a sibling declaration or block, prefer insert_before on the next sibling so the new code lands in the intended scope.
