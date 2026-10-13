---
summary: "Use TypeSafe Jev structured classification for workflow routing"
read_when:
  - You want a dedicated classifier to choose work-maps and routes
  - You need to configure TypeSafe credentials
title: "Jev"
---

Jev is a structured classifier from TypeSafe. The bundled `jev` plugin adapts
[TypeSafe's evaluation API](https://docs.typesafe.ai/api) for enterprise routing.
It does not provide a conversation or tool-execution model.

Set `TYPESAFE_API_KEY` in the gateway environment, or save a provider credential
with `openclaw models auth login --provider jev --method api-key`. This does not
change the agent's primary model. Restart the gateway after installing a plugin
or changing its environment.

Set **Settings → Enterprise → Route Planner Model** to `jev/jev-latest`, or use:

```json5
{
  enterprise: { routePlanner: { model: "jev/jev-latest" } },
}
```

In chat, **Routing model** accepts the same reference for an individual query.
**Default** uses the saved routing setting. The conversation continues with its
normal execution model. An explicit account can use `jev/jev-latest@jev:work`.

The adapter calls `POST https://api.typesafe.ai/v1/systemone` with a bearer token.
A Choice question selects a work-map (including a no-match option); a second
request uses independent Noul questions to select every required leaf operation.
Ancestor scopes still apply. A probability of at least 0.5 selects an operation.
An ambiguous operation returns a fixed clarification question instead of
executing a guessed route. The shared routing deadline and cancellation signal
cover both requests. Choice supports up to 255 options, including no-match.

The API returns probabilities. The adapter does not promise that repeated hosted
inference is deterministic. It validates response shapes, choice ids and
probability bounds before accepting a result. It uses no alternate model on a
provider error; normal enterprise unavailable/failed planning policy applies.

For a version-pinned model, replace `jev-latest` with a version listed in the
[TypeSafe model reference](https://docs.typesafe.ai/models). Disable the plugin
with `plugins.entries.jev.enabled: false` to prevent its activation.
