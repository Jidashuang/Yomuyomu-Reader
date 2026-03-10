FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY backend/requirements-deploy.txt /app/backend/requirements-deploy.txt
RUN python -m pip install --no-cache-dir -r /app/backend/requirements-deploy.txt

COPY . /app

RUN mkdir -p /bootstrap-data \
    && for file in \
        /app/backend/data/jmdict.db \
        /app/backend/data/jlpt_levels.json \
        /app/backend/data/jlpt_levels.json.example; do \
        if [ -f "$file" ]; then cp "$file" /bootstrap-data/; fi; \
    done \
    && chmod +x /app/backend/start.sh

EXPOSE 8000

CMD ["/app/backend/start.sh"]
