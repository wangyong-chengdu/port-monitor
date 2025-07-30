class PortMonitor {
    constructor() {
        this.tasks = [];
        this.currentEditingTask = null;
        this.currentLogsTaskId = null;
        this.logsRefreshInterval = null;
        this.init();
    }

    async init() {
        // 检查认证状态
        const authStatus = await this.checkAuthStatus();
        if (!authStatus.authenticated) {
            window.location.href = '/login.html';
            return;
        }
        
        // 显示用户信息
        this.displayUserInfo(authStatus.username);
        
        this.bindEvents();
        this.loadTasks();
        this.loadFeishuConfig();
    }

    async checkAuthStatus() {
        try {
            const response = await fetch('/api/auth/status');
            return await response.json();
        } catch (error) {
            console.error('检查认证状态失败:', error);
            return { authenticated: false };
        }
    }

    displayUserInfo(username) {
        const header = document.querySelector('.header');
        if (header) {
            const userInfo = document.createElement('div');
            userInfo.className = 'user-info';
            userInfo.innerHTML = `
                <span class="username"><i class="fas fa-user"></i> ${username}</span>
                <button class="btn btn-secondary btn-small logout-btn" onclick="portMonitor.logout()">
                    <i class="fas fa-sign-out-alt"></i> 登出
                </button>
            `;
            header.appendChild(userInfo);
        }
    }

    async logout() {
        try {
            const response = await fetch('/api/auth/logout', {
                method: 'POST'
            });
            
            if (response.ok) {
                window.location.href = '/login.html';
            } else {
                this.showNotification('登出失败', 'error');
            }
        } catch (error) {
            console.error('登出失败:', error);
            this.showNotification('登出失败', 'error');
        }
    }

    bindEvents() {
        // 新建任务按钮
        document.getElementById('addTaskBtn').addEventListener('click', () => {
            this.showTaskModal();
        });

        // 飞书配置按钮
        document.getElementById('feishuConfigBtn').addEventListener('click', () => {
            this.showFeishuModal();
        });

        // 模态框关闭
        document.querySelectorAll('.close').forEach(closeBtn => {
            closeBtn.addEventListener('click', (e) => {
                this.closeModal(e.target.closest('.modal'));
            });
        });

        // 点击模态框外部关闭
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal(modal);
                }
            });
        });

        // 任务表单提交
        document.getElementById('taskForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveTask();
        });

        // 飞书表单提交
        document.getElementById('feishuForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveFeishuConfig();
        });

        // 取消按钮
        document.getElementById('cancelBtn').addEventListener('click', () => {
            this.closeModal(document.getElementById('taskModal'));
        });

        document.getElementById('feishuCancelBtn').addEventListener('click', () => {
            this.closeModal(document.getElementById('feishuModal'));
        });

        // 测试飞书按钮
        document.getElementById('testFeishuBtn').addEventListener('click', () => {
            this.testFeishu();
        });
    }

    async loadTasks() {
        try {
            this.showLoading();
            const response = await fetch('/api/tasks');
            if (response.status === 401) {
                window.location.href = '/login.html';
                return;
            }
            const tasks = await response.json();
            this.tasks = tasks;
            this.renderTasks();
            this.updateStats();
        } catch (error) {
            this.showNotification('加载任务失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async loadFeishuConfig() {
        try {
            const response = await fetch('/api/feishu/config');
            const config = await response.json();
            if (config.webhook_url) {
                document.getElementById('webhookUrl').value = config.webhook_url;
            }
        } catch (error) {
            console.error('加载飞书配置失败:', error);
        }
    }

    renderTasks() {
        const container = document.getElementById('taskContainer');
        
        if (this.tasks.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-inbox" style="font-size: 3em; color: #a0aec0; margin-bottom: 15px;"></i>
                    <h3 style="color: #4a5568; margin-bottom: 10px;">暂无监控任务</h3>
                    <p style="color: #718096;">点击"新建任务"开始创建您的第一个端口监控任务</p>
                </div>
            `;
            return;
        }

        container.innerHTML = this.tasks.map(task => this.renderTaskCard(task)).join('');
        
        // 绑定任务卡片事件
        this.bindTaskEvents();
    }

    renderTaskCard(task) {
        const statusClass = task.status === 'running' ? 'status-running' : 'status-stopped';
        const statusText = task.status === 'running' ? '运行中' : '已停止';
        const intervalText = this.formatInterval(task.interval_value, task.interval_unit);
        
        return `
            <div class="task-card" data-task-id="${task.id}">
                <div class="task-header">
                    <div>
                        <div class="task-title">${task.name}</div>
                        <span class="task-status ${statusClass}">${statusText}</span>
                    </div>
                </div>
                
                <div class="task-info">
                    <div class="task-info-item">
                        <i class="fas fa-server"></i>
                        <span>${task.hostname}:${task.port}</span>
                    </div>
                    <div class="task-info-item">
                        <i class="fas fa-clock"></i>
                        <span>每 ${intervalText} 检测一次</span>
                    </div>
                    <div class="task-info-item">
                        <i class="fas fa-calendar"></i>
                        <span>创建于 ${new Date(task.created_at).toLocaleString('zh-CN')}</span>
                    </div>
                </div>
                
                <div class="task-actions">
                    ${task.status === 'running' ? 
                        '<button class="btn btn-warning btn-small stop-task"><i class="fas fa-stop"></i> 停止</button>' :
                        '<button class="btn btn-success btn-small start-task"><i class="fas fa-play"></i> 启动</button>'
                    }
                    <button class="btn btn-info btn-small check-task">
                        <i class="fas fa-search"></i> 立即检测
                    </button>
                    <button class="btn btn-secondary btn-small view-logs">
                        <i class="fas fa-list"></i> 查看日志
                    </button>
                    <button class="btn btn-secondary btn-small edit-task">
                        <i class="fas fa-edit"></i> 编辑
                    </button>
                    <button class="btn btn-danger btn-small delete-task">
                        <i class="fas fa-trash"></i> 删除
                    </button>
                </div>
            </div>
        `;
    }

    bindTaskEvents() {
        // 启动任务
        document.querySelectorAll('.start-task').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.startTask(taskId);
            });
        });

        // 停止任务
        document.querySelectorAll('.stop-task').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.stopTask(taskId);
            });
        });

        // 立即检测
        document.querySelectorAll('.check-task').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.checkTask(taskId);
            });
        });

        // 查看日志
        document.querySelectorAll('.view-logs').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.viewLogs(taskId);
            });
        });

        // 编辑任务
        document.querySelectorAll('.edit-task').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.editTask(taskId);
            });
        });

        // 删除任务
        document.querySelectorAll('.delete-task').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const taskId = e.target.closest('.task-card').dataset.taskId;
                this.deleteTask(taskId);
            });
        });
    }

    formatInterval(value, unit) {
        const unitMap = {
            'seconds': '秒',
            'minutes': '分钟',
            'hours': '小时'
        };
        return `${value} ${unitMap[unit]}`;
    }

    updateStats() {
        const totalTasks = this.tasks.length;
        const runningTasks = this.tasks.filter(task => task.status === 'running').length;
        
        document.getElementById('totalTasks').textContent = totalTasks;
        document.getElementById('runningTasks').textContent = runningTasks;
    }

    showTaskModal(task = null) {
        const modal = document.getElementById('taskModal');
        const form = document.getElementById('taskForm');
        const title = document.getElementById('modalTitle');
        
        if (task) {
            title.textContent = '编辑监控任务';
            document.getElementById('taskName').value = task.name;
            document.getElementById('hostname').value = task.hostname;
            document.getElementById('port').value = task.port;
            document.getElementById('intervalValue').value = task.interval_value;
            document.getElementById('intervalUnit').value = task.interval_unit;
            this.currentEditingTask = task;
        } else {
            title.textContent = '新建监控任务';
            form.reset();
            this.currentEditingTask = null;
        }
        
        modal.style.display = 'block';
    }

    showFeishuModal() {
        const modal = document.getElementById('feishuModal');
        modal.style.display = 'block';
    }

    closeModal(modal) {
        modal.style.display = 'none';
        
        // 如果关闭的是日志模态框，停止自动刷新
        if (modal.id === 'logsModal') {
            this.stopLogsAutoRefresh();
        }
    }

    async saveTask() {
        const formData = new FormData(document.getElementById('taskForm'));
        const taskData = Object.fromEntries(formData.entries());
        
        try {
            this.showLoading();
            
            let response;
            if (this.currentEditingTask) {
                response = await fetch(`/api/tasks/${this.currentEditingTask.id}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(taskData)
                });
            } else {
                response = await fetch('/api/tasks', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(taskData)
                });
            }
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
                this.closeModal(document.getElementById('taskModal'));
                this.loadTasks();
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('保存任务失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async saveFeishuConfig() {
        const webhookUrl = document.getElementById('webhookUrl').value;
        
        try {
            this.showLoading();
            
            const response = await fetch('/api/feishu/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ webhook_url: webhookUrl })
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
                this.closeModal(document.getElementById('feishuModal'));
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('保存配置失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async testFeishu() {
        try {
            this.showLoading();
            
            const response = await fetch('/api/feishu/test', {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('测试失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async startTask(taskId) {
        try {
            this.showLoading();
            
            const response = await fetch(`/api/tasks/${taskId}/start`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
                this.loadTasks();
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('启动任务失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async stopTask(taskId) {
        try {
            this.showLoading();
            
            const response = await fetch(`/api/tasks/${taskId}/stop`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
                this.loadTasks();
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('停止任务失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async checkTask(taskId) {
        try {
            this.showLoading();
            
            const response = await fetch(`/api/tasks/${taskId}/check`, {
                method: 'POST'
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('执行检测失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async viewLogs(taskId) {
        try {
            this.showLoading();
            
            const response = await fetch(`/api/tasks/${taskId}/logs`);
            const logs = await response.json();
            
            if (response.ok) {
                this.showLogsModal(taskId, logs);
            } else {
                this.showNotification('获取日志失败: ' + logs.error, 'error');
            }
        } catch (error) {
            this.showNotification('获取日志失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    showLogsModal(taskId, logs) {
        const task = this.tasks.find(t => t.id == taskId);
        const modal = document.getElementById('logsModal');
        const title = document.getElementById('logsModalTitle');
        const content = document.getElementById('logsContent');
        
        title.textContent = `${task.name} - 检测日志`;
        
        // 存储当前查看的任务ID，用于自动刷新
        this.currentLogsTaskId = taskId;
        
        this.renderLogs(logs);
        modal.style.display = 'block';
        
        // 启动自动刷新日志
        this.startLogsAutoRefresh();
    }

    renderLogs(logs) {
        const content = document.getElementById('logsContent');
        
        if (logs.length === 0) {
            content.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #718096;">
                    <i class="fas fa-inbox" style="font-size: 2em; margin-bottom: 15px;"></i>
                    <p>暂无检测日志</p>
                </div>
            `;
        } else {
            content.innerHTML = logs.map(log => {
                const statusClass = log.status === 'success' ? 'log-success' : 'log-failed';
                const statusIcon = log.status === 'success' ? 'fas fa-check-circle' : 'fas fa-times-circle';
                const responseTime = log.response_time ? ` (${log.response_time}ms)` : '';
                const errorMsg = log.error_message ? `<br><small style="color: #e53e3e;">${log.error_message}</small>` : '';
                
                return `
                    <div class="log-item ${statusClass}">
                        <div>
                            <i class="${statusIcon}"></i>
                            <span class="log-status">${log.status === 'success' ? '连接成功' : '连接失败'}${responseTime}</span>
                            ${errorMsg}
                        </div>
                        <div class="log-time">${new Date(log.checked_at).toLocaleString('zh-CN')}</div>
                    </div>
                `;
            }).join('');
        }
    }

    startLogsAutoRefresh() {
        // 清除之前的定时器
        if (this.logsRefreshInterval) {
            clearInterval(this.logsRefreshInterval);
        }
        
        // 每5秒自动刷新日志
        this.logsRefreshInterval = setInterval(async () => {
            if (this.currentLogsTaskId && document.getElementById('logsModal').style.display === 'block') {
                try {
                    const response = await fetch(`/api/tasks/${this.currentLogsTaskId}/logs`);
                    const logs = await response.json();
                    
                    if (response.ok) {
                        this.renderLogs(logs);
                    }
                } catch (error) {
                    console.error('自动刷新日志失败:', error);
                }
            } else {
                // 如果模态框已关闭，停止自动刷新
                this.stopLogsAutoRefresh();
            }
        }, 5000);
    }

    stopLogsAutoRefresh() {
        if (this.logsRefreshInterval) {
            clearInterval(this.logsRefreshInterval);
            this.logsRefreshInterval = null;
        }
        this.currentLogsTaskId = null;
    }

    editTask(taskId) {
        const task = this.tasks.find(t => t.id == taskId);
        if (task) {
            this.showTaskModal(task);
        }
    }

    async deleteTask(taskId) {
        const task = this.tasks.find(t => t.id == taskId);
        
        if (!confirm(`确定要删除任务 "${task.name}" 吗？此操作不可恢复。`)) {
            return;
        }
        
        try {
            this.showLoading();
            
            const response = await fetch(`/api/tasks/${taskId}`, {
                method: 'DELETE'
            });
            
            const result = await response.json();
            
            if (response.ok) {
                this.showNotification(result.message, 'success');
                this.loadTasks();
            } else {
                this.showNotification(result.error, 'error');
            }
        } catch (error) {
            this.showNotification('删除任务失败: ' + error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    showLoading() {
        document.getElementById('loading').classList.remove('hidden');
    }

    hideLoading() {
        document.getElementById('loading').classList.add('hidden');
    }

    showNotification(message, type = 'info') {
        const container = document.getElementById('notifications');
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <div style="display: flex; align-items: center; gap: 10px;">
                <i class="fas ${
                    type === 'success' ? 'fa-check-circle' :
                    type === 'error' ? 'fa-exclamation-circle' :
                    type === 'warning' ? 'fa-exclamation-triangle' :
                    'fa-info-circle'
                }"></i>
                <span>${message}</span>
            </div>
        `;
        
        container.appendChild(notification);
        
        // 3秒后自动移除
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 3000);
    }
}

// 初始化应用
document.addEventListener('DOMContentLoaded', () => {
    window.portMonitor = new PortMonitor();
});