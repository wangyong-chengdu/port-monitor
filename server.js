const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { NodeSSH } = require('node-ssh');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());

// Session配置
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './'
    }),
    secret: 'port-monitor-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24小时
    }
}));

app.use(express.static('public'));

// 数据库初始化
const db = new sqlite3.Database('port_monitor.db');

// 获取本地时间字符串的函数
function getLocalDateTime() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 密码加密函数
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// 认证中间件
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    } else {
        return res.status(401).json({ error: '未授权访问，请先登录' });
    }
}

// 检查是否已有用户
function checkUserExists(callback) {
    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
        if (err) {
            callback(err, false);
        } else {
            callback(null, row.count > 0);
        }
    });
}

// 创建表
db.serialize(() => {
    // 监控任务表 - 扩展为支持端口监控和脚本执行
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'port', -- 'port' 或 'script'
        hostname TEXT NOT NULL,
        port INTEGER, -- 端口监控时必填
        username TEXT, -- 远程服务器用户名
        password TEXT, -- 远程服务器密码
        script_path TEXT, -- 脚本路径
        interval_value INTEGER NOT NULL,
        interval_unit TEXT NOT NULL,
        status TEXT DEFAULT 'stopped',
        created_at DATETIME,
        updated_at DATETIME
    )`);
    
    // 检测日志表 - 扩展为支持脚本执行结果
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        status TEXT NOT NULL,
        response_time INTEGER,
        error_message TEXT,
        script_output TEXT, -- 脚本执行输出
        checked_at DATETIME,
        FOREIGN KEY (task_id) REFERENCES tasks (id)
    )`);
    
    // 飞书配置表
    db.run(`CREATE TABLE IF NOT EXISTS feishu_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_url TEXT NOT NULL,
        created_at DATETIME
    )`);
    
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME
    )`);
    
    // 添加新字段到现有表（如果不存在）
    db.run(`ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'port'`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('添加task_type字段失败:', err.message);
        }
    });
    db.run(`ALTER TABLE tasks ADD COLUMN username TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('添加username字段失败:', err.message);
        }
    });
    db.run(`ALTER TABLE tasks ADD COLUMN password TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('添加password字段失败:', err.message);
        }
    });
    db.run(`ALTER TABLE tasks ADD COLUMN script_path TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('添加script_path字段失败:', err.message);
        }
    });
    db.run(`ALTER TABLE logs ADD COLUMN script_output TEXT`, (err) => {
        if (err && !err.message.includes('duplicate column name')) {
            console.error('添加script_output字段失败:', err.message);
        }
    });
    
    // 修改port字段为可空（针对脚本任务）
    db.run(`CREATE TABLE IF NOT EXISTS tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'port',
        hostname TEXT NOT NULL,
        port INTEGER,
        username TEXT,
        password TEXT,
        script_path TEXT,
        interval_value INTEGER NOT NULL,
        interval_unit TEXT NOT NULL,
        status TEXT DEFAULT 'stopped',
        created_at DATETIME,
        updated_at DATETIME
    )`, (err) => {
        if (err) {
            console.error('创建新表失败:', err.message);
            return;
        }
        
        // 复制数据到新表
        db.run(`INSERT INTO tasks_new SELECT * FROM tasks`, (err) => {
            if (err) {
                console.error('复制数据失败:', err.message);
                return;
            }
            
            // 删除旧表并重命名新表
            db.run(`DROP TABLE tasks`, (err) => {
                if (err) {
                    console.error('删除旧表失败:', err.message);
                    return;
                }
                
                db.run(`ALTER TABLE tasks_new RENAME TO tasks`, (err) => {
                    if (err) {
                        console.error('重命名表失败:', err.message);
                    } else {
                        console.log('数据库表结构升级完成');
                    }
                });
            });
        });
    });
});

// 存储定时任务
const cronJobs = new Map();

// 端口连通性检测函数
function checkPortConnectivity(hostname, port, timeout = 5000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const socket = new net.Socket();
        
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            const responseTime = Date.now() - startTime;
            socket.destroy(); // 主动关闭连接
            resolve({ success: true, responseTime });
        });
        
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ success: false, error: 'Connection timeout' });
        });
        
        socket.on('error', (err) => {
            socket.destroy();
            resolve({ success: false, error: err.message });
        });
        
        socket.connect(port, hostname);
    });
}

