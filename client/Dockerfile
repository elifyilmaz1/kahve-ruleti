FROM node:18
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# Geliştirme için serve kullanılabilir: RUN npm install -g serve
CMD ["npm", "start"]
