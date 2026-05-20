const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const cloudinary = require('cloudinary').v2;
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 限制 10MB
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const app = express();

// ========== GitHub Actions 觸發函數 ==========
async function triggerGitHubAction() {
  try {
    const githubToken = process.env.GH_PAT_TOKEN;
    if (!githubToken) {
      console.log('⚠️ 未設定 GH_PAT_TOKEN，跳過觸發 GitHub Actions');
      return;
    }
    
    const repo = 'fernbrom1127/linephotowall';
    const workflowId = 'update-photos-json.yml';
    
    await axios.post(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        ref: 'main',
        inputs: {
          trigger: 'new_upload'
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    console.log('✅ 已觸發 GitHub Actions 更新 photos.json');
  } catch (error) {
    console.error('❌ 觸發 GitHub Actions 失敗:', error.response?.data || error.message);
  }
}

// ========== CORS 設定 ==========
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://newlinephotowall.onrender.com',
    'https://photo.fernbrom.com',
    'http://localhost:3000'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// ========== 基本安全設定 ==========
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

// ========== 速率限制 ==========
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: '請求過於頻繁，請稍後再試',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  skip: (req) => {
    return req.ip === '127.0.0.1' || req.path === '/health';
  }
});

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// ========== Cloudinary 設定 ==========
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ========== Google Sheets 設定 ==========
let googleSheetDoc = null;
let googleSheetReady = false;
let photosSheet = null;
let settingsSheet = null;
let messagesSheet = null;
let pendingCaption = {};

