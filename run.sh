#!/bin/bash
# =======================================================
#         合同智能脱敏系统 Linux 启动脚本
# =======================================================

# 切换到脚本所在目录，防止路径错位
cd "$(dirname "$0")"

# 检查 python3 是否存在
if ! command -v python3 &> /dev/null; then
    echo "[错误] 系统未检测到 python3 命令，请先安装 Python 环境。"
    exit 1
fi

# 执行跨平台 Python 启动逻辑
python3 run.py
