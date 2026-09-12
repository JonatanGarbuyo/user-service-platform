# Part C — Type-Level Programming & Libraries (Referents)

Leading-word definitions reproduced verbatim from the condensed reference.
Each `## ` heading is one complete technique: the concept, the code, when to
use it, and its tradeoff. Source: `TYPESCRIPT-TECHNIQUES-CONDENSED.md` Part C.

## typeLevelCorrespondence

> Every runtime concept has a type-level twin: `if` → conditional, destructuring → `infer`, loop → recursion, linked list → tuple.

```ts
type If<C, A, B> = C extends true ? A : B;                       // if/else
type Head<T extends any[]> = T extends [infer h, ...any[]] ? h : never; // destructure
type Reverse<T extends any[]> = T extends [infer h, ...infer t] ? [...Reverse<t>, h] : [];
```

When to use: stuck on a hard type problem — ask "what is the runtime equivalent?" and translate it mechanically.
Tradeoff: none; it's a mindset, not a construct.

## unionDistribution

> `T extends U ? A : B` runs once *per union member* — the single fact behind `Exclude`, `Extract`, `NonNullable`, and every distributive utility.

```ts
type Exclude<U, E> = U extends E ? never : U;
type Drive<L> = L extends "green" ? "go" : "stop";
// Drive<"red" | "green"> → "stop" | "go"
```

When to use: any union utility; also the footgun — to compare two types as a *pair*, wrap in a tuple `[a, b] extends [...]` (see `XOR` in the workshop).
Tradeoff: surprises when you wanted whole-union logic and got per-member.

## inferPattern

> `infer X` is type-level destructuring/pattern-matching — capture part of a type without naming it.

```ts
type UnwrapPromise<I> = I extends Promise<infer A> ? A : I;
type FirstLetter<W> = W extends `${infer F}${infer _}` ? F : "";
type GetHex<C> = C extends "red" ? "#f00" : C extends "green" ? "#0f0" : "#fff";
```

When to use: unwrap wrappers, match literal structure, extract from template literals — the type-level equivalent of `case` on a shape.
Tradeoff: `infer` only works inside a conditional's `extends` clause.

## tupleAsLinkedList

> Tuples are the recursive data structure of the type system — recursion over them is the type-level loop.

```ts
type Reverse<T extends any[]> = T extends [infer h, ...infer t] ? [...Reverse<t>, h] : [];
type Every<T extends any[]> = T[number] extends true ? true : false; // non-recursive form
```

When to use: algorithms over ordered structures. Always look for the indexed-access one-liner first (`T[number]`) before writing recursion.
Tradeoff: deep recursion hits the type-instantiation limit; keep tuples short.

## keyRemapping

> `as` in a mapped type re-maps keys — rename, filter, transform — with `keyof T & string` to reach literal ops.

```ts
type Getters<T> = { [k in keyof T & string as `get_${k}`]: () => T[k] };
type Lower<T> = { [k in keyof T & string as Lowercase<k>]: T[k] };
```

When to use: derived object shapes (getter/event-name maps, case-converted keys).
Tradeoff: `keyof T & string` is required or template literals can't operate on non-string keys.

## collectKeys

> `{...}[keyof T]` turns a mapped type into a union — the "collect keys matching a condition" idiom.

```ts
type KeysToOmit<T, V> = { [k in keyof T]: T[k] extends V ? never : k }[keyof T];
type OmitByValue<T, V> = { [k in KeysToOmit<T, V>]: T[k] };
```

When to use: filter keys by *value type* instead of by name (Omit by value).
Tradeoff: reads dense; worth a comment on the double indexed access.

## urlParamInference

> Parse route strings at the type level, then enforce the params object at the call site.

```ts
function createURL<T extends string>(path: T, params: ExtractUrlParams<T>): string;
// createURL("org/:orgId/dashboard(/:id)", { orgId: "2" });        // ok, id optional
// createURL("org/:orgId/dashboard(/:id)", { dashboardId: "2" });  // error: orgId missing
```

When to use: typed routing, typed query builders, any string-DSL you want validated.
Tradeoff: the extractor is real recursion + template literals; keep the DSL small.

## typeFunctions

> A type function is an interface with a phantom `rawArgs` symbol slot + `this['argN']` accessors; `Apply` fills the slot, `return` reads it.

```ts
export interface Fn { [rawArgs]: unknown; args: this[rawArgs] extends infer A extends unknown[] ? A : never; return: unknown; }
type Apply<f extends Fn, args extends unknown[]> = (f & { [rawArgs]: args })["return"];
type Pipe<acc, xs extends Fn[]> = xs extends [infer f extends Fn, ...infer rest extends Fn[]] ? Pipe<Apply<f, [acc]>, rest> : acc;
// Pipe<1, [Numbers.Add<1>, Numbers.Negate]> → -2
```

When to use: composable type-level functions, hotscript-style libraries, partial application with placeholders.
Tradeoff: heavy machinery — only worth it when you *compose* many functions, not for one-off types.

## unionToIntersection

> Distribute a union into function-argument position, then infer the whole signature — function-arg unions collapse via contravariance.

```ts
type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void ? I & U : never;
// UnionToIntersection<{a:1} | {b:2}> → {a:1} & {b:2}
```

When to use: merging union members, `F.Narrow`, merge utilities — the classic "collapse a union" trick.
Tradeoff: ordering of `&` members is unspecified; rely on it only for merge semantics.

## literalUnion

> `'a' | 'b' | string` kills IDE autocomplete for the literals; the intersection form keeps suggestions.

```ts
type LiteralUnion<L, P> = L | (P & {});
type Pet = LiteralUnion<'dog' | 'cat', string>; // literals still suggested
```

