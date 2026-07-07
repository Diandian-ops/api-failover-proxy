FROM node:20-alpine

WORKDIR /app

# 换阿里云镜像源加速（国内构建），装 better-sqlite3 编译依赖
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
 && apk add --no-cache python3 make g++

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 拷贝源码、网页端、脚本
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config.example.js ./

# 默认配置；生产环境请挂载 config.local.js 或通过环境变量覆盖
ENV PROXY_HOST=0.0.0.0
ENV PROXY_PORT=9090

EXPOSE 9090

# 健康检查（带鉴权）
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9090/health || exit 1

CMD ["node", "src/server.js"]
