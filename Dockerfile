FROM python:3.14-slim
WORKDIR /app
COPY server.py index.html script.js styles.css icon.svg ./
ENV PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "server.py", "--host", "0.0.0.0", "--data", "/storage/auth", "--library", "/storage/library", "--secure-cookie"]
