#!/bin/bash

# Port Monitor 更新脚本
echo "开始更新 Port Monitor 项目..."

# 设置项目目录
PROJECT_DIR="/opt/port-monitor"
BACKUP_DIR="$PROJECT_DIR/backup"

# 创建备份目录
mkdir -p $BACKUP_DIR

# 停止服务
echo "停止服务..."
pm2 stop port-monitor

# 备份数据库文件
echo "备份数据库文件..."
cp $PROJECT_DIR/port_monitor.db $BACKUP_DIR/port_monitor_$(date +%Y%m%d_%H%M%S).db 2>/dev/null || true
cp $PROJECT_DIR/sessions.db $BACKUP_DIR/sessions_$(date +%Y%m%d_%H%M%S).db 2>/dev/null || true

# 进入项目目录
cd $PROJECT_DIR

# 如果使用Git更新
if [ -d ".git" ]; then
    echo "从Git拉取最新代码..."
    git pull origin main
else
    echo "请手动上传新的项目文件到 $PROJECT_DIR"
    echo "按任意键继续..."
    read -n 1
fi

# 安装/更新依赖
echo "更新项目依赖..."
npm install

# 重启服务
echo "重启服务..."
pm2 restart port-monitor

echo "更新完成！"

# 显示服务状态
pm2 status