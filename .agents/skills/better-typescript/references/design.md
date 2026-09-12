# Part A — Data Modeling (Alexis King)

Leading-word definitions reproduced verbatim from the condensed reference.
Each `## ` heading is one complete technique: the concept, the code, when to
use it, and its tradeoff. Source: `TYPESCRIPT-TECHNIQUES-CONDENSED.md` Part A.

## positiveSpace

> Define the set of values you *want* — not the set you must exclude.

Most people see types as restrictions (`unknown` is the universe; each type is
a smaller bubble inside it). That leads to wanting refinement types ("an `int`
≥ 0"), which almost no language has. Instead, a type constructor *introduces*
values: build what you want by shape, don't carve it out of a bigger set.

```ts
// restriction (fragile): Natural = Int where >= 0  — needs refinement, hard
// constructive (total):   a dedicated type with only valid values
type Duration = NonNegative<number>; // branded number, produced by a parser
```

When to use: any invariant that "should always hold" — encode it in the
constructor's shape rather than asserting it after the fact.

Tradeoff: needs a brand/smart constructor; the check lives in one place.

## addDontSubtract

> It's easier to add than to subtract.

Extending the set of possible values is trivial; restricting it is hard.

```ts
// build signed from unsigned by adding a sign — not by restricting an int
type Integer = { negative: boolean; magnitude: NonNegative<number> };
// vs Natural = Int where >= 0  (refinement: expensive machinery, few languages)
```

When to use: when a "refined" type feels impossible, model the value as a
product of things you already have.

Tradeoff: sometimes verbose; the constructive encoding may not match the
runtime representation you want.

## nonEmptyList

> A list the type guarantees has at least one element — an invariant encoded
> by shape, not by comment or validation.

A non-empty list *is* one element plus zero-or-more more (a product type).

```ts
type NonEmptyList<T> = [T, ...T[]];

// fragile: T[] + "should never be empty" throw
// total:   the argument type rules out the empty case
function latestTimestamp(log: NonEmptyList<{ timestamp: number }>): number {
  return log[0].timestamp; // no throw — impossible to call on empty
}
```

When to use: any consumer that would otherwise panic on the empty case
(`head`, `first`, `getLastChanged`). Strengthen the *argument*, don't weaken
the return.

Tradeoff: loses some `Array`-interface compatibility (e.g. can't `clear()`);
and fancy features like `[T, ...T[]]` are fine when your language has them.

## illegalStatesUnrepresentable

> Make invalid states impossible to express, so the compiler rejects them.

If ruling out a bad case is hard with your encoding, change the encoding — the
type system then finds every place that needs updating.

```ts
// fragile: two optional fields + comment ("at least one must be set")
// total:   a sum type with no empty contact state
type UserContact =
  | { kind: "email"; email: string }
  | { kind: "phone"; phone: string }
  | { kind: "both"; email: string; phone: string };

type User = { id: number; contact: UserContact };
```

When to use: whenever a record would otherwise need an invariant comment or a
validation that can be skipped.

Tradeoff: more types to write; occasionally the encoding fights your data
layout.

## ior

> "One, other, or both" — the shape for mutually-optional-but-not-optional
> fields, abstracted.

The talk's `Ior<A,B>` (`Left | Right | Both`) is the generic version; prefer
the fit-for-purpose concrete type (a boring name that adapts as the model
grows).

```ts
type UserContact =
  | { kind: "system" }
  | { kind: "email"; email: string }
  | { kind: "phone"; phone: string }
  | { kind: "both"; email: string; phone: string };
```

When to use: "at least one of X or Y must be set" — never two `Option` fields
plus a `Boolean` flag.

Tradeoff: adding a third option (e.g. a `System` user) is a new variant, not a
new flag — which is exactly what you want.

## decoupleRepresentation

> Data has no single "privileged" representation — pick the one that fits the
> code you're writing.

"My data *is* an array" is a trap. Reframe: "my data is a sequence of zero-or-
more elements, which *can be represented* by an array."

```ts
// ascribing the array type is a choice, not a fact
type Sequ = T[];                       // zero or more
type NonEmpty<T> = [T, ...T[]];        // one or more — same data, other lens
type Pairs<T> = [T, T][];              // always in pairs
```

When to use: when a type seems to force a representation that doesn't fit —
the data can wear several types.

Tradeoff: representation changes ripple through consumers; sometimes wrapping
back is not worth it.

## obligationPropagation

> A type system is an obligation-propagation machine: producers far away
> force consumers to handle every case.

Adding a variant makes every exhaustive match stop compiling until handled —
including consumers arbitrarily far away (through call chains or a DB
round-trip).

```ts
type UserType = "standard" | "admin" | "system" | "api"; // +api

function authorize(user: UserType): void {
  // compiler lists every case you forgot:
  switch (user) {
    case "standard": break;
    case "admin":    break;
    case "system":   break;
    // error: not all code paths... 'api' not handled
  }
}
```

When to use: when the burden is "the compiler reminds me of every place that
cares when my data grows."

Tradeoff: added variants are *work* — every consumer must do something, even
"can't happen."

## totalFunctions

> Write functions with no failure path — eliminate `panic("shouldn't
> happen")` instead of scattering it.

Pick the simplest representation that lets you write as few panics as
possible. If a function can fail, make the *input* type rule the failure out.

```ts
function totalChange(log: { change: number }[]): number {
  return log.reduce((acc, e) => acc + e.change, 0); // empty ⇒ 0, fine
}
function latestTimestamp(log: [T, ...T[]]): number {
  return log[0].timestamp; // total: empty is unrepresentable, no throw
}
```

When to use: every "should never happen" throw is a smell — treat it like a
radioactive substance: remove it, or isolate and document it.

Tradeoff: pushing every impossible case into the type is sometimes more work
than it's worth; pick your battles.

## strengthenArgumentNotReturn

> Rule out failure at the *input* instead of forcing every caller to handle an
> impossible result.

`head :: NonEmpty a -> a` is total; `head :: [a] -> Maybe a` forces each caller
to handle a `Nothing` that can't happen.

```ts
// weak return:  latestTimestamp(log: T[]): number | undefined
// strong arg:   latestTimestamp(log: [T, ...T[]]): number   — no handling needed
```

When to use: when callers would otherwise pattern-match an impossible case
over and over.

Tradeoff: the strong-argument version rejects legal-but-empty call sites — you
must prove non-emptiness at those boundaries.

## pushObligationsUp

> Parse at the boundary, then run the interior on narrow types with no error
> handling.

`Option<T>` can be *more* restrictive than `T` depending on where the
obligation lands. Choose which side carries the burden by changing the types.

```ts
// Option<T> pushes handling onto every consumer
function notify(user: User | null): void { /* must handle null */ }

// T pushes the obligation up to the callers: they must produce a User
function notify(user: User): void { /* total, no null case */ }
```

When to use: you decide where failure handling happens — at the system boundary
(API/DB/input) or inside. Move obligations to the places best equipped.

Tradeoff: whichever side you burden pays the cost; choose per the code you
actually write.

## parseDontValidate

> Return the refined value — don't check-and-forget.

`assertEmailFormat(s): void` can be dropped without breaking compilation. A
parser returns a branded value only it can produce, so the check can't be
skipped.

```ts
type Email = string & { readonly __brand: "email" }; // branded type

function parseEmail(s: string): Email {
  if (!/^[^@]+@[^@]+$/.test(s)) throw new Error("bad email");
  return s as Email; // only this function can produce an Email
}
```

When to use: any validator — prefer one that returns the refined value over
one that throws-and-returns-nothing.

Tradeoff: branding lives at boundaries; interior code must receive the brand
from somewhere trusted.

## smartConstructor

> Make validators "look like" parsers with abstract types when shape can't
> rule out the bad case.

When a representation can't structurally encode an invariant (e.g. an integer
in a range), hide the constructor behind an abstract type so the invariant is
maintained in one blessed place.

```ts
type NonNegative<T> = T & { readonly __brand: "NonNegative" };

function makeNonNegative(n: number): NonNegative<number> {
  if (n < 0) throw new Error("n must be >= 0");
  return n as NonNegative<number>;
}
```

When to use: invariants like ranges, non-zero, valid formats — anything shape
can't express.

Tradeoff: creates a "blessed surface area" that must hold the invariant;
stronger concrete encodings exist but don't always fit.

## noBoolInRecord

> Don't stick a `Bool` flag in a record because one function needs it.

A boolean flag reintroduces the exact invariant it was meant to mark (flag-iff-
state). Add a variant instead — let the datatype inform the code.

```ts
// fragile: isSystemUser: boolean + optional email/phone (invariant by comment)
// total:   a variant carries the state
type UserContact = { kind: "system" } | { kind: "email"; email: string } | ...;
```

When to use: whenever you reach for `isSomething: boolean` to model state.
Tradeoff: none real — the variant version is strictly more honest.

## avoidDenormalizedData

> Single source of truth; denormalize only behind one trusted abstraction.

Denormalized, mutable data is where invariants silently rot. If you must
denormalize, keep it behind one abstraction that maintains consistency.

```ts
// one object owns the truth; derived views are computed, not stored
const source = { email: "a@b.c", phone: "555" };
const contact = { email: source.email, phone: source.phone }; // derived
```

When to use: any cache, mirror, or derived field that can drift out of sync.
Tradeoff: computing on read costs a little more than a stale cache.

## speedBumpTypes

> Types that don't add safety — they slow you down where you keep making
> mistakes. Worth it only then.

`UserId` vs `PostId`, units, etc., don't add real type *safety*; they add a
"speed bump" against mistakes you make often. Keep them only if your team
actually keeps making that mistake.

```ts
// a speed bump: separate types for ids you confuse
type UserId = string & { __userId: true };
type PostId = string & { __postId: true };
```

When to use: only after a repeated mistake has been observed — not
speculatively.
Tradeoff: every boundary between the two types is friction.

## dontOverType

> Types as simple as possible, but no simpler.

An email is just a string handed to an email service — nobody inspects its
structure, so `string` is the right type. Don't model an `EmailAddress` type
everywhere.

```ts
// right: nobody inspects email structure
function sendEmail(to: string, body: string): void { /* ... */ }
// over-typed: Email brand bought nothing if no one branches on it
```

When to use: whenever a wrapper type adds ceremony but no constraint that
prevents a bug.
Tradeoff: you may under-type a boundary that later grows constraints — then
upgrade to a brand.

