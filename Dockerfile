FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/data /app/backups

EXPOSE 3000
CMD ["npm", "start"]