// 使用指数退避算法进行重试的端口连接检测
async function checkPortConnectivityWithRetry(hostname, port, timeout = 5000, maxRetries = 3) {
    let lastError = null;
    let totalResponseTime = 0;
    let actualAttempts = 0;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        actualAttempts = attempt + 1;
        
        // 如果不是第一次尝试，则等待退避时间
        if (attempt > 0) {
            const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // 最大等待10秒
            console.log(`端口检测重试 ${attempt}/${maxRetries} - ${hostname}:${port}，等待 ${backoffTime}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
        
        const result = await checkPortConnectivity(hostname, port, timeout);
        
        if (result.success) {
            return {
                success: true,
                responseTime: result.responseTime,
                attempts: actualAttempts,
                totalTime: totalResponseTime + result.responseTime
            };
        }
        
        lastError = result.error;
        totalResponseTime += timeout; // 累加超时时间
        
        // 只有在连接超时的情况下才进行重试，其他错误直接返回
        if (result.error !== 'Connection timeout') {
            console.log(`非超时错误，停止重试: ${result.error}`);
            break;
        }
    }
    
    return {
        success: false,
        error: lastError,
        attempts: actualAttempts,
        totalTime: totalResponseTime
    };
}

// SSH脚本执行功能
async function executeRemoteScript(hostname, username, password, scriptPath, timeout = 30000) {
    const ssh = new NodeSSH();
    const startTime = Date.now();
    
    try {
        console.log(`[${getLocalDateTime()}] 连接SSH服务器: ${username}@${hostname}`);
        
        await ssh.connect({
            host: hostname,
            username: username,
            password: password,
            timeout: timeout
        });
        
        console.log(`[${getLocalDateTime()}] SSH连接成功，执行脚本: ${scriptPath}`);
        
        const result = await ssh.execCommand(scriptPath, {
            cwd: '/home/' + username,
            timeout: timeout
        });
        
        const responseTime = Date.now() - startTime;
        
        ssh.dispose();
        
        if (result.code === 0) {
            console.log(`[${getLocalDateTime()}] 脚本执行成功: ${scriptPath}`);
            return {
                success: true,
                output: result.stdout,
                error: result.stderr,
                responseTime: responseTime,
                exitCode: result.code
            };
        } else {
            console.log(`[${getLocalDateTime()}] 脚本执行失败: ${scriptPath}, 退出码: ${result.code}`);
            return {
                success: false,
                output: result.stdout,
                error: result.stderr || `脚本执行失败，退出码: ${result.code}`,
                responseTime: responseTime,
                exitCode: result.code
            };
        }
    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.log(`[${getLocalDateTime()}] SSH连接或脚本执行异常: ${error.message}`);
        
        if (ssh.connection) {
            ssh.dispose();
        }
        
        return {
            success: false,
            output: '',
            error: error.message,
            responseTime: responseTime,
            exitCode: -1
        };
    }
}

// 发送飞书报警
async function sendFeishuAlert(taskName, hostname, port, error, alertType = 'port', scriptOutput = '') {
    try {
        const result = await new Promise((resolve, reject) => {
            db.get('SELECT webhook_url FROM feishu_config ORDER BY id DESC LIMIT 1', (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        if (!result || !result.webhook_url) {
            console.log('飞书Webhook未配置，跳过报警发送');
            return;
        }
        
        let title, content;
        
        if (alertType === 'script') {
            title = '🚨 脚本执行失败 - 紧急告警';
            content = `**⚠️ 脚本执行失败详情**\n\n**任务名称:** ${taskName}\n**目标服务器:** ${hostname}\n**错误信息:** ${error}\n**检测时间:** ${new Date().toLocaleString('zh-CN')}\n\n**请立即检查脚本执行状态！**`;
            
            if (scriptOutput && scriptOutput.trim()) {
                content += `\n\n**脚本输出:**\n\`\`\`\n${scriptOutput.substring(0, 500)}${scriptOutput.length > 500 ? '...' : ''}\n\`\`\``;
            }
        } else {
            title = '🚨 端口连通性检测失败 - 紧急告警';
            content = `**⚠️ 检测失败详情**\n\n**任务名称:** ${taskName}\n**目标地址:** ${hostname}:${port}\n**错误信息:** ${error}\n**检测时间:** ${new Date().toLocaleString('zh-CN')}\n\n**请立即检查目标服务状态！**`;
        }
        
        const message = {
            msg_type: 'interactive',
            card: {
                config: {
                    wide_screen_mode: true
                },
                header: {
                    title: {
                        tag: 'plain_text',
                        content: title
                    },
                    template: 'red'
                },
                elements: [
                    {
                        tag: 'div',
                        text: {
                            tag: 'lark_md',
                            content: content
                        }
                    },
                    {
                        tag: 'hr'
                    },
                    {
                        tag: 'note',
                        elements: [
                            {
                                tag: 'plain_text',
                                content: '此消息由端口监控系统自动发送，请及时处理故障。'
                            }
                        ]
                    }
                ]
            }
        };
        
        await axios.post(result.webhook_url, message);
        console.log('飞书报警发送成功');
    } catch (error) {
        console.error('发送飞书报警失败:', error.message);
    }
}

