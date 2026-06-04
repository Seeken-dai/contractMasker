# 合同智能脱敏系统云端部署与架构优化指南

如果你希望将本项目发布到 Google Cloud Platform (GCP) 或其它主流云平台，以下是针对本项目的云端发布方案及架构纠错说明。
在云端采用分布式多容器实例部署时，直接运行本项目会触发以下两个致命的系统 Bug：

### 1\. 数据库状态易失性 (Ephemerality Bug)

* **问题根源**：本地运行使用的是 `SQLite` 单文件数据库 (`masking.db`)。如果你将它部署在 **Google Cloud Run (Serverless)** 或容器集群中，容器的存储是临时的。当应用没有请求自动缩容到 0 实例，或者实例重启、扩容时，这个 `masking.db` 文件会被**直接销毁重置**，导致所有已脱敏合同的 UUID 历史映射关系永久丢失，合同将**永远无法还原**。
* **解决方案**：

  * **规范做法**：在生产环境中，修改 [app/database.py](file:///d:/项目/脱敏/app/database.py) 的连接层，将其配置为支持连接外部云数据库（如 **Google Cloud SQL for PostgreSQL** 或 **MySQL**），通过环境变量注入 `DATABASE\_URL`。
  * **折中省钱做法**：如果依然坚持使用 SQLite，你必须为 Google Cloud Run 挂载 **Cloud Storage FUSE** 或 **Filestore (NFS)** 共享持久化卷，将 `masking.db` 文件存储在持久卷中。

### 2\. 临时上传文件跨节点丢失 (Stateful Session Bug)

* **问题根源**：网页端脱敏是一个“两阶段请求”：第 1 步调用 `/api/upload` 上传原文件并保存在本地 `temp\_files/` 目录下；第 2 步点击脱敏发送 `/api/mask` 并在本地查找该文件。在云端如果有 2 个以上的容器实例运行：用户第 1 步上传的文件被保存在实例 A 上；第 2 步脱敏请求被负载均衡分发到了实例 B。实例 B 上由于没有 `temp\_files/` 下的这个原文件，系统会直接报错：*“原始上传文件已失效”*。
* **解决方案**：

  * **规范做法**：将临时文件存储从本地硬盘迁移到**云端对象存储**（如 **Google Cloud Storage, GCS**）。`/api/upload` 上传后直接存入云端的临时 Bucket；`/api/mask` 从云端下载处理。
  * **无状态做法**：使用我们已开发好的 **OpenAPI 接口 (`/api/openapi/mask`)** 进行对接。该接口是一次请求直接上传并完成脱敏，是完全**无状态 (Stateless)** 的，能够完美防范分布式状态错乱问题。

\---

## 🚀 部署方案 A：基于 Google Cloud Run（推荐，低成本、弹性）

Google Cloud Run 是运行本项目最优雅的平台。它支持自动伸缩，在无请求时可自动缩容至 0 实例，产生 0 费用。

### 1\. 准备工作

确保你本地已安装并初始化了 Google Cloud SDK (gcloud CLI)，并且有 GCP 项目的管理权限。

```bash
# 登录 GCP 并配置当前项目
gcloud auth login
gcloud config set project \[你的GCP项目ID]
```

### 2\. 构建并推送 Docker 镜像

我们已经为你创建了标准的 [Dockerfile](file:///d:/项目/脱敏/Dockerfile)。你可以直接使用 GCP 内置的 Cloud Build 将镜像推送到 Artifact Registry：

```bash
# 在项目根目录下执行，直接在云端构建镜像 (避免本地配置 Docker)
gcloud builds submit --tag gcr.io/\[你的GCP项目ID]/contract-masker:latest
```

### 3\. 一键部署至 Cloud Run

```bash
# 部署服务并允许外部匿名访问
gcloud run deploy contract-masker \\
    --image gcr.io/\[你的GCP项目ID]/contract-masker:latest \\
    --platform managed \\
    --region asia-east1 \\
    --allow-unauthenticated \\
    --port 8000
```

部署成功后，终端将输出一个公开的 HTTPS URL，例如 `https://contract-masker-xxxx-de.a.run.app`。在浏览器中打开此 URL 或调用其 OpenAPI 即可。

\---

## 🖥️ 部署方案 B：基于 Compute Engine (VM 虚拟机 / 轻量云服务器)

如果你的访问量非常固定，且希望继续保持简单的单机 SQLite 数据存储，可以使用 Compute Engine 虚拟机（类似于阿里云/腾讯云 ECS）。

### 1\. 创建 VM 实例

在 GCP Console 中创建一台 Debian 或 Ubuntu 系统的虚拟机，并在安全组中**开启 TCP 8000 端口**。

### 2\. 初始化环境与克隆代码

通过 SSH 连入 VM 实例，安装 Python 环境与 Git：

```bash
# 更新系统并安装环境
sudo apt-get update
sudo apt-get install -y python3 python3-pip git

# 克隆项目代码到服务器
git clone \[你的代码仓库地址] /app
cd /app

# 安装依赖
pip install -r requirements.txt
```

### 3\. 运行服务 (使用 Systemd 守护进程)

为了防止你关闭 SSH 窗口后服务挂掉，必须将其配置为系统守护进程：
在 `/etc/systemd/system/masker.service` 创建服务文件：

```ini
\[Unit]
Description=Contract Masker FastAPI Application
After=network.target

\[Service]
User=root
WorkingDirectory=/app
ExecStart=python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always

\[Install]
WantedBy=multi-user.target
```

启动并开启自启：

```bash
# 激活并运行服务
sudo systemctl daemon-reload
sudo systemctl start masker.service
sudo systemctl enable masker.service
```

现在，直接访问 `http://\[你的虚拟机外网IP]:8000` 即可。由于是单机 VM，你的 `masking.db` 将会一直保存在虚拟机的系统盘上，不会发生数据丢失。

