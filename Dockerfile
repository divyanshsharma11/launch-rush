# One image for every backend service (api, worker, payment provider, ERP simulator); compose.prod.yaml picks the command.
FROM node:24-slim AS admin
WORKDIR /admin
COPY admin/package.json admin/package-lock.json ./
RUN npm ci
COPY admin/ ./
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY sims ./sims
COPY db ./db
COPY --from=admin /admin/dist ./admin/dist
USER node
CMD ["node", "src/api.js"]
