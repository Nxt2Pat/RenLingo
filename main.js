const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { glob } = require('glob');
const translate = require('google-translate-api-x');

const MEMORY_FILE = 'translation_memory.json';
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 800,
        backgroundColor: '#1e1e24',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// สุ่มเลข ID 5 หลัก
function generateRandomID() {
    return Math.floor(10000 + Math.random() * 90000).toString();
}

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.on('start-translation', async (event, config) => {
    const { folderPath, targetLang, batchSize } = config;
    await runTranslator(folderPath, targetLang, batchSize);
    mainWindow.webContents.send('done');
});

async function runTranslator(baseFolder, targetLang, batchSize) {
    const randomID = generateRandomID();
    // สร้างโฟลเดอร์ MyTranslations ไว้ที่เดียวกับตัวโปรแกรม (หรือใน App Data)
    const rootDir = path.join(process.cwd(), 'MyTranslations');
    const originalDir = path.join(rootDir, 'Original', randomID);
    const translatedDir = path.join(rootDir, 'Translated', randomID);

    try {
        await fs.ensureDir(originalDir);
        await fs.ensureDir(translatedDir);
    } catch (err) { sendLog('สร้างโฟลเดอร์ไม่สำเร็จ: ' + err.message, 'error'); return; }

    let translationMemory = {};
    if (fs.existsSync(MEMORY_FILE)) {
        try {
            translationMemory = await fs.readJson(MEMORY_FILE);
            sendLog(`โหลดความจำเดิม: ${Object.keys(translationMemory).length} รายการ`, 'success');
        } catch (e) { translationMemory = {}; }
    }

    const targetPattern = path.join(baseFolder, '**/*.rpy').replace(/\\/g, '/');
    const files = await glob(targetPattern);

    if (files.length === 0) {
        sendLog('ไม่พบไฟล์ .rpy ในโฟลเดอร์ที่เลือก!', 'error');
        return;
    }

    sendLog(`📦 สร้างงานรหัส: ${randomID}`, 'info');
    sendLog(`📁 ต้นฉบับถูกสำรองไว้ที่: Original/${randomID}`, 'info');

    let processedCount = 0;
    for (const file of files) {
        const relativePath = path.relative(baseFolder, file);
        const backupPath = path.join(originalDir, relativePath);
        const outputPath = path.join(translatedDir, relativePath);

        // 1. สำรองต้นฉบับ
        await fs.ensureDir(path.dirname(backupPath));
        await fs.copy(file, backupPath);

        // 2. แปลไฟล์
        await processFile(file, outputPath, translationMemory, targetLang, batchSize);

        processedCount++;
        mainWindow.webContents.send('progress', (processedCount / files.length) * 100);
    }

    await fs.writeJson(MEMORY_FILE, translationMemory, { spaces: 2 });
    sendLog(`✅ แปลสำเร็จ! ไฟล์ทั้งหมดอยู่ที่: Translated/${randomID}`, 'success');
}

async function processFile(inputPath, outputPath, memory, targetLang, batchSize) {
    const fileName = path.basename(inputPath);
    sendLog(`กำลังประมวลผล: ${fileName}`);

    let content = await fs.readFile(inputPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let needToTranslate = [];

    // ค้นหาข้อความ
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^(\s*(?:new|[\w]+)?\s*)"(.*)"/);
        
        if (match && !line.trim().startsWith('old') && !line.trim().startsWith('#')) {
            let original = match[2];
            if (!original.trim() && i > 0 && lines[i-1].trim().startsWith('#')) {
                const commentMatch = lines[i-1].match(/#\s*"(.*)"/);
                if (commentMatch) original = commentMatch[1];
            }

            if (original.trim() && !memory[original] && !needToTranslate.includes(original)) {
                needToTranslate.push(original);
            }
        }
    }

    // แปล Batch
    if (needToTranslate.length > 0) {
        for (let i = 0; i < needToTranslate.length; i += batchSize) {
            const chunk = needToTranslate.slice(i, i + batchSize);
            const maskedData = chunk.map(text => maskText(text));
            try {
                const res = await translate(maskedData.map(d => d.maskedText), { to: targetLang });
                const results = Array.isArray(res) ? res : [res];
                
                chunk.forEach((original, index) => {
                    memory[original] = unmaskText(results[index].text, maskedData[index].variables);
                });
            } catch (err) { sendLog(`⚠️ แปลพลาดที่ ${fileName}: ${err.message}`, 'error'); }
        }
    }

    // สร้างเนื้อหาใหม่
    const newLines = lines.map((line, i) => {
        const match = line.match(/^(\s*(?:new|[\w]+)?\s*)"(.*)"/);
        if (match && !line.trim().startsWith('old') && !line.trim().startsWith('#')) {
            let prefix = match[1];
            let original = match[2];
            
            if (!original.trim() && i > 0 && lines[i-1].trim().startsWith('#')) {
                const commentMatch = lines[i-1].match(/#\s*"(.*)"/);
                if (commentMatch) original = commentMatch[1];
            }
            return (original.trim() && memory[original]) ? `${prefix}"${memory[original]}"` : line;
        }
        return line;
    });

    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeFile(outputPath, newLines.join('\n'), 'utf8');
}

function sendLog(msg, type='info') {
    if(mainWindow) mainWindow.webContents.send('log', { msg, type });
}

function maskText(text) {
    const pattern = /(\[.*?\]|\{.*?\})/g;
    let variables = [];
    let maskedText = text.replace(pattern, (match) => {
        variables.push(match);
        return `__${variables.length - 1}__`;
    });
    return { maskedText, variables };
}

function unmaskText(translatedText, variables) {
    if (!translatedText) return "";
    return translatedText.replace(/__\s*(\d+)\s*__/g, (match, index) => {
        return variables[index] || match; 
    });
}