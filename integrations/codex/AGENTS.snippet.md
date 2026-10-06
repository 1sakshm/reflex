## Reflex (fast routine decisions)

This project uses Reflex, a fast local decision runtime exposed as MCP tools.

- Before delegating work to a sub-agent or a different model, call `reflex_route_subtask` with a one-line description. Use the tier it returns when `type` is `auto`.
- For routine choices between known options (which file to open first, whether a web search is needed, whether to retry a failed command), you may call `reflex_decide` with the candidate actions. Follow `auto` answers; treat `escalate` hints as suggestions.
- After deciding something yourself following an `escalate`, call `reflex_observe_choice` with the `decision_id` and your choice so Reflex learns it.
- Don't use Reflex for decisions that need real reasoning: designing a fix, judging correctness, writing code.
