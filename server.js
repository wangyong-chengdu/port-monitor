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
    // 监控任务表
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        interval_value INTEGER NOT NULL,
        interval_unit TEXT NOT NULL,
        status TEXT DEFAULT 'stopped',
        created_at DATETIME,
        updated_at DATETIME
    )`);
    
    // 检测日志表
    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER,
        status TEXT NOT NULL,
        response_time INTEGER,
        error_message TEXT,
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

// 发送飞书报警
async function sendFeishuAlert(taskName, hostname, port, error) {
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
        
        const message = {
            msg_type: 'interactive',
            card: {
                config: {
                    wide_screen_mode: true
                },
                header: {
                    title: {
                        tag: 'plain_text',
                        content: '🚨 端口连通性检测失败 - 紧急告警'
                    },
                    template: 'red'
                },
                elements: [
                    {
                        tag: 'div',
                        text: {
                            tag: 'lark_md',
                            content: `**⚠️ 检测失败详情**\n\n**任务名称:** ${taskName}\n**目标地址:** ${hostname}:${port}\n**错误信息:** ${error}\n**检测时间:** ${new Date().toLocaleString('zh-CN')}\n\n**请立即检查目标服务状态！**`
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
    const result = await checkPortConnectivity(task.hostname, task.port);
    
    // 记录日志
    const logData = {
        task_id: task.id,
        status: result.success ? 'success' : 'failed',
        response_time: result.responseTime || null,
        error_message: result.error || null,
        checked_at: getLocalDateTime()
    };
    
    db.run(
        'INSERT INTO logs (task_id, status, response_time, error_message, checked_at) VALUES (?, ?, ?, ?, ?)',
        [logData.task_id, logData.status, logData.response_time, logData.error_message, logData.checked_at]
    );
    
    // 如果检测失败，发送报警
    if (!result.success) {
        await sendFeishuAlert(task.name, task.hostname, task.port, result.error);
    }
    
    console.log(`检测完成 - ${task.name} (${task.hostname}:${task.port}): ${result.success ? '成功' : '失败'}`);
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
    const { name, hostname, port, interval_value, interval_unit } = req.body;
    
    if (!name || !hostname || !port || !interval_value || !interval_unit) {
        res.status(400).json({ error: '缺少必要参数' });
        return;
    }
    
    const now = getLocalDateTime();
    
    db.run(
        'INSERT INTO tasks (name, hostname, port, interval_value, interval_unit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [name, hostname, port, interval_value, interval_unit, now, now],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ id: this.lastID, message: '任务创建成功' });
        }
    );
});

// 更新任务
app.put('/api/tasks/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    const { name, hostname, port, interval_value, interval_unit } = req.body;
    
    // 如果任务正在运行，先停止
    stopCronJob(parseInt(id));
    
    const now = getLocalDateTime();
    
    db.run(
        'UPDATE tasks SET name = ?, hostname = ?, port = ?, interval_value = ?, interval_unit = ?, status = "stopped", updated_at = ? WHERE id = ?',
        [name, hostname, port, interval_value, interval_unit, now, id],
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