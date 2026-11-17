FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY bin ./bin
USER node
EXPOSE 7480
ENV HOST=0.0.0.0
CMD ["node", "server.mjs"]
