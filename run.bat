@echo off
cd /d "%~dp0"
python run.py
if %errorlevel% neq 0 (
    pause
)
