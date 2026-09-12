---
name: better-typescript
description: Use when writing, reviewing, or teaching TypeScript code that involves type design. Trigger words and techniques — union types, `satisfies`, generics, `any`→`unknown`, branded types, mapped types, optional/exact keys, `as const`, literal union autocomplete, the `infer` pattern, `input`/`output` inference, `type-level` programming, `exactExtraKeys`, `mergeOverIntersection`, `distributedPickOmit`, `UnionToIntersection`, `typePredicate`, `assertionFunction`, `functionOverloads`, `threeLevels`. Use to review existing code (detect anti-patterns and suggest the correct leading-word technique) and to teach a type technique to a human.
---

# better-typescript

A leading-word skill. Each **leading word** names a complete, self-contained
TypeScript technique (concept + code + when-to-use + tradeoff). The body below
is only the router: when a trigger fires, halt here, consult the **master
index**, and open the owning reference file for the full technique.

Sources: Part A is constructive data modeling (Alexis King); Part B is type
mechanics (Matt Pocock); Part C is type-level programming and libraries (the
referents). Techniques and code are kept verbatim from the condensed reference.

## Entry workflow

1. **Detect the trigger.** A user or agent is writing, reviewing, or teaching
   TypeScript — or they name a leading word (e.g. "use `nonEmptyList` here",
   "collapse this union").
2. **Halt.** Do not re-explain from memory. A leading word's full definition
   lives in exactly one reference file.
3. **Consult the master index.** Find the leading word → owning file.
4. **Open only that file** and read that `## ` section. Read the neighboring
   sections only if you need more signal; each entry is self-contained.
5. **Apply / review / teach.** For review, see `references/review.md`. For
   teaching a leading word to a human, see `references/teach.md`.
6. **Back-reference.** When you use a word, name it for the human
   (e.g. "that's `parseDontValidate`, see `references/design.md`").

## Files

- `references/design.md` — Part A · data modeling (King), 16 leading words.
- `references/mechanics.md` — Part B · type mechanics (Pocock), 13 leading words.
- `references/type-level.md` — Part C · type-level programming & libraries, 21 leading words.
- `references/review.md` — anti-pattern → technique review checklist.
- `references/teach.md` — protocol to explain a leading word to a human.

## Master index (leading word → reference file)

| Leading word | File |
|---|---|
| positiveSpace | references/design.md |
| addDontSubtract | references/design.md |
| nonEmptyList | references/design.md |
| illegalStatesUnrepresentable | references/design.md |
| ior | references/design.md |
| decoupleRepresentation | references/design.md |
| obligationPropagation | references/design.md |
| totalFunctions | references/design.md |
| strengthenArgumentNotReturn | references/design.md |
| pushObligationsUp | references/design.md |
| parseDontValidate | references/design.md |
| smartConstructor | references/design.md |
| noBoolInRecord | references/design.md |
| avoidDenormalizedData | references/design.md |
| speedBumpTypes | references/design.md |
| dontOverType | references/design.md |
| widenLiteral | references/mechanics.md |
| nonFalsy | references/mechanics.md |
| noInfer | references/mechanics.md |
| anyToUnknown | references/mechanics.md |
| additiveOverloadsBreakUnions | references/mechanics.md |
| noPositiveOnlyTypeGuard | references/mechanics.md |
| typeParamDefault | references/mechanics.md |
| constraintsRestrictNotErase | references/mechanics.md |
| tArgsExtendsAny | references/mechanics.md |
| typePredicate | references/mechanics.md |
| assertionFunction | references/mechanics.md |
| functionOverloads | references/mechanics.md |
| threeLevels | references/mechanics.md |
| typeLevelCorrespondence | references/type-level.md |
| unionDistribution | references/type-level.md |
| inferPattern | references/type-level.md |
| tupleAsLinkedList | references/type-level.md |
| keyRemapping | references/type-level.md |
| collectKeys | references/type-level.md |
| urlParamInference | references/type-level.md |
| typeFunctions | references/type-level.md |
| unionToIntersection | references/type-level.md |
| literalUnion | references/type-level.md |
| distributedPickOmit | references/type-level.md |
| mergeOverIntersection | references/type-level.md |
| exactExtraKeys | references/type-level.md |
| taggedBrand | references/type-level.md |
| narrow | references/type-level.md |
| expectEqual | references/type-level.md |
| noUnsafe | references/type-level.md |
| schemaInference | references/type-level.md |
| inferFromDefaults | references/type-level.md |
| satisfies | references/type-level.md |
| exactOptionalFlag | references/type-level.md |
