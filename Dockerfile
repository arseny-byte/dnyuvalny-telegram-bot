FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY bot.js inspector-agent.js ./
EXPOSE 3000
CMD ["node", "bot.js"]
