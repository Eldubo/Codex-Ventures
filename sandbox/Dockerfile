FROM node:24-alpine
ENV NODE_ENV=development
RUN addgroup -g 10001 sandbox && adduser -D -u 10001 -G sandbox sandbox
RUN mkdir -p /opt/codex/app /opt/codex/npm-cache /workspace && chown root:root /opt/codex /opt/codex/app /opt/codex/npm-cache /workspace && chmod 0555 /opt/codex /opt/codex/app /workspace
COPY --chown=root:root package.json package-lock.json /opt/codex/app/
WORKDIR /opt/codex/app
RUN npm ci --ignore-scripts --cache /opt/codex/npm-cache --audit=false --fund=false && rm -rf node_modules
COPY --chown=root:root sandbox/runner.cjs /opt/codex/runner.cjs
RUN chmod 0444 /opt/codex/runner.cjs
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/codex/runner.cjs"]
