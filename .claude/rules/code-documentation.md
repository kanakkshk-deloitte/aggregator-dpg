# Rule: Code Documentation

Every public class, method, and function must have a TSDoc comment. Private helpers (`_` prefix or unexported) should have one if the logic is non-obvious.

**Format:** Use TSDoc.

```typescript
/**
 * Assembles the full API prompt from NLU results and session history.
 *
 * @param request - Contains intent, entities, session history, and raw input.
 * @returns PromptResponse with the assembled system prompt and user message.
 * @throws {ValueError} If request.intent is null or empty.
 * @throws {KnowledgeEngineError} If RAG retrieval fails after retries.
 */
assemblePrompt(request: PromptRequest): Promise<PromptResponse> {
```

**Rules:**

- The first line is a single-sentence summary ending with a period.
- Add `@param` / `@returns` only when they say more than the name and type. Always document thrown exceptions (`@throws`).
- Do not restate the function name or describe _how_ it works — describe _what_ it does and _why_ the caller needs it.
- Module-level file comments must state the module's role within the DPG framework and which package it belongs to.

**Style (doc blocks and inline comments):**

- State facts about the current code in short, simple sentences.
- No dramatic wording, metaphors, or emphasis (ALL-CAPS words, "deliberately", "NOTE:").
- No history: no "used to", "was renamed", "since #123", PR, issue, review or plan-phase references. Git and PRs hold history.
- Keep each `@param` / `@returns` / `@throws` to one short line.
- Do not add inline comments that restate the code.
- Keep real constraints, stated plainly (e.g. "Never log this value.", "Must run in the caller's transaction.").
- Keep a one-sentence reason for any non-obvious choice.