// 执行单次检测
async function performCheck(task) {
    let result;
    let logData = {
        task_id: task.id,
        checked_at: getLocalDateTime()
    };
    
    if (task.task_type === 'script') {
        // 执行远程脚本
        result = await executeRemoteScript(task.hostname, task.username, task.password, task.script_path);
        
        logData.status = result.success ? 'success' : 'failed';
        logData.response_time = result.responseTime;
        logData.error_message = result.success ? null : result.error;
        logData.script_output = result.output;
        
        // 如果脚本执行失败，发送飞书报警
        if (!result.success) {
            await sendFeishuAlert(task.name, task.hostname, null, result.error, 'script', result.output);
        }
        
        const statusText = result.success ? '成功' : '失败';
        console.log(`脚本执行完成 - ${task.name} (${task.hostname}): ${statusText}`);
    } else {
        // 执行端口连通性检测
        result = await checkPortConnectivityWithRetry(task.hostname, task.port);
        
        // 构建错误消息，包含重试信息
        let errorMessage = result.error || null;
        if (!result.success && result.attempts > 1) {
            errorMessage = `${result.error} (重试 ${result.attempts - 1} 次后失败)`;
        }
        
        logData.status = result.success ? 'success' : 'failed';
        logData.response_time = result.responseTime || null;
        logData.error_message = errorMessage;
        logData.script_output = null;
        
        // 只有在所有重试都失败后才发送报警
        if (!result.success) {
            await sendFeishuAlert(task.name, task.hostname, task.port, errorMessage);
        }
        
        const statusText = result.success ? '成功' : '失败';
        const attemptInfo = result.attempts > 1 ? ` (尝试 ${result.attempts} 次)` : '';
        console.log(`检测完成 - ${task.name} (${task.hostname}:${task.port}): ${statusText}${attemptInfo}`);
    }
    
    // 记录日志
    db.run(
        'INSERT INTO logs (task_id, status, response_time, error_message, script_output, checked_at) VALUES (?, ?, ?, ?, ?, ?)',
        [logData.task_id, logData.status, logData.response_time, logData.error_message, logData.script_output, logData.checked_at]
    );
}

// 启动定时任务
function startCronJob(task) {
    const { id, interval_value, interval_unit } = task;
    
    let cronExpression;
    switch (interval_unit) {
        case 'seconds':
            cronExpression = `*/${interval_value} * * * * *`;
            break;
        case 'minutes':
            cronExpression = `0 */${interval_value} * * * *`;
            break;
        case 'hours':
            cronExpression = `0 0 */${interval_value} * * *`;
            break;
        default:
            throw new Error('无效的时间单位');
    }
    
    const job = cron.schedule(cronExpression, () => {
        performCheck(task);
    }, { scheduled: false });
    
    cronJobs.set(id, job);
    job.start();
    
    console.log(`定时任务已启动: ${task.name} (${interval_value} ${interval_unit})`);
}

