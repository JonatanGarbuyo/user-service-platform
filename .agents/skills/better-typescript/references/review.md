# Review axis — anti-pattern → technique checklist

A checklist for reviewing existing TypeScript code. When you spot a bad
pattern below, name the leading word, open its owning reference file, and
apply that technique. The `noUnsafe` lint rules (`no-unsafe-*`,
`no-unnecessary-*`, `consistent-type-*`, `strict-boolean-expressions`) are the
detectors; the leading words are the cures — see
`references/type-level.md` under `noUnsafe`.

## Design / data modeling (Part A — `references/design.md`)

| Anti-pattern (what bad looks like) | Fix (leading word) |
|---|---|
| Types seen as restrictions; values "carved," out of a bigger set | `positiveSpace` |
| A refined type feels impossible; reached for refinement machinery | `addDontSubtract` |
| `T[]` plus a "should never be empty" throw | `nonEmptyList` |
| Two optional fields + a comment ("at least one must be set") | `illegalStatesUnrepresentable` |
| "One, other or both" encoded as booleans + optional fields | `ior` |
| A model locked to a single privileged shape | `decoupleRepresentation` |
| A variant added; exhaustive matches stop compiling until handled | `obligationPropagation` |
| `panic("shouldn't happen")` scattered through a function | `totalFunctions` |
| Failure ruled out at the return; every caller repeats `\| undefined` | `strengthenArgumentNotReturn` |
| `null` handling spread across interior logic | `pushObligationsUp` |
| A validator that throws and returns nothing (droppable) | `parseDontValidate` |
| An invariant shape can't express (ranges, non-zero) | `smartConstructor` |
| An `isSomething: boolean` flag in a record models state | `noBoolInRecord` |
| Denormalized fields / caches that can drift out of sync | `avoidDenormalizedData` |
| A wrapper type added speculatively, bought no safety | `speedBumpTypes` |
| Ceremony without a bug-preventing constraint | `dontOverType` |

## Type mechanics (Part B — `references/mechanics.md`)

| Anti-pattern | Fix (leading word) |
|---|---|
| `Set`/`.includes` rejects a widened literal | `widenLiteral` |
| `.filter(Boolean)` result keeps falsy members | `nonFalsy` (+ `noInfer`) |
| Contextual typing picks the wrong type parameter | `noInfer` |
| `any` at untrusted data boundaries (`JSON.parse`, `.json()`, `isArray`) | `anyToUnknown` |
| A duplicated overload on a union-typed caller fails | `additiveOverloadsBreakUnions` |
| `.includes` typed as a type guard (wrong in the `else`) | `noPositiveOnlyTypeGuard` |
| A no-arg generic call falls back to `unknown` | `typeParamDefault` |
| An `extends` constraint erases the caller type | `constraintsRestrictNotErase` |
| A function-wrapper loses `...args`/result inference | `tArgsExtendsAny` |
| `unknown` narrowed by scattered `if`s | `typePredicate`, `assertionFunction` |
| One signature can't express distinct call shapes | `functionOverloads` |
| Advanced toolkit used where application-level suffices | `threeLevels` |

## Type-level & libraries (Part C — `references/type-level.md`)

| Anti-pattern | Fix (leading word) |
|---|---|
| Stuck with no runtime analogy | `typeLevelCorrespondence` |
| Wanted whole-union logic, got per-member | `unionDistribution` |
| Capturing part of a type without naming it | `inferPattern` |
| Recursive loop when an indexed access works | `tupleAsLinkedList` |
| Remapping keys on derived object shapes | `keyRemapping` |
| Filtering keys by value type, not name | `collectKeys` |
| Untyped route/query strings | `urlParamInference` |
| Composing many type transforms | `typeFunctions` |
| Merging union members into one shape | `unionToIntersection` |
| Literal union kills IDE suggestions | `literalUnion` |
| `Pick`/`Omit` on a union merges all members | `distributedPickOmit` |
| `A & B` becomes `never` on conflicting keys | `mergeOverIntersection` |
| Excess keys slip in on variables | `exactExtraKeys` |
| Opaque primitive with no producing constructor | `taggedBrand` |
| Literal inference lost on call-site arrays/objects | `narrow` |
| No test-case for a type utility | `expectEqual` |
| Bad `any` usage not failing at scale | `noUnsafe` |
| Runtime validator vs hand-typed static type | `schemaInference` |
| Library return type should follow the passed value | `inferFromDefaults` |
| "Check as a type but keep literals" | `satisfies` |
| `{ x?: T }` accidentally allows `{ x: undefined }` explicitly | `exactOptionalFlag` |

## Procedure

1. Grep for smells in the anti-pattern column and name them (e.g. "this is
   `parseDontValidate` being skipped").
2. Open the fix leading word's section in its owning file under
   `references/` — verbatim technique to cite.
3. Flag what is bad, name the exact leading word and file, offer the verbatim
   fix from that section.
4. If the human wants the rationale explained rather than patched, hand off to
   `references/teach.md`.
