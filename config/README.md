# Configuration skeleton

Project profiles are untrusted, versioned YAML documents validated by
`src/contracts/project-profile.ts`. Runtime provisioning is intentionally deferred.

Production configuration will live below `$XDG_CONFIG_HOME/agent-factory/` and must be readable
only by its owner. The Phase 1 loader accepts only regular files with permission bits exactly
`0600`; repository fixtures are non-secret examples and are loaded through the deterministic
in-memory filesystem adapter in tests.

Global lane and backlog environment values are:

```text
AGENT_FACTORY_IMPLEMENTATION_LIMIT=1
AGENT_FACTORY_FEEDBACK_LIMIT=1
AGENT_FACTORY_READY_TO_MERGE_LIMIT=1
```

Each accepts an integer from `0` through the hard v1 maximum `3`. Defaults are `1`. Project
profiles may only lower the effective value because the controller takes the minimum of the
global and configured project ceiling.

Claude implementation runtime values are also parsed centrally:

```text
AGENT_FACTORY_CLAUDE_MODEL=claude-fable-5
AGENT_FACTORY_CLAUDE_EFFORT=high
```

The defaults shown are used when a variable is absent. Effort accepts `low`, `medium`, `high`,
or `max`; the model must be one bounded, safe command-argument value. Runtime values are captured
per provider session and cannot change on resume.