// 停止定时任务
function stopCronJob(taskId) {
    const job = cronJobs.get(taskId);
    if (job) {
        job.stop();
        cronJobs.delete(taskId);
        console.log(`定时任务已停止: ${taskId}`);
    }
}

// 认证相关API

// 检查是否需要初始化用户
app.get('/api/auth/init', (req, res) => {
    checkUserExists((err, exists) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ needsInit: !exists });
    });
});

// 初始化用户（首次设置）
app.post('/api/auth/init', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        res.status(400).json({ error: '用户名和密码不能为空' });
        return;
    }
    
    checkUserExists((err, exists) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (exists) {
            res.status(400).json({ error: '用户已存在，无法重复初始化' });
            return;
        }
        
        const hashedPassword = hashPassword(password);
        const now = getLocalDateTime();
        
        db.run(
            'INSERT INTO users (username, password, created_at) VALUES (?, ?, ?)',
            [username, hashedPassword, now],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                req.session.authenticated = true;
                req.session.username = username;
                res.json({ message: '用户初始化成功' });
            }
        );
    });
});

// 用户登录
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        res.status(400).json({ error: '用户名和密码不能为空' });
        return;
    }
    
    const hashedPassword = hashPassword(password);
    
    db.get(
        'SELECT * FROM users WHERE username = ? AND password = ?',
        [username, hashedPassword],
        (err, row) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            if (row) {
                req.session.authenticated = true;
                req.session.username = username;
                res.json({ message: '登录成功' });
            } else {
                res.status(401).json({ error: '用户名或密码错误' });
            }
        }
    );
});

// 用户登出
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            res.status(500).json({ error: '登出失败' });
            return;
        }
        res.json({ message: '登出成功' });
    });
});

// 检查认证状态
app.get('/api/auth/status', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.json({ authenticated: true, username: req.session.username });
    } else {
        res.json({ authenticated: false });
    }
});

// API 路由

// 获取所有任务
app.get('/api/tasks', requireAuth, (req, res) => {
    db.all('SELECT * FROM tasks ORDER BY created_at DESC', (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// 创建新任务
app.post('/api/tasks', requireAuth, (req, res) => {
    const { name, task_type, hostname, port, username, password, script_path, interval_value, interval_unit } = req.body;
    
    if (!name || !task_type || !hostname || !interval_value || !interval_unit) {
        res.status(400).json({ error: '缺少必要参数' });
        return;
    }
    
    // 验证任务类型特定的必要参数
    if (task_type === 'port' && !port) {
        res.status(400).json({ error: '端口监控任务需要指定端口' });
        return;
    }
    
    if (task_type === 'script' && (!username || !password || !script_path)) {
        res.status(400).json({ error: '脚本执行任务需要指定用户名、密码和脚本路径' });
        return;
    }
    
    const now = getLocalDateTime();
    
    db.run(
        'INSERT INTO tasks (name, task_type, hostname, port, username, password, script_path, interval_value, interval_unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, task_type, hostname, port, username, password, script_path, interval_value, interval_unit, now, now],
        function(err) {
            if (err) {
                console.error('创建任务时数据库错误:', err);
                res.status(500).json({ error: '创建任务失败，请检查输入参数是否正确' });
                return;
            }
            res.json({ id: this.lastID, message: '任务创建成功' });
        }
    );
});

// 更新任务
app.put('/api/tasks/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { name, task_type, hostname, port, username, password, script_path, interval_value, interval_unit } = req.body;
    
    if (!name || !task_type || !hostname || !interval_value || !interval_unit) {
        res.status(400).json({ error: '缺少必要参数' });
        return;
    }
    
    // 验证任务类型特定的必要参数
    if (task_type === 'port' && !port) {
        res.status(400).json({ error: '端口监控任务需要指定端口' });
        return;
    }
    
    if (task_type === 'script' && (!username || !password || !script_path)) {
        res.status(400).json({ error: '脚本执行任务需要指定用户名、密码和脚本路径' });
        return;
    }
    
    // 如果任务正在运行，先停止
    stopCronJob(parseInt(id));
    
    const now = getLocalDateTime();
    
    db.run(
        'UPDATE tasks SET name = ?, task_type = ?, hostname = ?, port = ?, username = ?, password = ?, script_path = ?, interval_value = ?, interval_unit = ?, status = "stopped", updated_at = ? WHERE id = ?',
        [name, task_type, hostname, port, username, password, script_path, interval_value, interval_unit, now, id],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: '任务更新成功' });
        }
    );
});

