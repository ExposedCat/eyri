FROM denoland/deno:2.5.4 AS runtime

WORKDIR /app

COPY deno.json deno.lock ./
COPY src ./src

RUN deno cache --allow-import --lock=deno.lock src/main.ts
RUN deno cache --allow-import --lock=deno.lock src/healthcheck.ts

CMD ["run", "-A", "src/main.ts"]
