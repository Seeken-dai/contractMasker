import os
import sys
import platform
import subprocess

def start_server():
    current_os = platform.system()
    
    # 获取当前工作目录
    working_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(working_dir)
    
    # 默认配置
    host = "127.0.0.1"
    port = 8000
    app_name = "合同智能脱敏"
    version = "1.2.0"
    
    # 提前加载 config.json 配置文件以获取产品名称与版本号
    config_path = os.path.join(working_dir, "config.json")
    has_config = os.path.exists(config_path)
    if has_config:
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as f:
                config_data = json.load(f)
                if isinstance(config_data, dict):
                    if "host" in config_data:
                        host = str(config_data["host"])
                    if "port" in config_data:
                        port = int(config_data["port"])
                    if "app_name" in config_data:
                        app_name = str(config_data["app_name"])
                    if "version" in config_data:
                        version = str(config_data["version"])
        except Exception:
            pass

    print("=" * 60)
    print(f"         {app_name}系统启动器 v{version} (跨平台版)")
    print("=" * 60)
    print(f"[检测] 当前运行操作系统: {current_os}")
    
    # 检查并自动安装缺失的依赖
    print("[检查] 正在校验 Python 第三方库依赖...")
    required_libraries = ["fastapi", "uvicorn", "docx", "jieba", "pydantic", "multipart"]
    missing_libs = []
    
    # 逐一测试导入
    for lib in required_libraries:
        try:
            if lib == "docx":
                import docx
            elif lib == "multipart":
                import multipart
            else:
                __import__(lib)
        except ImportError:
            missing_libs.append(lib)
            
    if missing_libs:
        print(f"[警告] 检测到本地环境缺失关键库: {', '.join(missing_libs)}")
        print("[环境] 正在为你跨平台自动下载并补齐依赖...")
        req_path = os.path.join(working_dir, "requirements.txt")
        if not os.path.exists(req_path):
            print(f"[错误] 未找到依赖库声明文件 requirements.txt，请确保其位于: {working_dir}")
            sys.exit(1)
            
        try:
            # 跨平台安全执行 pip 安装指令
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
            print("[环境] 依赖库自动补齐成功！")
        except Exception as ex:
            print(f"[错误] 自动修复环境依赖失败，请手动在终端执行: pip install -r requirements.txt")
            print(f"      异常细节: {ex}")
            sys.exit(1)
    else:
        print("[环境] 校验通过，所有运行库已就绪。")
        
    if has_config:
        print(f"[配置] 成功加载本地配置文件 config.json (主机: {host}, 端口: {port})")
    else:
        # 如果配置文件不存在，自动生成一个默认配置的 config.json，方便用户后续修改
        try:
            import json
            with open(config_path, "w", encoding="utf-8") as f:
                json.dump({"host": "127.0.0.1", "port": 8000, "app_name": "合同智能脱敏", "version": "1.2.0"}, f, indent=4, ensure_ascii=False)
            print("[配置] 未找到配置文件，已在根目录自动生成默认 config.json 模板文件。")
        except Exception as e:
            pass
        
    print(f"\n[INFO] 正在启动主 Web 服务 (绑定地址: {host}:{port})...")
    print(f"[INFO] 请在浏览器中打开: http://{host}:{port}")
    print(f"[INFO] 对外接口文档地址: http://{host}:{port}/docs")
    print("[INFO] 按 Ctrl + C 可以终止服务。")
    print("=" * 60)
    print()
    
    # 启动 Uvicorn 命令
    cmd = [sys.executable, "-m", "uvicorn", "app.main:app", "--host", host, "--port", str(port)]
    
    try:
        # 使用 subprocess.run 在当前终端阻塞运行，完美传递 Ctrl+C 信号
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n[INFO] 服务已由用户手动终止退出。")
    except Exception as e:
        print(f"\n[错误] Uvicorn 运行时发生致命异常: {e}")
        sys.exit(1)

if __name__ == "__main__":
    start_server()
