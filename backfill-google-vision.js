// backfill-google-vision.js - 使用 Google Vision API 批次補標籤
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const vision = require('@google-cloud/vision');
const axios = require('axios');
const fs = require('fs');

// ========== 1. 讀取環境變數 ==========
const client_email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
let private_key = process.env.GOOGLE_PRIVATE_KEY;
const sheetId = process.env.GOOGLE_SHEET_ID;

// ========== 2. 處理 Google Sheets 私鑰格式 ==========
if (private_key) {
  private_key = private_key.replace(/^"|"$/g, '');
  private_key = private_key.replace(/\\n/g, '\n');
}

// ========== 3. 初始化 Google Vision API ==========
// 方式一：使用環境變數（推薦）
// 需要設定環境變數 GOOGLE_APPLICATION_CREDENTIALS 指向你的 JSON 金鑰檔路徑
// 或者直接從檔案讀取（需要將 JSON 金鑰上傳到 GitHub Secrets）

// 因為在 GitHub Actions 環境，我們用另一種方式：直接從 JSON 字串初始化
let visionClient = null;

function initVisionClient() {
  try {
    const visionKeyJson = process.env.GOOGLE_VISION_KEY_JSON;
    if (!visionKeyJson) {
      console.error('❌ 缺少 GOOGLE_VISION_KEY_JSON 環境變數');
      return false;
    }
    
    const keyData = JSON.parse(visionKeyJson);
    visionClient = new vision.ImageAnnotatorClient({
      credentials: keyData,
    });
    console.log('✅ Google Vision API 客戶端初始化成功');
    return true;
  } catch (error) {
    console.error('❌ Google Vision API 初始化失敗:', error.message);
    return false;
  }
}

// ========== 4. 檢查環境變數 ==========
console.log('🔧 檢查環境變數:');
console.log(`EMAIL: ${client_email ? '已設定' : '❌ 未設定'}`);
console.log(`PRIVATE KEY: ${private_key ? `已設定 (長度: ${private_key.length})` : '❌ 未設定'}`);
console.log(`SHEET ID: ${sheetId ? '已設定' : '❌ 未設定'}`);
console.log(`GOOGLE_VISION_KEY_JSON: ${process.env.GOOGLE_VISION_KEY_JSON ? '已設定' : '❌ 未設定'}`);

// ========== 5. 使用 Google Vision API 獲取標籤 ==========
async function getLabelsFromGoogleVision(imageUrl) {
  if (!visionClient) {
    return '';
  }
  
  try {
    // 下載圖片
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000
    });
    
    // 轉換成 base64
    const imageBase64 = Buffer.from(response.data).toString('base64');
    
    // 呼叫 Vision API
    const [result] = await visionClient.labelDetection({
      image: { content: imageBase64 }
    });
    
    const labels = result.labelAnnotations
      .filter(label => label.score > 0.6) // 只保留信心指數 60% 以上的
      .map(label => label.description);
    
    console.log(`🏷️ Google Vision 辨識到: ${labels.join(', ') || '無'}`);
    return labels.join(', ');
    
  } catch (error) {
    console.error(`❌ Google Vision API 呼叫失敗:`, error.message);
    return '';
  }
}

// ========== 6. 主要批次處理函數 ==========
async function backfillTagsWithGoogleVision() {
  if (!client_email || !private_key || !sheetId) {
    console.error('❌ 缺少必要的 Google Sheets 環境變數');
    process.exit(1);
  }
  
  if (!initVisionClient()) {
    console.error('❌ 無法初始化 Google Vision API');
    process.exit(1);
  }
  
  console.log('🔧 開始使用 Google Vision API 批次補回 AI 標籤...');
  
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
    
    // 測試模式：先處理前 3 筆測試
    const testMode = true;
    let processed = 0;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const existingTags = row.get('標籤') || '';
      
      // 跳過已經有標籤的照片
      if (existingTags !== '') {
        console.log(`⏭️ 第 ${i+1} 筆已有標籤 (${existingTags.substring(0, 30)}...)，跳過`);
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
        const aiTags = await getLabelsFromGoogleVision(imageUrl);
        
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
        
        // 避免請求太快被限制
        await new Promise(resolve => setTimeout(resolve, 1000));
        
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

// ========== 7. 執行程式 ==========
backfillTagsWithGoogleVision();