When to use: API params that accept any string but should suggest known values.
Tradeoff: only affects editor hints, not assignability — type-fest documents this.

## distributedPickOmit

> Built-in `Pick`/`Omit` on a union merge members; the distributed versions keep member-specific keys.

```ts
type DistributedOmit<U, K> = U extends any ? Omit<U, K> : never;
// Omit<A | B, 'foo'>          → { discriminant: 'A' | 'B' }      (useless)
// DistributedOmit<A | B, 'foo'> → { discriminant: 'A'; a: number } | { discriminant: 'B'; b: string }
```

When to use: transforming discriminated unions per-member instead of across the merge.
Tradeoff: the result is a union again — fine for sums, wrong for shared-key records.

## mergeOverIntersection

> `A & B` produces `never` on conflicting keys; `Merge` overrides instead.

```ts
// Merge<{a: string}, {a: number}> → {a: number}   (not never)
// Merge also flattens via Simplify, so tooltips show the resolved type
```

When to use: composition where a key is redefined; `&` is for orthogonal records only.
Tradeoff: `&` is the native operator; `Merge` is a utility you must remember to import.

## exactExtraKeys

> Excess-property checks only fire on *object literals*; `Exact` marks extra input keys `never` so structural values also fail.

```ts
type Exact<P, I> = { [K in keyof P]: Exact<P[K], I[K]> } & Record<Exclude<keyof I, keyof P>, never>;
```

When to use: strict config/param objects that arrive as variables, not literals.
Tradeoff: recursive + a `Record<..., never>` merge — only reach for it at real trust boundaries.

## taggedBrand

> Brand/opaque types + smart constructors — a `string` that only a parser can produce. The type-fest spelling of `parseDontValidate`.

```ts
type TagContainer<T> = { readonly [tag]: T };
type Tagged<T, Token> = T & { readonly [tag]: Token };
// Tagged<string, 'Email'> — produced only by parseEmail
```

When to use: refined primitives (Email, UserId) — always paired with a constructor that enforces the invariant.
Tradeoff: runtime value is unchanged; the brand is erased — enforce at boundaries only.

## narrow

> Wrap a generic param so call sites infer *literal* tuples/objects instead of widening.

```ts
declare function foo<A extends any[]>(x: F.Narrow<A>): A;
const t = foo(['e', 2, true, { f: ['g'] }]); // literal tuple inferred, not (string|number|boolean|...)[]
```

When to use: config arrays/objects whose literal values must survive inference (e.g. `as const` behavior without `as const`).
Tradeoff: recursion into shape preserves literals at every depth — the classic implementation is `NarrowRaw` (ts-toolbelt).

## expectEqual

> `Expect<Equal<A, B>>` is the type-level assertion primitive — write your utility against its test-cases.

```ts
import type { Equal, Expect } from '@type-challenges/utils';
type cases = [Expect<Equal<DeepReadonly<X>, Expected>>]; // type-error if wrong
```

When to use: verifying type utilities; the 189-challenge bank is the drill set for every pattern in Part C.
Tradeoff: `Equal` is exact structural equality — a stricter bar than assignability.

## noUnsafe

> Type-aware lint rules (`no-unsafe-*`, `no-unnecessary-*`, `consistent-type-*`, `strict-boolean-expressions`) make bad type usage fail loudly.

When to use: enforce boundary hygiene at scale — force `unknown` narrowing, ban unsafe member access, require `type` imports.
Tradeoff: these are the *project rules* view of what Part A/B/C teach; enable the type-checked parser to get them.

## schemaInference

> One schema object is both the validator and the source of the type: `z.infer` reads the output slot.

```ts
const User = z.object({ id: z.string(), email: z.string().email() });
type User = z.infer<typeof User>; // { id: string; email: string }
User.parse(someUnknown);           // validated + typed from the same object
```

When to use: runtime validation + static type from one source (parse-don't-validate at runtime); `safeParse` gives a total `{ data } | { error }`.
Tradeoff: the type is derived, so hand-written interfaces can drift; schema and type can never disagree.

## inferFromDefaults

> Overload the primitive cases, then a generic fallback; infer `T` from the passed value so callers write no type args.

```ts
export function useStorage(key: string, defaults: MaybeRefOrGetter<string>): RemovableRef<string>;
export function useStorage(key: string, defaults: MaybeRefOrGetter<number>): RemovableRef<number>;
export function useStorage<T>(key: string, defaults: MaybeRefOrGetter<T>): RemovableRef<T>;
// const n = useStorage('count', 0); // RemovableRef<number> — no <number> at the call site
```

When to use: library APIs whose return type should follow the input value (`useStorage`, config builders).
Tradeoff: overloads multiply as primitives grow; keep the generic fallback last.

## satisfies

> Validate a value against a type WITHOUT adopting it — keep the literal inference.

```ts
const palette = { red: [255, 0, 0], blue: [0, 0, 255] }
  satisfies Record<string, readonly [number, number, number]>;
// palette.red is [255, 0, 0] (narrowed), but palette.blue.push(0) errors
```

When to use: "check against a type, don't adopt it" — the modern fix for the `as const`-vs-`as Type` dilemma.
Tradeoff: native (TS 4.9+); replaces many hand-rolled `LiteralUnion`-style workarounds.

## exactOptionalFlag

> With `exactOptionalPropertyTypes`, `{ x?: T }` does NOT mean `{ x: T | undefined }` — absence is the only "not set".

```ts
// exactOptionalPropertyTypes: true
const c: { x?: number } = { x: undefined }; // error — omit the key instead
```

When to use: enabling strictness flags; the compiler-level enforcement of Part A's `noBoolInRecord` / `illegalStatesUnrepresentable`.
Tradeoff: flag-based, so it's per-project; code written for it fails on projects without it.

