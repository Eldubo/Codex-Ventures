# Repository agent instructions

- Use strict TypeScript and the existing Next.js App Router architecture.
- Keep domain logic independent of React and route handlers; validate external inputs with Zod.
- Treat all seeded/demo participants and measurements as synthetic. Never present them as real customer data or claim external actions that did not occur.
- Persist local demo state behind a storage boundary. Do not expose server filesystem paths or secrets through API responses.
- Never execute generated code on the host. Code execution and deployment are simulated unless a restricted sandbox is explicitly implemented and verified.
- Protect project scoping and validate state transitions; write audit records for review actions.
- Use deterministic seeds for simulations and derive analytics from stored events.
- Before completion, run the requested test, type-check, and production build commands and document results. Do not claim checks passed unless they ran successfully.
