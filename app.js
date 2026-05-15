const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const GoogleSheetsManager = require('./googleSheets');

const app = express();
app.use(express.json());
app.use(express.static('public')); // 讓網頁靜態檔案可被訪問

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 初始化 Google Sheets
const googleSheets = new GoogleSheetsManager();
googleSheets.initialize();

// ========== 對話記憶（純記憶體，不用資料庫） ==========
// 儲存每個使用者的對話歷史
// 結構：{ "使用者ID": [{ role: "user", content: "..." }, { role: "assistant", content: "..." }] }
const userConversations = {};

// 設定：每個使用者最多記住 10 組對話（一問一答算一組，所以是 20 則訊息）
const MAX_HISTORY_MESSAGES = 20;  // 10 組對話 = 20 則訊息

// 取得使用者的對話歷史
function getConversationHistory(userId) {
  if (!userConversations[userId]) {
    userConversations[userId] = [];
  }
  return userConversations[userId];
}

// 加入一則對話到歷史
function addToHistory(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  
  // 如果超過最大長度，刪除最舊的
  while (history.length > MAX_HISTORY_MESSAGES) {
    history.shift();
  }
}

// 清除使用者的對話歷史（可選，目前沒用到）
function clearHistory(userId) {
  delete userConversations[userId];
}

// 定期清理記憶體（每天凌晨 4 點清空一次，避免佔用太多記憶體）
setInterval(() => {
  const users = Object.keys(userConversations);
  if (users.length > 0) {
    console.log(`🧹 定期清理記憶體，清除 ${users.length} 位使用者的對話記錄`);
    for (const userId of users) {
      delete userConversations[userId];
    }
  }
}, 24 * 60 * 60 * 1000); // 24 小時

// ========== 從 JSON 檔案載入角色設定 ==========
let ROLES = {};

function loadRoles() {
  try {
    const data = fs.readFileSync('./roles.json', 'utf8');
    ROLES = JSON.parse(data);
    console.log(`✅ ${new Date().toLocaleString()} - 已載入 ${Object.keys(ROLES).length} 個角色：${Object.keys(ROLES).join(', ')}`);
  } catch (error) {
    console.error('❌ 讀取 roles.json 失敗：', error.message);
    ROLES = {};
  }
}

loadRoles();
setInterval(loadRoles, 60000);

// ========== 下載 LINE 圖片 ==========
async function downloadLineImage(messageId) {
  try {
    const response = await axios.get(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: {
          'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
        },
        responseType: 'arraybuffer'
      }
    );
    
    // 建立暫存目錄
    if (!fs.existsSync('./temp')) {
      fs.mkdirSync('./temp');
    }
    
    const fileName = `${Date.now()}_${messageId}.jpg`;
    const filePath = path.join('./temp', fileName);
    fs.writeFileSync(filePath, response.data);
    
    // 上傳到 Google Sheets 需要公開網址，這裡需要一個圖片儲存服務
    // 方案1：使用免費圖床（如 ImgBB）
    // 方案2：使用 Cloudinary
    // 方案3：自己架設圖片伺服器
    
    // 這裡示範使用 ImgBB API 上傳
    const imageUrl = await uploadToImgBB(filePath);
    
    // 刪除暫存檔案
    fs.unlinkSync(filePath);
    
    return imageUrl;
  } catch (error) {
    console.error('❌ 下載 LINE 圖片失敗：', error.message);
    return null;
  }
}

// 上傳到 ImgBB 免費圖床（需要註冊取得 API Key）
async function uploadToImgBB(imagePath) {
  const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
  if (!IMGBB_API_KEY) {
    console.error('❌ 缺少 IMGBB_API_KEY，照片將無法儲存為公開網址');
    return null;
  }
  
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
      new URLSearchParams({
        image: base64Image,
        expiration: 0 // 永久儲存
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    
    return response.data.data.url;
  } catch (error) {
    console.error('❌ 上傳到 ImgBB 失敗：', error.message);
    return null;
  }
}

// ========== DeepSeek 呼叫函數（含對話記憶） ==========
async function callDeepSeekWithMemory(userId, userMessage, systemPrompt) {
  console.log(`📡 呼叫 DeepSeek API（使用者 ${userId.substring(0, 8)}...，有記憶模式）`);
  
  // 1. 取得使用者的對話歷史
  const history = getConversationHistory(userId);
  console.log(`   📝 記憶長度：${history.length} 則訊息（最多 ${MAX_HISTORY_MESSAGES} 則）`);
  
  // 2. 組成 messages 陣列：systemPrompt + 歷史對話 + 當前訊息
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,  // 過去的對話
    { role: 'user', content: userMessage }  // 當前訊息
  ];
  
  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-chat',  // 使用 deepseek-chat 模型
        messages: messages,
        temperature: 0.8,
        max_tokens: 1000
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        timeout: 15000
      }
    );
    
    const reply = response.data.choices[0].message.content;
    
    // 3. 儲存到歷史
    addToHistory(userId, 'user', userMessage);
    addToHistory(userId, 'assistant', reply);
    
    console.log(`   ✅ DeepSeek 回覆成功，新記憶長度：${history.length + 2} 則`);
    return reply;
    
  } catch (error) {
    console.error('❌ DeepSeek API 錯誤：', error.response?.data || error.message);
    
    if (error.response?.data?.error?.message) {
      return `DeepSeek 錯誤：${error.response.data.error.message}`;
    }
    return '抱歉，AI 暫時無法回應，請稍後再試。';
  }
}

