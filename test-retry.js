// 测试退避指数算法重试功能
const net = require('net');

// 复制原有的端口检测函数
function checkPortConnectivity(hostname, port, timeout = 5000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        const socket = new net.Socket();
        
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            const responseTime = Date.now() - startTime;
            socket.destroy();
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
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 如果不是第一次尝试，则等待退避时间
        if (attempt > 0) {
            const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
            console.log(`端口检测重试 ${attempt}/${maxRetries} - ${hostname}:${port}，等待 ${backoffTime}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
        
        console.log(`尝试连接 ${hostname}:${port} (第 ${attempt + 1} 次)`);
        const result = await checkPortConnectivity(hostname, port, timeout);
        
        if (result.success) {
            console.log(`✅ 连接成功！响应时间: ${result.responseTime}ms`);
            return {
                success: true,
                responseTime: result.responseTime,
                attempts: attempt + 1,
                totalTime: totalResponseTime + result.responseTime
            };
        }
        
        console.log(`❌ 连接失败: ${result.error}`);
        lastError = result.error;
        totalResponseTime += timeout;
        
        // 只有在连接超时的情况下才进行重试，其他错误直接返回
        if (result.error !== 'Connection timeout') {
            console.log(`🚫 非超时错误，停止重试`);
            break;
        }
    }
    
    return {
        success: false,
        error: lastError,
        attempts: maxRetries + 1,
        totalTime: totalResponseTime
    };
}

// 测试函数
async function testRetryMechanism() {
    console.log('=== 端口检测重试机制测试 ===\n');
    
    // 测试1: 连接一个会超时的地址（使用防火墙阻止的端口）
    console.log('测试1: 连接会超时的地址 (10.255.255.1:80 - 不可路由地址)');
    const result1 = await checkPortConnectivityWithRetry('10.255.255.1', 80, 1000, 3);
    console.log('结果:', result1);
    console.log();
    
    // 测试2: 连接一个不存在的端口（连接被拒绝，不应重试）
    console.log('测试2: 连接不存在的端口 (localhost:9999)');
    const result2 = await checkPortConnectivityWithRetry('localhost', 9999, 1000, 3);
    console.log('结果:', result2);
    console.log();
    
    // 测试3: 连接一个无效的主机名（DNS错误，不应重试）
    console.log('测试3: 连接无效主机名 (invalid-host-name:80)');
    const result3 = await checkPortConnectivityWithRetry('invalid-host-name-12345', 80, 1000, 3);
    console.log('结果:', result3);
    console.log();
    
    // 测试4: 连接本地可能存在的服务
    console.log('测试4: 尝试连接本地服务 (localhost:80)');
    const result4 = await checkPortConnectivityWithRetry('localhost', 80, 1000, 3);
    console.log('结果:', result4);
    console.log();
    
    console.log('=== 测试完成 ===');
}

// 运行测试
testRetryMechanism().catch(console.error);