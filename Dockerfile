FROM python:3.12-slim

# 设置容器工作目录
WORKDIR /workspace

# 设置环境变量，防止 python 生成 pyc 并且保证标准输出直接打印
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# 安装系统依赖（如 gcc 等编译工具，虽然 python-docx 较少需要，但以防万一）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# 复制依赖定义并安装
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码与前端静态资源
COPY ./app ./app
COPY ./static ./static

# 声明暴露的端口
EXPOSE 8000

# 启动 FastAPI Uvicorn 服务
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
