// 测试修复后的重试逻辑
const net = require('net');

// 复制修复后的端口检测函数
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

// 修复后的重试函数
async function checkPortConnectivityWithRetry(hostname, port, timeout = 5000, maxRetries = 3) {
    let lastError = null;
    let totalResponseTime = 0;
    let actualAttempts = 0;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        actualAttempts = attempt + 1;
        
        // 如果不是第一次尝试，则等待退避时间
        if (attempt > 0) {
            const backoffTime = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
            console.log(`端口检测重试 ${attempt}/${maxRetries} - ${hostname}:${port}，等待 ${backoffTime}ms`);
            await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
        
        console.log(`尝试连接 ${hostname}:${port} (第 ${actualAttempts} 次)`);
        const result = await checkPortConnectivity(hostname, port, timeout);
        
        if (result.success) {
            console.log(`✅ 连接成功！响应时间: ${result.responseTime}ms`);
            return {
                success: true,
                responseTime: result.responseTime,
                attempts: actualAttempts,
                totalTime: totalResponseTime + result.responseTime
            };
        }
        
        console.log(`❌ 连接失败: ${result.error}`);
        lastError = result.error;
        totalResponseTime += timeout;
        
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

// 测试修复
async function testFix() {
    console.log('=== 测试修复后的重试逻辑 ===\n');
    
    // 测试ECONNREFUSED错误（应该只尝试1次）
    console.log('测试: ECONNREFUSED错误 (localhost:9999)');
    const result1 = await checkPortConnectivityWithRetry('localhost', 9999, 1000, 3);
    console.log('结果:', result1);
    console.log(`实际尝试次数: ${result1.attempts} (应该是1)`);
    console.log();
    
    // 测试超时错误（应该重试3次，总共4次尝试）
    console.log('测试: 超时错误 (10.255.255.1:80)');
    const result2 = await checkPortConnectivityWithRetry('10.255.255.1', 80, 1000, 3);
    console.log('结果:', result2);
    console.log(`实际尝试次数: ${result2.attempts} (应该是4)`);
    console.log();
    
    console.log('=== 测试完成 ===');
}

testFix().catch(console.error);