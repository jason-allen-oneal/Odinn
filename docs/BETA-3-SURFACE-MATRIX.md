# Beta 3 surface matrix

This is the operator-facing classification for the Ódinn Forge Beta 3
surface. The classification labels are normative and are reused by the
[README](../README.md), [public beta guide](public-beta.md),
[P0 beta gates](P0-BETA-GATES.md), and [operator console guide](operator-console.md).

| Surface | Classification | Operator claim and boundary |
| --- | --- | --- |
| Local onboarding, CLI, loopback gateway, and local console | **verified local behavior** | The normal single-operator workflow is supported on an owner-controlled machine with the gateway bound to loopback. |
| Durable jobs, run ledger, audit chain, approval journal, browser-recovery journal, and local state repair | **verified local behavior** | Restart recovery, audit verification, and bounded local restore paths are implemented. An unknown unsafe outcome remains `needs-review`; it is not silently replayed. |
| Deterministic local tools, policy checks, capability boundaries, and owner-controlled workspace operations | **verified local behavior** | These paths are audited and bounded when used through the documented CLI or gateway execution boundary. |
| Forked gateway workers | **verified local behavior** | Forked workers are crash containment, not a security sandbox. They retain the parent OS identity, environment, filesystem, and network authority. |
| Release archives, checksums, package smoke, and versioned installer rollback | **verified local behavior** | The packaged artifact and installer pointers have local verification and rollback paths; operators must verify the exact release evidence. |
| Provider transport adapters, retry/backoff handling, OAuth refresh paths, usage normalization, and local protocol-provider smoke | **verified local behavior** | The local adapter contracts and protocol smoke are covered. A passing local protocol provider does not prove a live provider account or service. |
| Live provider accounts, model availability, quotas, rate limits, OAuth/device flows, local model servers, and CLI adapters | **provider- or platform-dependent** | Behavior depends on the provider service, account, credentials, installed model/server, adapter, operating system, and network. |
| Public web reads, fetch egress, isolated browser profiles, browser engines, and approval prompts | **provider- or platform-dependent** | Availability, rendering, login state, network behavior, and site responses depend on external services and the host platform. |
| Approved browser mutations and other external side effects | **provider- or platform-dependent** | Approval and recovery journals provide operator control and recovery blocking, but the external outcome may be delayed, partial, or unknown. |
| Opt-in TLS multi-user remote hosting | **provider- or platform-dependent** | Remote hosting is application-level tenant isolation, not hostile-user OS isolation. Each tenant has separate application state, but the host still needs OS, container, or machine isolation for mutually hostile users. |
| Proof, Sentinel, Capability Tokens, Rewind, Capsules, Counterfactuals, Darwin, and self-improvement | **experimental and disabled by default** | These local vertical slices require explicit per-feature enablement and remain operator-driven, review-gated, or bounded as documented. |
| Audited extension and MCP execution adapters and their policy/capability boundary | **verified local behavior** | Enabled adapters cross the shared audited execution boundary. Container execution has the documented restrictions; direct extension execution is rejected. |
| Third-party extension/MCP packages, Agent SDK packages, and Skill SDK packages | **experimental and disabled by default** | Installation, registration, or discovery does not grant trust or execute code. Enablement requires explicit review, integrity, grants, and the documented policy boundary. |
| Experimental replay, rewind, capsule, and counterfactual actions in disposable or copied local workspaces | **experimental and disabled by default** | These paths can preserve and compare bounded local records, but they do not extend guarantees to arbitrary remote effects. |
| Full replay or rollback of external effects, remote browser/provider mutations, or nondeterministic provider behavior | **explicitly unsupported** | External effects and nondeterministic provider behavior are outside full replay/rollback guarantees. |
| Hostile-code containment by forked workers or hostile-user OS isolation through remote hosting | **explicitly unsupported** | Use separate operating-system users, containers, or machines when the code or users are mutually hostile. |

## Three hard limits

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

When a surface is not clearly covered by the matrix, treat it as
**explicitly unsupported** until the release evidence and operator
documentation say otherwise.
