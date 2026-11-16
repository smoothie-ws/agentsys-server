FROM node:22-alpine
WORKDIR /app
COPY package.json headless.js ./
COPY bin ./bin
COPY server ./server
COPY runtime ./runtime
COPY api ./api
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/api/meta').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "bin/agentsys-server.js"]
CMD ["start", "--host", "0.0.0.0", "--port", "8080", "--data", "/data"]
