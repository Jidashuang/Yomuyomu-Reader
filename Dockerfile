FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY backend/requirements-deploy.txt /app/backend/requirements-deploy.txt
RUN python -m pip install --no-cache-dir -r /app/backend/requirements-deploy.txt

COPY . /app

EXPOSE 8000

CMD ["python3", "backend/server.py"]
