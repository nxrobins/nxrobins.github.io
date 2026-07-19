# Sigil — Two Frontiers Worth Claiming

**Status:** Draft · **Date:** 2026-07-19 · **Scope:** design/vision, not a spec

Sigil's edge is not out-optimizing LLVM on raw codegen — that race is lost before it starts. Its edge is that it may be the only *verified, capability-secure language being written by agents*. The frontiers worth claiming are therefore the ones where "well-positioned" and "never been done" actually overlap: the ones that **fuse verification with the agent-in-the-loop premise**.

Two qualify. Both build directly on pieces Sigil already has — a self-hosting typechecker, Z3-backed capability verification, taint tracking, fuel-metered execution, a two-ring security model, and verified lowering to Wasm.

- **Frontier 1 — Cost as a verified type.** Lift *fuel* from a runtime meter to a static, SMT-proven bound carried in the type. Sigil already has both halves nobody else combines: a cost model (fuel) and a prover (Z3).
- **Frontier 4 — The verifier inside the generation loop.** Move the verifier *into* the agent's decode loop, so unsafe or unbounded code is unemittable, and carry intent from prompt → proof → binary. This one is novel *because of Sigil's premise*, not merely a good fit for its tools.

They are not independent. Frontier 1 gives Frontier 4 something concrete to constrain on and attest to. The last section makes that composition explicit.

---

## Frontier 1 — Cost as a Verified Type

### The gap

Types today prove *what* a function computes. They say nothing about *how much it costs*. That omission is the root of a whole class of failures — unbounded computation, denial of service, runaway agents, unpredictable bills — that we currently catch (if at all) at runtime, as a trap, after the resources are already spent.

Sigil already meters fuel dynamically: each operation debits a budget, execution traps when the budget is exhausted. That is the *runtime* half. The frontier is the *static* half — proving, before the code ever runs, an upper bound on the fuel a function consumes as a function of its inputs, and carrying that bound in the type.

> Refinement types constrain *values* (`x: Int where x > 0`). Cost types constrain *consumption* (`f: … @ fuel ≤ 3·len(xs) + 8`). It is the missing non-functional half of the type system.

### The idea

Every function's type carries a symbolic upper bound on its fuel:

```sigil
// illustrative pseudocode — not Sigil's real grammar
fn dedupe(xs: List<T>) -> List<T>
    @ fuel <= 3 * len(xs) + 8
{
    ...
}
```

The compiler either **infers** the bound bottom-up or **checks** an annotated one. `dedupe` may now only be called in a context that can prove it affords `3·len(xs) + 8` fuel — a guarantee available at every call site, across module boundaries, without whole-program analysis.

### Design sketch

**1. The cost algebra.** Assign each primitive operation a symbolic fuel cost drawn from *the same table the runtime meter uses*. Compose bottom-up:

- sequencing → sum of costs
- branching → max (or a path-sensitive join under a known guard)
- calls → substitute the callee's published cost signature

**2. Loops and recursion — the hard part.** A `map`/`fold` over a list of known length has a syntactic bound. General `while`/recursion needs a *ranking function* and a *cost recurrence*. Solving recurrences is not Z3's job. The pragmatic, solver-friendly split is:

- **Author/agent annotates** the closed-form bound (e.g. `fuel ≤ 3·len(xs) + 8`).
- **Z3 discharges** the inductive step: assuming the bound holds for the recursive sub-call, does it hold for the whole? — the same shape as verifying any inductive invariant.

Bound *inference* (finding the template automatically) is a later refinement; bound *checking* is enough to ship.

**3. Z3's role is discharge, not discovery.** The solver answers validity queries: *for all inputs, is `actual_cost ≤ declared_bound`?* Keep the bound language inside a decidable fragment — linear integer arithmetic / Presburger — so queries stay robust. Polynomial bounds via templates are a stretch goal; unrestricted nonlinear arithmetic is where Z3 gets flaky, so it stays out of the core.

**4. The soundness anchor (the crux).** A static cost type is meaningless unless it *provably matches* the fuel the runtime actually charges. The obligation:

> For every operation, the fuel debited by the emitted Wasm equals the fuel counted in the static model.

This is a translation-validation-flavored property on the Sigil → Wasm lowering. Because Sigil already does verified lowering *and* already meters fuel, it is closer to discharging this than anyone. This sentence is what makes the feature "never been done in production" rather than "a linter."

