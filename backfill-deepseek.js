// backfill-deepseek.js - 使用 DeepSeek API 批次補標籤（完整修正版）
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const axios = require('axios');

// ========== 1. 讀取環境變數 ==========
const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let private_key = process.env.GOOGLE_PRIVATE_KEY;
const sheetId = process.env.GOOGLE_SHEET_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// 處理 Google Sheets 私鑰格式
if (private_key) {
  private_key = private_key.replace(/^"|"$/g, '');
  private_key = private_key.replace(/\\n/g, '\n');
}

// ========== 2. DeepSeek API 配置 ==========
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// 使用 DeepSeek 獲取圖片標籤
async function getLabelsFromDeepSeek(imageUrl) {
  try {
    // 1. 先下載圖片
    console.log(`   📥 下載圖片中...`);
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    // 2. 轉為 Base64
    const imageBase64 = Buffer.from(imageResponse.data).toString('base64');
    const mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
    
    console.log(`   📤 呼叫 DeepSeek API...`);
    
    // 3. DeepSeek 正確的圖片辨識格式（images 參數）
    const requestBody = {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'user',
          content: '請分析這張照片，識別出照片中的主要物體、場景、人物特徵等。請用中文輸出，只返回關鍵字標籤，用逗號分隔，最多5個標籤。不要有其他說明文字。例如："貓, 動物, 寵物, 室內"',
          images: [`data:${mimeType};base64,${imageBase64}`]
        }
      ],
      max_tokens: 100,
      temperature: 0.3
    };
    
    const response = await axios.post(DEEPSEEK_API_URL, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      },
      timeout: 30000
    });
    
    const tags = response.data.choices[0].message.content.trim();
    console.log(`   🏷️ DeepSeek 辨識到: ${tags.substring(0, 80)}...`);
    return tags;
    
  } catch (error) {
    console.error(`   ❌ DeepSeek API 調用失敗:`, error.response?.data || error.message);
    return '';
  }
}

// ========== 3. 檢查環境變數 ==========
console.log('🔧 檢查環境變數:');
console.log(`EMAIL: ${client_email ? '已設定' : '❌ 未設定'}`);
console.log(`PRIVATE KEY: ${private_key ? `已設定 (長度: ${private_key.length})` : '❌ 未設定'}`);
console.log(`SHEET ID: ${sheetId ? '已設定' : '❌ 未設定'}`);
console.log(`DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY ? '已設定' : '❌ 未設定'}`);

// ========== 4. 主要批次處理函數 ==========
async function backfillTagsWithDeepSeek() {
  if (!client_email || !private_key || !sheetId) {
    console.error('❌ 缺少必要的 Google Sheets 環境變數');
    process.exit(1);
  }
  
  if (!DEEPSEEK_API_KEY) {
    console.error('❌ 缺少 DeepSeek API Key');
    process.exit(1);
  }
  
  console.log('🔧 開始使用 DeepSeek API 批次補回 AI 標籤...');
  
  try {
    // 連線 Google Sheets
    const auth = new JWT({
      email: client_email,
      key: private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    console.log('✅ Google Sheets 連線成功');
    
    const photosSheet = doc.sheetsByTitle['照片牆'];
    if (!photosSheet) {
      console.error('❌ 找不到「照片牆」工作表');
      return;
    }
    
    await photosSheet.loadHeaderRow();
    const rows = await photosSheet.getRows();
    console.log(`📋 總共有 ${rows.length} 筆照片`);
    
    let updatedCount = 0;
    let errorCount = 0;
    
    // 測試模式：先處理前 3 筆測試（改成 false 處理全部）
    const testMode = true;
    let processed = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const existingTags = row.get('標籤') || '';
      
      // 跳過已經有標籤的照片
      if (existingTags !== '') {
        console.log(`⏭️ 第 ${i+1} 筆已有標籤，跳過`);
        continue;
      }
      
      if (testMode && processed >= 3) {
        console.log('✅ 測試模式完成，已處理 3 張照片');
        break;
      }
      
      const imageUrl = row.get('圖片URL');
      if (!imageUrl) {
        console.log(`⚠️ 第 ${i+1} 筆沒有圖片 URL，跳過`);
        continue;
      }
      
      console.log(`\n🔄 處理第 ${i+1}/${rows.length} 筆：${imageUrl.substring(0, 60)}...`);
      
      try {
        const aiTags = await getLabelsFromDeepSeek(imageUrl);
        
        if (aiTags && aiTags !== '') {
          row.set('標籤', aiTags);
          await row.save();
          updatedCount++;
          processed++;
          console.log(`✅ 已更新標籤：${aiTags.substring(0, 80)}...`);
        } else {
          console.log(`⚠️ 未偵測到標籤，保留空白`);
          errorCount++;
        }
        
        // 避免請求太快（DeepSeek 有速率限制）
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`❌ 處理失敗：`, error.message);
        errorCount++;
      }
    }
    
    console.log(`\n🎉 完成！`);
    console.log(`   ✅ 成功更新：${updatedCount} 筆`);
    console.log(`   ❌ 失敗/無標籤：${errorCount} 筆`);
    
  } catch (error) {
    console.error('❌ 錯誤：', error.message);
    console.error(error);
  }
}

// ========== 5. 執行程式 ==========
backfillTagsWithDeepSeek();
