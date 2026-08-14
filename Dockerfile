FROM node:20-alpine

WORKDIR /app

# 安装依赖（先拷贝 package 文件以利用 Docker 层缓存）
COPY package*.json ./
RUN npm install

# 拷贝源码并编译
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 删除开发依赖，减小镜像体积
RUN npm prune --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]