// 删除任务
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    
    // 停止定时任务
    stopCronJob(parseInt(id));
    
    // 删除任务和相关日志
    db.serialize(() => {
        db.run('DELETE FROM logs WHERE task_id = ?', [id]);
        db.run('DELETE FROM tasks WHERE id = ?', [id], function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: '任务删除成功' });
        });
    });
});

// 启动任务
app.post('/api/tasks/:id/start', requireAuth, (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM tasks WHERE id = ?', [id], (err, task) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!task) {
            res.status(404).json({ error: '任务不存在' });
            return;
        }
        
        try {
            startCronJob(task);
            
            db.run('UPDATE tasks SET status = "running" WHERE id = ?', [id], (err) => {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                res.json({ message: '任务启动成功' });
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// 停止任务
app.post('/api/tasks/:id/stop', requireAuth, (req, res) => {
    const { id } = req.params;
    
    stopCronJob(parseInt(id));
    
    db.run('UPDATE tasks SET status = "stopped" WHERE id = ?', [id], (err) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json({ message: '任务停止成功' });
    });
});

// 手动执行检测
app.post('/api/tasks/:id/check', requireAuth, (req, res) => {
    const { id } = req.params;
    
    db.get('SELECT * FROM tasks WHERE id = ?', [id], async (err, task) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        if (!task) {
            res.status(404).json({ error: '任务不存在' });
            return;
        }
        
        await performCheck(task);
        res.json({ message: '检测完成' });
    });
});

// 获取任务日志
app.get('/api/tasks/:id/logs', requireAuth, (req, res) => {
    const { id } = req.params;
    const { limit = 50 } = req.query;
    
    db.all(
        'SELECT * FROM logs WHERE task_id = ? ORDER BY checked_at DESC LIMIT ?',
        [id, limit],
        (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json(rows);
        }
    );
});

// 配置飞书Webhook
app.post('/api/feishu/config', requireAuth, (req, res) => {
    const { webhook_url } = req.body;
    
    if (!webhook_url) {
        res.status(400).json({ error: '缺少webhook_url参数' });
        return;
    }
    
    const now = getLocalDateTime();
    
    db.run(
        'INSERT INTO feishu_config (webhook_url, created_at) VALUES (?, ?)',
        [webhook_url, now],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ message: '飞书配置保存成功' });
        }
    );
});

// 获取飞书配置
app.get('/api/feishu/config', requireAuth, (req, res) => {
    db.get('SELECT * FROM feishu_config ORDER BY id DESC LIMIT 1', (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(row || {});
    });
});

// 测试飞书报警
app.post('/api/feishu/test', requireAuth, async (req, res) => {
    try {
        await sendFeishuAlert('测试任务', 'test.example.com', 80, '这是一条测试报警消息');
        res.json({ message: '测试报警发送成功' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 服务器启动时恢复运行中的任务
db.all('SELECT * FROM tasks WHERE status = "running"', (err, tasks) => {
    if (err) {
        console.error('恢复任务失败:', err.message);
        return;
    }
    
    tasks.forEach(task => {
        try {
            startCronJob(task);
            console.log(`恢复任务: ${task.name}`);
        } catch (error) {
            console.error(`恢复任务失败 ${task.name}:`, error.message);
        }
    });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`端口监控系统启动成功，访问地址: http://localhost:${PORT}`);
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...');
    
    // 停止所有定时任务
    cronJobs.forEach((job, taskId) => {
        job.stop();
        console.log(`停止任务: ${taskId}`);
    });
    
    // 关闭数据库连接
    db.close((err) => {
        if (err) {
            console.error('关闭数据库失败:', err.message);
        } else {
            console.log('数据库连接已关闭');
        }
        process.exit(0);
    });
});