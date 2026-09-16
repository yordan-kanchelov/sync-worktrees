---
"sync-worktrees": minor
---

Every MCP tool input schema is now a `z.strictObject`, so an argument key no tool declares is refused by name instead of being dropped in silence.

All nine tools declared `inputSchema: z.object({...})`. A plain `z.object` strips unknown keys, and the SDK's `validateToolInput` passes the stripped `parseResult.data` to the handler, so a misspelled or snake_case argument simply ceased to exist and the handler ran on its defaults. Measured against the built `dist/mcp-server.js` over stdio before the change: `detect_context {path, include_status: true}` returned the full context with no status labels and `isError` unset — indistinguishable from a caller that never asked for them — and `list_worktrees {repo_name: 'b'}` listed every configured repo. The one that costs something is `create_worktree {branchName, baseBranch, repo_name: 'b'}` under a multi-repo config: `repoName` never reaches the handler, so the branch is created, pushed and given a worktree in whatever repository is current, and the response says `success: true`. snake_case argument names are a routine LLM failure mode, so none of this is hypothetical.

Strict turns each of these into an InvalidParams error, and the offending key survives all the way to the client. zod puts it in the issue message (`Unrecognized key: "repo_name"`), not only in the structured `keys` array that Standard Schema drops on the way to the SDK, so what a client now receives for the case above is an error result reading `Input validation error: Invalid arguments for tool create_worktree: Unrecognized key: "repo_name"` — quoted from a real stdio round trip against the built bundle, on both the 2026-07-28 and the legacy 2025-11-25 protocol paths.

The advertised tool listing changes with them: every `tools/list` input schema now carries `additionalProperties: false`, which is the only difference in the JSON Schema a client sees. That is the half of the fix that works before a bad call is made — a client whose model decodes against the advertised schema is now steered away from `repo_name` rather than only corrected after the fact.

Nothing else about the schemas changes. `.optional()` and `.default()` behave exactly as before, no tool relied on `.passthrough()` or a catchall, and every input is flat — strings and booleans only, no nested object or array-of-objects — so the shallowness of `z.strictObject` has nothing to reach past. The inferred TypeScript types are identical, and the handlers declare their own parameter types rather than inferring them from the schemas.

This is a minor rather than a patch because it is a visible behaviour change for every MCP client: a call that today sends an extra key and appears to succeed will start returning an error. That cost is accepted deliberately. A call that appears to succeed while acting on the wrong repository is worse than one that fails with the reason printed.