**5. Composability — a genuine structural win.** Because each function *publishes* its cost signature, cost reasoning survives separate compilation. This sidesteps, for the cost dimension, the classic tension between modular builds and whole-program analysis that sinks traditional WCET tooling.

### What it unlocks: resource capabilities

This is the payoff that is uniquely Sigil's. Fuse cost types with the existing capability system and you get capabilities that gate *resources*, not just *permissions*:

```sigil
// a capability authorizing bounded compute
cap Compute(budget: Fuel)

// call rejected at COMPILE TIME if the callee's proven bound may exceed budget
with Compute(budget = 10_000) {
    let out = dedupe(xs);   // ok iff 3*len(xs)+8 <= 10_000 is provable here
}
```

"You may call this, but only if it provably costs ≤ X." Zero-trust extends from *what code may do* to *how much it may spend*. For a world of untrusted, agent-generated software running on metered compute, this is the natural — and currently missing — primitive: a cost contract enforced by the type system and attested by the binary.

### Where the frontier line actually is

Each ingredient has prior art; the *fusion* is new.

- **RAML** (Resource-Aware ML, Hoffmann) — automatic amortized analysis, the closest serious system. Research language; not capability-secure, not agent-native, no verified Wasm.
- **Liquid Haskell / TiML / RelCost** — refinement and cost-in-types work, all research-scoped.
- **EVM gas / Wasmtime fuel** — dynamic metering, zero static proof.

Novelty to claim: *static, SMT-verified cost as a first-class type, fused with capability security (resource capabilities), preserved through verified compilation to Wasm, in an agent-native language.*

### Risks / open questions

- **Precision vs. soundness.** Over-approximate bounds are always sound but may reject reasonable programs. Inference quality decides whether the feature is usable or merely correct.
- **Nonlinear cost.** Anything past linear/polynomial strains Z3. Mitigation: restrict the bound language; reject what can't be expressed decidably.
- **Cost-model fidelity.** If downstream Wasm engines don't honor the fuel model uniformly, wall-clock reality diverges from the proof (same failure mode as constant-time guarantees leaking at the JIT boundary). The guarantee is precise at the fuel-semantics level; be honest about where it stops.

### A tractable first milestone

Linear bounds only; annotations required (no inference); structural recursion only; Z3 discharges the inductive step; one `Compute` capability that gates calls against a static budget. Prove the fuel-fidelity lemma for the primitive-op table. Ship that, and the cost-type story is real — everything above it is refinement.

---

## Frontier 4 — The Verifier Inside the Generation Loop

### The premise shift

For sixty years the compiler has run *after* the human writes code. Sigil is written *by agents*. That relocates the verifier: types, capabilities, taint, and Z3 can move *inside* the generation loop, so that

- the agent literally **cannot emit** code that fails verification (constraint, not correction), and
- the **intent** that produced the code is carried as a first-class artifact — prompt → spec → code → proof → binary.

"The prompt is the medium," made literal and checkable.

### The ladder

Present it as a ladder from tractable to research-frontier — each rung is shippable on its own.

**Layer 0 — Syntax-constrained decoding.** *(Exists; baseline.)* Grammar-constrained decoding (GBNF, Outlines, guidance) guarantees syntactically valid Sigil. Table stakes.

**Layer 1 — Type-constrained decoding.** *(Emerging research.)* Filter each generation step to well-typed continuations: after `x.`, only fields/methods valid for `x`; an `Int` position can't be filled by a `String`. Sigil's self-hosting typechecker is the asset — driven incrementally, it is the oracle. Tractable for local constraints; harder where legality depends on not-yet-generated context (handled by unit-level backtracking, below).