// ========== LINE Webhook 簽章驗證 ==========
function verifyLineSignature(req, res, next) {
  if (!LINE_CHANNEL_SECRET || LINE_CHANNEL_SECRET === 'your_channel_secret_here') {
    console.log('⚠️ 跳過簽章驗證（未設定 LINE_CHANNEL_SECRET）');
    return next();
  }

  const signature = req.headers['x-line-signature'];
  if (!signature) {
    console.error('❌ 缺少 LINE 簽章');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(body)
    .digest('base64');

  if (signature !== expectedSignature) {
    console.error('❌ 簽章驗證失敗');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('✅ LINE 簽章驗證通過');
  next();
}

// ========== Google Sheets 初始化 ==========
async function initGoogleSheets() {
  try {
    console.log('🔧 開始初始化 Google Sheets...');
    
    const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const private_key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;
    
    if (!client_email || !private_key || !sheetId) {
      console.log('⚠️ 缺少 Google Sheets 環境變數');
      return false;
    }
    
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    console.log('✅ 文件載入成功');
    googleSheetDoc = doc;
    
    photosSheet = doc.sheetsByTitle['照片牆'];
    if (!photosSheet) {
      photosSheet = await doc.addSheet({ title: '照片牆' });
      console.log('✅ 已建立全新的「照片牆」工作表');
    }

    const expectedHeaders = ['時間', '使用者ID', '圖片URL', '原始訊息', '標籤', '年月', '按讚數'];
    let currentHeaders = [];

    try {
      await photosSheet.loadHeaderRow();
      currentHeaders = photosSheet.headerValues;
    } catch (headerError) {
      currentHeaders = [];
    }

    let needRepair = false;
    if (currentHeaders.length === 0) {
      needRepair = true;
    } else if (currentHeaders.length !== expectedHeaders.length) {
      needRepair = true;
    } else {
      for (let i = 0; i < expectedHeaders.length; i++) {
        if (currentHeaders[i] !== expectedHeaders[i]) {
          needRepair = true;
          break;
        }
      }
    }

    if (needRepair) {
      console.log('🔄 正在重建「照片牆」工作表結構...');
      try {
        await photosSheet.clear();
        await photosSheet.setHeaderRow(expectedHeaders);
        console.log('✅ 已成功重建標題列');
      } catch (repairError) {
        console.error('❌ 重建工作表失敗:', repairError.message);
        return false;
      }
    }
    
    settingsSheet = doc.sheetsByTitle['使用者設定'];
    if (!settingsSheet) {
      settingsSheet = await doc.addSheet({ title: '使用者設定', headerValues: ['使用者ID', '顯示名稱', '頭像URL', '自我介紹', 'IG帳號', 'FB帳號', '更新時間'] });
      console.log('✅ 已建立「使用者設定」工作表');
    }
    
    messagesSheet = doc.sheetsByTitle['留言板'];
    if (!messagesSheet) {
      messagesSheet = await doc.addSheet({ title: '留言板', headerValues: ['留言ID', '目標使用者ID', '留言者ID', '留言內容', '時間', '按讚數', '父留言ID'] });
      console.log('✅ 已建立「留言板」工作表');
    }
    
    googleSheetReady = true;
    console.log('✅ Google Sheets 連線成功！');
    return true;
  } catch (error) {
    console.error('❌ Google Sheets 連線失敗：', error.message);
    googleSheetReady = false;
    return false;
  }
}

// ========== Cloudinary 上傳圖片 ==========
async function uploadToCloudinary(imageBuffer, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { 
            folder: 'linebot_photos', 
            timeout: 30000,
            categorization: 'google_tagging',
            auto_tagging: 0.6,
          },
          (error, uploadResult) => {
            if (error) return reject(error);
            if (uploadResult && uploadResult.secure_url) resolve(uploadResult);
            else reject(new Error('Cloudinary 未回傳圖片網址'));
          }
        );
        uploadStream.end(imageBuffer);
      });
      console.log(`✅ Cloudinary 上傳成功`);
      return result;
    } catch (error) {
      console.error(`❌ Cloudinary 上傳失敗:`, error.message);
      if (attempt === retries) return null;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// ========== 儲存圖片到 Google Sheets ==========
async function savePhotoToSheet(userId, uploadResult, caption = '') {
  if (!googleSheetReady || !photosSheet) return false;
  const yearMonth = new Date().toISOString().substring(0, 7);
  
  const sanitizedCaption = caption ? caption.replace(/[<>]/g, '').substring(0, 500) : '';
  const aiTags = (uploadResult.tags && uploadResult.tags.length > 0) 
    ? uploadResult.tags.slice(0, 10).join(', ')
    : '';
  
  try {
    await photosSheet.addRow({
      '時間': new Date().toISOString(),
      '使用者ID': userId,
      '圖片URL': uploadResult.secure_url,
      '原始訊息': sanitizedCaption,
      '標籤': aiTags,
      '年月': yearMonth,
      '按讚數': 0
    });
    console.log(`📸 照片已儲存，AI 標籤：${aiTags || '無'}`);
    return true;
  } catch (error) {
    console.error('❌ 儲存失敗：', error.message);
    return false;
  }
}

// ========== 更新照片說明文字 ==========
async function updatePhotoCaption(imageUrl, caption) {
  if (!googleSheetReady || !photosSheet) return false;
  const sanitizedCaption = caption ? caption.replace(/[<>]/g, '').substring(0, 500) : '';
  try {
    const rows = await photosSheet.getRows();
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl) {
        row.set('原始訊息', sanitizedCaption);
        await row.save();
        console.log(`📝 已更新照片說明`);
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error('❌ 更新說明失敗：', error.message);
    return false;
  }
}

// ========== 回覆輔助函數 ==========
async function replyToUser(replyToken, message) {
  if (!replyToken) return;
  const safeMessage = message ? message.substring(0, 2000) : '';
  try {
    await axios.post('https://api.line.me/v2/bot/message/reply', {
      replyToken,
      messages: [{ type: 'text', text: safeMessage }]
    }, { headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` } });
  } catch (error) {
    console.error('回覆失敗：', error.response?.data || error.message);
  }
}

// ========== 定期清理過期的 pendingCaption ==========
setInterval(() => {
  const now = Date.now();
  for (const [userId, data] of Object.entries(pendingCaption)) {
    if (now - data.timestamp > 60000) {
      delete pendingCaption[userId];
    }
  }
}, 30000);

// ========== 路由 ==========
app.get('/', (req, res) => res.redirect('/photowall'));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/user/:userId', (req, res) => {
  const safeUserId = req.params.userId.replace(/[<>]/g, '');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>我的相簿</title><script>localStorage.setItem('userId','${safeUserId}');window.location.href='/photowall';</script></head><body>載入中...</body></html>`);
});

// ========== LINE Webhook ==========
app.post('/webhook', webhookLimiter, express.json(), verifyLineSignature, async (req, res) => {
  res.status(200).send('OK');
  
  const events = req.body.events;
  if (!events || !Array.isArray(events)) return;
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;
    const messageType = event.message?.type;
    
    if (!userId) continue;
    
    console.log(`\n📸 [${new Date().toLocaleString()}] 使用者：${userId.substring(0,8)}...`);
    
    try {
      if (messageType === 'image') {
        const messageId = event.message.id;
        console.log(`   📸 收到圖片：${messageId}`);
        
        const imageResponse = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
          headers: { 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` },
          responseType: 'arraybuffer',
          timeout: 30000
        });
        
        if (imageResponse.data.length > 5 * 1024 * 1024) {
          await replyToUser(replyToken, '❌ 圖片過大，請上傳小於 5MB 的照片');
          continue;
        }
        
        const uploadResult = await uploadToCloudinary(imageResponse.data);

        if (uploadResult) {
          await savePhotoToSheet(userId, uploadResult, '');
          pendingCaption[userId] = { imageUrl: uploadResult.secure_url, timestamp: Date.now() };
          
          // ★★★ 觸發 GitHub Actions 更新 photos.json ★★★
          triggerGitHubAction().catch(e => console.error('觸發失敗:', e.message));
          
          await replyToUser(replyToken, 
            `📸 照片已儲存！\n\n` +
            `📝 如需加上說明文字，請在 1 分鐘內輸入\n` +
            `🏠 照片牆：https://photo.fernbrom.com/\n` +
            `👤 個人相簿：https://photo.fernbrom.com/user/${userId}`                
          );
        } else {
          await replyToUser(replyToken, '❌ 圖片上傳失敗，請稍後再試');
        }
      }
      else if (messageType === 'text' && userMessage) {
        const pending = pendingCaption[userId];
        
        if (pending && (Date.now() - pending.timestamp) < 60000) {
          const caption = (userMessage === '略過' || userMessage === 'skip') ? '' : userMessage;
          await updatePhotoCaption(pending.imageUrl, caption);
          delete pendingCaption[userId];
          
          await replyToUser(replyToken, 
            `✅ 已${caption ? `加上說明` : '略過說明'}！\n🏠 照片牆：https://photo.fernbrom.com/photowall`
          );
        } else {
          await replyToUser(replyToken, '請先傳送照片，再為它加上說明～');
        }
      }
    } catch (error) {
      console.error(`   ❌ 錯誤：`, error.message);
      if (replyToken) await replyToUser(replyToken, '❌ 處理失敗，請稍後再試');
    }
  }
});

