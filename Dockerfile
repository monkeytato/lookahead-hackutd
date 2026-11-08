# Portable image for any container host (Fly.io, Railway, Cloud Run, ...). Render uses render.yaml instead.
#   docker build -t centerguard .
#   docker run -p 8080:8080 -e NVIDIA_API_KEY=... centerguard
# Pass NVIDIA_API_KEY at run time (host secret); never bake it into the image.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 RACKMON_SIM=1 NEMOTRON_EVAL_BUDGET_MS=45000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src ./src
# server/.data (demo state) is written at run time, so the server folder belongs to the runtime user
COPY --chown=node:node server ./server
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "server/index.ts", "--prod"]
