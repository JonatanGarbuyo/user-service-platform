# Part B — Type Mechanics (Matt Pocock)

Leading-word definitions reproduced verbatim from the condensed reference.
Each `## ` heading is one complete technique: the concept, the code, when to
use it, and its tradeoff. Source: `TYPESCRIPT-TECHNIQUES-CONDENSED.md` Part B.

## widenLiteral

> Accept a literal type *or* its widened primitive at the argument position.

`Set<"GET" | "POST">.has("GET")` fails because `"GET"` widens to `string`,
which isn't assignable to the literal union. Fix: accept both, via
`T | (WidenLiteral<T> & {})`.

```ts
type WidenLiteral<T> = T extends string ? string
  : T extends number ? number
  : T extends boolean ? boolean
  : T extends bigint ? bigint
  : T extends symbol ? symbol
  : T;

interface Set<T> {
  has(value: T | (WidenLiteral<T> & {})): boolean;
}
```

When to use: augmenting `.includes`/`.has`/`.indexOf` on literal-typed
containers. The `& {}` keeps overload resolution on the right overload and
stops `WidenLiteral` swallowing object types.
Tradeoff: the signature is denser; only needed when container keys are
literal unions.

## nonFalsy

> Strip falsy values from a type — the type-level companion to
> `.filter(Boolean)`.

```ts
type NonFalsy<T> = T extends false | 0 | "" | null | undefined | 0n ? never : T;

// result: NonFalsy<noInfer<S>>[] — array without falsy members
```

When to use: typing `.filter(Boolean)` so the result type matches runtime.
Tradeoff: needs `NoInfer` too, or contextual typing breaks the element check.

## noInfer

> Stop contextual typing from flowing backward through a type parameter.

Without `NoInfer<S>`, the surrounding context picks `S` and silently skips the
structural check on array elements.

```ts
interface Array<T> {
  filter<S extends T>(
    predicate: BooleanConstructor,
    thisArg?: any,
  ): TSReset.NonFalsy<NoInfer<S>>[];
}
```

When to use: any augmented method where the generic must be inferred purely
from the argument, not the return/context.
Tradeoff: `<S extends T>` remains only for overload resolution — inference is
dead, by design.

## anyToUnknown

> Replace `any` returns with `unknown` to force explicit narrowing at every
> consumer.

The core ts-reset move: `JSON.parse`, `fetch().json()`, and `Array.isArray`
all lose information by typing `any`.

```ts
interface JSON {
  parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown;
}
interface Body { json(): Promise<unknown>; }
interface ArrayConstructor { isArray(arg: any): arg is unknown[]; }
```

When to use: boundaries that hand you untrusted data should give you
`unknown`, not `any` — callers must narrow before use.
Tradeoff: migration cost; existing `any` consumers now need explicit checks.

## additiveOverloadsBreakUnions

> Declaration merging can only *add* overloads, never replace them — and
> additive overloads break union callers.

Overriding `Promise.catch`'s `any` reason to `unknown` adds a second overload;
on a union of promises (`Promise<number> | Promise<void>`) no single overload
fits, and the call fails to resolve.

```ts
// Promise<T> | Promise<U>  +  duplicated .catch overload  ⇒  "not callable"
// workaround: use Promise<T | U> instead of a union of promises
```

When to use: before augmenting a built-in method signature — check whether the
duplicate overload will break union-typed callers.
Tradeoff: none available — it's a hard limit of the type system; keep the
augmentation opt-in, not in `recommended`.

## noPositiveOnlyTypeGuard

> Type-guard narrowing is exhaustive in the *else* branch — so a runtime
> membership check can't be a type guard.

`[400, 404].includes(status)` narrows correctly in the `if` but wrongly in the
`else` (it assumes the array exhausts all values of `T`).

```ts
if ([400, 404].includes(status)) {
  // status: 400 | 404 — correct
} else {
  // status: 500 — WRONG; the array isn't guaranteed exhaustive
}
```

When to use: to *avoid* typing `.includes` as a type guard — TypeScript has no
"positive-only" guard.
Tradeoff: there is no safe version; keep `includes` returning `boolean`.

## typeParamDefault

> One keyword turns a no-arg generic call from `unknown` into something safe.