// ========== 網頁上傳照片接口 ==========
app.post('/api/upload-web', upload.single('photo'), async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: '未提供憑證' });
    
    const token = authHeader.split(' ')[1];
    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleUserId = payload.sub;

    const imageBuffer = req.file.buffer;
    const caption = req.body.caption || '';

    const uploadResult = await uploadToCloudinary(imageBuffer);
    if (!uploadResult) throw new Error('Cloudinary 上傳失敗');

    await savePhotoToSheet(`google_${googleUserId}`, uploadResult, caption);

    // ★★★ 觸發 GitHub Actions 更新 photos.json ★★★
    triggerGitHubAction().catch(e => console.error('觸發失敗:', e.message));

    res.json({ success: true, imageUrl: uploadResult.secure_url });
  } catch (error) {
    console.error('上傳失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== 照片牆 API ==========
app.get('/api/photos', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      if (userId === 'test_user') continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      const time = row.get('時間') || '';
      let yearMonth = row.get('年月') || '';
      if (!yearMonth && time) yearMonth = time.substring(0, 7);
      photos.push({
        time: time,
        userId,
        imageUrl,
        message: row.get('原始訊息') || '',
        tag: row.get('標籤') || '',
        yearMonth: yearMonth,
        likes: parseInt(row.get('按讚數')) || 0
      });
    }
    photos.reverse();
    res.json(photos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/photos/user/:userId', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const targetUserId = req.params.userId;
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      if (userId !== targetUserId) continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      const time = row.get('時間') || '';
      let yearMonth = row.get('年月') || '';
      if (!yearMonth && time) yearMonth = time.substring(0, 7);
      photos.push({
        time: time,
        userId,
        imageUrl,
        message: row.get('原始訊息') || '',
        tag: row.get('標籤') || '',
        yearMonth: yearMonth,
        likes: parseInt(row.get('按讚數')) || 0
      });
    }
    photos.sort((a,b) => new Date(b.time) - new Date(a.time));
    res.json(photos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/photos/tag/:tag', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const tag = req.params.tag;
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      const rowTag = row.get('標籤') || '';
      if (!rowTag.toLowerCase().includes(tag.toLowerCase())) continue;
      const time = row.get('時間') || '';
      let yearMonth = row.get('年月') || '';
      if (!yearMonth && time) yearMonth = time.substring(0, 7);
      photos.push({
        time: time,
        userId: row.get('使用者ID'),
        imageUrl: row.get('圖片URL'),
        message: row.get('原始訊息') || '',
        tag: rowTag,
        yearMonth: yearMonth,
        likes: parseInt(row.get('按讚數')) || 0
      });
    }
    photos.reverse();
    res.json(photos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/photos/date/:yearMonth', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const yearMonth = req.params.yearMonth;
    const rows = await photosSheet.getRows();
    const photos = [];
    for (const row of rows) {
      let rowYearMonth = row.get('年月') || '';
      const time = row.get('時間') || '';
      if (!rowYearMonth && time) rowYearMonth = time.substring(0, 7);
      if (rowYearMonth !== yearMonth) continue;
      photos.push({
        time: time,
        userId: row.get('使用者ID'),
        imageUrl: row.get('圖片URL'),
        message: row.get('原始訊息') || '',
        tag: row.get('標籤') || '',
        yearMonth: rowYearMonth,
        likes: parseInt(row.get('按讚數')) || 0
      });
    }
    photos.reverse();
    res.json(photos);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/photo/tag', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.status(503).json({ success: false });
  try {
    const { imageUrl, userId, tag } = req.body;
    const rows = await photosSheet.getRows();
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl && row.get('使用者ID') === userId) {
        row.set('標籤', tag);
        await row.save();
        break;
      }
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/photo/like', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.status(503).json({ success: false });
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ success: false });
    const rows = await photosSheet.getRows();
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl) {
        const currentLikes = parseInt(row.get('按讚數')) || 0;
        const newLikes = currentLikes + 1;
        row.set('按讚數', newLikes);
        await row.save();
        res.json({ success: true, likes: newLikes });
        return;
      }
    }
    res.status(404).json({ success: false, message: '找不到照片' });
  } catch (error) {
    console.error('❌ 按讚失敗：', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/users', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.json([]);
  try {
    const rows = await photosSheet.getRows();
    const usersMap = new Map();
    for (const row of rows) {
      const userId = row.get('使用者ID') || '';
      const imageUrl = row.get('圖片URL') || '';
      if (!userId || userId === 'test_user') continue;
      if (!imageUrl || imageUrl === 'https://test.com/test.jpg') continue;
      if (!usersMap.has(userId)) {
        usersMap.set(userId, {
          userId,
          photoCount: 0,
          latestPhoto: imageUrl,
          latestTime: row.get('時間') || ''
        });
      }
      const user = usersMap.get(userId);
      user.photoCount++;
      const photoTime = row.get('時間') || '';
      if (photoTime > user.latestTime) {
        user.latestTime = photoTime;
        user.latestPhoto = imageUrl;
      }
    }
    let settingsMap = new Map();
    if (settingsSheet) {
      const settingsRows = await settingsSheet.getRows();
      for (const row of settingsRows) {
        const uid = row.get('使用者ID');
        if (uid) {
          settingsMap.set(uid, {
            displayName: row.get('顯示名稱') || '',
            avatarUrl: row.get('頭像URL') || '',
            bio: row.get('自我介紹') || '',
            ig: row.get('IG帳號') || '',
            fb: row.get('FB帳號') || ''
          });
        }
      }
    }
    const users = Array.from(usersMap.values()).map(user => {
      const setting = settingsMap.get(user.userId) || {};
      return {
        userId: user.userId,
        photoCount: user.photoCount,
        latestPhoto: setting.avatarUrl || user.latestPhoto,
        displayName: setting.displayName || null,
        bio: setting.bio || '',
        ig: setting.ig || '',
        fb: setting.fb || '',
        latestTime: user.latestTime
      };
    });
    users.sort((a,b) => b.photoCount - a.photoCount);
    res.json(users);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/user/displayname', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ success: false });
  try {
    const { userId, displayName } = req.body;
    if (!userId) return res.status(400).json({ success: false });
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(r => r.get('使用者ID') === userId);
    if (userRow) {
      userRow.set('顯示名稱', displayName || '');
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': displayName || '',
        '頭像URL': '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/user/avatar', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ success: false });
  try {
    const { userId, avatarUrl } = req.body;
    if (!userId) return res.status(400).json({ success: false });
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(r => r.get('使用者ID') === userId);
    if (userRow) {
      userRow.set('頭像URL', avatarUrl || '');
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': '',
        '頭像URL': avatarUrl || '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ========== 刪除照片 API（含權限驗證） ==========
app.delete('/api/photo', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.status(503).json({ success: false });
  try {
    const { imageUrl, userId } = req.query;
    if (!userId || !imageUrl) return res.status(400).json({ success: false, error: '缺少必要參數' });
    
    // ========== 驗證請求者身份 ==========
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: '未提供憑證' });
    }
    
    const token = authHeader.split(' ')[1];
    let requestUserId = null;
    
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      requestUserId = `google_${payload.sub}`;
      console.log(`🔐 驗證成功: ${requestUserId} 嘗試刪除 ${userId} 的照片`);
    } catch (e) {
      console.error('Token 驗證失敗:', e.message);
      return res.status(401).json({ success: false, error: '無效的憑證，請重新登入' });
    }
    
    // ========== 只能刪除自己的照片 ==========
    if (requestUserId !== userId) {
      console.error(`❌ 權限不足: ${requestUserId} 試圖刪除 ${userId} 的照片`);
      return res.status(403).json({ success: false, error: '您沒有權限刪除別人的照片' });
    }
    
    // ========== 執行刪除 ==========
    const rows = await photosSheet.getRows();
    let targetRow = null;
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl && row.get('使用者ID') === userId) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) {
      return res.status(404).json({ success: false, message: '找不到該筆照片' });
    }
    await targetRow.delete();
    console.log(`✅ 已刪除照片: ${imageUrl}`);
    res.json({ success: true });
  } catch (error) { 
    console.error('刪除失敗:', error);
    res.status(500).json({ success: false, error: error.message }); 
  }
});