// ========== LINE Webhook ==========
app.post('/webhook/:role', async (req, res) => {
  const role = req.params.role;
  const roleConfig = ROLES[role];
  
  if (!roleConfig) {
    console.log(`❌ 未知角色：${role}`);
    return res.status(404).send('Role not found');
  }
  
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).send('OK');
  }
  
  for (const event of events) {
    const replyToken = event.replyToken;
    const userMessage = event.message?.text;
    const userId = event.source?.userId;  // LINE 使用者唯一 ID
    const messageType = event.message?.type;
    
    if (!userId) {
      console.log('⚠️ 無法取得使用者 ID');
      continue;
    }
    
    console.log(`\n🎭 [${new Date().toLocaleString()}] 角色「${roleConfig.name}」`);
    console.log(`   👤 使用者 ID：${userId.substring(0, 8)}...`);
    
    if (replyToken) {
      try {
        // ========== 新增：處理圖片訊息 ==========
        if (messageType === 'image') {
          console.log(`   📸 收到圖片訊息，ID：${event.message.id}`);
          
          // 下載圖片並取得公開網址
          const imageUrl = await downloadLineImage(event.message.id);
          
          if (imageUrl) {
            // 儲存到 Google Sheets
            await googleSheets.addPhoto(userId, imageUrl, role, userMessage || '圖片分享');
            
            // 回覆訊息（不影響原有對話）
            const photoReply = `📸 照片已上傳到照片牆！\n${imageUrl}`;
            
            await axios.post('https://api.line.me/v2/bot/message/reply', {
              replyToken: replyToken,
              messages: [{ type: 'text', text: photoReply }]
            }, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
              }
            });
          } else {
            // 圖片上傳失敗的回覆
            await axios.post('https://api.line.me/v2/bot/message/reply', {
              replyToken: replyToken,
              messages: [{ type: 'text', text: '抱歉，圖片上傳失敗，請稍後再試。' }]
            }, {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
              }
            });
          }
        } 
        // 處理文字訊息（原有功能完全不變）
        else if (messageType === 'text' && userMessage) {
          const aiReply = await callDeepSeekWithMemory(userId, userMessage, roleConfig.systemPrompt);
          
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: aiReply }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });
          
          console.log(`   💬 用戶：${userMessage.substring(0, 50)}${userMessage.length > 50 ? '...' : ''}`);
          console.log(`   🤖 ${roleConfig.name}：${aiReply.substring(0, 50)}${aiReply.length > 50 ? '...' : ''}\n`);
        }
        // 非文字非圖片的訊息（貼圖等）
        else {
          await axios.post('https://api.line.me/v2/bot/message/reply', {
            replyToken: replyToken,
            messages: [{ type: 'text', text: roleConfig.welcome }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });
        }
        
      } catch (error) {
        console.error('回覆失敗：', error.response?.data || error.message);
      }
    }
  }
  
  res.status(200).send('OK');
});

// ========== 照片牆網頁 API ==========
app.get('/api/photos', async (req, res) => {
  try {
    const photos = await googleSheets.getAllPhotos(100);
    res.json(photos);
  } catch (error) {
    res.status(500).json({ error: '讀取照片失敗' });
  }
});

// 照片牆網頁
app.get('/photowall', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photowall.html'));
});

// 健康檢查端點
app.get('/', (req, res) => {
  res.status(200).send('別偷看我屁股');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 伺服器運作中，port: ${port}`);
  console.log(`📋 已載入角色：${Object.keys(ROLES).join(', ')}`);
  console.log(`🧠 對話記憶模式：每個使用者最多記住 ${MAX_HISTORY_MESSAGES} 則訊息（10 組對話）`);
  console.log(`📸 照片牆網址：http://localhost:${port}/photowall`);
});
