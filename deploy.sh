#!/bin/bash

# Port Monitor 部署脚本
echo "开始部署 Port Monitor 项目..."

# 设置项目目录
PROJECT_DIR="/opt/port-monitor"
BACKUP_DIR="$PROJECT_DIR/backup"

# 创建备份目录
mkdir -p $BACKUP_DIR

# 如果服务正在运行，先停止
if pm2 list | grep -q "port-monitor"; then
    echo "停止现有服务..."
    pm2 stop port-monitor
fi

# 备份数据库文件
if [ -f "$PROJECT_DIR/port_monitor.db" ]; then
    echo "备份数据库文件..."
    cp $PROJECT_DIR/port_monitor.db $BACKUP_DIR/port_monitor_$(date +%Y%m%d_%H%M%S).db
fi

if [ -f "$PROJECT_DIR/sessions.db" ]; then
    cp $PROJECT_DIR/sessions.db $BACKUP_DIR/sessions_$(date +%Y%m%d_%H%M%S).db
fi

# 进入项目目录
cd $PROJECT_DIR

# 安装/更新依赖
echo "安装项目依赖..."
npm install

# 启动服务
echo "启动服务..."
pm2 start server.js --name "port-monitor"

# 保存PM2配置
pm2 save

echo "部署完成！"
echo "访问地址: http://$(curl -s ifconfig.me):3000"
echo "本地访问: http://localhost:3000"

# 显示服务状态
pm2 status