# Contributing to ClawWorks

ClawWorks is a fork of [OpenClaw](https://github.com/openclaw/openclaw) that adds a governance
layer: work-maps, a tool-call gate, capability grants, policies, run traces, and the typed object
graph. Everything under that — the gateway, channels, nodes, canvas, skills, the plugin system, the
companion apps — is upstream's and works as documented there.

The fork is maintained by [@JY-1019](https://github.com/JY-1019). Nobody from the upstream project
maintains it, reviews its pull requests, or owes it support.

## Where a change belongs

**Upstream, not here**, when the behavior is inherited *and reproduces on stock OpenClaw*: a channel
that will not connect, a gateway or protocol defect, plugin SDK gaps, the macOS/iOS/Android apps,
docs for any of those. Send it to [openclaw/openclaw](https://github.com/openclaw/openclaw/issues).
A fix there reaches every OpenClaw install, including this one — filing it here only delays it. An
inherited surface that breaks only on ClawWorks is this fork's bug, not theirs, and belongs here.

**Here**, when it is the governance layer: work-map schema and authoring, step routing and
advancement, the tool-call gate, capability grants, governance policies, knowledge foundations, run
traces, the ontology and its tools, the enterprise Control UI views, and the `openclaw enterprise`
CLI. If you are unsure, open it here and it will be routed.

## Issues

Blank issues are disabled — pick a template and fill it in. One issue per report; split multiple
problems into separate submissions. What makes a report actionable:

- What you expected, what happened, and the exact steps between them.
- Version and commit SHA, plus the relevant `openclaw.json` section with secrets removed.
- For a governed run, the run id and what `openclaw enterprise runs show <runId>` printed. That
  trace usually answers the question faster than a description does.

Security issues do not belong in the tracker at all. See [`SECURITY.md`](SECURITY.md) for the
private disclosure path.

## Pull requests

Pull requests are welcome for the governance layer. Before opening one:

- Read [`AGENTS.md`](AGENTS.md). It is the repository's hard policy — architecture boundaries,
  naming rules, test lanes, and the commands that have to stay green. Scoped `AGENTS.md` files own
  their subtrees; read the ones covering the paths you touch.
- Fill in the PR template honestly. `What Problem This Solves` and `Evidence` are the two sections
  that get read first, and a PR without evidence is a PR nobody can verify.
- Prove the surface you changed. `pnpm test <path>` for the touched files, `pnpm check:changed` for
  the lanes your change lands in.

Two constraints are not negotiable, because the fork exists to keep them:

- **Machine identifiers stay frozen.** The `openclaw` CLI and package name, `openclaw/plugin-sdk/*`
  import specifiers, `@openclaw/*` package names, `openclaw.plugin.json` and its schema keys, config
  keys, `OPENCLAW_*` environment variables, and `~/.openclaw` state paths never change. Only display
  names say ClawWorks. `pnpm plugin-sdk:api:gen --check` guards the SDK surface.
- **Governance fails closed.** A change that lets a run proceed when a decision could not be reached
  needs to say why in the diff, not in the PR description.

## Development

```bash
git clone https://github.com/JY-1019/ClawWorks.git
cd ClawWorks

pnpm install
pnpm openclaw setup     # first run only
pnpm gateway:watch      # dev loop, auto-reload
```

The repository is a pnpm workspace and bundled plugins load from `extensions/*` during development;
a plain `npm install` at the root is not a supported setup. Enterprise changes must keep the golden
checks green.

## Credit

The platform this builds on is the work of Peter Steinberger and the OpenClaw contributors, under
the MIT license. Questions about that platform belong in
[their tracker](https://github.com/openclaw/openclaw/issues) and
[their Discord](https://discord.gg/clawd), where the people who wrote it can answer them.