// ========== 使用者個人資料 API ==========
app.get('/api/user/profile/:userId', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const targetUserId = req.params.userId;
    const rows = await settingsSheet.getRows();
    const userRow = rows.find(row => row.get('使用者ID') === targetUserId);
    
    if (!userRow) {
      return res.json({ 
        userId: targetUserId, 
        displayName: null, 
        avatarUrl: null, 
        bio: '', 
        ig: '', 
        fb: '' 
      });
    }
    
    res.json({
      userId: targetUserId,
      displayName: userRow.get('顯示名稱') || null,
      avatarUrl: userRow.get('頭像URL') || null,
      bio: userRow.get('自我介紹') || '',
      ig: userRow.get('IG帳號') || '',
      fb: userRow.get('FB帳號') || ''
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/user/profile', async (req, res) => {
  if (!googleSheetReady || !settingsSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { userId, bio, ig, fb } = req.body;
    if (!userId) return res.status(400).json({ error: '缺少 userId' });
    
    const rows = await settingsSheet.getRows();
    let userRow = rows.find(row => row.get('使用者ID') === userId);
    
    if (userRow) {
      if (bio !== undefined) userRow.set('自我介紹', bio);
      if (ig !== undefined) userRow.set('IG帳號', ig);
      if (fb !== undefined) userRow.set('FB帳號', fb);
      userRow.set('更新時間', new Date().toISOString());
      await userRow.save();
    } else {
      await settingsSheet.addRow({
        '使用者ID': userId,
        '顯示名稱': '',
        '頭像URL': '',
        '自我介紹': bio || '',
        'IG帳號': ig || '',
        'FB帳號': fb || '',
        '更新時間': new Date().toISOString()
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 留言板 API ==========
app.get('/api/messages/:userId', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const targetUserId = req.params.userId;
    const rows = await messagesSheet.getRows();
    
    let settingsMap = new Map();
    if (settingsSheet) {
      const settingsRows = await settingsSheet.getRows();
      for (const row of settingsRows) {
        const uid = row.get('使用者ID');
        if (uid) {
          settingsMap.set(uid, {
            displayName: row.get('顯示名稱') || uid.substring(0, 8),
            avatarUrl: row.get('頭像URL') || ''
          });
        }
      }
    }
    
    const messages = [];
    for (const row of rows) {
      if (row.get('目標使用者ID') === targetUserId) {
        const senderId = row.get('留言者ID');
        const senderInfo = settingsMap.get(senderId) || { displayName: senderId?.substring(0, 8), avatarUrl: '' };
        
        messages.push({
          id: row.get('留言ID'),
          senderId: senderId,
          senderName: senderInfo.displayName,
          senderAvatar: senderInfo.avatarUrl,
          content: row.get('留言內容'),
          time: row.get('時間'),
          likes: parseInt(row.get('按讚數')) || 0,
          parentId: row.get('父留言ID') || null
        });
      }
    }
    messages.reverse();
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Google 登入 ==========
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleUserId = payload.sub;
    const email = payload.email;
    const name = payload.name;
    const avatar = payload.picture;

    res.json({ 
      success: true, 
      userId: googleUserId,
      displayName: name,
      avatarUrl: avatar,
      email: email
    });
  } catch (error) {
    console.error('Google 登入驗證失敗:', error);
    res.status(401).json({ success: false, error: '驗證失敗' });
  }
});

// ========== 留言板操作 ==========
app.post('/api/messages', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { targetUserId, senderId, content } = req.body;
    if (!targetUserId || !senderId || !content) {
      return res.status(400).json({ error: '缺少必要參數' });
    }
    
    const rows = await messagesSheet.getRows();
    const newId = rows.length + 1;
    
    await messagesSheet.addRow({
      '留言ID': newId,
      '目標使用者ID': targetUserId,
      '留言者ID': senderId,
      '留言內容': content,
      '時間': new Date().toISOString(),
      '按讚數': 0,
      '父留言ID': ''
    });
    
    res.json({ success: true, messageId: newId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/like', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: '缺少留言ID' });
    
    const rows = await messagesSheet.getRows();
    const targetRow = rows.find(row => row.get('留言ID') == messageId);
    
    if (!targetRow) return res.status(404).json({ error: '留言不存在' });
    
    const currentLikes = parseInt(targetRow.get('按讚數')) || 0;
    targetRow.set('按讚數', currentLikes + 1);
    await targetRow.save();
    
    res.json({ success: true, likes: currentLikes + 1 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 刪除照片 API（含權限驗證） ==========
app.delete('/api/photo', async (req, res) => {
  if (!googleSheetReady || !photosSheet) return res.status(503).json({ success: false });
  try {
    const { imageUrl, userId } = req.query;
    if (!userId || !imageUrl) return res.status(400).json({ success: false, error: '缺少必要參數' });
    
    // 驗證請求者身份
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: '未提供憑證' });
    }
    
    const token = authHeader.split(' ')[1];
    let requestUserId = null;
    
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      requestUserId = `google_${payload.sub}`;
    } catch (e) {
      return res.status(401).json({ success: false, error: '無效的憑證，請重新登入' });
    }
    
    // 只能刪除自己的照片
    if (requestUserId !== userId) {
      return res.status(403).json({ success: false, error: '您沒有權限刪除別人的照片' });
    }
    
    // 執行刪除
    const rows = await photosSheet.getRows();
    let targetRow = null;
    for (const row of rows) {
      if (row.get('圖片URL') === imageUrl && row.get('使用者ID') === userId) {
        targetRow = row;
        break;
      }
    }
    if (!targetRow) {
      return res.status(404).json({ success: false, message: '找不到該筆照片' });
    }
    await targetRow.delete();
    res.json({ success: true });
  } catch (error) { 
    res.status(500).json({ success: false, error: error.message }); 
  }
});
app.post('/api/messages/reply', async (req, res) => {
  if (!googleSheetReady || !messagesSheet) return res.status(503).json({ error: '服務未就緒' });
  try {
    const { parentMessageId, targetUserId, senderId, content } = req.body;
    if (!parentMessageId || !content) return res.status(400).json({ error: '缺少必要參數' });
    
    const rows = await messagesSheet.getRows();
    const parentMessage = rows.find(row => row.get('留言ID') == parentMessageId);
    
    let parentSenderName = parentMessage?.get('留言者ID') || 'unknown';
    if (settingsSheet) {
      const settingsRows = await settingsSheet.getRows();
      const parentSetting = settingsRows.find(row => row.get('使用者ID') === parentMessage?.get('留言者ID'));
      if (parentSetting) parentSenderName = parentSetting.get('顯示名稱') || parentSenderName.substring(0, 8);
    }
    
    const parentContent = parentMessage ? parentMessage.get('留言內容') : '原留言已不存在';
    const newId = rows.length + 1;
    
    const replyContent = `🔁 回覆 @${parentSenderName}：「${parentContent.substring(0, 50)}${parentContent.length > 50 ? '…' : ''}」\n---\n${content}`;
    
    await messagesSheet.addRow({
      '留言ID': newId,
      '目標使用者ID': targetUserId,
      '留言者ID': senderId,
      '留言內容': replyContent,
      '時間': new Date().toISOString(),
      '按讚數': 0,
      '父留言ID': parentMessageId
    });
    
    res.json({ success: true, messageId: newId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== 照片牆網頁 ==========
app.get('/photowall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photowall.html'));
});

// ========== 啟動伺服器 ==========
const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`🚀 純相簿機器人啟動，port: ${port}`);
  await initGoogleSheets();
  if (googleSheetReady) console.log(`📸 照片牆已就緒`);
});
