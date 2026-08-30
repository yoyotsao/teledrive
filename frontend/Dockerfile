FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_TELEGRAM_API_ID
ARG VITE_TELEGRAM_API_HASH
ENV VITE_TELEGRAM_API_ID=$VITE_TELEGRAM_API_ID
ENV VITE_TELEGRAM_API_HASH=$VITE_TELEGRAM_API_HASH

RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/conf.d/security-headers.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