**Layer 2 — Capability / taint-constrained decoding.** *(Beyond the general frontier — because these are Sigil's semantics.)* Mask any continuation that would use an ungranted capability, create a taint flow from secret to sink, or illegally cross the two-ring boundary. The agent *cannot express* a capability escalation. This is **generation-time capability confinement** — a security posture nobody has, because nobody has (agent-native) × (capability-secure) × (constrained decoding) in one system.

**Layer 3 — SMT in the loop.** *(The frontier.)* Two modes:

- **Verify-and-backtrack (proof-carrying generation).** The agent proposes a function plus its spec/invariant; Z3 checks; on failure the *counterexample* is fed back into context and the agent regenerates. The compiler's counterexamples become inference-time signal. Sigil can prototype a version of this today — Z3 is already integrated.

  ```
  agent → fn f(...) { ... }  @ ensures P
  Z3    → UNSAT proof? no. counterexample: x = -1 violates P at line 4
  agent ← regenerate with {x = -1 ⇒ P fails at line 4}
  ```

- **Solver-guided decoding.** The solver actively prunes the search — only propose branch conditions consistent with reaching the required postcondition. This is CEGIS (counterexample-guided inductive synthesis) fused with LLM decoding. Greenfield; high risk, high novelty.

**Layer 4 — Intent-carrying compilation.** *(The attestation payoff.)* The prompt/spec is not discarded — it is captured and carried to the binary, enabling:

- **Conformance checking** — check the code against the *intent*, not just against itself. (Honest bound: only the *formalizable* fragment of intent is checkable. Types, capability requirements, and — crucially — **cost bounds from Frontier 1** are exactly that fragment.)
- **Provenance / attestation** — the binary carries a signed chain `prompt → spec → code → proof → Wasm`. In a zero-trust world of agent-written software, this is the missing attestation primitive: verify *why* code exists and that it meets its stated contract. This plugs straight into ViewSpec, whose five structural elements already include **Provenance**.

### Why Sigil specifically

- Needs a **fast incremental verifier** — you cannot re-check the whole program per token. Sigil's self-hosting typechecker + Z3 is the enabler.
- Needs the **language semantics to *be* the safety properties** (capabilities, taint), so "constrain to safe code" is meaningful. That is Sigil's entire design.
- Needs **SMT already in the loop.** Z3 is integrated.

Almost no one has all three together.

### Where the frontier line actually is

- **Grammar-constrained decoding** (GBNF, Outlines, SynCode) — syntax only.
- **Type-constrained generation** (2024–25 papers) — types, not capabilities or SMT.
- **CEGIS / Sketch / Rosette** — synthesis, not LLM-native, not an agent-native language.
- **Proof-carrying code** (Necula, 1997) — the ancestor of Layer 4's attestation, but for human-shipped native binaries, not agent-generated code with prompt provenance.
- **Self-repair / self-debug agent loops** — post-hoc, not in-loop, not capability-aware.

Novelty to claim: *capability/taint/SMT-constrained generation (Layers 2–3) and prompt → proof → binary attestation (Layer 4), in one agent-native language.* Layers 0–1 exist; Sigil's contribution is pushing the constraint down into security semantics and solver-checked properties, and up into intent provenance.

### Risks / open questions

- **Per-token verification latency** is the killer. Mitigation: don't constrain every token — cheap type masking per token, expensive SMT per *unit* (statement/expression), with backtracking at unit granularity.
- **Constrained decoding can degrade quality** — a locally legal token can paint the function into an unsatisfiable corner. Unit-level backtracking, not just token masking, is mandatory.
- **Intent rarely formalizes.** Attestation of *provenance* is achievable now; conformance to a *formal* spec is achievable only where intent is already formal — which is exactly where Frontier 1 helps.

### A tractable first milestone

Layer 2 at expression granularity: capability- and taint-constrained generation with unit-level backtracking, driven by the existing typechecker; Layer 3 in verify-and-backtrack mode only (Z3 as a tool in an agent loop, counterexamples fed back). Emit a provenance record (`prompt hash → spec → proof → Wasm hash`) even before conformance checking exists. That is a shippable, genuinely novel slice.

---

## The two compose

Frontier 1 and Frontier 4 are one system viewed from two ends.

- Cost-as-a-type is a **formalizable fragment of intent**. Layer 4 can *check* it; Layers 2–3 can *enforce* it during generation.
- So an agent can be **constrained at generation time** to emit only code within a fuel budget, and the binary can **attest** to its cost envelope.

The composite artifact — **resource-bounded, capability-confined, provenance-attested agent code** — does not exist anywhere today. Each half has scattered prior art; the union, in an agent-native language that ships verified Wasm, is open ground. That union is the thing worth building, and Sigil is the one codebase already holding all the pieces.

### Suggested sequencing

1. Frontier 1 first milestone (linear cost types + one `Compute` capability + fuel-fidelity lemma). It is the more self-contained build and it produces the checkable intent fragment the rest leans on.
2. Frontier 4 Layer 2 (capability/taint-constrained generation) on top of the existing typechecker.
3. Frontier 4 Layer 3 verify-and-backtrack, using Z3 already present for Frontier 1.
4. Layer 4 provenance record, then conformance checking over the formalizable fragment — starting with cost bounds.

Each step ships value alone. Together they are the claim no incumbent can copy without first building Sigil's premise.