```ts
const createStringMap = <T = string>() => new Map<string, T>();

createStringMap();          // Map<string, string> — safe default
createStringMap<number>();  // Map<string, number> — explicit wins
```

When to use: any generic function where omitting the type argument is common
and `unknown` is the wrong fallback.
Tradeoff: a default can hide missing explicit types — keep defaults for the
sensible case.

## constraintsRestrictNotErase

> An `extends` constraint gates the input but preserves the full type in the
> output.

```ts
const addCodeToError = <TError extends { message: string; code?: number }>(
  error: TError,
) => ({ ...error, code: error.code ?? 8000 });

const e = addCodeToError(new Error("oh dear!"));
// type: Error & { code: number }   — TError preserved, not reduced to constraint
```

When to use: generic helpers that must both restrict arguments and keep the
caller's type in the return.
Tradeoff: the return type is an intersection; deeply-nested shapes can get
noisy.

## tArgsExtendsAny

> Type a higher-order function that wraps another function's signature while
> keeping args and result inferred.

```ts
type PromiseFunc<TArgs extends any[], TResult> = (...args: TArgs) => Promise<TResult>;

const safeFunction =
  <TArgs extends any[], TResult>(func: PromiseFunc<TArgs, TResult>) =>
  async (...args: TArgs) => {
    try { return await func(...args); }
    catch (e) { if (e instanceof Error) return e; throw e; }
  };
```

When to use: wrappers, decorators, memoizers — anything that takes a function
and returns a function. `extends any[]` is the standard "any tuple of args"
constraint (plain `TArgs` breaks the `...args` spread).
Tradeoff: the signature is intimidating at first read; the inference payoff is
worth it.

## typePredicate

> A function that narrows its input via `value is X` — the `if`-branch is
> refined by the full runtime check.

```ts
const hasDataAndId = (value: unknown): value is { data: { id: string } } =>
  typeof value === "object" && value !== null &&
  "data" in value && typeof value.data === "object" && value.data !== null &&
  "id" in value.data && typeof value.data.id === "string";

if (hasDataAndId(x)) { x.data.id; /* string */ }
```

When to use: parsing/guarding `unknown` input — the runtime check and the type
narrowing live in one function.
Tradeoff: the predicate body is on you — a wrong check silently lies about the
type.

## assertionFunction

> Narrow by *throwing*: after the call, the narrowing is unconditional — no
> `if` needed.

```ts
function assertIsAdminUser(user: User | AdminUser): asserts user is AdminUser {
  if (!("roles" in user)) throw new Error("User is not an admin");
}

const handleRequest = (user: User | AdminUser) => {
  assertIsAdminUser(user);
  user.roles; // AdminUser — narrowed with no if/else
};
```

When to use: guard clauses that must hold for the rest of the function —
fail-fast instead of branch-narrow.
Tradeoff: an assertion throws by contract; callers can't recover from the
narrowing being false.

## functionOverloads

> Multiple public signatures over one implementation signature — callers see
> the overloads, not the union.

```ts
function sum(values: { a: number; b: number }): number;
function sum(a: number, b: number): number;
function sum(valuesOrA: { a: number; b: number } | number, b?: number): number {
  return typeof valuesOrA === "object" ? valuesOrA.a + valuesOrA.b : valuesOrA + b!;
}
```

When to use: when generics can't express distinct call shapes (e.g. object *or*
two numbers). The implementation signature must be compatible with all
overloads.
Tradeoff: the implementation often needs assertions (`b!`) because its params
are a union.

## threeLevels

> Three levels of TypeScript complexity: application → library → utils-folder.

- **Application:** plain typed app code — objects, unions, generics at call
  sites.
- **Library:** generic types and functions *you ship* to be used by others.
- **Utils folder:** generic functions that *make* functions and compose with
  inference — `safeFunction`, `assertIsAdminUser`, `sum`.

```ts
// utils level: a generic wrapper whose signature is built from its argument
const safeFunction =
  <TArgs extends any[], TResult>(func: PromiseFunc<TArgs, TResult>) =>
  async (...args: TArgs) => { /* ... */ };
```

When to use: to know which toolkit a technique belongs to — most "advanced
TypeScript" lives at the utils-folder level.
Tradeoff: writing utils-folder code without the vocabulary mislabels it as
"application type complexity."

