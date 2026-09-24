FROM denoland/deno:2.5.4 AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/eyri-chart \
    && /opt/eyri-chart/bin/pip install --no-cache-dir matplotlib==3.11.2

ENV PATH="/opt/eyri-chart/bin:${PATH}"

WORKDIR /app

COPY deno.json deno.lock ./
COPY src ./src

RUN deno cache --allow-import --lock=deno.lock src/main.ts
RUN deno cache --allow-import --lock=deno.lock src/healthcheck.ts

CMD ["run", "-A", "src/main.ts"]
