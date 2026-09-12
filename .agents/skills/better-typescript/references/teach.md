# Teach axis — how to explain a leading word to a human

Use this when a "teach" branch fires: the human wants a leading word *made
clear*, not just applied. Ground every sentence in the reference file the word
lives in; never improvise a technique beyond what the source says.

## Protocol

1. **Name the canonical definition.** Quote the leading word's one-line
   "> ..." summary from its section (the italic pull-quote at the top of the
   entry).
2. **Show the code.** Open the owning file (`references/design.md`,
   `references/mechanics.md`, or `references/type-level.md`), read the `## `
   section, and walk through the code block line by line — say what each line
   does, in runtime terms.
3. **Give the recipe.** Repeat the section's "When to use" exactly: the cases
   where this technique applies.
4. **State the tradeoff.** Quote the section's "Tradeoff" line so the human
   knows when NOT to reach for it — every leading word has a cost.
5. **Anchor with the file.** Point at the owning reference file and leading
   word (e.g. "that's `parseDontValidate`, see `references/design.md`") so they
   can go deeper — cite the skill's own files, never external source paths.
6. **Connect to neighbors.** If the human seems ready, cross-link to the
   counterpart leading words (e.g. teach `parseDontValidate` after
   `smartConstructor`, or `tupleAsLinkedList` before `unionDistribution`).
7. **One-pace recap.** End with a single-sentence definition they could reuse:
   "`nonEmptyList` means the type itself proves at least one element, so the
   empty case never needs handling."

## When teaching folds into review

If the context started as a review (`references/review.md`), first name the
bad pattern (the anti-pattern row), then switch into this protocol for the
explanation.

## Run-ahead defaults

- Definition too long to hold → give the pull-quote only, then the code, then
  offer to expand.
- If the human has "seen it before" → skip to the tradeoff and the
  neighbors step.
- Never invent: if a leading word you need is not in the master index, stop
  and say so rather than making one up.
