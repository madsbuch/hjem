FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/madsbuch/hjem" \
      org.opencontainers.image.description="Hjem hub"
WORKDIR /app
COPY dist/hub.mjs ./hub.mjs
ENV NODE_ENV=production
EXPOSE 8099
CMD ["node", "hub.mjs"]
