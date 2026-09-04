FROM node:22-alpine

WORKDIR /app

# Dependencies first so an edit to server.mjs does not reinstall them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

ENV PORT=9700
EXPOSE 9700
USER node
CMD ["node", "server.mjs"]
