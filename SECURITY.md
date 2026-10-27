# Security model and limitations

## MVP trust boundaries
- The app is a local, single-user demonstration. It has no authentication or network-facing authorization boundary; do not expose it to untrusted networks as-is.
- API inputs are validated and project identifiers are resolved through the local store. Persistent files contain demo/product data only.
- The simulation engine uses deterministic local rules and never executes agent-generated code.
- Proposal artifacts are deterministic demo fixtures, clearly labeled as non-AI-generated. Approval requires matching base version/hash and a validated unified diff; it queues a one-shot isolated validation job and never applies the diff to the original repository.
- The optional internal Docker smoke executor connects only to the local Engine endpoint (Windows named pipe or Unix socket); it rejects alternate images and never pulls images. Docker Engine access is powerful, so only run the app as a trusted local user.

## Threats and mitigations
- Invalid/malicious request data: validate with Zod, bound collection sizes, and return generic errors.
- Path traversal: clients never choose storage paths; storage uses fixed filenames under the app's data directory.
- XSS: render user text as React text; do not inject HTML.
- Secret exposure: no API keys are required; future keys must remain server-side and be redacted from logs.
- Duplicate transitions: state changes check current state; idempotency keys deduplicate simulation submissions; local-store updates are serialized within one process.
- Sandbox execution: only the fixed command sequence (`npm ci --offline`, test, typecheck, lint) and smoke probe are permitted by `sandbox/runner.cjs`. The container has no network, runs as UID 10001, drops all Linux capabilities, uses `no-new-privileges`, read-only root, bounded tmpfs, CPU/memory/PID/log limits, and no bind mounts. A disposable source snapshot is sent over stdin to a fixed runner; no repository path is mounted in Docker. `/workspace` is executable only to run project checks; `/tmp` and `/home/sandbox` remain `noexec`. The runner validates paths and sizes, receives no environment secrets or Docker socket, and exposes bounded redacted logs. Container and temporary host workspace cleanup is attempted on every exit.
- Build trust: the operator explicitly builds the allowlisted local image from `sandbox/Dockerfile`; the app does not pull or build images. Review the Dockerfile before building and rebuild from trusted source when updating it.
- Arbitrary code execution: approved diffs are executed only inside the restricted container to run allowlisted installation and checks. This is not a deployment, merge, or write-back path. Container isolation reduces risk but is not a substitute for keeping Docker and the host up to date.
- Job queue: the single-process worker recovers interrupted `RUNNING` jobs as queued work and caps attempts. It does not coordinate multiple server processes, and an operator must not run multiple app replicas against the same JSON file.
- SSE: the event stream is unauthenticated, matching the local single-user scope. Do not expose it outside a trusted local environment.

## Limitations
JSON persistence is intended only for local development/demo and does not provide cross-process locking or multi-user isolation. Backups are manual; stop the server before copying/restoring `.data/codex-ventures.json`. PostgreSQL/Prisma, authentication, cross-process jobs, and production hardening require follow-up. SSE is present but is not authorized for multi-user access. Docker isolation tests are not proof of safety against kernel/container-runtime vulnerabilities. Demo proposals are fixtures, not AI output. Windows cannot create symlinks in the current test environment, so that one symlink test is skipped there; the snapshot rejects symlinks when encountered.
