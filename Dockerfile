FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/data/blankstock.db
VOLUME /data
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
