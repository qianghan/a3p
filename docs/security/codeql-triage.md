# CodeQL triage

Every alert dismissed on this repository, and why. A dismissal with no
reasoning attached is indistinguishable from someone clearing a red badge, so
the reasoning lives here, in version control, where it can be argued with.

The rule for adding an entry: say what the query claims, say why it does not
hold **here**, and say what was done anyway. "It's a false positive" on its own
is not an entry.

---

## `js/xss-through-dom` — four `<img src>` sites in Settings

`app/(dashboard)/settings/page.tsx` (avatar, ×2) ·
`components/settings/AgentBookSettingsPanel.tsx` (logo, ×2)

**The claim:** "DOM text is reinterpreted as HTML without escaping
meta-characters."

**Why it does not hold.** Two independent reasons, either of which is
sufficient.

1. *The sink is not an HTML sink.* These are React JSX `<img src>` attributes.
   JSX escapes attribute values; nothing is reinterpreted as HTML. And the
   payload the query implies cannot fire from that attribute anyway — a
   `javascript:` URL in an `img src` does not execute in any current browser,
   and an SVG loaded through `<img>` runs no script by specification.

2. *The source is the user's own input, rendered back to them.*
   `pendingLogoUrl` is `URL.createObjectURL(file)` from the tenant's own file
   picker. `logoUrl` and `avatarUrl` are values that tenant saved in their own
   settings. There is no path by which one user's string reaches another
   user's DOM. The worst available outcome is self-inflicted.

**What was done anyway.** `lib/safe-image-src.ts`, applied at all four sites.

This is not an XSS mitigation. What an arbitrary string in `src` actually buys
is a request the page makes *on the viewer's behalf* to a host of somebody
else's choosing: a tracking pixel that fires on every invoice preview, an
intranet URL probed from inside a browser session, a `data:` blob of arbitrary
size. That is worth refusing on its own merits, and it is refused.

**Why a dismissal rather than a fix.** The validator parses the URL and returns
a string rebuilt from the parsed components, specifically so the check is
visible to taint analysis rather than transparent to it. CodeQL still reports
the alert, because it models `new URL(x).toString()` as taint-preserving — as
it must, since the output really is derived from the input. No sanitiser can
clear this query on this sink. The choice is between a dismissal and deleting
a feature (tenant-supplied logo URLs) that works.

Consolidating the four sites onto one validator also found a live bug: the
settings page's own helper allowed `http`/`https` only, so the `blob:` preview
of an avatar the user had just chosen from disk was silently discarded — and
the fallback initial rendered in its place, which is why nobody noticed.

---

## `js/regex-injection` — `packages/utils/src/regex-safety.ts`

**The claim:** "This regular expression is constructed from a user-provided
value."

**Why it does not hold.** It is constructed from a user-provided value, and
that is the function's entire purpose. `assessUserRegex` exists to decide
whether a pattern submitted through skill registration is safe to store and
run; deciding that requires compiling it and timing it against inputs that
almost match. Refusing to construct the regex here would mean not validating
it at all — the alert asks for the opposite of the fix.

The compile is bounded before it happens: length-capped, and the probes that
follow it are short by design so a catastrophic pattern costs seconds rather
than minutes.

**Note on the count.** This alert did not appear with the guard. It moved. The
same `new RegExp(userValue)` was previously in
`app/api/v1/agentbook-core/skills/register/route.ts`, where it did nothing but
check syntax. PR #545 relocated it into a function that also refuses
catastrophic backtracking. Net alerts unchanged; net safety materially better.

---

## Not dismissed, and why they are still open

Kept visible rather than triaged away:

- **`js/missing-rate-limiting`** ×2 — real, and not launch-blocking. Both sit
  behind authentication. Worth doing; not worth dismissing.
- **`js/loop-bound-injection`** — `plugins/agentbook-expense/backend/src/server.ts`.
  Not yet examined properly. An unexamined alert must not be dismissed.
- **`js/stack-trace-exposure`** — `lib/agentbook-tenant.ts`. This one re-emits
  the body of a `Response` that this same module threw, and every throw site
  in the file builds that body from a string literal. It is a false positive
  and could be dismissed on that evidence; it is left open because the fix
  (constructing the response from a known shape rather than passing a body
  through) is small and honest, and preferable to an argument.
